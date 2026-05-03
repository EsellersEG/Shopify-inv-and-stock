/**
 * Normalize a store object from the API to a consistent camelCase shape.
 * Works regardless of whether the API returns camelCase or snake_case keys.
 */
export function normalizeStore(store: any) {
  if (!store) return store;

  const rawFm = store.fieldMappings || store.field_mappings;
  const rawMfm = store.metafieldMappings || store.metafield_mappings;
  let fieldMappings: Record<string, string> = {};
  let metafieldMappings: any[] = [];
  try { fieldMappings = typeof rawFm === 'string' ? JSON.parse(rawFm || '{}') : (rawFm || {}); } catch {}
  try { metafieldMappings = typeof rawMfm === 'string' ? JSON.parse(rawMfm || '[]') : (Array.isArray(rawMfm) ? rawMfm : []); } catch {}

  return {
    ...store,
    id: store.id,
    name: store.name || '',
    shopDomain: store.shopDomain || store.shop_domain || '',
    accessToken: store.accessToken || store.access_token || '',
    spreadsheetId: store.spreadsheetId || store.spreadsheet_id || '',
    serviceAccountJson: store.serviceAccountJson || store.service_account_json || '',
    sheetName: store.sheetName || store.sheet_name || 'Template',
    skuCol: store.skuCol || store.sku_col || 'Variant SKU',
    priceCol: store.priceCol || store.price_col || 'Variant Price',
    compareAtPriceCol: store.compareAtPriceCol || store.compare_at_price_col || 'Variant Compare At Price',
    inventoryCol: store.inventoryCol || store.inventory_col || 'Variant Inventory Qty',
    fieldMappings,
    metafieldMappings,
  };
}
