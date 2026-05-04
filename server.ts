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
      sheet_name TEXT DEFAULT 'Template',
      sku_col TEXT DEFAULT 'Variant SKU',
      price_col TEXT DEFAULT 'Variant Price',
      compare_at_price_col TEXT DEFAULT 'Variant Compare At Price',
      inventory_col TEXT DEFAULT 'Variant Inventory Qty',
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
    ["sheet_name",           "TEXT DEFAULT 'Template'"],
    ["sku_col",              "TEXT DEFAULT 'Variant SKU'"],
    ["price_col",            "TEXT DEFAULT 'Variant Price'"],
    ["compare_at_price_col", "TEXT DEFAULT 'Variant Compare At Price'"],
    ["inventory_col",        "TEXT DEFAULT 'Variant Inventory Qty'"],
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

  // Backfill legacy default values for existing stores
  try {
    await pool.query(`UPDATE master_stores SET sheet_name = 'Template' WHERE sheet_name = 'Sheet1'`);
    await pool.query(`UPDATE master_stores SET sku_col = 'Variant SKU' WHERE sku_col = 'SKU'`);
    await pool.query(`UPDATE master_stores SET price_col = 'Variant Price' WHERE price_col = 'Price'`);
    await pool.query(`UPDATE master_stores SET compare_at_price_col = 'Variant Compare At Price' WHERE compare_at_price_col = 'Compare At Price'`);
    await pool.query(`UPDATE master_stores SET inventory_col = 'Variant Inventory Qty' WHERE inventory_col = 'Inventory'`);
    console.log("Legacy default values backfilled.");
  } catch (e) {
    console.error("Backfill failed (non-fatal):", e);
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

  // Add missing columns to filter_rules
  try { await pool.query("ALTER TABLE filter_rules ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE"); } catch {}
  try { await pool.query("ALTER TABLE filter_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"); } catch {}

  // Add missing columns to sync_logs for richer tracking
  try { await pool.query("ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS sync_mode TEXT DEFAULT 'all'"); } catch {}
  try { await pool.query("ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS total_count INT DEFAULT 0"); } catch {}
  try { await pool.query("ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS created_count INT DEFAULT 0"); } catch {}
  try { await pool.query("ALTER TABLE sync_logs ADD COLUMN IF NOT EXISTS skipped_count INT DEFAULT 0"); } catch {}

  // Add missing columns to sync_results for product details
  try { await pool.query("ALTER TABLE sync_results ADD COLUMN IF NOT EXISTS product_title TEXT DEFAULT ''"); } catch {}
  try { await pool.query("ALTER TABLE sync_results ADD COLUMN IF NOT EXISTS shopify_product_id TEXT DEFAULT ''"); } catch {}
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

// ── Convert Google Drive / Dropbox share links to direct download URLs ──
function convertToDirectUrl(url: string): string {
  url = url.trim();
  // Google Drive: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  const driveMatch = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (driveMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  }
  // Google Drive: https://drive.google.com/open?id=FILE_ID
  const driveMatch2 = url.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (driveMatch2) {
    return `https://drive.google.com/uc?export=download&id=${driveMatch2[1]}`;
  }
  // Dropbox: change dl=0 to dl=1
  if (url.includes("dropbox.com")) {
    return url.replace("dl=0", "dl=1");
  }
  return url;
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

    // Success - add delay to pace requests (300ms for heavy mutations)
    await new Promise(r => setTimeout(r, 300));
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

// ── Fast GraphQL helper for turbo batch (no pacing delay, rate limit retries only) ──
async function shopifyGraphQLFast(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: any,
  maxRetries = 8
): Promise<{ data?: any; errors?: any[]; userErrors?: any[] }> {
  let lastError: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(variables ? { query, variables } : { query })
    });
    if (!res.ok) {
      if (res.status === 429) {
        const waitTime = Math.min(500 * Math.pow(2, attempt), 15000);
        console.log(`[TURBO RATE] HTTP 429, waiting ${waitTime}ms (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      const text = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const isThrottled = data.errors?.some((e: any) =>
      e.message?.toLowerCase().includes('throttled') || e.extensions?.code === 'THROTTLED'
    );
    if (isThrottled) {
      const waitTime = Math.min(500 * Math.pow(2, attempt), 15000);
      console.log(`[TURBO RATE] Throttled, waiting ${waitTime}ms (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, waitTime));
      lastError = data.errors;
      continue;
    }
    return data;
  }
  return { errors: lastError || [{ message: 'Max retries exceeded' }] };
}

// ──────────────────────────────────────────────────────────────────────
// TURBO BATCH SYNC — Price + Stock + Metafields in under 20 min for 10K
// Batches everything aggressively and runs phases in parallel.
//
// Stock:      inventorySetQuantities — up to 100 items/call, 10 concurrent
// Price:      productVariantsBulkUpdate — up to 15 products/alias call, 8 concurrent
// Metafields: metafieldsSet — up to 25 per call, 10 concurrent
// ──────────────────────────────────────────────────────────────────────
async function turboSyncPriceStockMeta(
  shopDomain: string,
  accessToken: string,
  locationId: string | number,
  priceUpdates: Array<{ sku: string; variantId: string; productId: string; price: string; compareAtPrice: string | null; priceChanged: boolean; compareAtPriceChanged: boolean }>,
  stockUpdates: Array<{ sku: string; invId: string; value: number }>,
  metafieldUpdates: Array<{ productId: string; metafields: Array<{ namespace: string; key: string; type: string; value: string }> }>,
  metafieldDefMap: Map<string, string>,
  onProgress: (phase: string, current: number, total: number) => void
): Promise<{ priceOk: number; priceErr: number; stockOk: number; stockErr: number; metaOk: number; metaErr: number; logs: string[] }> {
  const logs: string[] = [];
  let priceOk = 0, priceErr = 0, stockOk = 0, stockErr = 0, metaOk = 0, metaErr = 0;

  const totalOps = priceUpdates.length + stockUpdates.length + metafieldUpdates.length;
  let completedOps = 0;
  const reportProgress = () => {
    onProgress("Turbo sync", completedOps, totalOps);
  };

  // ── PHASE 1: BATCH STOCK (up to 100 items per call, 10 concurrent) ──
  const stockPhase = async () => {
    if (stockUpdates.length === 0) return;
    const stockBatches: Array<typeof stockUpdates> = [];
    for (let i = 0; i < stockUpdates.length; i += 100) {
      stockBatches.push(stockUpdates.slice(i, i + 100));
    }
    console.log(`[TURBO] Stock: ${stockUpdates.length} items in ${stockBatches.length} batches`);
    
    await parallelBatch(stockBatches, async (batch) => {
      const mutation = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`;
      const variables = {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: batch.map(u => ({
            inventoryItemId: u.invId,
            locationId: typeof locationId === 'number' ? `gid://shopify/Location/${locationId}` : locationId,
            quantity: u.value
          }))
        }
      };
      const result = await shopifyGraphQLFast(shopDomain, accessToken, mutation, variables);
      const errs = result.data?.inventorySetQuantities?.userErrors;
      if (result.errors || (errs && errs.length > 0)) {
        stockErr += batch.length;
        const msg = result.errors?.[0]?.message || errs?.[0]?.message || "Unknown stock error";
        logs.push(`Stock batch error: ${msg}`);
      } else {
        stockOk += batch.length;
      }
      completedOps += batch.length;
      reportProgress();
    }, 10);
    console.log(`[TURBO] Stock done: ${stockOk} ok, ${stockErr} errors`);
  };

  // ── PHASE 2: BATCH PRICE (up to 15 products per aliased call, 8 concurrent) ──
  const pricePhase = async () => {
    if (priceUpdates.length === 0) return;
    // Group by productId
    const byProduct: Record<string, typeof priceUpdates> = {};
    priceUpdates.forEach(u => {
      if (!byProduct[u.productId]) byProduct[u.productId] = [];
      byProduct[u.productId].push(u);
    });
    const productIds = Object.keys(byProduct);
    
    // Chunk into groups of 15 products per aliased mutation
    const priceChunks: string[][] = [];
    for (let i = 0; i < productIds.length; i += 15) {
      priceChunks.push(productIds.slice(i, i + 15));
    }
    console.log(`[TURBO] Price: ${priceUpdates.length} variants across ${productIds.length} products in ${priceChunks.length} batches`);
    
    await parallelBatch(priceChunks, async (chunk) => {
      let mutation = "mutation {";
      chunk.forEach((productId, pIdx) => {
        const variants = byProduct[productId];
        const variantInputs = variants.map(u => {
          const fields: string[] = [`id: "${u.variantId}"`];
          if (u.priceChanged) fields.push(`price: "${u.price}"`);
          if (u.compareAtPriceChanged) {
            fields.push(u.compareAtPrice === null || u.compareAtPrice === "" ? `compareAtPrice: null` : `compareAtPrice: "${u.compareAtPrice}"`);
          }
          return `{${fields.join(", ")}}`;
        }).join(", ");
        mutation += ` p${pIdx}: productVariantsBulkUpdate(productId: "${productId}", variants: [${variantInputs}]) { productVariants { id } userErrors { field message } }`;
      });
      mutation += " }";
      
      const result = await shopifyGraphQLFast(shopDomain, accessToken, mutation);
      if (result.errors) {
        priceErr += chunk.length;
        logs.push(`Price batch error: ${result.errors[0]?.message}`);
      } else {
        Object.keys(result.data || {}).forEach(key => {
          const errs = result.data[key]?.userErrors;
          if (errs?.length > 0) {
            priceErr++;
            logs.push(`Price error: ${errs[0].message}`);
          } else {
            priceOk++;
          }
        });
      }
      completedOps += chunk.length;
      reportProgress();
    }, 8);
    console.log(`[TURBO] Price done: ${priceOk} ok, ${priceErr} errors`);
  };

  // ── PHASE 3: BATCH METAFIELDS (up to 25 per call, 10 concurrent) ──
  const metaPhase = async () => {
    if (metafieldUpdates.length === 0) return;
    // Flatten all metafields with their ownerIds, then batch into groups of 25
    const allMfInputs: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];
    metafieldUpdates.forEach(u => {
      u.metafields.forEach(mf => {
        const defKey = `${mf.namespace}.${mf.key}`;
        const resolvedType = metafieldDefMap.get(defKey) || mf.type;
        allMfInputs.push({ ownerId: u.productId, namespace: mf.namespace, key: mf.key, type: resolvedType, value: mf.value });
      });
    });
    
    const mfBatches: Array<typeof allMfInputs> = [];
    for (let i = 0; i < allMfInputs.length; i += 25) {
      mfBatches.push(allMfInputs.slice(i, i + 25));
    }
    console.log(`[TURBO] Metafields: ${allMfInputs.length} fields in ${mfBatches.length} batches`);
    
    const mfMutation = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`;
    
    await parallelBatch(mfBatches, async (batch) => {
      const result = await shopifyGraphQLFast(shopDomain, accessToken, mfMutation, { metafields: batch });
      const errs = result.data?.metafieldsSet?.userErrors;
      if (result.errors || (errs && errs.length > 0)) {
        // On batch error, retry individually
        let batchOk = 0;
        for (const singleMf of batch) {
          const single = await shopifyGraphQLFast(shopDomain, accessToken, mfMutation, { metafields: [singleMf] });
          if (single.data?.metafieldsSet?.userErrors?.length > 0) {
            metaErr++;
            logs.push(`Metafield error ${singleMf.namespace}.${singleMf.key}: ${single.data.metafieldsSet.userErrors[0].message}`);
          } else {
            batchOk++;
          }
        }
        metaOk += batchOk;
      } else {
        metaOk += batch.length;
      }
      completedOps += batch.length;
      reportProgress();
    }, 10);
    console.log(`[TURBO] Metafields done: ${metaOk} ok, ${metaErr} errors`);
  };

  // ── RUN ALL THREE PHASES IN PARALLEL ──
  console.log(`[TURBO] Starting parallel execution: ${priceUpdates.length} price, ${stockUpdates.length} stock, ${metafieldUpdates.length} metafield products`);
  await Promise.all([stockPhase(), pricePhase(), metaPhase()]);
  
  return { priceOk, priceErr, stockOk, stockErr, metaOk, metaErr, logs };
}

// ──────────────────────────────────────────────────────────────────────
// SHOPIFY BULK OPERATIONS for 10K+ products (2-5 min completion)
// ──────────────────────────────────────────────────────────────────────

/**
 * Step 1: Create staged upload and get signed URL
 */
async function createStagedUpload(shopDomain: string, accessToken: string): Promise<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }> {
  const mutation = `
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES,
        filename: "bulk-operation.jsonl",
        mimeType: "text/jsonl",
        httpMethod: POST
      }]) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;
  
  const result = await shopifyGraphQL(shopDomain, accessToken, mutation, {});
  
  if (result.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    throw new Error(`Staged upload error: ${result.data.stagedUploadsCreate.userErrors[0].message}`);
  }
  
  const target = result.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("No staged upload target returned");
  
  console.log(`[BULK OPS] Staged upload created: ${target.url}`);
  return target;
}

