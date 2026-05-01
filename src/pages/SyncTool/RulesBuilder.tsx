import React, { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Loader2, Save, Eye, CheckCircle2, AlertCircle, Filter } from "lucide-react";

const OPERATORS = [
  { label: "Equals", value: "equals" },
  { label: "Not Equals", value: "not_equals" },
  { label: "Greater Than", value: "greater_than" },
  { label: "Less Than", value: "less_than" },
  { label: "Greater or Equal", value: "greater_or_equal" },
  { label: "Less or Equal", value: "less_or_equal" },
  { label: "Contains", value: "contains" },
  { label: "Not Contains", value: "not_contains" },
  { label: "Equals Any (multi-value)", value: "contains_any" },
  { label: "Not Equals Any (multi-value)", value: "not_contains_any" },
  { label: "Starts With", value: "starts_with" },
  { label: "Ends With", value: "ends_with" },
  { label: "Is Empty", value: "is_empty" },
  { label: "Is Not Empty", value: "is_not_empty" },
];

const NO_VALUE_OPERATORS = new Set(["is_empty", "is_not_empty"]);
const MULTI_VALUE_OPERATORS = new Set(["contains_any", "not_contains_any"]);

interface Rule {
  id: string;
  field: string;
  operator: string;
  value: string;
  logicalOperator: "AND" | "OR";
  groupId: number;
}

interface RulesBuilderProps {
  storeId: string;
  shopDomain: string;
  spreadsheetId: string;
  serviceAccountJson: string;
  sheetName: string;
}

function makeRule(): Rule {
  return {
    id: Math.random().toString(36).slice(2),
    field: "",
    operator: "equals",
    value: "",
    logicalOperator: "AND",
    groupId: 0,
  };
}

