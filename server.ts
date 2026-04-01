import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { JSONFilePreset } from "lowdb/node";
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

const __dirname = path.resolve();

async function startServer() {
  // Database Setup
  const defaultData = { users: [], clients: [], masterStores: [] };
  const db = await JSONFilePreset(path.join(__dirname, "data", "db.json"), defaultData);
  if (!db.data.masterStores) db.data.masterStores = [];
  await db.write();
  const JWT_SECRET = process.env.JWT_SECRET || "e-sellers-dashboard-secret-key-2024";

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Auth Middleware
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: "Access token required" });

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.status(403).json({ error: "Invalid or expired token" });
      req.user = user;
      next();
    });
  };

  const isAdmin = (req: any, res: any, next: any) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
    next();
  };

  // Auth Routes
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const user = db.data.users.find(u => u.email === email);

    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  });

  // Admin: Get All Clients
  app.get("/api/admin/clients", authenticateToken, isAdmin, (req, res) => {
    res.json(db.data.clients);
  });

  // Admin: Create Client
  app.post("/api/admin/clients", authenticateToken, isAdmin, async (req, res) => {
    const { name, email, password } = req.body;
    
    // Check if user already exists
    if (db.data.users.find(u => u.email === email)) {
      return res.status(400).json({ error: "User already exists with this email" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: `user-${Date.now()}`,
      email,
      password: hashedPassword,
      role: 'client',
      name
    };

    const newClient = {
      id: `client-${Date.now()}`,
      userId: newUser.id,
      name,
      stores: []
    };

    db.data.users.push(newUser);
    db.data.clients.push(newClient);
    await db.write();

    res.json({ success: true, client: newClient });
  });

  // Admin: Get All Master Stores
  app.get("/api/admin/master-stores", authenticateToken, isAdmin, (req, res) => {
    res.json(db.data.masterStores);
  });

  // Admin: Create/Register Master Store
  app.post("/api/admin/master-stores", authenticateToken, isAdmin, async (req, res) => {
    const store = req.body;
    const newMasterStore = {
      id: `mstore-${Date.now()}`,
      ...store
    };
    db.data.masterStores.push(newMasterStore);
    await db.write();
    res.json({ success: true, store: newMasterStore });
  });

  // Admin: Assign Store to Client (Linked to Master Store)
  app.post("/api/admin/clients/:clientId/stores", authenticateToken, isAdmin, async (req, res) => {
    const { clientId } = req.params;
    const { masterStoreId } = req.body;
    
    const client = db.data.clients.find(c => c.id === clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const masterStore = db.data.masterStores.find(ms => ms.id === masterStoreId);
    if (!masterStore) return res.status(404).json({ error: "Master store not found" });

    // Link the master store to the client
    const newLink = {
      id: `store-${Date.now()}`,
      masterStoreId: masterStore.id,
      shopDomain: masterStore.shopDomain,
      // We store the data here so the client can access it easily, 
      // but it points back to the master store
      ...masterStore
    };

    client.stores.push(newLink);
    await db.write();

    res.json({ success: true, store: newLink });
  });

  // Client: Get My Stores
  app.get("/api/client/stores", authenticateToken, (req, res) => {
    const client = db.data.clients.find(c => c.userId === req.user.id);
    if (!client && req.user.role !== 'admin') return res.status(404).json({ error: "Client profile not found" });
    
    if (req.user.role === 'admin') {
      // Admin sees all stores or specific subset? 
      // For now, let's say admin sees all clients' stores flattened
      const allStores = db.data.clients.flatMap(c => c.stores.map(s => ({ ...s, clientName: c.name })));
      return res.json(allStores);
    }

    res.json(client.stores);
  });

  // Shopify Verification
  app.post("/api/shopify/verify", authenticateToken, async (req, res) => {
    const { shopDomain, accessToken } = req.body;
    try {
      const response = await fetch(`https://${shopDomain}/admin/api/2024-01/shop.json`, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      });
      if (!response.ok) {
        throw new Error("Invalid credentials");
      }
      const data = await response.json();
      res.json({ success: true, shop: data.shop.name });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Google Sheets Verification
  app.post("/api/google/verify", authenticateToken, async (req, res) => {
    const { spreadsheetId, serviceAccountJson } = req.body;
    try {
      let credentials;
      try {
        credentials = JSON.parse(serviceAccountJson);
      } catch (parseError: any) {
        console.error("JSON Parse Error:", parseError);
        return res.status(400).json({ success: false, error: "Invalid JSON format. Please ensure you pasted the entire JSON file correctly." });
      }

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      const sheets = google.sheets({ version: "v4", auth });
      const response = await sheets.spreadsheets.get({
        spreadsheetId,
      });
      res.json({ success: true, title: response.data.properties?.title });
    } catch (error: any) {
      console.error("Google API Error:", error);
      
      let errorMessage = error.message;
      if (errorMessage.includes("has not been used in project")) {
        errorMessage = "Google Sheets API is not enabled for this Google Cloud Project. Please enable it in the Google Cloud Console.";
      } else if (errorMessage.includes("The caller does not have permission") || errorMessage.includes("Requested entity was not found")) {
        errorMessage = "The service account does not have access to this spreadsheet. Did you share the Google Sheet with the service account email?";
      }

      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  // Background Sync Management
  const syncSessions: Record<string, any> = {};

  const updateSyncSession = (shopDomain: string, data: any) => {
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
    } else if (data.type === 'error') {
      session.status = 'error';
      session.logs = [data.message];
      session.message = 'Error occurred';
    }
    // Emit to active SSE clients if any
    (session.clients || []).forEach((c: any) => c.res.write(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Sync Sheets to Shopify (Background Process)
  app.post("/api/sync/sheets-to-shopify", authenticateToken, async (req, res) => {
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, mapping, sheetName, syncMode } = req.body;
    
    if (syncSessions[shopDomain]?.status === 'loading') {
      return res.status(400).json({ error: "A sync is already running for this store." });
    }

    // Initialize/Reset session
    syncSessions[shopDomain] = { 
      status: 'loading', 
      progress: { current: 0, total: 0 }, 
      message: 'Starting background sync...', 
      logs: [],
      clients: syncSessions[shopDomain]?.clients || [] 
    };

    // Start background task
    (async () => {
      try {
        const startTime = Date.now();
        updateSyncSession(shopDomain, { type: 'progress', current: 0, total: 0, message: 'Fetching Google Sheets data...' });

        const credentials = JSON.parse(serviceAccountJson);
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const sheets = google.sheets({ version: "v4", auth });
        
        const sheetRes = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: sheetName || "Sheet1",
        });

        const rows = sheetRes.data.values;
        if (!rows || rows.length === 0) {
          return updateSyncSession(shopDomain, { type: 'error', message: "No data found in sheet." });
        }

        const headers = rows[0];
        const skuIndex = headers.indexOf(mapping.sku);
        const priceIndex = headers.indexOf(mapping.price);
        const inventoryIndex = headers.indexOf(mapping.inventory);

        if (skuIndex === -1) {
          return updateSyncSession(shopDomain, { type: 'error', message: `SKU column '${mapping.sku}' not found.` });
        }

        let updatedCount = 0;
        let errorCount = 0;
        const logs: string[] = [];
        const totalRows = rows.length - 1;

        const shouldSyncPrice = syncMode === 'price' || syncMode === 'both';
        const shouldSyncStock = syncMode === 'stock' || syncMode === 'both';

        let locationId: string | null = null;
        if (shouldSyncStock) {
          const locRes = await fetch(`https://${shopDomain}/admin/api/2024-01/locations.json`, {
            headers: { "X-Shopify-Access-Token": accessToken },
          });
          if (locRes.ok) {
            const locData = await locRes.json();
            locationId = locData.locations[0]?.id;
          } else {
            return updateSyncSession(shopDomain, { type: 'error', message: "Failed to fetch Shopify locations." });
          }
        }

        const skusArray = Array.from(new Set(rows.slice(1).map(r => r[skuIndex]).filter(Boolean)));
        const shopifyVariants = new Map<string, any>();

        // Fetching Shopify Variants (Optimized)
        updateSyncSession(shopDomain, { type: 'progress', current: 0, total: totalRows, message: 'Fetching Shopify products...' });
        const chunkSize = 100;
        for (let i = 0; i < skusArray.length; i += chunkSize) {
          const chunk = (skusArray as string[]).slice(i, i + chunkSize);
          const queryStr = chunk.map(sku => `sku:"${sku.replace(/"/g, '\\"')}"`).join(' OR ');
          
          let hasNextPage = true;
          let cursor: string | null = null;
          
          while (hasNextPage) {
            const query = `
              query getVariants($cursor: String, $queryStr: String) {
                productVariants(first: 100, after: $cursor, query: $queryStr) {
                  pageInfo { hasNextPage endCursor }
                  edges {
                    node {
                      id sku price
                      inventoryItem {
                        id
                        inventoryLevels(first: 1) {
                          edges { node { location { id } quantities(names: ["available"]) { name quantity } } }
                        }
                      }
                    }
                  }
                }
              }
            `;
            const gqlRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
              method: "POST",
              headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ query, variables: { cursor, queryStr } }),
            });

            if (!gqlRes.ok) break;

            const data = await gqlRes.json();
            if (data.errors) break;

            const connection = data.data.productVariants;
            for (const edge of connection.edges) {
              const node = edge.node;
              if (node.sku) {
                let available = 0;
                const level = node.inventoryItem?.inventoryLevels?.edges?.[0]?.node;
                if (level) {
                   available = level.quantities?.find((q: any) => q.name === 'available')?.quantity || 0;
                }
                shopifyVariants.set(node.sku, { variantId: node.id, inventoryItemId: node.inventoryItem?.id, price: node.price, available });
              }
            }
            hasNextPage = connection.pageInfo.hasNextPage;
            cursor = connection.pageInfo.endCursor;
          }
          updateSyncSession(shopDomain, { type: 'progress', current: Math.min(i + chunkSize, skusArray.length), total: skusArray.length, message: `Loaded ${shopifyVariants.size} stores products...` });
        }

        // Compare and Batch Updates
        const priceUpdates: any[] = [];
        const inventoryUpdates: any[] = [];

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const sku = row[skuIndex];
          const sheetPrice = row[priceIndex];
          const sheetInventory = row[inventoryIndex];
          if (!sku) continue;

          const shopifyData = shopifyVariants.get(sku);
          if (!shopifyData) {
            logs.push(`SKU ${sku} not found in Shopify`);
            errorCount++;
            continue;
          }

          if (shouldSyncPrice && sheetPrice && parseFloat(sheetPrice) !== parseFloat(shopifyData.price)) {
            priceUpdates.push({ id: shopifyData.variantId, price: sheetPrice, sku });
          }

          if (shouldSyncStock && sheetInventory) {
            const parsedInv = parseInt(sheetInventory, 10);
            if (!isNaN(parsedInv) && parsedInv !== shopifyData.available) {
              inventoryUpdates.push({ inventoryItemId: shopifyData.inventoryItemId, locationId: `gid://shopify/Location/${locationId}`, quantity: parsedInv, sku });
            }
          }
        }

        const totalUpdates = priceUpdates.length + inventoryUpdates.length;
        if (totalUpdates === 0) {
           return updateSyncSession(shopDomain, { type: 'complete', updatedCount: 0, errorCount, logs, duration: Date.now() - startTime });
        }

        // Execute Batch Updates
        let completed = 0;
        // Inventory batches of 100
        for (let i = 0; i < inventoryUpdates.length; i += 100) {
          const batch = inventoryUpdates.slice(i, i + 100);
          const mutation = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`;
          const variables = { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: batch.map(u => ({ inventoryItemId: u.inventoryItemId, locationId: u.locationId, quantity: u.quantity })) } };
          
          await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query: mutation, variables }),
          });
          completed += batch.length;
          updatedCount += batch.length;
          updateSyncSession(shopDomain, { type: 'progress', current: completed, total: totalUpdates, message: `Updating Inventory...` });
        }

        // Price batches of 10
        for (let i = 0; i < priceUpdates.length; i += 10) {
          const batch = priceUpdates.slice(i, i + 10);
          let mutation = `mutation {`;
          batch.forEach((u, index) => { mutation += `v${index}: productVariantUpdate(input: {id: "${u.id}", price: "${u.price}"}) { userErrors { message } }`; });
          mutation += `}`;
          
          await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query: mutation }),
          });
          completed += batch.length;
          updatedCount += batch.length;
          updateSyncSession(shopDomain, { type: 'progress', current: completed, total: totalUpdates, message: `Updating Prices...` });
        }

        updateSyncSession(shopDomain, { type: 'complete', updatedCount, errorCount, logs, duration: Date.now() - startTime });
      } catch (err: any) {
        updateSyncSession(shopDomain, { type: 'error', message: err.message });
      }
    })();

    res.json({ success: true, message: "Sync started in background" });
  });

  // Sync Status Polling
  app.get("/api/sync/status", authenticateToken, (req, res) => {
    const { shopDomain } = req.query;
    const session = syncSessions[shopDomain as string];
    if (!session) return res.json({ status: 'idle' });
    const { clients, ...safeSession } = session;
    res.json(safeSession);
  });

  // Sync Status Stream (SSE)
  app.get("/api/sync/stream", (req, res) => {
    const { shopDomain } = req.query;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (!syncSessions[shopDomain as string]) {
      syncSessions[shopDomain as string] = { logs: [], progress: { current: 0, total: 0 }, status: 'idle', message: '', clients: [] };
    }
    
    const session = syncSessions[shopDomain as string];
    const client = { id: Date.now(), res };
    session.clients = [...(session.clients || []), client];

    req.on('close', () => {
      session.clients = session.clients.filter((c: any) => c.id !== client.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
