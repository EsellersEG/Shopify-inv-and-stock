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

    CREATE TABLE IF NOT EXISTS filter_rules (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL REFERENCES master_stores(id) ON DELETE CASCADE,
      group_id INT DEFAULT 0,
      field TEXT NOT NULL,
      operator TEXT NOT NULL,
      value TEXT DEFAULT '',
      logical_operator TEXT DEFAULT 'AND',
      order_index INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sync_results (
      id TEXT PRIMARY KEY,
      sync_log_id TEXT NOT NULL REFERENCES sync_logs(id) ON DELETE CASCADE,
      shop_domain TEXT NOT NULL,
      sku TEXT NOT NULL,
      status TEXT NOT NULL,
      action TEXT DEFAULT '',
      message TEXT DEFAULT '',
      row_number INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  // Migration: Add all potentially missing columns to master_stores
  const masterStoresMigrations: [string, string][] = [
    ["name",                 "TEXT NOT NULL DEFAULT 'Unlabeled Store'"],
    ["spreadsheet_id",       "TEXT NOT NULL DEFAULT ''"],
    ["service_account_json", "TEXT NOT NULL DEFAULT ''"],
    ["sheet_name",           "TEXT DEFAULT 'Sheet1'"],
    ["sku_col",              "TEXT DEFAULT 'SKU'"],
    ["price_col",            "TEXT DEFAULT 'Price'"],
    ["compare_at_price_col", "TEXT DEFAULT 'Compare At Price'"],
    ["inventory_col",        "TEXT DEFAULT 'Inventory'"],
    ["field_mappings",       "TEXT DEFAULT '{}'"],
    ["metafield_mappings",   "TEXT DEFAULT '[]'"],
  ];
  for (const [col, def] of masterStoresMigrations) {
    try {
      await pool.query(`ALTER TABLE master_stores ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    } catch (e) {
      console.error(`Migration for ${col} failed:`, e);
    }
  }

  console.log("Database tables ready.");

  // Explicit creation for tables added after initial deployment (separate queries for reliability)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS filter_rules (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES master_stores(id) ON DELETE CASCADE,
        group_id INT DEFAULT 0,
        field TEXT NOT NULL,
        operator TEXT NOT NULL,
        value TEXT DEFAULT '',
        logical_operator TEXT DEFAULT 'AND',
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { console.error("filter_rules create failed:", e); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_results (
        id TEXT PRIMARY KEY,
        sync_log_id TEXT NOT NULL REFERENCES sync_logs(id) ON DELETE CASCADE,
        shop_domain TEXT NOT NULL,
        sku TEXT NOT NULL,
        status TEXT NOT NULL,
        action TEXT DEFAULT '',
        message TEXT DEFAULT '',
        row_number INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { console.error("sync_results create failed:", e); }
}

function evaluateRule(operator: string, fieldValue: string, ruleValue: string): boolean {
  const fieldStr = String(fieldValue ?? "").trim();
  const valueStr = String(ruleValue ?? "").trim();
  switch (operator) {
    case "equals": return fieldStr.toLowerCase() === valueStr.toLowerCase();
    case "not_equals": return fieldStr.toLowerCase() !== valueStr.toLowerCase();
    case "greater_than": { const fn = parseFloat(fieldStr), vn = parseFloat(valueStr); return !isNaN(fn) && !isNaN(vn) && fn > vn; }
    case "less_than": { const fn = parseFloat(fieldStr), vn = parseFloat(valueStr); return !isNaN(fn) && !isNaN(vn) && fn < vn; }
    case "greater_or_equal": { const fn = parseFloat(fieldStr), vn = parseFloat(valueStr); return !isNaN(fn) && !isNaN(vn) && fn >= vn; }
    case "less_or_equal": { const fn = parseFloat(fieldStr), vn = parseFloat(valueStr); return !isNaN(fn) && !isNaN(vn) && fn <= vn; }
    case "contains": return fieldStr.toLowerCase().includes(valueStr.toLowerCase());
    case "not_contains": return !fieldStr.toLowerCase().includes(valueStr.toLowerCase());
    case "contains_any": { const vals = valueStr.split(/[\s,\n]+/).filter((v: string) => v.length > 0); return vals.some((v: string) => fieldStr.toLowerCase() === v.toLowerCase()); }
    case "not_contains_any": { const vals = valueStr.split(/[\s,\n]+/).filter((v: string) => v.length > 0); return !vals.some((v: string) => fieldStr.toLowerCase() === v.toLowerCase()); }
    case "starts_with": return fieldStr.toLowerCase().startsWith(valueStr.toLowerCase());
    case "ends_with": return fieldStr.toLowerCase().endsWith(valueStr.toLowerCase());
    case "is_empty": return !fieldStr || fieldStr.length === 0;
    case "is_not_empty": return !!(fieldStr && fieldStr.length > 0);
    default: return false;
  }
}

function evaluateRules(rules: any[], rowData: Record<string, string>): boolean {
  if (!rules || rules.length === 0) return true;
  let result = true;
  for (let j = 0; j < rules.length; j++) {
    const rule = rules[j];
    const ruleResult = evaluateRule(rule.operator, rowData[rule.field] ?? "", rule.value ?? "");
    if (j === 0) {
      result = ruleResult;
    } else {
      const logic = (rule.logical_operator || "AND").toUpperCase();
      result = logic === "OR" ? result || ruleResult : result && ruleResult;
    }
  }
  return result;
}

// ── Shopify GraphQL helper with rate limiting & retry ──
async function shopifyGraphQL(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: any,
  maxRetries = 5
): Promise<{ data?: any; errors?: any[]; userErrors?: any[] }> {
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(variables ? { query, variables } : { query })
    });

    // Handle HTTP-level errors
    if (!res.ok) {
      const text = await res.text();
      // 429 = rate limited at HTTP level
      if (res.status === 429) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`[RATE LIMIT] HTTP 429, waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      throw new Error(`Shopify API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();

    // Check for GraphQL-level throttle
    const isThrottled = data.errors?.some((e: any) =>
      e.message?.toLowerCase().includes('throttled') ||
      e.extensions?.code === 'THROTTLED'
    );

    if (isThrottled) {
      const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.log(`[RATE LIMIT] Throttled, waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(r => setTimeout(r, waitTime));
      lastError = data.errors;
      continue;
    }

    // Success - add a small delay to pace requests
    await new Promise(r => setTimeout(r, 100));
    return data;
  }

  // Max retries exceeded
  console.error(`[RATE LIMIT] Max retries (${maxRetries}) exceeded`);
  return { errors: lastError || [{ message: 'Max retries exceeded due to rate limiting' }] };
}

// ── Parallel batch processor with controlled concurrency ──
async function parallelBatch<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 4
): Promise<R[]> {
  const results: R[] = [];
  let activeCount = 0;
  let currentIndex = 0;

  return new Promise((resolve, reject) => {
    const runNext = () => {
      while (activeCount < concurrency && currentIndex < items.length) {
        const idx = currentIndex++;
        activeCount++;
        fn(items[idx], idx)
          .then(result => {
            results[idx] = result;
            activeCount--;
            if (currentIndex >= items.length && activeCount === 0) {
              resolve(results);
            } else {
              runNext();
            }
          })
          .catch(reject);
      }
    };
    if (items.length === 0) resolve([]);
    else runNext();
  });
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
    const { rows } = await pool.query("SELECT * FROM master_stores");
    res.json(rows.map(normalizeStore));
  });

  app.post("/api/admin/master-stores", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { name, shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName, skuCol, priceCol, compareAtPriceCol, inventoryCol, fieldMappings, metafieldMappings } = req.body;
    try {
      const id = randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO master_stores (id, name, shop_domain, access_token, spreadsheet_id, service_account_json, sheet_name, sku_col, price_col, compare_at_price_col, inventory_col, field_mappings, metafield_mappings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [id, name || "Unlabeled Store", shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName || "Sheet1", skuCol || "SKU", priceCol || "Price", compareAtPriceCol || "Compare At Price", inventoryCol || "Inventory", JSON.stringify(fieldMappings || {}), JSON.stringify(metafieldMappings || [])]
      );
      res.json(normalizeStore(rows[0]));
    } catch (e: any) {
      res.status(400).json({ error: "Store domain already exists" });
    }
  });

  // Admin: Update Master Store
  app.put("/api/admin/master-stores/:id", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, shopDomain, accessToken, spreadsheetId, serviceAccountJson, sheetName, skuCol, priceCol, compareAtPriceCol, inventoryCol, fieldMappings, metafieldMappings } = req.body;
    try {
      // If serviceAccountJson is blank, keep the existing value in DB
      let finalServiceAccountJson = serviceAccountJson;
      if (!finalServiceAccountJson || String(finalServiceAccountJson).trim() === "") {
        const { rows: existing } = await pool.query("SELECT service_account_json FROM master_stores WHERE id = $1", [id]);
        if (existing.length === 0) return res.status(404).json({ error: "Store not found" });
        finalServiceAccountJson = existing[0].service_account_json;
      }
      const { rows } = await pool.query(
        `UPDATE master_stores 
         SET name = $1, shop_domain = $2, access_token = $3, spreadsheet_id = $4, service_account_json = $5, sheet_name = $6, sku_col = $7, price_col = $8, compare_at_price_col = $9, inventory_col = $10, field_mappings = $11, metafield_mappings = $12, updated_at = NOW()
         WHERE id = $13 RETURNING *`,
        [name || "Unlabeled Store", shopDomain, accessToken, spreadsheetId, finalServiceAccountJson, sheetName || "Sheet1", skuCol || "SKU", priceCol || "Price", compareAtPriceCol || "Compare At Price", inventoryCol || "Inventory", JSON.stringify(fieldMappings || {}), JSON.stringify(metafieldMappings || []), id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Store not found" });
      res.json(normalizeStore(rows[0]));
    } catch (e: any) {
      console.error("Update store error:", e);
      res.status(400).json({ error: e.message || "Store update failed or domain conflict" });
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
  // Helper: normalize master_stores row (handles both camelCase and snake_case DB columns)
  let _storeColumnsLogged = false;
  const normalizeStore = (r: any) => {
    if (!_storeColumnsLogged) {
      console.log("[DB DEBUG] master_stores column keys:", Object.keys(r));
      _storeColumnsLogged = true;
    }
    return {
      id: r.id,
      name: r.name,
      shopDomain: r.shop_domain || r.shopDomain,
      accessToken: r.access_token || r.accessToken,
      spreadsheetId: r.spreadsheet_id || r.spreadsheetId,
      serviceAccountJson: r.service_account_json || r.serviceAccountJson,
      sheet_name: r.sheet_name || r.sheetName,
      sku_col: r.sku_col || r.skuCol,
      price_col: r.price_col || r.priceCol,
      compare_at_price_col: r.compare_at_price_col || r.compareAtPriceCol,
      inventory_col: r.inventory_col || r.inventoryCol,
      field_mappings: r.field_mappings || r.fieldMappings,
      metafield_mappings: r.metafield_mappings || r.metafieldMappings,
      created_at: r.created_at || r.installedAt,
    };
  };

  app.get("/api/client/stores", authenticateToken, async (req: Request, res: Response) => {
    if (req.user.role === 'admin') {
      const { rows } = await pool.query("SELECT * FROM master_stores");
      return res.json(rows.map(normalizeStore));
    }
    const { rows } = await pool.query(
      "SELECT ms.* FROM master_stores ms JOIN store_assignments sa ON sa.master_store_id = ms.id WHERE sa.client_id = $1",
      [req.user.id]
    );
    res.json(rows.map(normalizeStore));
  });

  // Get sheet headers and first row preview for a store
  app.get("/api/stores/:id/sheet-headers", authenticateToken, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const { rows } = await pool.query("SELECT * FROM master_stores WHERE id = $1", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Store not found" });
      const store = normalizeStore(rows[0]);

      const credentials = JSON.parse(store.serviceAccountJson);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
      const sheets = google.sheets({ version: "v4", auth });
      const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: store.spreadsheetId, range: `${store.sheet_name || "Sheet1"}!1:2` });
      const sheetRows = sheetRes.data.values;
      if (!sheetRows || sheetRows.length === 0) return res.json({ headers: [], preview: {} });

      const headers = (sheetRows[0] || []).map((h: any) => String(h || "").trim());
      const firstRow = sheetRows[1] || [];
      const preview: Record<string, string> = {};
      headers.forEach((h: string, i: number) => {
        preview[h] = String(firstRow[i] || "");
      });

      res.json({ headers, preview });
    } catch (e: any) {
      console.error("Failed to fetch sheet headers:", e.message);
      res.status(500).json({ error: "Failed to fetch sheet headers" });
    }
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
        const logId = data.syncLogId || randomUUID();
        await pool.query(
          "INSERT INTO sync_logs (id, shop_domain, status, message, updated_count, error_count, duration, logs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [logId, shopDomain, "success", "Sync completed", data.updatedCount, data.errorCount, data.duration, data.logs || []]
        );
        if (data.syncResults && data.syncResults.length > 0) {
          for (let k = 0; k < data.syncResults.length; k += 100) {
            const batch = data.syncResults.slice(k, k + 100);
            const placeholders = batch.map((_: any, bi: number) => {
              const base = bi * 8;
              return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`;
            }).join(',');
            const values = batch.flatMap((r: any) => [randomUUID(), logId, shopDomain, r.sku, r.status, r.action, r.message || '', r.rowNumber]);
            await pool.query(`INSERT INTO sync_results (id,sync_log_id,shop_domain,sku,status,action,message,row_number) VALUES ${placeholders}`, values);
          }
        }
      } catch (e) { console.error("Failed to save sync log:", e); }
    } else if (data.type === "error") {
      session.status = "error";
      session.message = data.message;
      try {
        await pool.query(
          "INSERT INTO sync_logs (id, shop_domain, status, message, logs) VALUES ($1, $2, $3, $4, $5)",
          [data.syncLogId || randomUUID(), shopDomain, "error", data.message, [data.message]]
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
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, mapping, sheetName, syncMode, fields: syncFields = [] } = req.body;
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

        // Load filter rules for this store
        const syncLogId = randomUUID();
        const syncResultsArr: Array<{sku: string; status: string; action: string; message: string; rowNumber: number}> = [];
        let filterRules: any[] = [];
        let fieldMappings: Record<string, string> = {};
        try {
          const { rows: storeRows } = await pool.query("SELECT id, field_mappings FROM master_stores WHERE shop_domain = $1", [shopDomain]);
          const storeRow = storeRows[0];
          const storeId = storeRow?.id;
          if (storeId) {
            const { rows: ruleRows } = await pool.query("SELECT * FROM filter_rules WHERE shop_id = $1 ORDER BY order_index ASC", [storeId]);
            filterRules = ruleRows;
            if (filterRules.length > 0) console.log(`[SYNC] Loaded ${filterRules.length} filter rules`);
          }
          if (storeRow?.field_mappings) {
            try { fieldMappings = JSON.parse(storeRow.field_mappings); } catch {}
          }
        } catch (e) { console.error("[SYNC] Failed to load store config:", e); }

        const shouldSyncPrice  = syncMode === "price" || syncMode === "both" || syncMode === "all" || syncMode === "all-no-images" || (syncFields as string[]).includes("price");
        const shouldSyncStock  = syncMode === "stock" || syncMode === "both" || syncMode === "all" || syncMode === "all-no-images" || (syncFields as string[]).includes("stock");
        const shouldSyncTags   = syncMode === "all" || syncMode === "all-no-images" || (syncFields as string[]).includes("tags");
        const shouldSyncStatus = syncMode === "all" || syncMode === "all-no-images" || (syncFields as string[]).includes("status");
        const shouldSyncImages = syncMode === "all" || (syncFields as string[]).includes("images");

        // Product-level field column indexes (from stored field_mappings)
        const tagsColIdx     = (shouldSyncTags   && fieldMappings.tags)                                               ? headers.indexOf(fieldMappings.tags)                                        : -1;
        const statusColIdx   = (shouldSyncStatus && (fieldMappings.status || fieldMappings.published))                 ? headers.indexOf((fieldMappings.status || fieldMappings.published) as string): -1;
        const imageSrcColIdx = (shouldSyncImages && fieldMappings.image_src)                                           ? headers.indexOf(fieldMappings.image_src)                                    : -1;
        if (shouldSyncTags || shouldSyncStatus || shouldSyncImages) console.log(`[SYNC] Product field indexes: tags=${tagsColIdx}, status=${statusColIdx}, imageSrc=${imageSrcColIdx}`);

        let locationId = null;
        if (shouldSyncStock) {
          const locRes = await fetch(`https://${shopDomain}/admin/api/2025-01/locations.json`, { headers: { "X-Shopify-Access-Token": accessToken } });
          const locData = await locRes.json();
          locationId = locData.locations?.[0]?.id;
        }

        const skusArray = Array.from(new Set(rows.slice(1).map((r: any) => r[skuIndex]).filter(Boolean)));
        const shopifyVariants = new Map();
        const logs: string[] = [];

        // ── Step 1: Parallel SKU lookups (4 concurrent batches) ──
        const skuBatches: string[][] = [];
        for (let i = 0; i < skusArray.length; i += 100) {
          skuBatches.push(skusArray.slice(i, i + 100) as string[]);
        }
        
        console.log(`[SYNC] Fetching ${skusArray.length} SKUs in ${skuBatches.length} batches (4 parallel)`);
        let fetchedCount = 0;
        
        await parallelBatch(skuBatches, async (chunk, batchIdx) => {
          if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
          
          const searchQuery = chunk.map((sku: any) => `sku:${JSON.stringify(String(sku))}`).join(" OR ");
          const gqlQuery = `query ($q: String!) { productVariants(first: 100, query: $q) { edges { node { id sku price compareAtPrice product { id } inventoryItem { id inventoryLevels(first: 1) { edges { node { quantities(names: ["available"]) { quantity } } } } } } } } }`;
          const data = await shopifyGraphQL(shopDomain, accessToken, gqlQuery, { q: searchQuery });
          
          if (data.errors) {
            const errMsg = Array.isArray(data.errors) ? (data.errors[0]?.message || JSON.stringify(data.errors)) : JSON.stringify(data.errors);
            console.error(`[SYNC] GraphQL Query Errors (batch ${batchIdx}):`, JSON.stringify(data.errors));
            logs.push(`GraphQL error: ${errMsg}`);
          }
          
          data.data?.productVariants?.edges?.forEach((e: any) => {
            const node = e.node;
            const available = node.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.quantities?.[0]?.quantity || 0;
            shopifyVariants.set(node.sku, { variantId: node.id, productId: node.product?.id, invId: node.inventoryItem?.id, price: node.price, compareAtPrice: node.compareAtPrice, available });
          });
          
          fetchedCount += chunk.length;
          await updateSyncSession(shopDomain, { type: "progress", current: Math.min(fetchedCount, skusArray.length), total: skusArray.length, message: `Step 1: Fetching products (${Math.round(fetchedCount / skusArray.length * 100)}%)...` });
        }, 4);

        // ── Extract ALL field mapping column indexes ──
        const titleColIdx = fieldMappings.title ? headers.indexOf(fieldMappings.title) : -1;
        const descColIdx = fieldMappings.description ? headers.indexOf(fieldMappings.description) : (fieldMappings.body_html ? headers.indexOf(fieldMappings.body_html) : -1);
        const vendorColIdx = fieldMappings.vendor ? headers.indexOf(fieldMappings.vendor) : -1;
        const productTypeColIdx = fieldMappings.product_type ? headers.indexOf(fieldMappings.product_type) : -1;
        const handleColIdx = fieldMappings.handle ? headers.indexOf(fieldMappings.handle) : -1;
        const barcodeColIdx = fieldMappings.variant_barcode ? headers.indexOf(fieldMappings.variant_barcode) : -1;
        const weightColIdx = fieldMappings.variant_grams ? headers.indexOf(fieldMappings.variant_grams) : -1;
        const weightUnitColIdx = fieldMappings.variant_weight_unit ? headers.indexOf(fieldMappings.variant_weight_unit) : -1;
        const taxableColIdx = fieldMappings.variant_taxable ? headers.indexOf(fieldMappings.variant_taxable) : -1;
        const requiresShippingColIdx = fieldMappings.variant_requires_shipping ? headers.indexOf(fieldMappings.variant_requires_shipping) : -1;
        const option1NameColIdx = fieldMappings.option1_name ? headers.indexOf(fieldMappings.option1_name) : -1;
        const option1ValueColIdx = fieldMappings.option1_value ? headers.indexOf(fieldMappings.option1_value) : -1;
        const option2NameColIdx = fieldMappings.option2_name ? headers.indexOf(fieldMappings.option2_name) : -1;
        const option2ValueColIdx = fieldMappings.option2_value ? headers.indexOf(fieldMappings.option2_value) : -1;
        const option3NameColIdx = fieldMappings.option3_name ? headers.indexOf(fieldMappings.option3_name) : -1;
        const option3ValueColIdx = fieldMappings.option3_value ? headers.indexOf(fieldMappings.option3_value) : -1;
        const variantImageColIdx = fieldMappings.variant_image ? headers.indexOf(fieldMappings.variant_image) : -1;
        
        // Product creation only in "Sync All" mode with title mapping
        const canCreateProducts = syncMode === "all" && titleColIdx !== -1;
        
        if (canCreateProducts) {
          console.log(`[SYNC] Product creation enabled - syncMode=all and title column found at index ${titleColIdx}`);
          console.log(`[SYNC] Field mappings: title=${titleColIdx}, desc=${descColIdx}, vendor=${vendorColIdx}, type=${productTypeColIdx}, handle=${handleColIdx}, barcode=${barcodeColIdx}, weight=${weightColIdx}, tags=${tagsColIdx}, status=${statusColIdx}, image=${imageSrcColIdx}`);
        }

        const updates: any[] = [];
        const productUpdates: Record<string, { tags?: string[]; status?: string; imageSrc?: string }> = {};
        
        for (let i = 1; i < rows.length; i++) {
          const sku = String(rows[i][skuIndex] || "").trim();
          if (!sku) continue;

          // Apply filter rules
          if (filterRules.length > 0) {
            const rowData: Record<string, string> = {};
            headers.forEach((h: string, idx: number) => { rowData[h] = String(rows[i][idx] || "").trim(); });
            if (!evaluateRules(filterRules, rowData)) {
              syncResultsArr.push({ sku, status: "filtered", action: "excluded_by_rule", message: "Row excluded by filter rule", rowNumber: i });
              continue;
            }
          }
          
          const sheetPriceRaw = rows[i][priceIndex];
          const sheetCompareAtPriceRaw = compareAtPriceIndex !== -1 ? rows[i][compareAtPriceIndex] : undefined;
          const sheetInvRaw = rows[i][invIndex];
          
          const shopify = shopifyVariants.get(sku);
          if (!shopify) {
            // Product not found - queue for creation if we have title mapping
            if (canCreateProducts) {
              const title = String(rows[i][titleColIdx] ?? "").trim();
              if (title) {
                // Extract ALL mapped fields from this row
                const price = sheetPriceRaw ? parseFloat(String(sheetPriceRaw).replace(/[^\d.-]/g, "")) : 0;
                const compareAtPrice = sheetCompareAtPriceRaw ? parseFloat(String(sheetCompareAtPriceRaw).replace(/[^\d.-]/g, "")) : null;
                const inventory = sheetInvRaw ? parseInt(String(sheetInvRaw).replace(/[^\d-]/g, "")) : 0;
                const description = descColIdx !== -1 ? String(rows[i][descColIdx] ?? "").trim() : "";
                const vendor = vendorColIdx !== -1 ? String(rows[i][vendorColIdx] ?? "").trim() : "";
                const productType = productTypeColIdx !== -1 ? String(rows[i][productTypeColIdx] ?? "").trim() : "";
                const handle = handleColIdx !== -1 ? String(rows[i][handleColIdx] ?? "").trim() : "";
                const tags = tagsColIdx !== -1 ? String(rows[i][tagsColIdx] ?? "").trim().split(",").map(t => t.trim()).filter(Boolean) : [];
                const status = statusColIdx !== -1 ? String(rows[i][statusColIdx] ?? "").trim().toUpperCase() : "DRAFT";
                const imageSrc = imageSrcColIdx !== -1 ? String(rows[i][imageSrcColIdx] ?? "").trim() : "";
                const variantImage = variantImageColIdx !== -1 ? String(rows[i][variantImageColIdx] ?? "").trim() : "";
                const barcode = barcodeColIdx !== -1 ? String(rows[i][barcodeColIdx] ?? "").trim() : "";
                const weightRaw = weightColIdx !== -1 ? String(rows[i][weightColIdx] ?? "").trim() : "";
                const weight = weightRaw ? parseFloat(weightRaw.replace(/[^\d.-]/g, "")) : null;
                const weightUnit = weightUnitColIdx !== -1 ? String(rows[i][weightUnitColIdx] ?? "").trim().toUpperCase() : "GRAMS";
                const taxableRaw = taxableColIdx !== -1 ? String(rows[i][taxableColIdx] ?? "").trim().toLowerCase() : "";
                const taxable = taxableRaw === "true" || taxableRaw === "yes" || taxableRaw === "1";
                const requiresShippingRaw = requiresShippingColIdx !== -1 ? String(rows[i][requiresShippingColIdx] ?? "").trim().toLowerCase() : "";
                const requiresShipping = requiresShippingRaw !== "false" && requiresShippingRaw !== "no" && requiresShippingRaw !== "0";
                const option1Name = option1NameColIdx !== -1 ? String(rows[i][option1NameColIdx] ?? "").trim() : "";
                const option1Value = option1ValueColIdx !== -1 ? String(rows[i][option1ValueColIdx] ?? "").trim() : "";
                const option2Name = option2NameColIdx !== -1 ? String(rows[i][option2NameColIdx] ?? "").trim() : "";
                const option2Value = option2ValueColIdx !== -1 ? String(rows[i][option2ValueColIdx] ?? "").trim() : "";
                const option3Name = option3NameColIdx !== -1 ? String(rows[i][option3NameColIdx] ?? "").trim() : "";
                const option3Value = option3ValueColIdx !== -1 ? String(rows[i][option3ValueColIdx] ?? "").trim() : "";
                
                updates.push({
                  type: "create",
                  sku,
                  title,
                  description,
                  vendor,
                  productType,
                  handle,
                  tags,
                  status: ["ACTIVE", "DRAFT", "ARCHIVED"].includes(status) ? status : "DRAFT",
                  price: isNaN(price) ? 0 : price,
                  compareAtPrice: compareAtPrice && !isNaN(compareAtPrice) ? compareAtPrice : null,
                  inventory: isNaN(inventory) ? 0 : inventory,
                  imageSrc,
                  variantImage,
                  barcode,
                  weight: weight && !isNaN(weight) ? weight : null,
                  weightUnit: ["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"].includes(weightUnit) ? weightUnit : "GRAMS",
                  taxable,
                  requiresShipping,
                  option1Name,
                  option1Value,
                  option2Name,
                  option2Value,
                  option3Name,
                  option3Value,
                  rowNumber: i
                });
                console.log(`[SYNC] Create Pending: SKU ${sku} -> "${title}" (barcode: ${barcode || "none"}, vendor: ${vendor || "none"})`);
              } else {
                syncResultsArr.push({ sku, status: "not_found", action: "missing_title", message: "SKU not in Shopify and title is empty", rowNumber: i });
              }
            } else {
              syncResultsArr.push({ sku, status: "not_found", action: "no_shopify_match", message: "SKU not found in Shopify (no title column mapped for creation)", rowNumber: i });
            }
            continue;
          }

          // Collect product-level updates
          if (shopify.productId) {
            if (tagsColIdx !== -1) {
              const raw = String(rows[i][tagsColIdx] ?? "").trim();
              if (raw) {
                productUpdates[shopify.productId] = productUpdates[shopify.productId] || {};
                productUpdates[shopify.productId].tags = raw.split(",").map((t: string) => t.trim()).filter(Boolean);
              }
            }
            if (statusColIdx !== -1) {
              const rawStatus = String(rows[i][statusColIdx] ?? "").trim().toUpperCase();
              if (rawStatus && ["ACTIVE", "DRAFT", "ARCHIVED"].includes(rawStatus)) {
                productUpdates[shopify.productId] = productUpdates[shopify.productId] || {};
                productUpdates[shopify.productId].status = rawStatus;
              }
            }
            if (imageSrcColIdx !== -1) {
              const raw = String(rows[i][imageSrcColIdx] ?? "").trim();
              if (raw) {
                productUpdates[shopify.productId] = productUpdates[shopify.productId] || {};
                productUpdates[shopify.productId].imageSrc = raw;
              }
            }
          }

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

        // Track all SKUs queued for update
        const updatedSkus = new Set<string>(updates.filter((u: any) => u.type !== "create").map((u: any) => u.sku));
        updatedSkus.forEach(sku => {
          syncResultsArr.push({ sku, status: "updated", action: "sync_applied", message: "", rowNumber: 0 });
        });

        // ── Step 2a: Create new products (if any) ──
        const createBatch = updates.filter((u: any) => u.type === "create");
        let createdCount = 0;
        if (createBatch.length > 0) {
          console.log(`[SYNC] Creating ${createBatch.length} new products...`);
          await updateSyncSession(shopDomain, { type: "progress", current: 0, total: createBatch.length, message: `Step 2a: Creating ${createBatch.length} new products...` });
          
          // Process creates in parallel (2 concurrent to be safe with product creation)
          await parallelBatch(createBatch, async (item: any, idx: number) => {
            if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
            
            // Build product input with ALL mapped fields
            const productInput: any = {
              title: item.title,
              descriptionHtml: item.description || "",
              vendor: item.vendor || "",
              productType: item.productType || "",
              tags: item.tags || [],
              status: item.status || "DRAFT",
            };
            
            // Add handle if provided
            if (item.handle) {
              productInput.handle = item.handle;
            }
            
            // Add product options if provided (creates variant options)
            const productOptions: any[] = [];
            if (item.option1Name && item.option1Value) {
              productOptions.push({ name: item.option1Name, values: [{ name: item.option1Value }] });
            }
            if (item.option2Name && item.option2Value) {
              productOptions.push({ name: item.option2Name, values: [{ name: item.option2Value }] });
            }
            if (item.option3Name && item.option3Value) {
              productOptions.push({ name: item.option3Name, values: [{ name: item.option3Value }] });
            }
            if (productOptions.length > 0) {
              productInput.productOptions = productOptions;
            }
            
            // Step 1: Create product
            const createMutation = `mutation productCreate($input: ProductInput!) {
              productCreate(input: $input) {
                product {
                  id
                  variants(first: 1) {
                    edges {
                      node {
                        id
                        inventoryItem { id }
                      }
                    }
                  }
                }
                userErrors { field message }
              }
            }`;
            
            const result = await shopifyGraphQL(shopDomain, accessToken, createMutation, { input: productInput });
            
            if (result.errors) {
              const msg = `Create Error (${item.sku}): ${result.errors[0]?.message || JSON.stringify(result.errors)}`;
              console.error(`[SYNC] ${msg}`);
              logs.push(msg);
              syncResultsArr.push({ sku: item.sku, status: "error", action: "create_failed", message: result.errors[0]?.message || "Unknown error", rowNumber: item.rowNumber });
              return;
            }
            
            const userErrors = result.data?.productCreate?.userErrors;
            if (userErrors?.length > 0) {
              const msg = `Create Error (${item.sku}): ${userErrors[0].message}`;
              console.error(`[SYNC] ${msg}`);
              logs.push(msg);
              syncResultsArr.push({ sku: item.sku, status: "error", action: "create_failed", message: userErrors[0].message, rowNumber: item.rowNumber });
              return;
            }
            
            const newProduct = result.data?.productCreate?.product;
            if (newProduct) {
              const variantNode = newProduct.variants?.edges?.[0]?.node;
              const variantId = variantNode?.id;
              const invItemId = variantNode?.inventoryItem?.id;
              let variantUpdateOk = true;
              let invUpdateOk = true;
              
              // Step 2a: Update the default variant with price, compareAtPrice, barcode, taxable, requiresShipping
              if (variantId) {
                const variantInput: any = {
                  id: variantId,
                  price: String(item.price || 0),
                };
                if (item.compareAtPrice) variantInput.compareAtPrice = String(item.compareAtPrice);
                if (item.barcode) variantInput.barcode = item.barcode;
                if (item.taxable !== undefined) variantInput.taxable = item.taxable;
                // Note: requiresShipping is set via inventoryItem.requiresShipping in newer API
                
                const variantMutation = `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                    productVariants { id sku barcode }
                    userErrors { field message }
                  }
                }`;
                const variantResult = await shopifyGraphQL(shopDomain, accessToken, variantMutation, { productId: newProduct.id, variants: [variantInput] });
                if (variantResult.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
                  const errMsg = variantResult.data.productVariantsBulkUpdate.userErrors[0].message;
                  console.error(`[SYNC] Variant update error for ${item.sku}:`, errMsg);
                  logs.push(`Variant update failed for ${item.sku}: ${errMsg}`);
                  variantUpdateOk = false;
                } else {
                  console.log(`[SYNC] Variant updated: ${item.sku} (price: ${item.price}, barcode: ${item.barcode || "none"})`);
                }
              }
              
              // Step 2b: Update inventory item with SKU, weight, requiresShipping
              if (invItemId) {
                const invItemInput: any = {};
                if (item.sku) invItemInput.sku = item.sku;
                if (item.weight !== null && item.weight !== undefined) {
                  invItemInput.measurement = {
                    weight: {
                      value: item.weight,
                      unit: item.weightUnit || "GRAMS"
                    }
                  };
                }
                if (item.requiresShipping !== undefined) {
                  invItemInput.requiresShipping = item.requiresShipping;
                }
                
                if (Object.keys(invItemInput).length > 0) {
                  const invItemMutation = `mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
                    inventoryItemUpdate(id: $id, input: $input) {
                      inventoryItem { id sku }
                      userErrors { field message }
                    }
                  }`;
                  const invItemResult = await shopifyGraphQL(shopDomain, accessToken, invItemMutation, { id: invItemId, input: invItemInput });
                  if (invItemResult.data?.inventoryItemUpdate?.userErrors?.length > 0) {
                    const errMsg = invItemResult.data.inventoryItemUpdate.userErrors[0].message;
                    console.error(`[SYNC] Inventory item update error for ${item.sku}:`, errMsg);
                    logs.push(`Inventory item update failed for ${item.sku}: ${errMsg}`);
                    invUpdateOk = false;
                  } else {
                    console.log(`[SYNC] Inventory item updated: ${item.sku} (weight: ${item.weight || "none"})`);
                  }
                }
              }
              
              createdCount++;
              const statusMsg = (!variantUpdateOk || !invUpdateOk) ? "Product created with partial errors" : "Product created in Shopify";
              syncResultsArr.push({ sku: item.sku, status: "updated", action: "created", message: statusMsg, rowNumber: item.rowNumber });
              console.log(`[SYNC] Created: ${item.sku} -> ${newProduct.id}`);
              
              // Step 3: Set inventory if we have a location and inventory value
              if (locationId && item.inventory > 0 && invItemId) {
                const invMutation = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`;
                const invVars = { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: [{ inventoryItemId: invItemId, locationId: `gid://shopify/Location/${locationId}`, quantity: item.inventory }] } };
                await shopifyGraphQL(shopDomain, accessToken, invMutation, invVars);
                console.log(`[SYNC] Inventory set: ${item.sku} -> ${item.inventory}`);
              }
              
              // Step 4: Add product image if provided
              if (item.imageSrc) {
                const safeSrc = item.imageSrc.replace(/"/g, '\\"');
                const imgMutation = `mutation { productCreateMedia(productId: "${newProduct.id}", media: [{ mediaContentType: IMAGE, originalSource: "${safeSrc}" }]) { mediaUserErrors { message } } }`;
                const imgResult = await shopifyGraphQL(shopDomain, accessToken, imgMutation);
                if (imgResult.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
                  console.error(`[SYNC] Image error for ${item.sku}:`, imgResult.data.productCreateMedia.mediaUserErrors[0].message);
                } else {
                  console.log(`[SYNC] Image added: ${item.sku}`);
                }
              }
              
              // Step 5: Add variant image if different from product image
              if (item.variantImage && item.variantImage !== item.imageSrc) {
                const safeSrc = item.variantImage.replace(/"/g, '\\"');
                const imgMutation = `mutation { productCreateMedia(productId: "${newProduct.id}", media: [{ mediaContentType: IMAGE, originalSource: "${safeSrc}" }]) { mediaUserErrors { message } } }`;
                await shopifyGraphQL(shopDomain, accessToken, imgMutation);
              }
            }
            
            await updateSyncSession(shopDomain, { type: "progress", current: idx + 1, total: createBatch.length, message: `Step 2a: Creating products (${idx + 1}/${createBatch.length})...` });
          }, 2);
          
          console.log(`[SYNC] Created ${createdCount} products`);
        }

        // Filter out create operations for remaining processing
        const nonCreateUpdates = updates.filter((u: any) => u.type !== "create");

        if (nonCreateUpdates.length === 0 && Object.keys(productUpdates).length === 0) return await updateSyncSession(shopDomain, { type: "complete", updatedCount: createdCount, errorCount: logs.length, logs, duration: Date.now() - startTime, syncLogId, syncResults: syncResultsArr });

        for (let i = 0; i < nonCreateUpdates.length; i += 50) {
          if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
          const batch = nonCreateUpdates.slice(i, i + 50);
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
            const result = await shopifyGraphQL(shopDomain, accessToken, mutation);
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
            const result = await shopifyGraphQL(shopDomain, accessToken, mutation, variables);
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

        // ── Step 3: Product-level updates (tags, status, images) ──
        const productUpdateEntries = Object.entries(productUpdates);
        let productUpdateCount = 0;
        for (let pi = 0; pi < productUpdateEntries.length; pi += 25) {
          if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
          const chunk = productUpdateEntries.slice(pi, pi + 25);

          // Tags + status via productUpdate
          const tagsStatusChunk = chunk.filter(([, upd]) => upd.tags !== undefined || upd.status);
          if (tagsStatusChunk.length > 0) {
            let mutation = "mutation {";
            tagsStatusChunk.forEach(([productId, upd], idx) => {
              const inputParts: string[] = [`id: "${productId}"`];
              if (upd.tags !== undefined) inputParts.push(`tags: ${JSON.stringify(upd.tags)}`);
              if (upd.status) inputParts.push(`status: ${upd.status}`);
              mutation += ` p${idx}: productUpdate(input: { ${inputParts.join(", ")} }) { product { id } userErrors { message } }`;
            });
            mutation += " }";
            const result = await shopifyGraphQL(shopDomain, accessToken, mutation);
            if (result.errors) logs.push(`Product Update Error: ${result.errors[0]?.message || JSON.stringify(result.errors)}`);
            Object.keys(result.data || {}).forEach(key => {
              const errs = result.data[key]?.userErrors;
              if (errs?.length > 0) { logs.push(`Product Field Error: ${errs[0].message}`); } else productUpdateCount++;
            });
          }

          // Images via productCreateMedia
          for (const [productId, upd] of chunk) {
            if (!upd.imageSrc) continue;
            const safeSrc = upd.imageSrc.replace(/"/g, '\\"');
            const imgMutation = `mutation { productCreateMedia(productId: "${productId}", media: [{ mediaContentType: IMAGE, originalSource: "${safeSrc}" }]) { mediaUserErrors { message } } }`;
            const imgResult = await shopifyGraphQL(shopDomain, accessToken, imgMutation);
            const imgErrs = imgResult.data?.productCreateMedia?.mediaUserErrors;
            if (imgErrs?.length > 0) { logs.push(`Image Error: ${imgErrs[0].message}`); } else productUpdateCount++;
          }

          await updateSyncSession(shopDomain, { type: "progress", current: Math.min(pi + 25, productUpdateEntries.length), total: productUpdateEntries.length, message: "Step 3: Updating product fields (tags/status/images)..." });
        }

        const totalUpdated = createdCount + (nonCreateUpdates.length - logs.filter(l => !l.includes("Create Error")).length) + productUpdateCount;
        await updateSyncSession(shopDomain, { type: "complete", updatedCount: totalUpdated, errorCount: logs.length, logs, duration: Date.now() - startTime, syncLogId, syncResults: syncResultsArr });
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

  // ── Filter Rules CRUD ──────────────────────────────────────────────
  app.get("/api/stores/:id/rules", authenticateToken, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const { rows } = await pool.query(
        "SELECT * FROM filter_rules WHERE shop_id = $1 ORDER BY order_index ASC",
        [id]
      );
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch rules" });
    }
  });

  app.post("/api/stores/:id/rules", authenticateToken, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { rules } = req.body;
    try {
      await pool.query("DELETE FROM filter_rules WHERE shop_id = $1", [id]);
      if (rules && rules.length > 0) {
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          await pool.query(
            "INSERT INTO filter_rules (id, shop_id, group_id, field, operator, value, logical_operator, order_index, is_active, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            [randomUUID(), id, r.groupId || 0, r.field, r.operator, r.value || '', r.logicalOperator || 'AND', i, true, new Date()]
          );
        }
      }
      res.json({ success: true, saved: rules?.length || 0 });
    } catch (e: any) {
      console.error("Failed to save rules:", e);
      res.status(500).json({ error: "Failed to save rules" });
    }
  });

  // Rules Preview – count rows that would pass the given rules against the sheet
  app.post("/api/stores/:id/rules/preview", authenticateToken, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { rules } = req.body;
    try {
      const { rows: storeRows } = await pool.query("SELECT * FROM master_stores WHERE id = $1", [id]);
      if (storeRows.length === 0) return res.status(404).json({ error: "Store not found" });
      const store = normalizeStore(storeRows[0]);
      const credentials = JSON.parse(store.serviceAccountJson);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
      const sheets = google.sheets({ version: "v4", auth });
      const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: store.spreadsheetId, range: store.sheet_name || "Sheet1" });
      const sheetRows = sheetRes.data.values;
      if (!sheetRows || sheetRows.length < 2) return res.json({ total: 0, passing: 0 });
      const headers = (sheetRows[0] || []).map((h: any) => String(h || "").trim());
      const total = sheetRows.length - 1;
      let passing = 0;
      for (let i = 1; i < sheetRows.length; i++) {
        const rowData: Record<string, string> = {};
        headers.forEach((h: string, idx: number) => { rowData[h] = String(sheetRows[i][idx] || "").trim(); });
        if (evaluateRules(rules || [], rowData)) passing++;
      }
      res.json({ total, passing });
    } catch (e: any) {
      console.error("Rules preview error:", e.message);
      res.status(500).json({ error: "Failed to preview rules" });
    }
  });

  // ── Sync History & Validation ────────────────────────────────────────
  app.get("/api/sync/history", authenticateToken, async (req: Request, res: Response) => {
    try {
      let shopDomains: string[] = [];
      if (req.user.role === 'admin') {
        const { rows } = await pool.query("SELECT * FROM master_stores");
        shopDomains = rows.map((r: any) => r.shop_domain || r.shopDomain);
      } else {
        const { rows } = await pool.query(
          "SELECT ms.* FROM master_stores ms JOIN store_assignments sa ON sa.master_store_id = ms.id WHERE sa.client_id = $1",
          [req.user.id]
        );
        shopDomains = rows.map((r: any) => r.shop_domain || r.shopDomain);
      }
      if (shopDomains.length === 0) return res.json([]);
      const placeholders = shopDomains.map((_: any, i: number) => `$${i + 1}`).join(',');
      const { rows: logs } = await pool.query(
        `SELECT * FROM sync_logs WHERE shop_domain IN (${placeholders}) ORDER BY created_at DESC LIMIT 200`,
        shopDomains
      );
      res.json(logs);
    } catch (e: any) {
      console.error("Sync history error:", e);
      res.status(500).json({ error: "Failed to fetch sync history" });
    }
  });

  // Must come before /:logId/results to avoid route conflict
  app.get("/api/sync/history/export.csv", authenticateToken, async (req: Request, res: Response) => {
    const { logId } = req.query;
    if (!logId) return res.status(400).json({ error: "logId required" });
    try {
      const { rows } = await pool.query(
        "SELECT * FROM sync_results WHERE sync_log_id = $1 ORDER BY row_number ASC",
        [logId]
      );
      const header = "sku,status,action,message,row_number,created_at";
      const body = rows.map((r: any) =>
        `"${r.sku}","${r.status}","${r.action}","${(r.message || '').replace(/"/g, '""')}",${r.row_number},"${r.created_at}"`
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sync-results-${logId}.csv"`);
      res.send(header + '\n' + body);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to export CSV" });
    }
  });

  app.get("/api/sync/history/:logId/results", authenticateToken, async (req: Request, res: Response) => {
    const { logId } = req.params;
    try {
      const { rows } = await pool.query(
        "SELECT * FROM sync_results WHERE sync_log_id = $1 ORDER BY row_number ASC",
        [logId]
      );
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch sync results" });
    }
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