/**
 * Step 2: Upload JSONL file to signed URL
 */
async function uploadJSONLFile(url: string, parameters: Array<{ name: string; value: string }>, jsonlContent: string): Promise<void> {
  const FormData = (await import('form-data')).default;
  const formData = new FormData();
  
  // Add parameters first (order matters for some cloud storage providers)
  parameters.forEach(param => {
    formData.append(param.name, param.value);
  });
  
  // Add file last
  formData.append('file', Buffer.from(jsonlContent, 'utf-8'), {
    filename: 'bulk-operation.jsonl',
    contentType: 'text/jsonl'
  });
  
  const uploadResponse = await fetch(url, {
    method: 'POST',
    body: formData as any,
    headers: formData.getHeaders()
  });
  
  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`JSONL upload failed: ${uploadResponse.status} ${errorText}`);
  }
  
  console.log(`[BULK OPS] JSONL uploaded successfully (${jsonlContent.length} bytes)`);
}

/**
 * Step 3: Start bulk operation
 */
async function startBulkOperation(shopDomain: string, accessToken: string, stagedUploadPath: string): Promise<string> {
  const mutation = `
    mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(
        mutation: $mutation,
        stagedUploadPath: $stagedUploadPath
      ) {
        bulkOperation {
          id
          status
          errorCode
          createdAt
          objectCount
          fileSize
          url
          partialDataUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  const variables = {
    mutation: "mutation call($input: ProductUpdateInput!) { productUpdate(input: $input) { product { id } userErrors { message field } } }",
    stagedUploadPath
  };
  
  const result = await shopifyGraphQL(shopDomain, accessToken, mutation, variables);
  
  if (result.data?.bulkOperationRunMutation?.userErrors?.length > 0) {
    throw new Error(`Bulk operation error: ${result.data.bulkOperationRunMutation.userErrors[0].message}`);
  }
  
  const bulkOp = result.data?.bulkOperationRunMutation?.bulkOperation;
  if (!bulkOp?.id) throw new Error("No bulk operation ID returned");
  
  console.log(`[BULK OPS] Bulk operation started: ${bulkOp.id} (status: ${bulkOp.status})`);
  return bulkOp.id;
}

/**
 * Step 4: Poll bulk operation until complete
 */
async function pollBulkOperation(shopDomain: string, accessToken: string, bulkOpId: string, onProgress?: (objectCount: number, status: string) => void): Promise<{ status: string; objectCount: number; url: string | null }> {
  const query = `
    query {
      node(id: "${bulkOpId}") {
        ... on BulkOperation {
          id
          status
          errorCode
          createdAt
          completedAt
          objectCount
          fileSize
          url
          partialDataUrl
        }
      }
    }
  `;
  
  let attempts = 0;
  const maxAttempts = 360; // 1 hour max (10 sec intervals)
  
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 10000)); // Poll every 10 seconds
    
    const result = await shopifyGraphQL(shopDomain, accessToken, query, {});
    const bulkOp = result.data?.node;
    
    if (!bulkOp) {
      throw new Error("Bulk operation not found");
    }
    
    console.log(`[BULK OPS] Poll ${attempts + 1}: status=${bulkOp.status}, objectCount=${bulkOp.objectCount}, fileSize=${bulkOp.fileSize}`);
    
    if (onProgress) {
      onProgress(bulkOp.objectCount || 0, bulkOp.status);
    }
    
    if (bulkOp.status === 'COMPLETED') {
      console.log(`[BULK OPS] Bulk operation completed! ${bulkOp.objectCount} objects processed`);
      return {
        status: 'COMPLETED',
        objectCount: bulkOp.objectCount || 0,
        url: bulkOp.url
      };
    }
    
    if (bulkOp.status === 'FAILED' || bulkOp.status === 'CANCELED') {
      throw new Error(`Bulk operation ${bulkOp.status.toLowerCase()}: ${bulkOp.errorCode || 'unknown error'}`);
    }
    
    attempts++;
  }
  
  throw new Error("Bulk operation timed out after 1 hour");
}

/**
 * Step 5: Download and parse results JSONL
 */
async function downloadBulkResults(resultsUrl: string): Promise<Array<{ id?: string; userErrors?: Array<{ field: string; message: string }> }>> {
  if (!resultsUrl) return [];
  
  const response = await fetch(resultsUrl);
  if (!response.ok) {
    throw new Error(`Failed to download results: ${response.status}`);
  }
  
  const jsonlText = await response.text();
  const lines = jsonlText.trim().split('\n').filter(Boolean);
  
  console.log(`[BULK OPS] Downloaded ${lines.length} result lines`);
  
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      console.error(`[BULK OPS] Failed to parse line: ${line}`);
      return {};
    }
  });
}

/**
 * Step 6: Build JSONL content from product updates
 * For bulk operations, we focus on product-level fields (title, description, vendor, metafields)
 * Price/stock/variants stay in optimized individual mutations (already fast enough)
 * Each line: {"input": {...productUpdate variables...}}
 */
function buildBulkOperationJSONL(
  productUpdates: Record<string, any>
): string {
  const jsonlLines: string[] = [];
  
  // ── Product-level updates ONLY (title, description, vendor, tags, status, metafields) ──
  for (const [productId, upd] of Object.entries(productUpdates)) {
    const input: any = { id: productId };
    
    if (upd.title) input.title = upd.title;
    if (upd.description) input.descriptionHtml = upd.description;
    if (upd.vendor) input.vendor = upd.vendor;
    if (upd.productType) input.productType = upd.productType;
    if (upd.handle) input.handle = upd.handle;
    if (upd.tags !== undefined) input.tags = upd.tags;
    if (upd.status) input.status = upd.status;
    if (upd.giftCard !== undefined) input.giftCard = upd.giftCard;
    
    // Metafields (add to product input)
    if (upd.metafields && upd.metafields.length > 0) {
      input.metafields = upd.metafields.map((mf: any) => ({
        namespace: mf.namespace,
        key: mf.key,
        type: mf.type,
        value: mf.value
      }));
    }
    
    // Only add if there are actual field updates (skip image-only updates)
    const hasFieldUpdates = input.title || input.descriptionHtml || input.vendor || 
                           input.productType || input.handle || input.tags !== undefined || 
                           input.status || input.giftCard !== undefined || input.metafields;
    
    if (hasFieldUpdates) {
      jsonlLines.push(JSON.stringify({ input }));
    }
  }
  
  console.log(`[BULK OPS] Generated ${jsonlLines.length} JSONL lines for product updates`);
  return jsonlLines.join('\n');
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
    const { 
      name, 
      shopDomain, 
      shop_domain,
      accessToken, 
      access_token,
      spreadsheetId, 
      spreadsheet_id,
      serviceAccountJson, 
      service_account_json,
      sheetName, 
      sheet_name,
      skuCol, 
      sku_col,
      priceCol, 
      price_col,
      compareAtPriceCol, 
      compare_at_price_col,
      inventoryCol, 
      inventory_col,
      fieldMappings, 
      field_mappings,
      metafieldMappings,
      metafield_mappings
    } = req.body;
    
    try {
      console.log("[CREATE STORE] Request body keys:", Object.keys(req.body));
      
      // Accept both camelCase and snake_case
      const finalShopDomain = shopDomain || shop_domain;
      const finalAccessToken = accessToken || access_token;
      const finalSpreadsheetId = spreadsheetId || spreadsheet_id;
      const finalServiceAccountJson = serviceAccountJson || service_account_json;
      const finalSheetName = sheetName || sheet_name || "Template";
      const finalSkuCol = skuCol || sku_col || "Variant SKU";
      const finalPriceCol = priceCol || price_col || "Variant Price";
      const finalCompareAtPriceCol = compareAtPriceCol || compare_at_price_col || "Variant Compare At Price";
      const finalInventoryCol = inventoryCol || inventory_col || "Variant Inventory Qty";
      const finalFieldMappings = fieldMappings || field_mappings || {};
      const finalMetafieldMappings = metafieldMappings || metafield_mappings || [];
      
      const id = randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO master_stores (id, name, shop_domain, access_token, spreadsheet_id, service_account_json, sheet_name, sku_col, price_col, compare_at_price_col, inventory_col, field_mappings, metafield_mappings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [
          id, 
          name || "Unlabeled Store", 
          finalShopDomain, 
          finalAccessToken, 
          finalSpreadsheetId, 
          finalServiceAccountJson, 
          finalSheetName, 
          finalSkuCol, 
          finalPriceCol, 
          finalCompareAtPriceCol, 
          finalInventoryCol, 
          JSON.stringify(finalFieldMappings), 
          JSON.stringify(finalMetafieldMappings)
        ]
      );
      
      console.log("[CREATE STORE] Success! Created store:", rows[0].id);
      res.json(normalizeStore(rows[0]));
    } catch (e: any) {
      console.error("[CREATE STORE] Error:", e);
      res.status(400).json({ error: "Store domain already exists" });
    }
  });

  // Admin: Update Master Store
  app.put("/api/admin/master-stores/:id", authenticateToken, isAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { 
      name, 
      shopDomain, 
      shop_domain,
      accessToken, 
      access_token,
      spreadsheetId, 
      spreadsheet_id,
      serviceAccountJson, 
      service_account_json,
      sheetName, 
      sheet_name,
      skuCol, 
      sku_col,
      priceCol, 
      price_col,
      compareAtPriceCol, 
      compare_at_price_col,
      inventoryCol, 
      inventory_col,
      fieldMappings, 
      field_mappings,
      metafieldMappings,
      metafield_mappings
    } = req.body;
    
    try {
      console.log("[UPDATE STORE] Request body keys:", Object.keys(req.body));
      console.log("[UPDATE STORE] Raw body:", JSON.stringify(req.body, null, 2));
      console.log("[UPDATE STORE] sheetName/sheet_name:", sheetName, sheet_name);
      console.log("[UPDATE STORE] skuCol/sku_col:", skuCol, sku_col);
      console.log("[UPDATE STORE] priceCol/price_col:", priceCol, price_col);
      console.log("[UPDATE STORE] compareAtPriceCol/compare_at_price_col:", compareAtPriceCol, compare_at_price_col);
      console.log("[UPDATE STORE] inventoryCol/inventory_col:", inventoryCol, inventory_col);
      console.log("[UPDATE STORE] fieldMappings:", fieldMappings || field_mappings);
      console.log("[UPDATE STORE] metafieldMappings:", metafieldMappings || metafield_mappings);
      
      // Accept both camelCase and snake_case
      const finalShopDomain = shopDomain || shop_domain;
      const finalAccessToken = accessToken || access_token;
      const finalSpreadsheetId = spreadsheetId || spreadsheet_id;
      const finalSheetName = sheetName || sheet_name || "Template";
      const finalSkuCol = skuCol || sku_col || "Variant SKU";
      const finalPriceCol = priceCol || price_col || "Variant Price";
      const finalCompareAtPriceCol = compareAtPriceCol || compare_at_price_col || "Variant Compare At Price";
      const finalInventoryCol = inventoryCol || inventory_col || "Variant Inventory Qty";
      const finalFieldMappings = fieldMappings || field_mappings || {};
      const finalMetafieldMappings = metafieldMappings || metafield_mappings || [];
      
      console.log("[UPDATE STORE] Final values to save:");
      console.log("  - sheetName:", finalSheetName);
      console.log("  - skuCol:", finalSkuCol);
      console.log("  - priceCol:", finalPriceCol);
      console.log("  - compareAtPriceCol:", finalCompareAtPriceCol);
      console.log("  - inventoryCol:", finalInventoryCol);
      console.log("  - fieldMappings:", JSON.stringify(finalFieldMappings));
      console.log("  - metafieldMappings:", JSON.stringify(finalMetafieldMappings));
      
      // If serviceAccountJson is blank, keep the existing value in DB
      let finalServiceAccountJson = serviceAccountJson || service_account_json;
      if (!finalServiceAccountJson || String(finalServiceAccountJson).trim() === "") {
        const { rows: existing } = await pool.query("SELECT service_account_json FROM master_stores WHERE id = $1", [id]);
        if (existing.length === 0) return res.status(404).json({ error: "Store not found" });
        finalServiceAccountJson = existing[0].service_account_json;
      }
      
      const { rows } = await pool.query(
        `UPDATE master_stores 
         SET name = $1, shop_domain = $2, access_token = $3, spreadsheet_id = $4, service_account_json = $5, sheet_name = $6, sku_col = $7, price_col = $8, compare_at_price_col = $9, inventory_col = $10, field_mappings = $11, metafield_mappings = $12, updated_at = NOW()
         WHERE id = $13 RETURNING *`,
        [
          name || "Unlabeled Store", 
          finalShopDomain, 
          finalAccessToken, 
          finalSpreadsheetId, 
          finalServiceAccountJson, 
          finalSheetName, 
          finalSkuCol, 
          finalPriceCol, 
          finalCompareAtPriceCol, 
          finalInventoryCol, 
          JSON.stringify(finalFieldMappings), 
          JSON.stringify(finalMetafieldMappings), 
          id
        ]
      );
      
      if (rows.length === 0) return res.status(404).json({ error: "Store not found" });
      
      console.log("[UPDATE STORE] Success! Updated store:", rows[0].id);
      console.log("[UPDATE STORE] DB row sheetName:", rows[0].sheet_name);
      console.log("[UPDATE STORE] DB row skuCol:", rows[0].sku_col);
      console.log("[UPDATE STORE] DB row priceCol:", rows[0].price_col);
      
      const normalized = normalizeStore(rows[0]);
      console.log("[UPDATE STORE] Normalized response:", JSON.stringify({
        id: normalized.id,
        name: normalized.name,
        sheetName: normalized.sheetName,
        skuCol: normalized.skuCol,
        priceCol: normalized.priceCol,
        compareAtPriceCol: normalized.compareAtPriceCol,
        inventoryCol: normalized.inventoryCol
      }, null, 2));
      
      res.json(normalized);
    } catch (e: any) {
      console.error("[UPDATE STORE] Error:", e);
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
    
    // Parse field_mappings and metafield_mappings from JSON strings to objects
    let fieldMappings = {};
    let metafieldMappings = [];
    
    try {
      const fieldMappingsRaw = r.field_mappings || r.fieldMappings;
      if (typeof fieldMappingsRaw === 'string') {
        fieldMappings = JSON.parse(fieldMappingsRaw);
      } else if (fieldMappingsRaw && typeof fieldMappingsRaw === 'object') {
        fieldMappings = fieldMappingsRaw;
      }
    } catch (e) {
      console.error('[normalizeStore] Failed to parse field_mappings:', e);
    }
    
    try {
      const metafieldMappingsRaw = r.metafield_mappings || r.metafieldMappings;
      if (typeof metafieldMappingsRaw === 'string') {
        metafieldMappings = JSON.parse(metafieldMappingsRaw);
      } else if (Array.isArray(metafieldMappingsRaw)) {
        metafieldMappings = metafieldMappingsRaw;
      }
    } catch (e) {
      console.error('[normalizeStore] Failed to parse metafield_mappings:', e);
    }
    
    return {
      id: r.id,
      name: r.name,
      shopDomain: r.shop_domain || r.shopDomain,
      accessToken: r.access_token || r.accessToken,
      spreadsheetId: r.spreadsheet_id || r.spreadsheetId,
      serviceAccountJson: r.service_account_json || r.serviceAccountJson,
      sheetName: r.sheet_name || r.sheetName,
      skuCol: r.sku_col || r.skuCol,
      priceCol: r.price_col || r.priceCol,
      compareAtPriceCol: r.compare_at_price_col || r.compareAtPriceCol,
      inventoryCol: r.inventory_col || r.inventoryCol,
      fieldMappings,
      metafieldMappings,
      createdAt: r.created_at || r.installedAt,
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
      const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: store.spreadsheetId, range: `${store.sheetName || "Template"}!1:2` });
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
        const results = data.syncResults || [];
        const createdCount = results.filter((r: any) => r.action === 'created').length;
        const skippedCount = results.filter((r: any) => r.status === 'filtered' || r.status === 'not_found').length;
        await pool.query(
          "INSERT INTO sync_logs (id, shop_domain, status, message, updated_count, error_count, duration, logs, sync_mode, total_count, created_count, skipped_count) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
          [logId, shopDomain, "success", "Sync completed", data.updatedCount, data.errorCount, data.duration, data.logs || [], data.syncMode || 'all', results.length, createdCount, skippedCount]
        );
        if (results.length > 0) {
          for (let k = 0; k < results.length; k += 100) {
            const batch = results.slice(k, k + 100);
            const placeholders = batch.map((_: any, bi: number) => {
              const base = bi * 10;
              return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`;
            }).join(',');
            const values = batch.flatMap((r: any) => [randomUUID(), logId, shopDomain, r.sku, r.status, r.action, r.message || '', r.rowNumber, r.productTitle || '', r.shopifyProductId || '']);
            await pool.query(`INSERT INTO sync_results (id,sync_log_id,shop_domain,sku,status,action,message,row_number,product_title,shopify_product_id) VALUES ${placeholders}`, values);
          }
        }
      } catch (e) { console.error("Failed to save sync log:", e); }
    } else if (data.type === "error") {
      session.status = "error";
      session.message = data.message;
      session.logs = data.logs || [data.message];
      try {
        const errLogId = data.syncLogId || randomUUID();
        const results = data.syncResults || [];
        const createdCount = results.filter((r: any) => r.action === 'created').length;
        const skippedCount = results.filter((r: any) => r.status === 'filtered' || r.status === 'not_found').length;
        await pool.query(
          "INSERT INTO sync_logs (id, shop_domain, status, message, updated_count, error_count, duration, logs, sync_mode, total_count, created_count, skipped_count) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
          [errLogId, shopDomain, "error", data.message, 0, 1, data.duration || 0, data.logs || [data.message], data.syncMode || 'all', results.length, createdCount, skippedCount]
        );
        if (results.length > 0) {
          for (let k = 0; k < results.length; k += 100) {
            const batch = results.slice(k, k + 100);
            const placeholders = batch.map((_: any, bi: number) => {
              const base = bi * 10;
              return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`;
            }).join(',');
            const values = batch.flatMap((r: any) => [randomUUID(), errLogId, shopDomain, r.sku, r.status, r.action, r.message || '', r.rowNumber, r.productTitle || '', r.shopifyProductId || '']);
            await pool.query(`INSERT INTO sync_results (id,sync_log_id,shop_domain,sku,status,action,message,row_number,product_title,shopify_product_id) VALUES ${placeholders}`, values);
          }
        }
      } catch (dbErr) { console.error("Failed to save error sync log:", dbErr); }
    }
    (session.clients || []).forEach((c: any) => c.res.write(`data: ${JSON.stringify(data)}\n\n`));
  };

  app.post("/api/sync/cancel", authenticateToken, (req, res) => {
    const { shopDomain } = req.body;
    if (syncSessions[shopDomain]) {
      syncSessions[shopDomain].cancelled = true;
      syncSessions[shopDomain].status = "error";
      syncSessions[shopDomain].message = "Sync cancelled by user";
      // Immediately notify SSE clients so the UI updates
      (syncSessions[shopDomain].clients || []).forEach((c: any) => {
        try { c.res.write(`data: ${JSON.stringify({ type: "error", message: "Sync cancelled by user" })}\n\n`); } catch {}
      });
    }
    res.json({ success: true });
  });

  app.post("/api/sync/sheets-to-shopify", authenticateToken, async (req: Request, res: Response) => {
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, mapping, sheetName, syncMode, fields: syncFields = [] } = req.body;
    if (syncSessions[shopDomain]?.status === "loading") return res.status(400).json({ error: "Sync already running" });

    syncSessions[shopDomain] = { status: "loading", progress: { current: 0, total: 0 }, message: "Starting...", logs: [], clients: syncSessions[shopDomain]?.clients || [], cancelled: false, startedAt: Date.now() };

    (async () => {
      const startTime = Date.now();
      const syncLogId = randomUUID();
      const syncResultsArr: Array<{sku: string; status: string; action: string; message: string; rowNumber: number; productTitle?: string; shopifyProductId?: string}> = [];
      const logs: string[] = [];
      try {
        await updateSyncSession(shopDomain, { type: "progress", current: 0, total: 0, message: "Step 1: Fetching Data..." });

        const credentials = JSON.parse(serviceAccountJson);
        const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
        const sheets = google.sheets({ version: "v4", auth });
        const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName || "Sheet1" });
        const rows = sheetRes.data.values;
        if (!rows || rows.length === 0) return await updateSyncSession(shopDomain, { type: "error", message: "No data found", syncLogId, syncMode, duration: Date.now() - startTime });

        const rawHeaders = rows[0] || [];
        const headers = rawHeaders.map((h: any) => String(h || "").trim());
        const skuIndex = headers.indexOf(mapping.sku);
        const priceIndex = headers.indexOf(mapping.price);
        const compareAtPriceIndex = mapping.compareAtPrice ? headers.indexOf(mapping.compareAtPrice) : -1;
        const invIndex = headers.indexOf(mapping.inventory);
        
        console.log(`[SYNC] Headers Found:`, headers);
        console.log(`[SYNC] Indexes: SKU=${skuIndex}, Price=${priceIndex}, CompareAtPrice=${compareAtPriceIndex}, Inv=${invIndex}`);

        if (skuIndex === -1) return await updateSyncSession(shopDomain, { type: "error", message: `SKU column "${mapping.sku}" not found in sheet`, syncLogId, syncMode, duration: Date.now() - startTime });

        // Load filter rules for this store
        let filterRules: any[] = [];
        let fieldMappings: Record<string, string> = {};
        let metafieldMappings: Array<{ namespace: string; key: string; type: string; sheetColumn: string }> = [];
        try {
          const { rows: storeRows } = await pool.query("SELECT id, field_mappings, metafield_mappings FROM master_stores WHERE shop_domain = $1", [shopDomain]);
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
          if (storeRow?.metafield_mappings) {
            try { metafieldMappings = JSON.parse(storeRow.metafield_mappings) || []; } catch {}
          }
          if (metafieldMappings.length > 0) console.log(`[SYNC] Loaded ${metafieldMappings.length} metafield mappings`);
        } catch (e) { console.error("[SYNC] Failed to load store config:", e); }

        // Determine what fields to sync based on mode
        const isFullSync = syncMode === "all" || syncMode === "all-no-images";
        const shouldSyncPrice  = syncMode === "price" || syncMode === "both" || isFullSync || (syncFields as string[]).includes("price");
        const shouldSyncStock  = syncMode === "stock" || syncMode === "both" || isFullSync || (syncFields as string[]).includes("stock");
        const shouldSyncTags   = isFullSync || (syncFields as string[]).includes("tags");
        const shouldSyncStatus = isFullSync || (syncFields as string[]).includes("status");
        const shouldSyncImages = syncMode === "all" || (syncFields as string[]).includes("images");
        const shouldSyncProductFields = isFullSync; // Title, Description, Vendor, Product Type, Handle
        const shouldSyncVariantFields = isFullSync; // Barcode, Taxable, Options
        const shouldSyncInventoryFields = isFullSync; // Weight, Requires Shipping
        const shouldSyncMetafields = (isFullSync || (syncFields as string[]).includes("metafields")) && metafieldMappings.length > 0;

        // ── ALL field column indexes (from stored field_mappings) ──
        // Product-level fields
        const titleColIdx = shouldSyncProductFields && fieldMappings.title ? headers.indexOf(fieldMappings.title) : -1;
        const descColIdx = shouldSyncProductFields && (fieldMappings.description || fieldMappings.body_html) ? headers.indexOf((fieldMappings.description || fieldMappings.body_html) as string) : -1;
        const vendorColIdx = shouldSyncProductFields && fieldMappings.vendor ? headers.indexOf(fieldMappings.vendor) : -1;
        const productTypeColIdx = shouldSyncProductFields && fieldMappings.product_type ? headers.indexOf(fieldMappings.product_type) : -1;
        const handleColIdx = shouldSyncProductFields && fieldMappings.handle ? headers.indexOf(fieldMappings.handle) : -1;
        const tagsColIdx = shouldSyncTags && fieldMappings.tags ? headers.indexOf(fieldMappings.tags) : -1;
        const statusColIdx = shouldSyncStatus && (fieldMappings.status || fieldMappings.published) ? headers.indexOf((fieldMappings.status || fieldMappings.published) as string) : -1;
        const giftCardColIdx = shouldSyncProductFields && fieldMappings.gift_card ? headers.indexOf(fieldMappings.gift_card) : -1;
        
        // Option names (product-level)
        const option1NameColIdx = shouldSyncProductFields && fieldMappings.option1_name ? headers.indexOf(fieldMappings.option1_name) : -1;
        const option2NameColIdx = shouldSyncProductFields && fieldMappings.option2_name ? headers.indexOf(fieldMappings.option2_name) : -1;
        const option3NameColIdx = shouldSyncProductFields && fieldMappings.option3_name ? headers.indexOf(fieldMappings.option3_name) : -1;
        
        // Variant-level fields
        const barcodeColIdx = shouldSyncVariantFields && fieldMappings.variant_barcode ? headers.indexOf(fieldMappings.variant_barcode) : -1;
        const taxableColIdx = shouldSyncVariantFields && fieldMappings.variant_taxable ? headers.indexOf(fieldMappings.variant_taxable) : -1;
        const invPolicyColIdx = shouldSyncVariantFields && fieldMappings.variant_inventory_policy ? headers.indexOf(fieldMappings.variant_inventory_policy) : -1;
        const fulfillmentColIdx = shouldSyncVariantFields && fieldMappings.variant_fulfillment_service ? headers.indexOf(fieldMappings.variant_fulfillment_service) : -1;
        const option1ValueColIdx = shouldSyncVariantFields && fieldMappings.option1_value ? headers.indexOf(fieldMappings.option1_value) : -1;
        const option2ValueColIdx = shouldSyncVariantFields && fieldMappings.option2_value ? headers.indexOf(fieldMappings.option2_value) : -1;
        const option3ValueColIdx = shouldSyncVariantFields && fieldMappings.option3_value ? headers.indexOf(fieldMappings.option3_value) : -1;
        
        // Inventory item fields
        const weightColIdx = shouldSyncInventoryFields && fieldMappings.variant_grams ? headers.indexOf(fieldMappings.variant_grams) : -1;
        const weightUnitColIdx = shouldSyncInventoryFields && fieldMappings.variant_weight_unit ? headers.indexOf(fieldMappings.variant_weight_unit) : -1;
        const requiresShippingColIdx = shouldSyncInventoryFields && fieldMappings.variant_requires_shipping ? headers.indexOf(fieldMappings.variant_requires_shipping) : -1;
        
        // Image fields
        const imageSrcColIdx = shouldSyncImages && fieldMappings.image_src ? headers.indexOf(fieldMappings.image_src) : -1;
        const variantImageColIdx = shouldSyncImages && fieldMappings.variant_image ? headers.indexOf(fieldMappings.variant_image) : -1;
        const imageAltColIdx = shouldSyncImages && fieldMappings.image_alt_text ? headers.indexOf(fieldMappings.image_alt_text) : -1;
        
        // Metafield column indexes
        const metafieldColIndexes: Array<{ namespace: string; key: string; type: string; colIdx: number }> = [];
        if (shouldSyncMetafields) {
          metafieldMappings.forEach(mf => {
            const colIdx = headers.indexOf(mf.sheetColumn);
            if (colIdx !== -1) {
              metafieldColIndexes.push({ namespace: mf.namespace, key: mf.key, type: mf.type, colIdx });
            }
          });
          if (metafieldColIndexes.length > 0) console.log(`[SYNC] Metafield columns mapped: ${metafieldColIndexes.length}`);
        }
        
        console.log(`[SYNC] Field indexes - Product: title=${titleColIdx}, desc=${descColIdx}, vendor=${vendorColIdx}, type=${productTypeColIdx}, handle=${handleColIdx}, tags=${tagsColIdx}, status=${statusColIdx}`);
        console.log(`[SYNC] Field indexes - Variant: barcode=${barcodeColIdx}, taxable=${taxableColIdx}, opt1Val=${option1ValueColIdx}`);
        console.log(`[SYNC] Field indexes - Inventory: weight=${weightColIdx}, weightUnit=${weightUnitColIdx}, reqShip=${requiresShippingColIdx}`);
        console.log(`[SYNC] Field indexes - Images: image=${imageSrcColIdx}, variantImg=${variantImageColIdx}`);

        // Always fetch locationId (needed for stock sync AND product creation inventory)
        let locationId = null;
        try {
          const locRes = await fetch(`https://${shopDomain}/admin/api/2025-01/locations.json`, { headers: { "X-Shopify-Access-Token": accessToken } });
          const locData = await locRes.json();
          locationId = locData.locations?.[0]?.id;
          console.log(`[SYNC] Location ID: ${locationId}`);
        } catch (e) { console.error("[SYNC] Failed to fetch location:", e); }

        // Fetch Online Store publication ID for publishing created products
        let onlineStorePublicationId: string | null = null;
        try {
          const pubQuery = `{ publications(first: 20) { edges { node { id name } } } }`;
          const pubData = await shopifyGraphQL(shopDomain, accessToken, pubQuery, {});
          const publications = pubData.data?.publications?.edges || [];
          const onlineStore = publications.find((e: any) => 
            e.node.name === "Online Store" || e.node.name === "online_store"
          );
          if (onlineStore) {
            onlineStorePublicationId = onlineStore.node.id;
            console.log(`[SYNC] Online Store Publication ID: ${onlineStorePublicationId}`);
          } else if (publications.length > 0) {
            onlineStorePublicationId = publications[0].node.id;
            console.log(`[SYNC] Using first publication as fallback: ${onlineStorePublicationId} (${publications[0].node.name})`);
          }
        } catch (e) { console.error("[SYNC] Failed to fetch publications:", e); }

        // Fetch existing metafield definitions to resolve correct types
        const metafieldDefMap = new Map<string, string>();
        if (shouldSyncMetafields) {
          try {
            const defQuery = `{ metafieldDefinitions(first: 100, ownerType: PRODUCT) { edges { node { namespace key type { name } } } } }`;
            const defData = await shopifyGraphQL(shopDomain, accessToken, defQuery, {});
            (defData.data?.metafieldDefinitions?.edges || []).forEach((e: any) => {
              metafieldDefMap.set(`${e.node.namespace}.${e.node.key}`, e.node.type.name);
            });
            console.log(`[SYNC] Loaded ${metafieldDefMap.size} metafield definitions from Shopify`);
          } catch (e) { console.error("[SYNC] Failed to fetch metafield definitions:", e); }
        }

        const skusArray = Array.from(new Set(rows.slice(1).map((r: any) => r[skuIndex]).filter(Boolean)));
        const shopifyVariants = new Map();

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

        // Product creation ONLY in "Sync All" mode (not "all-no-images" which updates existing only)
        const canCreateProducts = syncMode === "all" && titleColIdx !== -1;
        
        if (canCreateProducts) {
          console.log(`[SYNC] Product creation enabled - syncMode=all and title column found at index ${titleColIdx}`);
        }

        const updates: any[] = [];
        // Expanded structure for ALL product-level updates
        const productUpdates: Record<string, {
          // Product fields
          title?: string;
          description?: string;
          vendor?: string;
          productType?: string;
          handle?: string;
          tags?: string[];
          status?: string;
          giftCard?: boolean;
          // Image
          imageSrc?: string;
          // Metafields
          metafields?: Array<{ namespace: string; key: string; type: string; value: string }>;
        }> = {};
        // Variant-level updates
        const variantUpdates: Record<string, {
          variantId: string;
          productId: string;
          barcode?: string;
          taxable?: boolean;
          inventoryPolicy?: string;
          fulfillmentService?: string;
          option1?: string;
          option2?: string;
          option3?: string;
        }> = {};
        // Inventory item updates
        const inventoryItemUpdates: Record<string, {
          invItemId: string;
          weight?: number;
          weightUnit?: string;
          requiresShipping?: boolean;
        }> = {};
        
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
                
                // Collect metafields for creation
                const createMetafields: Array<{ namespace: string; key: string; type: string; value: string }> = [];
                if (metafieldColIndexes.length > 0) {
                  for (const mf of metafieldColIndexes) {
                    const val = String(rows[i][mf.colIdx] ?? "").trim();
                    if (val) {
                      createMetafields.push({ namespace: mf.namespace, key: mf.key, type: mf.type, value: val });
                    }
                  }
                }
                
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
                  metafields: createMetafields,
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

          // ── Collect ALL updates for EXISTING products ──
          
          // Product-level fields
          if (shopify.productId) {
            productUpdates[shopify.productId] = productUpdates[shopify.productId] || {};
            
            // Title
            if (titleColIdx !== -1) {
              const val = String(rows[i][titleColIdx] ?? "").trim();
              if (val) productUpdates[shopify.productId].title = val;
            }
            // Description
            if (descColIdx !== -1) {
              const val = String(rows[i][descColIdx] ?? "").trim();
              if (val) productUpdates[shopify.productId].description = val;
            }
            // Vendor
            if (vendorColIdx !== -1) {
              const val = String(rows[i][vendorColIdx] ?? "").trim();
              if (val) productUpdates[shopify.productId].vendor = val;
            }
            // Product Type
            if (productTypeColIdx !== -1) {
              const val = String(rows[i][productTypeColIdx] ?? "").trim();
              if (val) productUpdates[shopify.productId].productType = val;
            }
            // Handle
            if (handleColIdx !== -1) {
              const val = String(rows[i][handleColIdx] ?? "").trim();
              if (val) productUpdates[shopify.productId].handle = val;
            }
            // Tags
            if (tagsColIdx !== -1) {
              const raw = String(rows[i][tagsColIdx] ?? "").trim();
              if (raw) productUpdates[shopify.productId].tags = raw.split(",").map((t: string) => t.trim()).filter(Boolean);
            }
            // Status
            if (statusColIdx !== -1) {
              const rawStatus = String(rows[i][statusColIdx] ?? "").trim().toUpperCase();
              if (rawStatus && ["ACTIVE", "DRAFT", "ARCHIVED"].includes(rawStatus)) {
                productUpdates[shopify.productId].status = rawStatus;
              }
            }
            // Gift Card
            if (giftCardColIdx !== -1) {
              const val = String(rows[i][giftCardColIdx] ?? "").trim().toLowerCase();
              if (val) productUpdates[shopify.productId].giftCard = val === "true" || val === "yes" || val === "1";
            }
            // Image (only if shouldSyncImages)
            if (imageSrcColIdx !== -1) {
              const raw = String(rows[i][imageSrcColIdx] ?? "").trim();
              if (raw) productUpdates[shopify.productId].imageSrc = raw;
            }
            
            // Metafields
            if (metafieldColIndexes.length > 0) {
              const mfValues: Array<{ namespace: string; key: string; type: string; value: string }> = [];
              for (const mf of metafieldColIndexes) {
                const val = String(rows[i][mf.colIdx] ?? "").trim();
                if (val) {
                  mfValues.push({ namespace: mf.namespace, key: mf.key, type: mf.type, value: val });
                }
              }
              if (mfValues.length > 0) {
                productUpdates[shopify.productId].metafields = mfValues;
              }
            }
          }
          
          // Variant-level fields
          if (shopify.variantId) {
            const hasVariantUpdates = barcodeColIdx !== -1 || taxableColIdx !== -1 || 
                                       invPolicyColIdx !== -1 || fulfillmentColIdx !== -1 ||
                                       option1ValueColIdx !== -1 || option2ValueColIdx !== -1 || option3ValueColIdx !== -1;
            if (hasVariantUpdates) {
              variantUpdates[sku] = { variantId: shopify.variantId, productId: shopify.productId };
              
              if (barcodeColIdx !== -1) {
                const val = String(rows[i][barcodeColIdx] ?? "").trim();
                if (val) variantUpdates[sku].barcode = val;
              }
              if (taxableColIdx !== -1) {
                const val = String(rows[i][taxableColIdx] ?? "").trim().toLowerCase();
                variantUpdates[sku].taxable = val === "true" || val === "yes" || val === "1";
              }
              if (invPolicyColIdx !== -1) {
                const val = String(rows[i][invPolicyColIdx] ?? "").trim().toUpperCase();
                if (val === "DENY" || val === "CONTINUE") variantUpdates[sku].inventoryPolicy = val;
              }
              if (fulfillmentColIdx !== -1) {
                const val = String(rows[i][fulfillmentColIdx] ?? "").trim();
                if (val) variantUpdates[sku].fulfillmentService = val;
              }
              if (option1ValueColIdx !== -1) {
                const val = String(rows[i][option1ValueColIdx] ?? "").trim();
                if (val) variantUpdates[sku].option1 = val;
              }
              if (option2ValueColIdx !== -1) {
                const val = String(rows[i][option2ValueColIdx] ?? "").trim();
                if (val) variantUpdates[sku].option2 = val;
              }
              if (option3ValueColIdx !== -1) {
                const val = String(rows[i][option3ValueColIdx] ?? "").trim();
                if (val) variantUpdates[sku].option3 = val;
              }
            }
          }
          
          // Inventory item fields
          if (shopify.invId) {
            const hasInvUpdates = weightColIdx !== -1 || requiresShippingColIdx !== -1;
            if (hasInvUpdates) {
              inventoryItemUpdates[sku] = { invItemId: shopify.invId };
              
              if (weightColIdx !== -1) {
                const val = String(rows[i][weightColIdx] ?? "").trim();
                const weight = parseFloat(val.replace(/[^\d.-]/g, ""));
                if (!isNaN(weight)) {
                  inventoryItemUpdates[sku].weight = weight;
                  inventoryItemUpdates[sku].weightUnit = weightUnitColIdx !== -1 
                    ? String(rows[i][weightUnitColIdx] ?? "GRAMS").trim().toUpperCase()
                    : "GRAMS";
                }
              }
              if (requiresShippingColIdx !== -1) {
                const val = String(rows[i][requiresShippingColIdx] ?? "").trim().toLowerCase();
                inventoryItemUpdates[sku].requiresShipping = val !== "false" && val !== "no" && val !== "0";
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
        // Build a quick sku→row map so we can pull the product title from the sheet
        const skuRowMap = new Map<string, number>();
        for (let ri = 1; ri < rows.length; ri++) {
          const s = String(rows[ri][skuIndex] || "").trim();
          if (s && !skuRowMap.has(s)) skuRowMap.set(s, ri);
        }
        const updatedSkus = new Set<string>(updates.filter((u: any) => u.type !== "create").map((u: any) => u.sku));
        updatedSkus.forEach(sku => {
          const rowIdx = skuRowMap.get(sku) || 0;
          const sheetTitle = titleColIdx !== -1 && rowIdx > 0 ? String(rows[rowIdx][titleColIdx] ?? "").trim() : "";
          const shopifyData = shopifyVariants.get(sku);
          syncResultsArr.push({ sku, status: "updated", action: "sync_applied", message: "", rowNumber: rowIdx, productTitle: sheetTitle, shopifyProductId: shopifyData?.productId || "" });
        });

        // ── Step 2a: Create new products (if any) ──
        const createBatch = updates.filter((u: any) => u.type === "create");
        const nonCreateUpdates = updates.filter((u: any) => u.type !== "create");
        const totalExistingToUpdate = Object.keys(productUpdates).length + Object.keys(variantUpdates).length + Object.keys(inventoryItemUpdates).length;
        let createdCount = 0;
        if (createBatch.length > 0) {
          console.log(`[SYNC] Creating ${createBatch.length} new products (${totalExistingToUpdate} existing queued for update)...`);
          await updateSyncSession(shopDomain, { type: "progress", current: 0, total: createBatch.length, message: `Step 2/6: Creating ${createBatch.length} NEW products (${totalExistingToUpdate} existing queued for update)...` });
          
          // Process creates in PARALLEL batches — 5 concurrent product pipelines
          let createProgress = 0;
          await parallelBatch(createBatch, async (item, idx) => {
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
            
            const result = await shopifyGraphQLFast(shopDomain, accessToken, createMutation, { input: productInput });
            
            if (result.errors) {
              const msg = `Create Error (${item.sku}): ${result.errors[0]?.message || JSON.stringify(result.errors)}`;
              console.error(`[SYNC] ${msg}`);
              logs.push(msg);
              syncResultsArr.push({ sku: item.sku, status: "error", action: "create_failed", message: result.errors[0]?.message || "Unknown error", rowNumber: item.rowNumber, productTitle: item.title || "" });
              createProgress++;
              await updateSyncSession(shopDomain, { type: "progress", current: createProgress, total: createBatch.length, message: `Step 2/6: Creating NEW products (${createProgress}/${createBatch.length})...` });
              return;
            }
            
            const userErrors = result.data?.productCreate?.userErrors;
            if (userErrors?.length > 0) {
              const msg = `Create Error (${item.sku}): ${userErrors[0].message}`;
              console.error(`[SYNC] ${msg}`);
              logs.push(msg);
              syncResultsArr.push({ sku: item.sku, status: "error", action: "create_failed", message: userErrors[0].message, rowNumber: item.rowNumber, productTitle: item.title || "" });
              createProgress++;
              await updateSyncSession(shopDomain, { type: "progress", current: createProgress, total: createBatch.length, message: `Step 2/6: Creating NEW products (${createProgress}/${createBatch.length})...` });
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
                const variantResult = await shopifyGraphQLFast(shopDomain, accessToken, variantMutation, { productId: newProduct.id, variants: [variantInput] });
                if (variantResult.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
                  const errMsg = variantResult.data.productVariantsBulkUpdate.userErrors[0].message;
                  console.error(`[SYNC] Variant update error for ${item.sku}:`, errMsg);
                  logs.push(`Variant update failed for ${item.sku}: ${errMsg}`);
                  variantUpdateOk = false;
                } else {
                  console.log(`[SYNC] Variant updated: ${item.sku} (price: ${item.price}, barcode: ${item.barcode || "none"})`);
                }
              }
              
              // Step 2b: Update inventory item with SKU, weight, requiresShipping, tracked=true
              if (invItemId) {
                const invItemInput: any = { tracked: true };
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
                  const invItemResult = await shopifyGraphQLFast(shopDomain, accessToken, invItemMutation, { id: invItemId, input: invItemInput });
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
              syncResultsArr.push({ sku: item.sku, status: "updated", action: "created", message: statusMsg, rowNumber: item.rowNumber, productTitle: item.title || "", shopifyProductId: newProduct.id });
              console.log(`[SYNC] Created: ${item.sku} -> ${newProduct.id}`);
              
              // Step 3: Set inventory if we have a location and inventory value
              if (locationId && item.inventory > 0 && invItemId) {
                const invMutation = `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { message } } }`;
                const invVars = { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: [{ inventoryItemId: invItemId, locationId: `gid://shopify/Location/${locationId}`, quantity: item.inventory }] } };
                await shopifyGraphQLFast(shopDomain, accessToken, invMutation, invVars);
                console.log(`[SYNC] Inventory set: ${item.sku} -> ${item.inventory}`);
              }
              
              // Step 4: Add product images (supports comma-separated URLs)
              if (item.imageSrc) {
                const allImageUrls = item.imageSrc.split(',').map((u: string) => u.trim()).filter(Boolean);
                for (let imgIdx = 0; imgIdx < allImageUrls.length; imgIdx++) {
                  const rawUrl = allImageUrls[imgIdx];
                  const directUrl = convertToDirectUrl(rawUrl);
                  const imgMutation = `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                    productCreateMedia(productId: $productId, media: $media) {
                      media { id }
                      mediaUserErrors { message }
                    }
                  }`;
                  const imgResult = await shopifyGraphQLFast(shopDomain, accessToken, imgMutation, {
                    productId: newProduct.id,
                    media: [{ mediaContentType: "IMAGE", originalSource: directUrl }]
                  });
                  if (imgResult.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
                    console.error(`[SYNC] Image ${imgIdx+1} error for ${item.sku}:`, imgResult.data.productCreateMedia.mediaUserErrors[0].message);
                    logs.push(`Image Error (${item.sku}) #${imgIdx+1}: ${imgResult.data.productCreateMedia.mediaUserErrors[0].message}`);
                  } else {
                    console.log(`[SYNC] Image ${imgIdx+1}/${allImageUrls.length} added: ${item.sku}`);
                  }
                }
              }
              
              // Step 5: Add variant image if different from product image
              if (item.variantImage && item.variantImage !== item.imageSrc) {
                const variantUrls = item.variantImage.split(',').map((u: string) => u.trim()).filter(Boolean);
                for (const rawUrl of variantUrls) {
                  const directUrl = convertToDirectUrl(rawUrl);
                  const imgMutation = `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                    productCreateMedia(productId: $productId, media: $media) {
                      media { id }
                      mediaUserErrors { message }
                    }
                  }`;
                  await shopifyGraphQLFast(shopDomain, accessToken, imgMutation, {
                    productId: newProduct.id,
                    media: [{ mediaContentType: "IMAGE", originalSource: directUrl }]
                  });
                }
              }
              
              // Step 6: Publish product to Online Store sales channel
              if (onlineStorePublicationId && item.status === "ACTIVE") {
                const publishMutation = `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
                  publishablePublish(id: $id, input: $input) {
                    publishable { ... on Product { id } }
                    userErrors { field message }
                  }
                }`;
                const publishResult = await shopifyGraphQLFast(shopDomain, accessToken, publishMutation, {
                  id: newProduct.id,
                  input: [{ publicationId: onlineStorePublicationId }]
                });
                const pubErrs = publishResult.data?.publishablePublish?.userErrors;
                if (pubErrs?.length > 0) {
                  console.error(`[SYNC] Publish error for ${item.sku}:`, pubErrs[0].message);
                  logs.push(`Publish Error (${item.sku}): ${pubErrs[0].message}`);
                } else {
                  console.log(`[SYNC] Published to Online Store: ${item.sku}`);
                }
              }
              
              // Step 7: Set metafields if any mapped
              if (item.metafields && item.metafields.length > 0) {
                const metafieldsInput = item.metafields.map((mf: any) => {
                  const defKey = `${mf.namespace}.${mf.key}`;
                  const resolvedType = metafieldDefMap.get(defKey) || mf.type;
                  console.log(`[SYNC] Metafield ${mf.namespace}.${mf.key}: configured=${mf.type}, resolved=${resolvedType}, value="${mf.value}"`);
                  return {
                    ownerId: newProduct.id,
                    namespace: mf.namespace,
                    key: mf.key,
                    type: resolvedType,
                    value: mf.value
                  };
                });
                
                const mfMutation = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
                  metafieldsSet(metafields: $metafields) {
                    metafields { id namespace key value }
                    userErrors { field message }
                  }
                }`;
                const mfResult = await shopifyGraphQLFast(shopDomain, accessToken, mfMutation, { metafields: metafieldsInput });
                const mfErrs = mfResult.data?.metafieldsSet?.userErrors;
                if (mfErrs?.length > 0) {
                  console.error(`[SYNC] Batch metafield error for ${item.sku}, retrying individually:`, mfErrs[0].message);
                  // Atomic failure — retry each metafield individually
                  let mfOk = 0;
                  for (const singleMf of metafieldsInput) {
                    const singleResult = await shopifyGraphQLFast(shopDomain, accessToken, mfMutation, { metafields: [singleMf] });
                    const singleErrs = singleResult.data?.metafieldsSet?.userErrors;
                    if (singleErrs?.length > 0) {
                      console.error(`[SYNC] Metafield ${singleMf.namespace}.${singleMf.key} FAILED: ${singleErrs[0].message}`);
                      logs.push(`Metafield Error (${item.sku}) ${singleMf.namespace}.${singleMf.key}: ${singleErrs[0].message}`);
                    } else { mfOk++; }
                  }
                  console.log(`[SYNC] Metafields for ${item.sku}: ${mfOk}/${metafieldsInput.length} set individually`);
                } else {
                  console.log(`[SYNC] Metafields set for new product ${item.sku}: ${item.metafields.length} fields`);
                }
              }
              
            }
            
            createProgress++;
            await updateSyncSession(shopDomain, { type: "progress", current: createProgress, total: createBatch.length, message: `Step 2/6: Creating NEW products (${createProgress}/${createBatch.length})...` });
          }, 5); // 5 concurrent product creation pipelines
          
          console.log(`[SYNC] Created ${createdCount} products`);
        }

        // nonCreateUpdates already computed above

        if (nonCreateUpdates.length === 0 && Object.keys(productUpdates).length === 0) return await updateSyncSession(shopDomain, { type: "complete", updatedCount: createdCount, errorCount: logs.length, logs, duration: Date.now() - startTime, syncLogId, syncResults: syncResultsArr, syncMode });

        // ──────────────────────────────────────────────────────────────────────
        // TURBO PATH: Price + Stock + Metafields only → massively parallel batching
        // Achieves 10K products in ~5-10 minutes instead of ~4 hours
        // ──────────────────────────────────────────────────────────────────────
        const isTurboEligible = !isFullSync && shouldSyncPrice && shouldSyncStock && !shouldSyncImages && !shouldSyncProductFields && !shouldSyncVariantFields && !shouldSyncInventoryFields;
        
        if (isTurboEligible && nonCreateUpdates.length > 0) {
          console.log(`[SYNC] ⚡ TURBO MODE: ${nonCreateUpdates.length} updates (price+stock+meta in parallel)`);
          await updateSyncSession(shopDomain, { type: "progress", current: 0, total: nonCreateUpdates.length, message: `⚡ Turbo Sync: ${nonCreateUpdates.length} products (parallel batching)...` });
          
          // Separate price and stock updates
          const turboPriceUpdates = nonCreateUpdates.filter((u: any) => u.type === "price").map((u: any) => ({
            sku: u.sku, variantId: u.id, productId: u.productId, price: u.price, compareAtPrice: u.compareAtPrice, priceChanged: u.priceChanged, compareAtPriceChanged: u.compareAtPriceChanged
          }));
          const turboStockUpdates = nonCreateUpdates.filter((u: any) => u.type === "inv").map((u: any) => ({
            sku: u.sku, invId: u.id, value: u.value
          }));
          
          // Collect metafield updates from productUpdates map
          const turboMetaUpdates: Array<{ productId: string; metafields: Array<{ namespace: string; key: string; type: string; value: string }> }> = [];
          for (const [productId, upd] of Object.entries(productUpdates)) {
            if (upd.metafields && upd.metafields.length > 0) {
              turboMetaUpdates.push({ productId, metafields: upd.metafields });
            }
          }
          
          const turboResult = await turboSyncPriceStockMeta(
            shopDomain, accessToken, locationId!,
            turboPriceUpdates, turboStockUpdates, turboMetaUpdates,
            metafieldDefMap,
            (phase, current, total) => {
              updateSyncSession(shopDomain, { type: "progress", current, total, message: `⚡ ${phase}: ${current}/${total}` }).catch(() => {});
            }
          );
          
          turboResult.logs.forEach(l => logs.push(l));
          const turboTotal = turboResult.priceOk + turboResult.stockOk + turboResult.metaOk + createdCount;
          const turboErrors = turboResult.priceErr + turboResult.stockErr + turboResult.metaErr + logs.filter(l => l.includes("Create Error")).length;
          console.log(`[SYNC] ⚡ TURBO COMPLETE: price=${turboResult.priceOk}ok/${turboResult.priceErr}err, stock=${turboResult.stockOk}ok/${turboResult.stockErr}err, meta=${turboResult.metaOk}ok/${turboResult.metaErr}err`);
          
          return await updateSyncSession(shopDomain, { type: "complete", updatedCount: turboTotal, errorCount: turboErrors, logs, duration: Date.now() - startTime, syncLogId, syncResults: syncResultsArr, syncMode });
        }

        // ──────────────────────────────────────────────────────────────────────
        // BULK OPERATIONS for "Sync All" modes (2-5 min for 10K+ products)
        // Handles: Product-level fields (title, description, vendor, tags, metafields)
        // Then continues to price/stock/variants/images via optimized individual mutations
        // ──────────────────────────────────────────────────────────────────────
        const useBulkOperations = isFullSync && (Object.keys(productUpdates).length > 50);
        let bulkSuccessCount = 0;
        let productFieldsSyncedViaBulk = false;
        
        if (useBulkOperations) {
          console.log(`[SYNC] Using BULK OPERATIONS for ${Object.keys(productUpdates).length} product field updates`);
          
          try {
            // Step 1: Build JSONL content (product-level fields + metafields only)
            await updateSyncSession(shopDomain, { type: "progress", current: 0, total: 100, message: "Step 3/7: Preparing bulk operation..." });
            const jsonlContent = buildBulkOperationJSONL(productUpdates);
            
            if (!jsonlContent || jsonlContent.trim().length === 0) {
              console.log(`[SYNC] No JSONL content generated, using individual mutations for all updates`);
            } else {
              // Step 2: Create staged upload
              await updateSyncSession(shopDomain, { type: "progress", current: 10, total: 100, message: "Step 3/7: Creating staged upload..." });
              const stagedUpload = await createStagedUpload(shopDomain, accessToken);
              
              // Step 3: Upload JSONL file
              await updateSyncSession(shopDomain, { type: "progress", current: 20, total: 100, message: "Step 3/7: Uploading data to Shopify..." });
              await uploadJSONLFile(stagedUpload.url, stagedUpload.parameters, jsonlContent);
              
              // Step 4: Start bulk operation
              await updateSyncSession(shopDomain, { type: "progress", current: 30, total: 100, message: "Step 3/7: Starting bulk operation..." });
              const bulkOpId = await startBulkOperation(shopDomain, accessToken, stagedUpload.resourceUrl);
              
              // Step 5: Poll until complete (with progress updates)
              await updateSyncSession(shopDomain, { type: "progress", current: 40, total: 100, message: "Step 3/7: Processing bulk operation (this takes 2-5 minutes)..." });
              
              const bulkResult = await pollBulkOperation(shopDomain, accessToken, bulkOpId, (objectCount, status) => {
                const progress = 40 + Math.floor((objectCount / Object.keys(productUpdates).length) * 40);
                updateSyncSession(shopDomain, { 
                  type: "progress", 
                  current: Math.min(progress, 80), 
                  total: 100, 
                  message: `Step 3/7: Shopify processing ${objectCount}/${Object.keys(productUpdates).length} products... (${status})` 
                }).catch(e => console.error(`[SYNC] Progress update failed:`, e));
              });
              
              // Step 6: Download and parse results
              await updateSyncSession(shopDomain, { type: "progress", current: 85, total: 100, message: "Step 3/7: Downloading results..." });
              const results = bulkResult.url ? await downloadBulkResults(bulkResult.url) : [];
              
              // Step 7: Process results
              let bulkErrorCount = 0;
              
              results.forEach((result: any) => {
                if (result.userErrors && result.userErrors.length > 0) {
                  bulkErrorCount++;
                  logs.push(`Bulk Error: ${result.userErrors[0].message}`);
                  console.error(`[BULK OPS] Error:`, result.userErrors[0]);
                } else {
                  bulkSuccessCount++;
                }
              });
              
              console.log(`[SYNC] Bulk operation completed: ${bulkSuccessCount} products updated, ${bulkErrorCount} errors`);
              logs.push(`Bulk operation: ${bulkSuccessCount} products updated (fields + metafields)`);
              productFieldsSyncedViaBulk = true;
              
              // Clear productUpdates since they've been processed via bulk ops
              // This prevents them from being processed again in individual mutation loops
              Object.keys(productUpdates).forEach(key => delete productUpdates[key]);
            }
          } catch (bulkError: any) {
            console.error(`[SYNC] Bulk operation failed:`, bulkError.message);
            logs.push(`Bulk operation failed: ${bulkError.message} - continuing with individual mutations`);
            // Fall through to individual mutations below
          }
        }

        // ──────────────────────────────────────────────────────────────────────
        // TURBO BATCH for price/stock/metafields (used in ALL sync modes)
        // Replaces the old sequential loops with parallel batching
        // ──────────────────────────────────────────────────────────────────────
        const turboPriceUpdates2 = nonCreateUpdates.filter((u: any) => u.type === "price").map((u: any) => ({
          sku: u.sku, variantId: u.id, productId: u.productId, price: u.price, compareAtPrice: u.compareAtPrice, priceChanged: u.priceChanged, compareAtPriceChanged: u.compareAtPriceChanged
        }));
        const turboStockUpdates2 = nonCreateUpdates.filter((u: any) => u.type === "inv").map((u: any) => ({
          sku: u.sku, invId: u.id, value: u.value
        }));
        const turboMetaUpdates2: Array<{ productId: string; metafields: Array<{ namespace: string; key: string; type: string; value: string }> }> = [];
        for (const [productId, upd] of Object.entries(productUpdates)) {
          if (upd.metafields && upd.metafields.length > 0) {
            turboMetaUpdates2.push({ productId, metafields: upd.metafields });
          }
        }

        if (turboPriceUpdates2.length > 0 || turboStockUpdates2.length > 0 || turboMetaUpdates2.length > 0) {
          const turboTotal2 = turboPriceUpdates2.length + turboStockUpdates2.length + turboMetaUpdates2.length;
          console.log(`[SYNC] ⚡ TURBO price/stock/meta: ${turboPriceUpdates2.length} price, ${turboStockUpdates2.length} stock, ${turboMetaUpdates2.length} meta products`);
          await updateSyncSession(shopDomain, { type: "progress", current: 0, total: turboTotal2, message: `⚡ Turbo: syncing ${turboTotal2} price/stock/meta updates in parallel...` });

          const turboResult2 = await turboSyncPriceStockMeta(
            shopDomain, accessToken, locationId!,
            turboPriceUpdates2, turboStockUpdates2, turboMetaUpdates2,
            metafieldDefMap,
            (phase, current, total) => {
              updateSyncSession(shopDomain, { type: "progress", current, total, message: `⚡ ${phase}: ${current}/${total}` }).catch(() => {});
            }
          );

          turboResult2.logs.forEach(l => logs.push(l));
          bulkSuccessCount += turboResult2.priceOk + turboResult2.stockOk + turboResult2.metaOk;
          console.log(`[SYNC] ⚡ TURBO price/stock/meta done: price=${turboResult2.priceOk}/${turboResult2.priceErr}, stock=${turboResult2.stockOk}/${turboResult2.stockErr}, meta=${turboResult2.metaOk}/${turboResult2.metaErr}`);
          
          // Clear metafields from productUpdates so they're not processed again in the product fields loop
          for (const [productId] of Object.entries(productUpdates)) {
            if (productUpdates[productId]) delete productUpdates[productId].metafields;
          }
        }

        // ── Step 3: Product-level updates (ALL fields: title, description, vendor, etc.) ──
        const productUpdateEntries = Object.entries(productUpdates);
        let productUpdateCount = 0;
        console.log(`[SYNC] Step 3: Updating ${productUpdateEntries.length} products with ALL fields...`);
        
        for (let pi = 0; pi < productUpdateEntries.length; pi += 10) {
          if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
          const chunk = productUpdateEntries.slice(pi, pi + 10);

          // Build productUpdate mutation with ALL product-level fields
          const fieldsChunk = chunk.filter(([, upd]) => 
            upd.title || upd.description || upd.vendor || upd.productType || upd.handle || 
            upd.tags !== undefined || upd.status || upd.giftCard !== undefined
          );
          
          if (fieldsChunk.length > 0) {
            let mutation = "mutation {";
            fieldsChunk.forEach(([productId, upd], idx) => {
              const inputParts: string[] = [`id: "${productId}"`];
              if (upd.title) inputParts.push(`title: ${JSON.stringify(upd.title)}`);
              if (upd.description) inputParts.push(`descriptionHtml: ${JSON.stringify(upd.description)}`);
              if (upd.vendor) inputParts.push(`vendor: ${JSON.stringify(upd.vendor)}`);
              if (upd.productType) inputParts.push(`productType: ${JSON.stringify(upd.productType)}`);
              if (upd.handle) inputParts.push(`handle: ${JSON.stringify(upd.handle)}`);
              if (upd.tags !== undefined) inputParts.push(`tags: ${JSON.stringify(upd.tags)}`);
              if (upd.status) inputParts.push(`status: ${upd.status}`);
              if (upd.giftCard !== undefined) inputParts.push(`giftCard: ${upd.giftCard}`);
              mutation += ` p${idx}: productUpdate(input: { ${inputParts.join(", ")} }) { product { id title } userErrors { field message } }`;
            });
            mutation += " }";
            
            const result = await shopifyGraphQL(shopDomain, accessToken, mutation);
            if (result.errors) logs.push(`Product Update Error: ${result.errors[0]?.message || JSON.stringify(result.errors)}`);
            Object.keys(result.data || {}).forEach(key => {
              const errs = result.data[key]?.userErrors;
              if (errs?.length > 0) { 
                logs.push(`Product Field Error: ${errs[0].message}`); 
              } else { 
                productUpdateCount++;
              }
            });
          }

          // Metafields already handled by turbo batch above — skip

          // Images via productCreateMedia (only if shouldSyncImages, supports comma-separated)
          for (const [productId, upd] of chunk) {
            if (!upd.imageSrc) continue;
            const allImageUrls = upd.imageSrc.split(',').map((u: string) => u.trim()).filter(Boolean);
            for (let imgIdx = 0; imgIdx < allImageUrls.length; imgIdx++) {
              const directUrl = convertToDirectUrl(allImageUrls[imgIdx]);
              const imgMutation = `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $productId, media: $media) {
                  media { id }
                  mediaUserErrors { message }
                }
              }`;
              const imgResult = await shopifyGraphQL(shopDomain, accessToken, imgMutation, {
                productId,
                media: [{ mediaContentType: "IMAGE", originalSource: directUrl }]
              });
              const imgErrs = imgResult.data?.productCreateMedia?.mediaUserErrors;
              if (imgErrs?.length > 0) {
                logs.push(`Image Error (${productId}) #${imgIdx+1}: ${imgErrs[0].message}`);
              } else if (imgIdx === 0) {
                productUpdateCount++;
              }
            }
          }

          await updateSyncSession(shopDomain, { type: "progress", current: Math.min(pi + 10, productUpdateEntries.length), total: productUpdateEntries.length, message: `Step 4/6: Updating product fields & metafields (${Math.min(pi + 10, productUpdateEntries.length)}/${productUpdateEntries.length})...` });
        }
        
        // ── Step 4: Variant-level updates (barcode, taxable, options) ──
        const variantUpdateEntries = Object.entries(variantUpdates);
        let variantUpdateCount = 0;
        if (variantUpdateEntries.length > 0) {
          console.log(`[SYNC] Step 4: Updating ${variantUpdateEntries.length} variants...`);
          
          // Group by productId for productVariantsBulkUpdate
          const byProduct: Record<string, Array<{ sku: string; variantId: string; data: any }>> = {};
          for (const [sku, data] of variantUpdateEntries) {
            if (!byProduct[data.productId]) byProduct[data.productId] = [];
            byProduct[data.productId].push({ sku, variantId: data.variantId, data });
          }
          
          const productIds = Object.keys(byProduct);
          for (let vi = 0; vi < productIds.length; vi += 5) {
            if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
            const pidChunk = productIds.slice(vi, vi + 5);
            
            let mutation = "mutation {";
            pidChunk.forEach((productId, pIdx) => {
              const variants = byProduct[productId];
              const variantInputs = variants.map(v => {
                const fields: string[] = [`id: "${v.variantId}"`];
                if (v.data.barcode) fields.push(`barcode: ${JSON.stringify(v.data.barcode)}`);
                if (v.data.taxable !== undefined) fields.push(`taxable: ${v.data.taxable}`);
                if (v.data.inventoryPolicy) fields.push(`inventoryPolicy: ${v.data.inventoryPolicy}`);
                // Option values - these require specific handling in Shopify API 2025-01
                // Note: Changing options on existing variants is complex and may require productVariantsBulkUpdate
                return `{ ${fields.join(", ")} }`;
              }).join(", ");
              mutation += ` v${pIdx}: productVariantsBulkUpdate(productId: "${productId}", variants: [${variantInputs}]) { productVariants { id barcode } userErrors { field message } }`;
            });
            mutation += " }";
            
            const result = await shopifyGraphQL(shopDomain, accessToken, mutation);
            if (result.errors) logs.push(`Variant Update Error: ${result.errors[0]?.message}`);
            Object.keys(result.data || {}).forEach(key => {
              const errs = result.data[key]?.userErrors;
              if (errs?.length > 0) { 
                logs.push(`Variant Field Error: ${errs[0].message}`); 
              } else {
                variantUpdateCount += byProduct[productIds[parseInt(key.slice(1))]]?.length || 0;
              }
            });
            
            await updateSyncSession(shopDomain, { type: "progress", current: Math.min(vi + 5, productIds.length), total: productIds.length, message: `Step 5/6: Updating variant fields (${Math.min(vi + 5, productIds.length)}/${productIds.length})...` });
          }
        }
        
        // ── Step 5: Inventory item updates (weight, requiresShipping) ──
        const invItemUpdateEntries = Object.entries(inventoryItemUpdates);
        let invItemUpdateCount = 0;
        if (invItemUpdateEntries.length > 0) {
          console.log(`[SYNC] Step 5: Updating ${invItemUpdateEntries.length} inventory items...`);
          
          for (let ii = 0; ii < invItemUpdateEntries.length; ii += 10) {
            if (syncSessions[shopDomain]?.cancelled) throw new Error("Sync terminated by user");
            const chunk = invItemUpdateEntries.slice(ii, ii + 10);
            
            for (const [sku, data] of chunk) {
              const invItemInput: any = {};
              if (data.weight !== undefined) {
                invItemInput.measurement = {
                  weight: {
                    value: data.weight,
                    unit: data.weightUnit || "GRAMS"
                  }
                };
              }
              if (data.requiresShipping !== undefined) {
                invItemInput.requiresShipping = data.requiresShipping;
              }
              
              if (Object.keys(invItemInput).length > 0) {
                const invItemMutation = `mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
                  inventoryItemUpdate(id: $id, input: $input) {
                    inventoryItem { id }
                    userErrors { field message }
                  }
                }`;
                const invItemResult = await shopifyGraphQL(shopDomain, accessToken, invItemMutation, { id: data.invItemId, input: invItemInput });
                const errs = invItemResult.data?.inventoryItemUpdate?.userErrors;
                if (errs?.length > 0) {
                  logs.push(`Inv Item Error (${sku}): ${errs[0].message}`);
                } else {
                  invItemUpdateCount++;
                }
              }
            }
            
            await updateSyncSession(shopDomain, { type: "progress", current: Math.min(ii + 10, invItemUpdateEntries.length), total: invItemUpdateEntries.length, message: `Step 6/6: Updating inventory items (${Math.min(ii + 10, invItemUpdateEntries.length)}/${invItemUpdateEntries.length})...` });
          }
        }

        const totalUpdated = createdCount + bulkSuccessCount + (nonCreateUpdates.length - logs.filter(l => !l.includes("Create Error")).length) + productUpdateCount + variantUpdateCount + invItemUpdateCount;
        console.log(`[SYNC] Complete: created=${createdCount}, bulk=${bulkSuccessCount}, product fields=${productUpdateCount}, variant fields=${variantUpdateCount}, inv items=${invItemUpdateCount}`);
        await updateSyncSession(shopDomain, { type: "complete", updatedCount: totalUpdated, errorCount: logs.length, logs, duration: Date.now() - startTime, syncLogId, syncResults: syncResultsArr, syncMode });
      } catch (err: any) {
        console.error(`[SYNC] Global Error:`, err);
        await updateSyncSession(shopDomain, { type: "error", message: err.message, syncLogId, syncResults: syncResultsArr, logs, duration: Date.now() - startTime, syncMode });
      }
    })();
    res.json({ success: true });
  });

  app.get("/api/sync/status", authenticateToken, (req, res) => {
    const session = syncSessions[req.query.shopDomain as string];
    if (!session) return res.json({ status: "idle" });
    const { clients, ...safe } = session;
    // Include elapsed time so frontend can restore the timer
    if (safe.status === "loading" && safe.startedAt) {
      safe.elapsedMs = Date.now() - safe.startedAt;
    }
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
      const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: store.spreadsheetId, range: store.sheetName || "Template" });
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
      const header = "sku,product_title,status,action,message,row_number,shopify_product_id,created_at";
      const body = rows.map((r: any) =>
        `"${r.sku}","${(r.product_title || '').replace(/"/g, '""')}","${r.status}","${r.action}","${(r.message || '').replace(/"/g, '""')}",${r.row_number},"${r.shopify_product_id || ''}","${r.created_at}"`
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
    app.get('/api/public-debug', async (req, res) => {
      try {
        const logs = await pool.query("SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT 10");
        const ms = await pool.query("SELECT id, shop_domain, name FROM master_stores");
        res.json({ logs: logs.rows, stores: ms.rows });
      } catch(e: any) {
        res.status(500).json({ error: e.message || String(e) });
      }
    });
    app.get("*", (req, res) => res.sendFile(path.join(path.resolve(), "dist", "index.html")));
  }

  app.listen(Number(PORT), "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}

startServer().catch(console.error);
