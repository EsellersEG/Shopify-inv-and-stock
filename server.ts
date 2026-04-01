import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // Database Setup
  const defaultData = { users: [], clients: [], stores: [] };
  const db = await JSONFilePreset(path.join(__dirname, "data", "db.json"), defaultData);
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

  // Admin: Assign Store to Client
  app.post("/api/admin/clients/:clientId/stores", authenticateToken, isAdmin, async (req, res) => {
    const { clientId } = req.params;
    const store = req.body; // { shopDomain, accessToken, spreadsheetId, serviceAccountJson, ... }
    
    const client = db.data.clients.find(c => c.id === clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const newStore = {
      id: `store-${Date.now()}`,
      ...store
    };

    client.stores.push(newStore);
    await db.write();

    res.json({ success: true, store: newStore });
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

  // Sync Sheets to Shopify (Streaming)
  app.post("/api/sync/sheets-to-shopify", authenticateToken, async (req, res) => {
    const { shopDomain, accessToken, spreadsheetId, serviceAccountJson, mapping, sheetName, syncMode } = req.body;
    
    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const startTime = Date.now();
      // 1. Get data from Google Sheets
      const credentials = JSON.parse(serviceAccountJson);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      const sheets = google.sheets({ version: "v4", auth });
      
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetName || "Sheet1",
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        sendEvent({ type: 'error', message: "No data found in sheet." });
        return res.end();
      }

      // Assume first row is headers
      const headers = rows[0];
      const skuIndex = headers.indexOf(mapping.sku);
      const priceIndex = headers.indexOf(mapping.price);
      const inventoryIndex = headers.indexOf(mapping.inventory);

      if (skuIndex === -1) {
        sendEvent({ type: 'error', message: `SKU column '${mapping.sku}' not found.` });
        return res.end();
      }

      let updatedCount = 0;
      let errorCount = 0;
      const logs: string[] = [];
      const totalRows = rows.length - 1;

      const shouldSyncPrice = syncMode === 'price' || syncMode === 'both';
      const shouldSyncStock = syncMode === 'stock' || syncMode === 'both';

      // Fetch location ID once if we need to sync stock
      let locationId: string | null = null;
      if (shouldSyncStock) {
        const locRes = await fetch(`https://${shopDomain}/admin/api/2024-01/locations.json`, {
          headers: { "X-Shopify-Access-Token": accessToken },
        });
        if (locRes.ok) {
          const locData = await locRes.json();
          locationId = locData.locations[0]?.id;
        } else {
          sendEvent({ type: 'error', message: "Failed to fetch Shopify locations. Check your access token permissions (needs read_locations)." });
          return res.end();
        }
      }

      const skusFromSheet = new Set<string>();
      for (let i = 1; i < rows.length; i++) {
        const sku = rows[i][skuIndex];
        if (sku) skusFromSheet.add(sku);
      }
      const skusArray = Array.from(skusFromSheet);

      const shopifyVariants = new Map<string, any>();

      if (skusArray.length > 2000) {
        sendEvent({ type: 'progress', current: 0, total: totalRows, message: 'Fetching existing Shopify products for fast comparison...' });
        let hasNextPage = true;
        let cursor: string | null = null;

        while (hasNextPage) {
          const query = `
            query getVariants($cursor: String) {
              productVariants(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                edges {
                  node {
                    id
                    sku
                    price
                    inventoryItem {
                      id
                      inventoryLevels(first: 5) {
                        edges {
                          node {
                            location { id }
                            quantities(names: ["available"]) {
                              name
                              quantity
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `;
          const variables = { cursor };
          const gqlRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
          });

          if (!gqlRes.ok) {
            sendEvent({ type: 'error', message: 'Failed to fetch Shopify products for comparison.' });
            return res.end();
          }

          const data = await gqlRes.json();
          if (data.errors) {
            sendEvent({ type: 'error', message: `GraphQL Error: ${data.errors[0].message}` });
            return res.end();
          }

          const connection = data.data.productVariants;
          for (const edge of connection.edges) {
            const node = edge.node;
            if (node.sku) {
              let available = 0;
              if (node.inventoryItem?.inventoryLevels?.edges) {
                const level = node.inventoryItem.inventoryLevels.edges.find((e: any) => e.node.location.id === `gid://shopify/Location/${locationId}`);
                if (level) {
                  const availableQuantity = level.node.quantities?.find((q: any) => q.name === 'available');
                  if (availableQuantity) available = availableQuantity.quantity;
                }
              }
              shopifyVariants.set(node.sku, {
                variantId: node.id,
                inventoryItemId: node.inventoryItem?.id,
                price: node.price,
                available: available
              });
            }
          }

          hasNextPage = connection.pageInfo.hasNextPage;
          cursor = connection.pageInfo.endCursor;
          sendEvent({ type: 'progress', current: shopifyVariants.size, total: totalRows, message: `Fetched ${shopifyVariants.size} products from Shopify...` });
          
          const throttle = data.extensions?.cost?.throttleStatus;
          if (throttle && throttle.currentlyAvailable < 500) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } else {
        sendEvent({ type: 'progress', current: 0, total: skusArray.length, message: `Fetching ${skusArray.length} products from Shopify for comparison...` });
        const chunkSize = 50;
        for (let i = 0; i < skusArray.length; i += chunkSize) {
          const chunk = skusArray.slice(i, i + chunkSize);
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
                      id
                      sku
                      price
                      inventoryItem {
                        id
                        inventoryLevels(first: 5) {
                          edges {
                            node {
                              location { id }
                              quantities(names: ["available"]) {
                                name
                                quantity
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            `;
            const variables = { cursor, queryStr };
            const gqlRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
              method: "POST",
              headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
              body: JSON.stringify({ query, variables }),
            });

            if (!gqlRes.ok) {
              sendEvent({ type: 'error', message: 'Failed to fetch Shopify products for comparison.' });
              return res.end();
            }

            const data = await gqlRes.json();
            if (data.errors) {
              sendEvent({ type: 'error', message: `GraphQL Error: ${data.errors[0].message}` });
              return res.end();
            }

            const connection = data.data.productVariants;
            for (const edge of connection.edges) {
              const node = edge.node;
              if (node.sku) {
                let available = 0;
                if (node.inventoryItem?.inventoryLevels?.edges) {
                  const level = node.inventoryItem.inventoryLevels.edges.find((e: any) => e.node.location.id === `gid://shopify/Location/${locationId}`);
                  if (level) {
                    const availableQuantity = level.node.quantities?.find((q: any) => q.name === 'available');
                    if (availableQuantity) available = availableQuantity.quantity;
                  }
                }
                shopifyVariants.set(node.sku, {
                  variantId: node.id,
                  inventoryItemId: node.inventoryItem?.id,
                  price: node.price,
                  available: available
                });
              }
            }

            hasNextPage = connection.pageInfo.hasNextPage;
            cursor = connection.pageInfo.endCursor;
            
            const throttle = data.extensions?.cost?.throttleStatus;
            if (throttle && throttle.currentlyAvailable < 500) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          sendEvent({ type: 'progress', current: Math.min(i + chunkSize, skusArray.length), total: skusArray.length, message: `Fetched ${Math.min(i + chunkSize, skusArray.length)} of ${skusArray.length} products from Shopify...` });
        }
      }

      sendEvent({ type: 'progress', current: 0, total: totalRows, message: 'Comparing data to find changes...' });

      const priceUpdates: { id: string, price: string, sku: string }[] = [];
      const inventoryUpdates: { inventoryItemId: string, locationId: string, quantity: number, sku: string }[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const sku = row[skuIndex];
        const sheetPrice = priceIndex !== -1 ? row[priceIndex] : null;
        const sheetInventory = inventoryIndex !== -1 ? row[inventoryIndex] : null;

        if (!sku) continue;

        const shopifyData = shopifyVariants.get(sku);
        if (!shopifyData) {
          logs.push(`SKU ${sku} not found in Shopify, skipping.`);
          errorCount++;
          continue;
        }

        if (shouldSyncPrice && sheetPrice !== null && sheetPrice !== undefined && sheetPrice !== "") {
          if (parseFloat(sheetPrice) !== parseFloat(shopifyData.price)) {
            priceUpdates.push({ id: shopifyData.variantId, price: sheetPrice, sku });
          }
        }

        if (shouldSyncStock && sheetInventory !== null && sheetInventory !== undefined && sheetInventory !== "") {
          const parsedInv = parseInt(sheetInventory, 10);
          if (!isNaN(parsedInv) && parsedInv !== shopifyData.available) {
            inventoryUpdates.push({ 
              inventoryItemId: shopifyData.inventoryItemId, 
              locationId: `gid://shopify/Location/${locationId}`, 
              quantity: parsedInv,
              sku
            });
          }
        }
      }

      const totalUpdates = priceUpdates.length + inventoryUpdates.length;
      let completedUpdates = 0;
      
      if (totalUpdates === 0) {
        const duration = Date.now() - startTime;
        sendEvent({ type: 'progress', current: totalRows, total: totalRows, message: `Everything is up to date! No changes needed.` });
        sendEvent({ type: 'complete', updatedCount: 0, errorCount, logs, duration });
        return res.end();
      }

      sendEvent({ type: 'progress', current: 0, total: totalUpdates, message: `Found ${totalUpdates} changes. Pushing updates to Shopify...` });

      // Execute Inventory Updates (Batch of 100)
      if (inventoryUpdates.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < inventoryUpdates.length; i += batchSize) {
          const batch = inventoryUpdates.slice(i, i + batchSize);
          const quantities = batch.map(u => ({
            inventoryItemId: u.inventoryItemId,
            locationId: u.locationId,
            quantity: u.quantity
          }));

          const query = `
            mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) {
                userErrors { field message }
              }
            }
          `;
          const variables = {
            input: {
              name: "available",
              reason: "correction",
              ignoreCompareQuantity: true,
              quantities: quantities
            }
          };

          const gqlRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
          });

          if (gqlRes.ok) {
            const data = await gqlRes.json();
            if (data.data?.inventorySetQuantities?.userErrors?.length > 0) {
              logs.push(`Inventory batch error: ${data.data.inventorySetQuantities.userErrors[0].message}`);
              errorCount += batch.length;
            } else {
              updatedCount += batch.length;
            }
            
            const throttle = data.extensions?.cost?.throttleStatus;
            if (throttle && throttle.currentlyAvailable < 200) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          } else {
            logs.push(`Failed to update inventory batch.`);
            errorCount += batch.length;
          }

          completedUpdates += batch.length;
          sendEvent({ type: 'progress', current: completedUpdates, total: totalUpdates, message: `Updating inventory... (${completedUpdates}/${totalUpdates})` });
        }
      }

      // Execute Price Updates (Batch of 10 using aliases)
      if (priceUpdates.length > 0) {
        const batchSize = 10;
        for (let i = 0; i < priceUpdates.length; i += batchSize) {
          const batch = priceUpdates.slice(i, i + batchSize);
          
          let mutationString = `mutation {`;
          batch.forEach((u, index) => {
            mutationString += `
              v${index}: productVariantUpdate(input: {id: "${u.id}", price: "${u.price}"}) {
                userErrors { message }
              }
            `;
          });
          mutationString += `}`;

          const gqlRes = await fetch(`https://${shopDomain}/admin/api/2024-01/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query: mutationString }),
          });

          if (gqlRes.ok) {
            const data = await gqlRes.json();
            batch.forEach((u, index) => {
              const errors = data.data?.[`v${index}`]?.userErrors;
              if (errors && errors.length > 0) {
                logs.push(`Failed to update price for SKU ${u.sku}: ${errors[0].message}`);
                errorCount++;
              } else {
                updatedCount++;
              }
            });
            
            const throttle = data.extensions?.cost?.throttleStatus;
            if (throttle && throttle.currentlyAvailable < 200) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } else {
            logs.push(`Failed to update price batch.`);
            errorCount += batch.length;
          }

          completedUpdates += batch.length;
          sendEvent({ type: 'progress', current: completedUpdates, total: totalUpdates, message: `Updating prices... (${completedUpdates}/${totalUpdates})` });
        }
      }

      const duration = Date.now() - startTime;
      sendEvent({ type: 'complete', updatedCount, errorCount, logs, duration });
      res.end();
    } catch (error: any) {
      sendEvent({ type: 'error', message: error.message });
      res.end();
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
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
