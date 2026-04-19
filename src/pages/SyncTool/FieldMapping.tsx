import React, { useState, useEffect } from "react";
import { api } from "../../lib/api";
import { Save, ChevronDown, ChevronUp, Plus, Trash2, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

// ── Field definitions matching Shopify import/export format ──

const REQUIRED_FIELDS = [
  { shopifyField: "title", label: "Title *" },
  { shopifyField: "vendor", label: "Vendor *" },
  { shopifyField: "variant_sku", label: "Variant SKU *" },
  { shopifyField: "variant_price", label: "Variant Price *" },
  { shopifyField: "variant_inventory_qty", label: "Variant Inventory Qty *" },
];

const RECOMMENDED_FIELDS = [
  { shopifyField: "variant_barcode", label: "Variant Barcode" },
  { shopifyField: "tags", label: "Tags" },
  { shopifyField: "variant_grams", label: "Variant Weight" },
  { shopifyField: "image_src", label: "Image Src" },
  { shopifyField: "variant_image", label: "Variant Image" },
];

const OPTIONAL_FIELDS = [
  { shopifyField: "handle", label: "Handle" },
  { shopifyField: "body_html", label: "Body (HTML)" },
  { shopifyField: "product_type", label: "Product Type" },
  { shopifyField: "published", label: "Published" },
  { shopifyField: "option1_name", label: "Option1 Name" },
  { shopifyField: "option1_value", label: "Option1 Value" },
  { shopifyField: "option2_name", label: "Option2 Name" },
  { shopifyField: "option2_value", label: "Option2 Value" },
  { shopifyField: "option3_name", label: "Option3 Name" },
  { shopifyField: "option3_value", label: "Option3 Value" },
  { shopifyField: "variant_weight_unit", label: "Variant Weight Unit" },
  { shopifyField: "variant_inventory_policy", label: "Variant Inventory Policy" },
  { shopifyField: "variant_fulfillment_service", label: "Variant Fulfillment Service" },
  { shopifyField: "variant_compare_at_price", label: "Variant Compare At Price" },
  { shopifyField: "variant_requires_shipping", label: "Variant Requires Shipping" },
  { shopifyField: "variant_taxable", label: "Variant Taxable" },
  { shopifyField: "image_alt_text", label: "Image Alt Text" },
  { shopifyField: "gift_card", label: "Gift Card" },
  { shopifyField: "status", label: "Status" },
];

const METAFIELD_TYPES = [
  { value: "single_line_text_field", label: "Single line text" },
  { value: "multi_line_text_field", label: "Multi-line text" },
  { value: "number_integer", label: "Integer" },
  { value: "number_decimal", label: "Decimal" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
  { value: "url", label: "URL" },
  { value: "json", label: "JSON" },
];

interface MetafieldMapping {
  namespace: string;
  key: string;
  type: string;
  sheetColumn: string;
}

interface FieldMappingProps {
  storeId: string;
  spreadsheetId: string;
  serviceAccountJson: string;
  sheetName: string;
  // Legacy fields - for backward compat with sync
  skuCol: string;
  priceCol: string;
  compareAtPriceCol: string;
  inventoryCol: string;
  onMappingSave?: (mappings: Record<string, string>, metafields: MetafieldMapping[]) => void;
}

export default function FieldMapping({
  storeId,
  spreadsheetId,
  serviceAccountJson,
  sheetName,
  skuCol,
  priceCol,
  compareAtPriceCol,
  inventoryCol,
  onMappingSave,
}: FieldMappingProps) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [metafields, setMetafields] = useState<MetafieldMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRecommended, setShowRecommended] = useState(true);
  const [showOptional, setShowOptional] = useState(false);
  const [showMetafields, setShowMetafields] = useState(false);

  useEffect(() => {
    if (storeId) loadData();
  }, [storeId]);

  async function loadData() {
    setLoading(true);
    try {
      // Fetch sheet headers
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/stores/${storeId}/sheet-headers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.headers) {
        setHeaders(data.headers);
        setPreview(data.preview || {});
      }

      // Fetch existing store data to get field_mappings
      const storeRes = await fetch(`/api/admin/master-stores`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const stores = await storeRes.json();
      const store = Array.isArray(stores) ? stores.find((s: any) => s.id === storeId) : null;

      if (store) {
        let existingMappings: Record<string, string> = {};
        try {
          existingMappings = JSON.parse(store.field_mappings || "{}");
        } catch {}

        // Seed from legacy columns if no field_mappings exist
        if (Object.keys(existingMappings).length === 0) {
          existingMappings = {
            variant_sku: store.sku_col || skuCol || "SKU",
            variant_price: store.price_col || priceCol || "Price",
            variant_compare_at_price: store.compare_at_price_col || compareAtPriceCol || "",
            variant_inventory_qty: store.inventory_col || inventoryCol || "Inventory",
          };
          // Auto-detect other fields from headers
          const headerLower = data.headers?.map((h: string) => h.toLowerCase()) || [];
          const autoMap: Record<string, string[]> = {
            title: ["title"],
            vendor: ["vendor"],
            variant_barcode: ["variant barcode", "barcode"],
            tags: ["tags"],
            handle: ["handle"],
            body_html: ["body (html)", "body html", "description"],
            product_type: ["product type"],
            published: ["published"],
            status: ["status"],
            image_src: ["image src"],
            variant_image: ["variant image"],
            variant_grams: ["variant grams", "variant weight", "weight"],
            option1_name: ["option1 name"],
            option1_value: ["option1 value"],
            option2_name: ["option2 name"],
            option2_value: ["option2 value"],
            option3_name: ["option3 name"],
            option3_value: ["option3 value"],
            variant_weight_unit: ["variant weight unit"],
            variant_inventory_policy: ["variant inventory policy"],
            variant_fulfillment_service: ["variant fulfillment service"],
            variant_requires_shipping: ["variant requires shipping"],
            variant_taxable: ["variant taxable"],
          };
          for (const [field, possibles] of Object.entries(autoMap)) {
            if (existingMappings[field]) continue;
            for (const p of possibles) {
              const idx = headerLower.indexOf(p);
              if (idx !== -1) {
                existingMappings[field] = data.headers[idx];
                break;
              }
            }
          }
        }

        setMappings(existingMappings);

        let existingMetafields: MetafieldMapping[] = [];
        try {
          existingMetafields = JSON.parse(store.metafield_mappings || "[]");
        } catch {}
        setMetafields(existingMetafields);
      }
    } catch (e) {
      console.error("Failed to load field mapping data:", e);
    } finally {
      setLoading(false);
    }
  }

  function setMapping(shopifyField: string, sheetColumn: string) {
    setMappings((prev) => {
      const next = { ...prev };
      if (sheetColumn) {
        next[shopifyField] = sheetColumn;
      } else {
        delete next[shopifyField];
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const token = localStorage.getItem("token");
      
      // Fetch the current store data first so we can merge
      const storeRes = await fetch(`/api/admin/master-stores`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const stores = await storeRes.json();
      const store = Array.isArray(stores) ? stores.find((s: any) => s.id === storeId) : null;
      
      if (!store) {
        console.error("Store not found for saving");
        return;
      }

      await fetch(`/api/admin/master-stores/${storeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: store.name,
          shopDomain: store.shop_domain,
          accessToken: store.access_token,
          spreadsheetId: store.spreadsheet_id,
          serviceAccountJson: store.service_account_json,
          sheetName: store.sheet_name,
          fieldMappings: mappings,
          metafieldMappings: metafields,
          // Keep legacy columns in sync
          skuCol: mappings.variant_sku || store.sku_col || skuCol,
          priceCol: mappings.variant_price || store.price_col || priceCol,
          compareAtPriceCol: mappings.variant_compare_at_price || store.compare_at_price_col || compareAtPriceCol,
          inventoryCol: mappings.variant_inventory_qty || store.inventory_col || inventoryCol,
        }),
      });
      onMappingSave?.(mappings, metafields);
    } catch (e) {
      console.error("Failed to save mappings:", e);
    } finally {
      setSaving(false);
    }
  }

  const allRequiredMapped = REQUIRED_FIELDS.every((f) => mappings[f.shopifyField]);

  function renderFieldRow(field: { shopifyField: string; label: string }) {
    const selectedCol = mappings[field.shopifyField] || "";
    const previewVal = selectedCol ? preview[selectedCol] || "-" : "-";

    return (
      <tr key={field.shopifyField} className="border-b border-gray-50 last:border-0">
        <td className="py-3.5 pr-4 text-sm font-bold text-black">{field.label}</td>
        <td className="py-3.5 pr-4">
          <select
            className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-2.5 text-sm font-bold text-black outline-none focus:ring-2 focus:ring-[#FFA500]/50 appearance-none cursor-pointer"
            value={selectedCol}
            onChange={(e) => setMapping(field.shopifyField, e.target.value)}
          >
            <option value="">-- Select Column --</option>
            {headers.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </td>
        <td className="py-3.5 text-sm text-gray-500 truncate max-w-[200px]" title={previewVal}>
          {previewVal}
        </td>
      </tr>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[#FFA500]" />
      </div>
    );
  }

  if (headers.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400 font-bold uppercase text-xs tracking-widest">
        No sheet headers found. Make sure the spreadsheet and sheet name are configured correctly.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Status */}
      <div className={`flex items-center gap-3 px-6 py-4 rounded-2xl border ${allRequiredMapped ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
        {allRequiredMapped ? (
          <>
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            <span className="text-sm font-bold text-emerald-800">All required fields mapped</span>
          </>
        ) : (
          <>
            <AlertCircle className="w-5 h-5 text-amber-600" />
            <span className="text-sm font-bold text-amber-800">Some required fields are not mapped</span>
          </>
        )}
        <div className="ml-auto">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 bg-[#FFA500] hover:bg-orange-600 text-white px-6 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-lg shadow-orange-500/20 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>{saving ? "Saving..." : "Save Mappings"}</span>
          </button>
        </div>
      </div>

      {/* Required Fields */}
      <div className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-gray-100">
          <h3 className="text-sm font-black text-black uppercase tracking-widest">Required Fields</h3>
        </div>
        <div className="px-8 py-4">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest w-1/4">Shopify Field</th>
                <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest w-1/3">Google Sheet Column</th>
                <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest">Preview Value</th>
              </tr>
            </thead>
            <tbody>{REQUIRED_FIELDS.map(renderFieldRow)}</tbody>
          </table>
        </div>
      </div>

      {/* Recommended Fields */}
      <div className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm">
        <button
          className="w-full px-8 py-5 border-b border-gray-100 flex items-center justify-between hover:bg-gray-50 transition-colors"
          onClick={() => setShowRecommended(!showRecommended)}
        >
          <h3 className="text-sm font-black text-black uppercase tracking-widest">Recommended Fields</h3>
          {showRecommended ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
        </button>
        {showRecommended && (
          <div className="px-8 py-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest w-1/4">Shopify Field</th>
                  <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest w-1/3">Google Sheet Column</th>
                  <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest">Preview Value</th>
                </tr>
              </thead>
              <tbody>{RECOMMENDED_FIELDS.map(renderFieldRow)}</tbody>
            </table>
          </div>
        )}
      </div>

      {/* Optional Fields */}
      <div className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm">
        <button
          className="w-full px-8 py-5 border-b border-gray-100 flex items-center justify-between hover:bg-gray-50 transition-colors"
          onClick={() => setShowOptional(!showOptional)}
        >
          <h3 className="text-sm font-black text-black uppercase tracking-widest">Optional Fields</h3>
          {showOptional ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
        </button>
        {showOptional && (
          <div className="px-8 py-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest w-1/4">Shopify Field</th>
                  <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest w-1/3">Google Sheet Column</th>
                  <th className="text-left py-2 text-[10px] font-black text-gray-400 uppercase tracking-widest">Preview Value</th>
                </tr>
              </thead>
              <tbody>{OPTIONAL_FIELDS.map(renderFieldRow)}</tbody>
            </table>
          </div>
        )}
      </div>

      {/* Metafields */}
      <div className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm">
        <button
          className="w-full px-8 py-5 border-b border-gray-100 flex items-center justify-between hover:bg-gray-50 transition-colors"
          onClick={() => setShowMetafields(!showMetafields)}
        >
          <h3 className="text-sm font-black text-black uppercase tracking-widest">Metafields (Optional)</h3>
          {showMetafields ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
        </button>
        {showMetafields && (
          <div className="px-8 py-6 space-y-4">
            <p className="text-xs text-gray-500 font-medium">
              Map Shopify metafields to columns in your Google Sheet. Each metafield needs a namespace, key, and type.
            </p>
            {metafields.length === 0 && (
              <p className="text-center py-6 text-gray-400 text-xs font-bold uppercase tracking-widest">
                No metafields configured
              </p>
            )}
            {metafields.map((mf, idx) => (
              <div key={idx} className="border border-gray-100 rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-gray-500 uppercase tracking-widest">Metafield #{idx + 1}</span>
                  <button
                    onClick={() => setMetafields(metafields.filter((_, i) => i !== idx))}
                    className="text-red-400 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1">Namespace</label>
                    <input
                      className="w-full bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-[#FFA500]/50"
                      value={mf.namespace}
                      onChange={(e) => {
                        const updated = [...metafields];
                        updated[idx] = { ...updated[idx], namespace: e.target.value };
                        setMetafields(updated);
                      }}
                      placeholder="e.g. custom"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1">Key</label>
                    <input
                      className="w-full bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-[#FFA500]/50"
                      value={mf.key}
                      onChange={(e) => {
                        const updated = [...metafields];
                        updated[idx] = { ...updated[idx], key: e.target.value };
                        setMetafields(updated);
                      }}
                      placeholder="e.g. color"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1">Type</label>
                    <select
                      className="w-full bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-[#FFA500]/50 appearance-none cursor-pointer"
                      value={mf.type}
                      onChange={(e) => {
                        const updated = [...metafields];
                        updated[idx] = { ...updated[idx], type: e.target.value };
                        setMetafields(updated);
                      }}
                    >
                      {METAFIELD_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1">Sheet Column</label>
                    <select
                      className="w-full bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-[#FFA500]/50 appearance-none cursor-pointer"
                      value={mf.sheetColumn}
                      onChange={(e) => {
                        const updated = [...metafields];
                        updated[idx] = { ...updated[idx], sheetColumn: e.target.value };
                        setMetafields(updated);
                      }}
                    >
                      <option value="">-- Select --</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {mf.namespace && mf.key && (
                  <p className="text-[10px] text-gray-400 font-mono">
                    Shopify key: metafield:{mf.namespace}.{mf.key}:{mf.type}
                  </p>
                )}
              </div>
            ))}
            <button
              onClick={() =>
                setMetafields([...metafields, { namespace: "custom", key: "", type: "single_line_text_field", sheetColumn: "" }])
              }
              className="flex items-center gap-2 text-[#FFA500] hover:text-orange-600 font-black text-xs uppercase tracking-widest transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Add Metafield</span>
            </button>
          </div>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-center">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-3 bg-[#FFA500] hover:bg-orange-600 text-white px-12 py-5 rounded-2xl font-black text-xs uppercase tracking-[0.2em] transition-all shadow-2xl shadow-orange-500/20 disabled:opacity-50 italic"
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          <span>{saving ? "Saving Mappings..." : "Save All Mappings"}</span>
        </button>
      </div>
    </div>
  );
}
