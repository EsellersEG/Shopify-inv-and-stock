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
      name TEXT NOT NULL DEFAULT 'Unlabeled Store',
      shop_domain TEXT UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      service_account_json TEXT NOT NULL,
      sheet_name TEXT DEFAULT 'Sheet1',
      sku_col TEXT DEFAULT 'SKU',
      price_col TEXT DEFAULT 'Price',
      compare_at_price_col TEXT DEFAULT 'Compare At Price',
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
  
  // Migration: Add name column to master_stores if it doesn't exist
  try {
    await pool.query("ALTER TABLE master_stores ADD COLUMN IF NOT EXISTS name TEXT DEFAULT 'Unlabeled Store'");
  } catch (e) {
    console.error("Migration failed or column already exists:", e);
  }

  // Migration: Add compare_at_price_col column
  try {
    await pool.query("ALTER TABLE master_stores ADD COLUMN IF NOT EXISTS compare_at_price_col TEXT DEFAULT 'Compare At Price'");
  } catch (e) {
    console.error("Migration for compare_at_price_col failed:", e);
  }

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

  app.post("/api/admin/master-stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { name, shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName, skuCol, priceCol, compareAtPriceCol, inventoryCol } = req.body;
    try {
      const id = randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO master_stores (id, name, shop_domain, access_token, spreadsheet_id, service_account_json, sheet_name, sku_col, price_col, compare_at_price_col, inventory_col)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [id, name || "Unlabeled Store", shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName || "Sheet1", skuCol || "SKU", priceCol || "Price", compareAtPriceCol || "Compare At Price", inventoryCol || "Inventory"]
      );
      res.json(rows[0]);
    } catch (e: any) {
      res.status(400).json({ error: "Store domain already exists" });
    }
  });

  // Admin: Update Master Store
  app.put("/api/admin/master-stores/:id", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName, skuCol, priceCol, compareAtPriceCol, inventoryCol } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE master_stores 
         SET name = $1, shop_domain = $2, access_token = $3, spreadsheet_id = $4, service_account_json = $5, sheet_name = $6, sku_col = $7, price_col = $8, compare_at_price_col = $9, inventory_col = $10, updated_at = NOW()
         WHERE id = $11 RETURNING *`,
        [name || "Unlabeled Store", shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName || "Sheet1", skuCol || "SKU", priceCol || "Price", compareAtPriceCol || "Compare At Price", inventoryCol || "Inventory", id]
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

  // Admin: Unassign Store
  app.delete("/api/admin/clients/:clientId/stores/:masterStoreId", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { clientId, masterStoreId } = req.params;
    try {
      await pool.query("DELETE FROM store_assignments WHERE client_id = $1 AND master_store_id = $2", [clientId, masterStoreId]);
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ error: "Unassign failed" });
    }
  });

  // Client: Get My Stores
  app.get("/api/client/stores", authenticateToken, async (req: Request, res: Response) => {
    if (req.user.role === 'admin') {
      const { rows } = await pool.query("SELECT * FROM master_stores ORDER BY created_at DESC");
      return res.json(rows.map(r => ({
        id: r.id,
        name: r.name,
        shopDomain: r.shop_domain,
        accessToken: r.access_token,
        spreadsheetId: r.spreadsheet_id,
        serviceAccountJson: r.service_account_json,
        sheet_name: r.sheet_name,
        sku_col: r.sku_col,
        price_col: r.price_col,
        compare_at_price_col: r.compare_at_price_col,
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
      name: r.name,
      shopDomain: r.shop_domain,
      accessToken: r.access_token,
      spreadsheetId: r.spreadsheet_id,
      serviceAccountJson: r.service_account_json,
      sheet_name: r.sheet_name,
      sku_col: r.sku_col,
      price_col: r.price_col,
      compare_at_price_col: r.compare_at_price_col,
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

  app.post("/api/sync/cancel", authenticateToken, (req, res) => {
    const { shopDomain } = req.body;
    if (syncSessions[shopDomain]) {
      syncSessions[shopDomain].cancelled = true;
      syncSessions[shopDomain].message = "Cancelling process...";
    }
    res.json({ success: true });
  });

  app.post("/api/sync/sheets-to-shopify", authenticateToken, async (req: Request, res: Response) => {
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, mapping, sheetName, syncMode } = req.body;
    if (syncSessions[shopDomain]?.status === "loading") return res.status(400).json({ error: "Sync already running" });

    syncSessions[shopDomain] = { status: "loading", progress: { current: 0, total: 0 }, message: "Starting...", logs: [], clients: syncSessions[shopDomain]?.clients || [], cancelled: false };

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

        const rawHeaders = rows[0] || [];
        const headers = rawHeaders.map((h: any) => String(h || "").trim());
        const skuIndex = headers.indexOf(mapping.sku);
        const priceIndex = headers.indexOf(mapping.price);
        const compareAtPriceIndex = mapping.compareAtPrice ? headers.indexOf(mapping.compareAtPrice) : -1;
        const invIndex = headers.indexOf(mapping.inventory);
        
        console.log(`[SYNC] Headers Found:`, headers);
        console.log(`[SYNC] Indexes: SKU=${skuIndex}, Price=${priceIndex}, CompareAtPrice=${compareAtPriceIndex}, Inv=${invIndex}`);

        if (skuIndex === -1) return await updateSyncSession(shopDomain, { type: "error", message: `SKU column "${mapping.sku}" not found in sheet` });

        const shouldSyncPrice = syncMode === "price" || syncMode === "both";
        const shouldSyncStock = syncMode === "stock" || syncMode === "both";

        let locationId = null;
        if (shouldSyncStock) {
          const locRes = await fetch(`https://${shopDomain}/admin/api/2025-01/locations.json`, { headers: { "X-Shopify-Access-Token": accessToken } });
          const locData = await locRes.json();
          locationId = locData.locations?.[0]?.id;
        }

        const skusArray = Array.from(new Set(rows.slice(1).map((r: any) => r[skuIndex]).filter(Boolean)));
        const shopifyVariants = new Map();
        const logs: string[] = [];

        for (let i = 0; i < skusArray.length; i += 100) {
          if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
          const chunk = skusArray.slice(i, i + 100);
          const queryStr = chunk.map((sku: any) => `sku:"${sku.replace(/"/g, '\\"')}"`).join(" OR ");
          const query = `query getVariants($queryStr: String) { productVariants(first: 100, query: $queryStr) { edges { node { id sku price compareAtPrice product { id } inventoryItem { id inventoryLevels(first: 1) { edges { node { quantities(names: ["available"]) { quantity } } } } } } } } }`;
          const gqlRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
            method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: { queryStr } })
          });
          const data = await gqlRes.json();
          if (data.errors) {
            console.error(`[SYNC] GraphQL Query Errors:`, JSON.stringify(data.errors));
            logs.push(`GraphQL fetch error: ${data.errors[0]?.message || 'Unknown'}`);
          }
          data.data?.productVariants?.edges?.forEach((e: any) => {
            const node = e.node;
            const available = node.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.quantities?.[0]?.quantity || 0;
            shopifyVariants.set(node.sku, { variantId: node.id, productId: node.product?.id, invId: node.inventoryItem?.id, price: node.price, compareAtPrice: node.compareAtPrice, available });
          });
          await updateSyncSession(shopDomain, { type: "progress", current: Math.min(i + 100, skusArray.length), total: skusArray.length, message: `Step 1: Fetching products in sheet...` });
        }

        const updates: any[] = [];
        
        for (let i = 1; i < rows.length; i++) {
          const sku = String(rows[i][skuIndex] || "").trim();
          if (!sku) continue;
          
          const sheetPriceRaw = rows[i][priceIndex];
          const sheetCompareAtPriceRaw = compareAtPriceIndex !== -1 ? rows[i][compareAtPriceIndex] : undefined;
          const sheetInvRaw = rows[i][invIndex];
          
          const shopify = shopifyVariants.get(sku);
          if (!shopify) continue;

          if (shouldSyncPrice) {
            let priceChanged = false;
            let compareAtPriceChanged = false;
            let newPrice = shopify.price;
            let newCompareAtPrice = shopify.compareAtPrice;

            if (sheetPriceRaw !== undefined && sheetPriceRaw !== "") {
              const sheetPrice = parseFloat(String(sheetPriceRaw).replace(/[^\d.-]/g, ""));
              const shopifyPrice = parseFloat(shopify.price || "0");
              if (!isNaN(sheetPrice) && sheetPrice !== shopifyPrice) {
                newPrice = sheetPrice.toString();
                priceChanged = true;
              }
            }

            if (compareAtPriceIndex !== -1) {
              if (sheetCompareAtPriceRaw === undefined || sheetCompareAtPriceRaw === null || String(sheetCompareAtPriceRaw).trim() === "") {
                // Sheet is empty → clear compare-at price on Shopify if it has one
                if (shopify.compareAtPrice && parseFloat(shopify.compareAtPrice) > 0) {
                  newCompareAtPrice = null;
                  compareAtPriceChanged = true;
                }
              } else {
                const sheetCompareAtPrice = parseFloat(String(sheetCompareAtPriceRaw).replace(/[^\d.-]/g, ""));
                const shopifyCompareAtPrice = parseFloat(shopify.compareAtPrice || "0");
                if (!isNaN(sheetCompareAtPrice) && sheetCompareAtPrice !== shopifyCompareAtPrice) {
                  newCompareAtPrice = sheetCompareAtPrice.toString();
                  compareAtPriceChanged = true;
                }
              }
            }

            if (priceChanged || compareAtPriceChanged) {
              updates.push({ type: "price", sku, id: shopify.variantId, productId: shopify.productId, price: newPrice, compareAtPrice: newCompareAtPrice, priceChanged, compareAtPriceChanged });
              console.log(`[SYNC] Price Pending: SKU ${sku} -> price: ${shopify.price} to ${newPrice}, compareAt: ${shopify.compareAtPrice} to ${newCompareAtPrice}`);
            }
          }

          if (shouldSyncStock && sheetInvRaw !== undefined && sheetInvRaw !== "") {
            const sheetInv = parseInt(String(sheetInvRaw).replace(/[^\d-]/g, ""));
            const shopifyInv = shopify.available;
            
            if (!isNaN(sheetInv) && sheetInv !== shopifyInv) {
              updates.push({ type: "inv", sku, id: shopify.invId, value: sheetInv });
              console.log(`[SYNC] Stock Pending: SKU ${sku} -> ${shopifyInv} to ${sheetInv}`);
            }
          }
        }

        if (updates.length === 0) return await updateSyncSession(shopDomain, { type: "complete", updatedCount: 0, errorCount: 0, logs, duration: Date.now() - startTime });

        for (let i = 0; i < updates.length; i += 50) {
          if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
          const batch = updates.slice(i, i + 50);
          const priceBatch = batch.filter((u: any) => u.type === "price");
          const invBatch = batch.filter((u: any) => u.type === "inv");

          if (priceBatch.length > 0) {
            // Group by productId for productVariantsBulkUpdate
            const byProduct: Record<string, any[]> = {};
            priceBatch.forEach((u: any) => {
              if (!byProduct[u.productId]) byProduct[u.productId] = [];
              byProduct[u.productId].push(u);
            });

            const productIds = Object.keys(byProduct);
            let mutation = `mutation {`;
            productIds.forEach((productId, pIdx) => {
              const variants = byProduct[productId];
              const variantInputs = variants.map((u: any) => {
                const fields: string[] = [`id: "${u.id}"`];
                if (u.priceChanged) fields.push(`price: "${u.price}"`);
                if (u.compareAtPriceChanged) {
                  if (u.compareAtPrice === null || u.compareAtPrice === "") {
                    fields.push(`compareAtPrice: null`);
                  } else {
                    fields.push(`compareAtPrice: "${u.compareAtPrice}"`);
                  }
                }
                return `{${fields.join(", ")}}`;
              }).join(", ");
              mutation += ` p${pIdx}: productVariantsBulkUpdate(productId: "${productId}", variants: [${variantInputs}]) { productVariants { id sku price compareAtPrice } userErrors { field message } }`;
            });
            mutation += ` }`;

            console.log(`[SYNC] Price mutation: ${productIds.length} products, ${priceBatch.length} variants`);
            const gqlRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
              method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ query: mutation })
            });
            const result = await gqlRes.json();
            if (result.errors) {
              const msg = `GraphQL Price Error: ${result.errors[0]?.message || JSON.stringify(result.errors)}`;
              console.error(`[SYNC] ${msg}`);
              logs.push(msg);
            }
            Object.keys(result.data || {}).forEach(key => {
              const errors = result.data[key]?.userErrors;
              if (errors?.length > 0) {
                const pIdx = parseInt(key.slice(1));
                const pid = productIds[pIdx];
                const skus = byProduct[pid]?.map((v: any) => v.sku).join(', ');
                const msg = `Price Error (${skus}): ${errors[0].message}`;
                console.error(`[SYNC] ${msg}`);
                logs.push(msg);
              }
            });
          }

          if (invBatch.length > 0) {
            const mutation = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`;
            const variables = { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: invBatch.map((u: any) => ({ inventoryItemId: u.id, locationId: `gid://shopify/Location/${locationId}`, quantity: u.value })) } };
            const invRes = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
              method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ query: mutation, variables })
            });
            const result = await invRes.json();
            if (result.errors) {
              const msg = `GraphQL Inventory Error: ${result.errors[0]?.message || JSON.stringify(result.errors)}`;
              console.error(`[SYNC] ${msg}`);
              logs.push(msg);
            }
            const errors = result.data?.inventorySetQuantities?.userErrors;
            if (errors?.length > 0) {
              const msg = `Inventory Error: ${errors[0].message}`;
              console.error(`[SYNC] ${msg}`);
              logs.push(msg);
            }
          }

          await updateSyncSession(shopDomain, { type: "progress", current: Math.min(i + 50, updates.length), total: updates.length, message: `Step 2: Syncing updates to Shopify...` });
        }

        await updateSyncSession(shopDomain, { type: "complete", updatedCount: updates.length - logs.length, errorCount: logs.length, logs, duration: Date.now() - startTime });
      } catch (err: any) {
        console.error(`[SYNC] Global Error:`, err);
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
