import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { google } from "googleapis";
import pkg from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const { Pool } = pkg;

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const JWT_SECRET = process.env.JWT_SECRET || "e-sellers-dashboard-secret-key-2024";

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS master_stores (
      id TEXT PRIMARY KEY,
      shop_domain TEXT UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      service_account_json TEXT NOT NULL,
      sheet_name TEXT DEFAULT 'Sheet1',
      sku_col TEXT DEFAULT 'SKU',
      price_col TEXT DEFAULT 'Price',
      inventory_col TEXT DEFAULT 'Inventory',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS store_assignments (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      master_store_id TEXT NOT NULL REFERENCES master_stores(id) ON DELETE CASCADE,
      UNIQUE(client_id, master_store_id)
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      updated_count INT DEFAULT 0,
      error_count INT DEFAULT 0,
      duration INT DEFAULT 0,
      logs TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("Database tables ready.");
}

async function startServer() {
  // Init DB tables
  await initDatabase();

  // Ensure default admin exists
  const adminEmail = "yahia@e-sellers.com";
  const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [adminEmail]);
  if (rows.length === 0) {
    const hashedPassword = await bcrypt.hash("yahia123", 10);
    await pool.query(
      "INSERT INTO users (id, email, password, name, role) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), adminEmail, hashedPassword, "Yahia (Admin)", "admin"]
    );
    console.log("Default admin created:", adminEmail);
  }

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json());

  // Auth Middleware
  const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Access token required" });
    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.status(403).json({ error: "Invalid or expired token" });
      req.user = user;
      next();
    });
  };

  const isAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    next();
  };

  // Health
  app.get("/api/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", db: "connected" });
    } catch {
      res.status(500).json({ status: "error", db: "disconnected" });
    }
  });

  // Auth: Login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: "24h" });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  });

  // Admin: Get All Clients
  app.get("/api/admin/clients", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { rows: clients } = await pool.query("SELECT id, email, name, role, created_at FROM users WHERE role = 'client'");
    // Get store assignments for each client
    const result = await Promise.all(clients.map(async (client) => {
      const { rows: stores } = await pool.query(
        "SELECT ms.* FROM master_stores ms JOIN store_assignments sa ON sa.master_store_id = ms.id WHERE sa.client_id = $1",
        [client.id]
      );
      return { ...client, stores };
    }));
    res.json(result);
  });

  // Admin: Create Client
  app.post("/api/admin/clients", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { name, email, password } = req.body;
    try {
      const hashed = await bcrypt.hash(password, 10);
      const id = randomUUID();
      await pool.query("INSERT INTO users (id, email, password, name, role) VALUES ($1, $2, $3, $4, 'client')", [id, email, hashed, name]);
      res.json({ id, email, name, role: "client" });
    } catch (e: any) {
      res.status(400).json({ error: "Email already exists" });
    }
  });

  // Admin: Get Master Stores
  app.get("/api/admin/master-stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { rows } = await pool.query("SELECT * FROM master_stores ORDER BY created_at DESC");
    res.json(rows);
  });

  // Admin: Register Master Store
  app.post("/api/admin/master-stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName, skuCol, priceCol, inventoryCol } = req.body;
    try {
      const id = randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO master_stores (id, shop_domain, access_token, spreadsheet_id, service_account_json, sheet_name, sku_col, price_col, inventory_col)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName || "Sheet1", skuCol || "SKU", priceCol || "Price", inventoryCol || "Inventory"]
      );
      res.json(rows[0]);
    } catch (e: any) {
      res.status(400).json({ error: "Store domain already exists" });
    }
  });

  // Admin: Update Master Store
  app.put("/api/admin/master-stores/:id", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName, skuCol, priceCol, inventoryCol } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE master_stores 
         SET shop_domain = $1, access_token = $2, spreadsheet_id = $3, service_account_json = $4, sheet_name = $5, sku_col = $6, price_col = $7, inventory_col = $8, updated_at = NOW()
         WHERE id = $9 RETURNING *`,
        [shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName || "Sheet1", skuCol || "SKU", priceCol || "Price", inventoryCol || "Inventory", id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Store not found" });
      res.json(rows[0]);
    } catch (e: any) {
      res.status(400).json({ error: "Store update failed or domain conflict" });
    }
  });

  // Admin: Delete Master Store
  app.delete("/api/admin/master-stores/:id", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      await pool.query("DELETE FROM master_stores WHERE id = $1", [id]);
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ error: "Delete failed" });
    }
  });

  // Admin: Assign Store to Client
  app.post("/api/admin/clients/:clientId/stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { clientId } = req.params;
    const { masterStoreId } = req.body;
    try {
      const id = randomUUID();
      await pool.query("INSERT INTO store_assignments (id, client_id, master_store_id) VALUES ($1, $2, $3)", [id, clientId, masterStoreId]);
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ error: "Store already assigned or invalid IDs" });
    }
  });

  // Client: Get My Stores
  app.get("/api/client/stores", authenticateToken, async (req: Request, res: Response) => {
    if (req.user.role === 'admin') {
      const { rows } = await pool.query("SELECT * FROM master_stores ORDER BY created_at DESC");
      return res.json(rows.map(r => ({
        id: r.id,
        shopDomain: r.shop_domain,
        accessToken: r.access_token,
        spreadsheetId: r.spreadsheet_id,
        serviceAccountJson: r.service_account_json,
        sheet_name: r.sheet_name,
        sku_col: r.sku_col,
        price_col: r.price_col,
        inventory_col: r.inventory_col,
        created_at: r.created_at
      })));
    }
    const { rows } = await pool.query(
      "SELECT ms.* FROM master_stores ms JOIN store_assignments sa ON sa.master_store_id = ms.id WHERE sa.client_id = $1",
      [req.user.id]
    );
    res.json(rows.map(r => ({
      id: r.id,
      shopDomain: r.shop_domain,
      accessToken: r.access_token,
      spreadsheetId: r.spreadsheet_id,
      serviceAccountJson: r.service_account_json,
      sheet_name: r.sheet_name,
      sku_col: r.sku_col,
      price_col: r.price_col,
      inventory_col: r.inventory_col,
      created_at: r.created_at
    })));
  });

  // Background Sync Management
  const syncSessions: Record<string, any> = {};

  const updateSyncSession = async (shopDomain: string, data: any) => {
    if (!syncSessions[shopDomain]) {
      syncSessions[shopDomain] = { logs: [], progress: { current: 0, total: 0 }, status: "idle", message: "" };
    }
    const session = syncSessions[shopDomain];
    if (data.type === "progress") {
      session.progress = { current: data.current, total: data.total };
      session.message = data.message;
      session.status = "loading";
    } else if (data.type === "complete") {
      session.status = "success";
      session.result = { updated: data.updatedCount, errors: data.errorCount, duration: data.duration };
      session.logs = data.logs || [];
      session.message = "Sync Complete";
      try {
        await pool.query(
          "INSERT INTO sync_logs (id, shop_domain, status, message, updated_count, error_count, duration, logs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [randomUUID(), shopDomain, "success", "Sync completed", data.updatedCount, data.errorCount, data.duration, data.logs || []]
        );
      } catch {}
    } else if (data.type === "error") {
      session.status = "error";
      session.message = data.message;
      try {
        await pool.query(
          "INSERT INTO sync_logs (id, shop_domain, status, message, logs) VALUES ($1, $2, $3, $4, $5)",
          [randomUUID(), shopDomain, "error", data.message, [data.message]]
        );
      } catch {}
    }
    (session.clients || []).forEach((c: any) => c.res.write(`data: ${JSON.stringify(data)}\n\n`));
  };

  app.post("/api/sync/sheets-to-shopify", authenticateToken, async (req: Request, res: Response) => {
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, mapping, sheetName, syncMode } = req.body;
    if (syncSessions[shopDomain]?.status === "loading") return res.status(400).json({ error: "Sync already running" });

    syncSessions[shopDomain] = { status: "loading", progress: { current: 0, total: 0 }, message: "Starting...", logs: [], clients: syncSessions[shopDomain]?.clients || [] };

    (async () => {
      try {
        const startTime = Date.now();
        await updateSyncSession(shopDomain, { type: "progress", current: 0, total: 0, message: "Step 1: Fetching Data..." });

        const credentials = JSON.parse(serviceAccountJson);
        const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
        const sheets = google.sheets({ version: "v4", auth });
        const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName || "Sheet1" });
        const rows = sheetRes.data.values;
        if (!rows || rows.length === 0) return await updateSyncSession(shopDomain, { type: "error", message: "No data found" });

        const headers = rows[0];
        const skuIndex = headers.indexOf(mapping.sku);
        const priceIndex = headers.indexOf(mapping.price);
        const invIndex = headers.indexOf(mapping.inventory);
        if (skuIndex === -1) return await updateSyncSession(shopDomain, { type: "error", message: "SKU column not found" });

        const shouldSyncPrice = syncMode === "price" || syncMode === "both";
        const shouldSyncStock = syncMode === "stock" || syncMode === "both";

        let locationId = null;
        if (shouldSyncStock) {
          const locRes = await fetch(`https://${shopDomain}/admin/api/2024-01/locations.json`, { headers: { "X-Shopify-Access-Token": accessToken } });
          const locData = await locRes.json();
          locationId = locData.locations?.[0]?.id;
        }

        const skusArray = Array.from(new Set(rows.slice(1).map((r: any) => r[skuIndex]).filter(Boolean)));
        const shopifyVariants = new Map();

        for (let i = 0; i < skusArray.length; i += 100) {
          const chunk = skusArray.slice(i, i + 100);
          const queryStr = chunk.map((sku: any) => `sku:"${sku.replace(/"/g, '\\"')}"`).join(" OR ");
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
          await updateSyncSession(shopDomain, { type: "progress", current: Math.min(i + 100, skusArray.length), total: skusArray.length, message: `Step 1: Fetching products in sheet...` });
        }

        const updates: any[] = [];
        for (let i = 1; i < rows.length; i++) {
          const sku = rows[i][skuIndex];
          const price = rows[i][priceIndex];
          const inv = rows[i][invIndex];
          const shopify = shopifyVariants.get(sku);
          if (!shopify) continue;
          if (shouldSyncPrice && price && parseFloat(price) !== parseFloat(shopify.price)) updates.push({ type: "price", id: shopify.variantId, value: price });
          if (shouldSyncStock && inv && parseInt(inv) !== shopify.available) updates.push({ type: "inv", id: shopify.invId, value: parseInt(inv) });
        }

        if (updates.length === 0) return await updateSyncSession(shopDomain, { type: "complete", updatedCount: 0, errorCount: 0, logs: [], duration: Date.now() - startTime });

        for (let i = 0; i < updates.length; i += 50) {
          const batch = updates.slice(i, i + 50);
          const priceBatch = batch.filter((u: any) => u.type === "price");
          const invBatch = batch.filter((u: any) => u.type === "inv");

          if (priceBatch.length > 0) {
            let mutation = `mutation {`;
            priceBatch.forEach((u: any, idx: number) => { mutation += `v${idx}: productVariantUpdate(input: {id: "${u.id}", price: "${u.value}"}) { userErrors { message } }`; });
            mutation += `}`;
            await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
              method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ query: mutation })
            });
          }

          if (invBatch.length > 0) {
            const mutation = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`;
            const variables = { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: invBatch.map((u: any) => ({ inventoryItemId: u.id, locationId: `gid://shopify/Location/${locationId}`, quantity: u.value })) } };
            await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
              method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ query: mutation, variables })
            });
          }

          await updateSyncSession(shopDomain, { type: "progress", current: Math.min(i + 50, updates.length), total: updates.length, message: `Step 2: Syncing updates to Shopify...` });
        }

        await updateSyncSession(shopDomain, { type: "complete", updatedCount: updates.length, errorCount: 0, logs: [], duration: Date.now() - startTime });
      } catch (err: any) {
        await updateSyncSession(shopDomain, { type: "error", message: err.message });
      }
    })();
    res.json({ success: true });
  });

  app.get("/api/sync/status", authenticateToken, (req, res) => {
    const session = syncSessions[req.query.shopDomain as string];
    if (!session) return res.json({ status: "idle" });
    const { clients, ...safe } = session;
    res.json(safe);
  });

  app.get("/api/sync/stream", (req, res) => {
    const shop = req.query.shopDomain as string;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (!syncSessions[shop]) syncSessions[shop] = { status: "idle", logs: [], progress: { current: 0, total: 0 }, message: "", clients: [] };
    const client = { id: Date.now(), res };
    syncSessions[shop].clients = [...(syncSessions[shop].clients || []), client];
    req.on("close", () => { syncSessions[shop].clients = syncSessions[shop].clients.filter((c: any) => c.id !== client.id); });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(path.resolve(), "dist")));
    app.get("*", (req, res) => res.sendFile(path.join(path.resolve(), "dist", "index.html")));
  }

  app.listen(Number(PORT), "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}

startServer().catch(console.error);