export default function RulesBuilder({
  storeId,
  shopDomain,
  spreadsheetId,
  serviceAccountJson,
  sheetName,
}: RulesBuilderProps) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [previewResult, setPreviewResult] = useState<{ total: number; passing: number } | null>(null);

  const token = () => localStorage.getItem("token") || "";

  useEffect(() => {
    if (storeId) loadData();
  }, [storeId]);

  async function loadData() {
    setLoading(true);
    try {
      const [headersRes, rulesRes] = await Promise.all([
        fetch(`/api/stores/${storeId}/sheet-headers`, { headers: { Authorization: `Bearer ${token()}` } }),
        fetch(`/api/stores/${storeId}/rules`, { headers: { Authorization: `Bearer ${token()}` } }),
      ]);
      const headersData = await headersRes.json();
      const rulesData = await rulesRes.json();

      if (headersData.headers) setHeaders(headersData.headers);

      if (Array.isArray(rulesData) && rulesData.length > 0) {
        setRules(
          rulesData.map((r: any) => ({
            id: r.id,
            field: r.field,
            operator: r.operator,
            value: r.value || "",
            logicalOperator: r.logical_operator || "AND",
            groupId: r.group_id || 0,
          }))
        );
      }
    } catch (e) {
      console.error("Failed to load rules data:", e);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveStatus("idle");
    try {
      const res = await fetch(`/api/stores/${storeId}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ rules }),
      });
      if (res.ok) {
        setSaveStatus("success");
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    setPreviewResult(null);
    try {
      const res = await fetch(`/api/stores/${storeId}/rules/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ rules }),
      });
      const data = await res.json();
      setPreviewResult(data);
    } catch (e) {
      console.error("Preview failed:", e);
    } finally {
      setPreviewing(false);
    }
  }

  function addRule() {
    setPreviewResult(null);
    setRules((prev) => [...prev, makeRule()]);
  }

  function removeRule(id: string) {
    setPreviewResult(null);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }

  function updateRule(id: string, patch: Partial<Rule>) {
    setPreviewResult(null);
    setRules((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const updated = { ...r, ...patch };
        // Clear value when switching to no-value operator
        if (patch.operator && NO_VALUE_OPERATORS.has(patch.operator)) {
          updated.value = "";
        }
        return updated;
      })
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[#FFA500]" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header actions */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-black text-black uppercase tracking-widest">Filter Rules</h2>
          <p className="text-xs text-gray-400 font-medium mt-1">
            Only rows that pass ALL rules will be included in each sync. Rules are evaluated in order.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handlePreview}
            disabled={previewing || rules.length === 0}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-gray-200 text-xs font-black uppercase tracking-widest text-gray-600 hover:border-[#FFA500] hover:text-[#FFA500] transition-all disabled:opacity-40"
          >
            {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            Preview Count
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 bg-[#FFA500] hover:bg-orange-600 text-white px-5 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-lg shadow-orange-500/20 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? "Saving..." : "Save Rules"}
          </button>
        </div>
      </div>

      {/* Save status */}
      {saveStatus !== "idle" && (
        <div
          className={`flex items-center gap-3 px-5 py-3.5 rounded-2xl border text-sm font-bold ${
            saveStatus === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          {saveStatus === "success" ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          {saveStatus === "success" ? "Rules saved successfully" : "Failed to save rules"}
        </div>
      )}

      {/* Preview result */}
      {previewResult && (
        <div
          className={`flex items-center gap-4 px-6 py-4 rounded-2xl border ${
            previewResult.passing === 0
              ? "bg-red-50 border-red-200"
              : previewResult.passing === previewResult.total
              ? "bg-emerald-50 border-emerald-200"
              : "bg-amber-50 border-amber-200"
          }`}
        >
          <Eye className="w-5 h-5 text-gray-600" />
          <div>
            <p className="text-sm font-black text-black">
              {previewResult.passing} of {previewResult.total} rows will pass these rules
            </p>
            <p className="text-xs text-gray-500 font-medium mt-0.5">
              {previewResult.total - previewResult.passing} rows would be excluded from sync
            </p>
          </div>
          <div className="ml-auto">
            <div className="h-3 w-40 bg-white rounded-full overflow-hidden border border-gray-200">
              <div
                className="h-full bg-[#FFA500] rounded-full transition-all"
                style={{ width: `${(previewResult.passing / (previewResult.total || 1)) * 100}%` }}
              />
            </div>
            <p className="text-[10px] font-black text-gray-500 text-right mt-1 uppercase tracking-widest">
              {Math.round((previewResult.passing / (previewResult.total || 1)) * 100)}% passing
            </p>
          </div>
        </div>
      )}

      {/* Rules list */}
      <div className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-xs font-black text-black uppercase tracking-widest flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Rules ({rules.length})
          </h3>
          <button
            onClick={addRule}
            className="flex items-center gap-2 text-[#FFA500] hover:text-orange-600 text-xs font-black uppercase tracking-widest transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Rule
          </button>
        </div>

        {rules.length === 0 ? (
          <div className="py-16 text-center">
            <Filter className="w-8 h-8 text-gray-200 mx-auto mb-4" />
            <p className="text-xs font-black text-gray-400 uppercase tracking-widest">No rules configured</p>
            <p className="text-xs text-gray-400 font-medium mt-1">All rows will be included in sync</p>
            <button
              onClick={addRule}
              className="mt-6 flex items-center gap-2 mx-auto bg-gray-50 hover:bg-gray-100 border border-gray-100 px-6 py-3 rounded-xl text-xs font-black uppercase tracking-widest text-gray-600 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add First Rule
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {rules.map((rule, idx) => (
              <div key={rule.id} className="px-8 py-5 flex items-start gap-4">
                {/* Logical operator badge (for rules after the first) */}
                <div className="pt-2 w-14 shrink-0">
                  {idx === 0 ? (
                    <span className="text-[10px] font-black text-gray-300 uppercase tracking-widest">WHERE</span>
                  ) : (
                    <select
                      value={rule.logicalOperator}
                      onChange={(e) => updateRule(rule.id, { logicalOperator: e.target.value as "AND" | "OR" })}
                      className="w-full bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5 text-xs font-black uppercase outline-none focus:ring-2 focus:ring-[#FFA500]/50 appearance-none cursor-pointer text-center"
                    >
                      <option value="AND">AND</option>
                      <option value="OR">OR</option>
                    </select>
                  )}
                </div>

                {/* Field selector */}
                <div className="flex-1">
                  <select
                    value={rule.field}
                    onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                    className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 text-sm font-bold text-black outline-none focus:ring-2 focus:ring-[#FFA500]/50 appearance-none cursor-pointer"
                  >
                    <option value="">-- Select Column --</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>

                {/* Operator selector */}
                <div className="flex-1">
                  <select
                    value={rule.operator}
                    onChange={(e) => updateRule(rule.id, { operator: e.target.value })}
                    className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 text-sm font-bold text-black outline-none focus:ring-2 focus:ring-[#FFA500]/50 appearance-none cursor-pointer"
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                </div>

                {/* Value input */}
                <div className="flex-1">
                  {NO_VALUE_OPERATORS.has(rule.operator) ? (
                    <div className="bg-gray-50 border border-dashed border-gray-200 rounded-xl px-4 py-3 text-xs font-bold text-gray-300 uppercase tracking-widest">
                      No value needed
                    </div>
                  ) : MULTI_VALUE_OPERATORS.has(rule.operator) ? (
                    <textarea
                      rows={2}
                      value={rule.value}
                      onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                      placeholder={"Enter values separated by comma or newline\ne.g. Active, Draft"}
                      className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 text-sm font-bold text-black outline-none focus:ring-2 focus:ring-[#FFA500]/50 resize-none"
                    />
                  ) : (
                    <input
                      type="text"
                      value={rule.value}
                      onChange={(e) => updateRule(rule.id, { value: e.target.value })}
                      placeholder="Value..."
                      className="w-full bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 text-sm font-bold text-black outline-none focus:ring-2 focus:ring-[#FFA500]/50"
                    />
                  )}
                </div>

                {/* Delete */}
                <button
                  onClick={() => removeRule(rule.id)}
                  className="pt-3 text-gray-300 hover:text-red-500 transition-colors shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Operator reference */}
      <div className="bg-gray-50 border border-gray-100 rounded-[2rem] p-8">
        <h4 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4">Operator Reference</h4>
        <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 font-medium">
          <span><span className="font-black text-black">equals / not_equals</span> — exact match (case-insensitive)</span>
          <span><span className="font-black text-black">greater_than / less_than</span> — numeric comparison</span>
          <span><span className="font-black text-black">contains / not_contains</span> — substring match</span>
          <span><span className="font-black text-black">equals_any</span> — match any value from a list</span>
          <span><span className="font-black text-black">starts_with / ends_with</span> — prefix/suffix match</span>
          <span><span className="font-black text-black">is_empty / is_not_empty</span> — blank check</span>
        </div>
      </div>
    </div>
  );
}
