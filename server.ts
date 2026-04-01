import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { google } from "googleapis";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

dotenv.config();

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "e-sellers-dashboard-secret-key-2024";

async function startServer() {
  // Ensure default admin exists
  const adminEmail = "yahia@e-sellers.com";
  try {
    const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash("yahia123", 10);
      await prisma.user.create({
        data: {
          email: adminEmail,
          password: hashedPassword,
          name: "Yahia (Admin)",
          role: "admin"
        }
      });
      console.log("Default admin created: ", adminEmail);
    }
  } catch (e) {
    console.warn("Database connection not ready yet. Server starting anyway...");
  }

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json());

  // Auth Middleware
  const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Access token required" });

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.status(403).json({ error: "Invalid or expired token" });
      req.user = user;
      next();
    });
  };

  const isAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
    next();
  };

  // Health check
  app.get("/api/health", (req, res) => res.json({ status: "ok" }));

  // Auth: Login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  });

  // Admin: Get All Clients
  app.get("/api/admin/clients", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const clients = await prisma.user.findMany({ 
      where: { role: 'client' },
      include: { stores: { include: { masterStore: true } } } 
    });
    res.json(clients);
  });

  // Admin: Create Client
  app.post("/api/admin/clients", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { name, email, password } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = await prisma.user.create({
        data: { name, email, password: hashedPassword, role: 'client' }
      });
      res.json(newUser);
    } catch (e: any) {
      res.status(400).json({ error: e.message || "Failed to create client" });
    }
  });

  // Admin: Get Store Database (Master Stores)
  app.get("/api/admin/master-stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const stores = await prisma.masterStore.findMany();
    res.json(stores);
  });

  // Admin: Register Master Store
  app.post("/api/admin/master-stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    try {
      const newStore = await prisma.masterStore.create({ data: req.body });
      res.json(newStore);
    } catch (e: any) {
      res.status(400).json({ error: "Store domain already exists or invalid data" });
    }
  });

  // Admin: Assign Master Store to Client
  app.post("/api/admin/clients/:clientId/stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { clientId } = req.params;
    const { masterStoreId } = req.body;
    try {
      const assignment = await prisma.store.create({ data: { clientId, masterStoreId } });
      res.json(assignment);
    } catch (e: any) {
      res.status(400).json({ error: "Store already assigned or invalid IDs" });
    }
  });

  // Client: Get My Assigned Stores
  app.get("/api/client/stores", authenticateToken, async (req: Request, res: Response) => {
    const assignments = await prisma.store.findMany({
      where: { clientId: req.user.id },
      include: { masterStore: true }
    });
    res.json(assignments.map(a => a.masterStore));
  });

  // Background Sync Management
  const syncSessions: Record<string, any> = {};

  const updateSyncSession = async (shopDomain: string, data: any) => {
    if (!syncSessions[shopDomain]) {
      syncSessions[shopDomain] = { logs: [], progress: { current: 0, total: 0 }, status: 'idle', message: '' };
    }
    const session = syncSessions[shopDomain];
    if (data.type === 'progress') {
      session.progress = { current: data.current, total: data.total };
      session.message = data.message;
      session.status = 'loading';
    } else if (data.type === 'complete') {
      session.status = 'success';
      session.result = { updated: data.updatedCount, errors: data.errorCount, duration: data.duration };
      session.logs = data.logs || [];
      session.message = 'Sync Complete';
      try {
        await prisma.syncLog.create({
          data: {
            shopDomain,
            status: 'success',
            message: 'Sync completed',
            updatedCount: data.updatedCount,
            errorCount: data.errorCount,
            duration: data.duration,
            logs: data.logs || []
          }
        });
      } catch (e) {}
    } else if (data.type === 'error') {
      session.status = 'error';
      session.message = data.message;
      try {
        await prisma.syncLog.create({
          data: { shopDomain, status: 'error', message: data.message, logs: [data.message] }
        });
      } catch (e) {}
    }
    (session.clients || []).forEach((c: any) => c.res.write(`data: ${JSON.stringify(data)}\n\n`));
  };

  app.post("/api/sync/sheets-to-shopify", authenticateToken, async (req: Request, res: Response) => {
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, mapping, sheetName, syncMode } = req.body;
    if (syncSessions[shopDomain]?.status === 'loading') return res.status(400).json({ error: "Sync already running" });

    syncSessions[shopDomain] = { status: 'loading', progress: { current: 0, total: 0 }, message: 'Starting...', logs: [], clients: syncSessions[shopDomain]?.clients || [] };

    (async () => {
      try {
        const startTime = Date.now();
        await updateSyncSession(shopDomain, { type: 'progress', current: 0, total: 0, message: 'Step 1: Fetching Data...' });
        
        const credentials = JSON.parse(serviceAccountJson);
        const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
        const sheets = google.sheets({ version: "v4", auth });
        const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName || "Sheet1" });
        const rows = sheetRes.data.values;
        if (!rows || rows.length === 0) return await updateSyncSession(shopDomain, { type: 'error', message: "No data found" });

        const headers = rows[0];
        const skuIndex = headers.indexOf(mapping.sku);
        const priceIndex = headers.indexOf(mapping.price);
        const invIndex = headers.indexOf(mapping.inventory);
        if (skuIndex === -1) return await updateSyncSession(shopDomain, { type: 'error', message: "SKU column not found" });

        const shouldSyncPrice = syncMode === 'price' || syncMode === 'both';
        const shouldSyncStock = syncMode === 'stock' || syncMode === 'both';

        let locationId = null;
        if (shouldSyncStock) {
          const locRes = await fetch(`https://${shopDomain}/admin/api/2024-01/locations.json`, { headers: { "X-Shopify-Access-Token": accessToken } });
          const locData = await locRes.json();
          locationId = locData.locations?.[0]?.id;
        }

        const skusArray = Array.from(new Set(rows.slice(1).map(r => r[skuIndex]).filter(Boolean)));
        const shopifyVariants = new Map();

        for (let i = 0; i < skusArray.length; i += 100) {
          const chunk = skusArray.slice(i, i + 100);
          const queryStr = chunk.map(sku => `sku:"${sku.replace(/"/g, '\\"')}"`).join(' OR ');
          const query = `query getVariants($queryStr: String) { productVariants(first: 100, query: $queryStr) { edges { node { id sku price inventoryItem { id inventoryLevels(first: 1) { edges { node { quantities(names: ["available"]) { quantity } } } } } } } } }`;
          const gqlRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
            method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: { queryStr } })
          });
          const data = await gqlRes.json();
          data.data?.productVariants?.edges?.forEach((e: any) => {
            const node = e.node;
            const available = node.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.quantities?.[0]?.quantity || 0;
            shopifyVariants.set(node.sku, { variantId: node.id, invId: node.inventoryItem?.id, price: node.price, available });
          });
          await updateSyncSession(shopDomain, { type: 'progress', current: Math.min(i + 100, skusArray.length), total: skusArray.length, message: `Step 1: Analyzing items...` });
        }

        const updates: any[] = [];
        for (let i = 1; i < rows.length; i++) {
          const sku = rows[i][skuIndex];
          const price = rows[i][priceIndex];
          const inv = rows[i][invIndex];
          const shopify = shopifyVariants.get(sku);
          if (!shopify) continue;
          if (shouldSyncPrice && price && parseFloat(price) !== parseFloat(shopify.price)) updates.push({ type: 'price', id: shopify.variantId, value: price });
          if (shouldSyncStock && inv && parseInt(inv) !== shopify.available) updates.push({ type: 'inv', id: shopify.invId, value: parseInt(inv) });
        }

        if (updates.length === 0) return await updateSyncSession(shopDomain, { type: 'complete', updatedCount: 0, errorCount: 0, duration: Date.now() - startTime });

        for (let i = 0; i < updates.length; i += 50) {
            const batch = updates.slice(i, i + 50);
            // Splitting into price and inv batches for efficiency
            const priceBatch = batch.filter(u => u.type === 'price');
            const invBatch = batch.filter(u => u.type === 'inv');

            if (priceBatch.length > 0) {
              let mutation = `mutation {`;
              priceBatch.forEach((u, idx) => { mutation += `v${idx}: productVariantUpdate(input: {id: "${u.id}", price: "${u.value}"}) { userErrors { message } }`; });
              mutation += `}`;
              await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
                method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
                body: JSON.stringify({ query: mutation })
              });
            }

            if (invBatch.length > 0) {
              const mutation = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`;
              const variables = { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: invBatch.map(u => ({ inventoryItemId: u.id, locationId: `gid://shopify/Location/${locationId}`, quantity: u.value })) } };
              await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
                method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
                body: JSON.stringify({ query: mutation, variables })
              });
            }

            await updateSyncSession(shopDomain, { type: 'progress', current: Math.min(i + 50, updates.length), total: updates.length, message: `Step 2: Syncing updates...` });
        }

        await updateSyncSession(shopDomain, { type: 'complete', updatedCount: updates.length, errorCount: 0, logs: [], duration: Date.now() - startTime });
      } catch (err: any) {
        await updateSyncSession(shopDomain, { type: 'error', message: err.message });
      }
    })();
    res.json({ success: true });
  });

  app.get("/api/sync/status", authenticateToken, (req, res) => {
    const session = syncSessions[req.query.shopDomain as string];
    if (!session) return res.json({ status: 'idle' });
    const { clients, ...safe } = session;
    res.json(safe);
  });

  app.get("/api/sync/stream", (req, res) => {
    const shop = req.query.shopDomain as string;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (!syncSessions[shop]) syncSessions[shop] = { status: 'idle', logs: [], progress: { current: 0, total: 0 }, message: '', clients: [] };
    const client = { id: Date.now(), res };
    syncSessions[shop].clients = [...(syncSessions[shop].clients || []), client];
    req.on('close', () => syncSessions[shop].clients = syncSessions[shop].clients.filter((c: any) => c.id !== client.id));
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(path.resolve(), "dist")));
    app.get("*", (req, res) => res.sendFile(path.join(path.resolve(), "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server on port ${PORT}`));
}

startServer();
