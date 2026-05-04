import React, { useState, useEffect } from "react";
import { Clock, Download, ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";

interface SyncLog {
  id: string;
  shop_domain: string;
  status: "success" | "error";
  sync_mode: string;
  message: string;
  updated_count: number;
  created_count: number;
  skipped_count: number;
  error_count: number;
  total_count: number;
  duration: number;
  logs: string[];
  created_at: string;
}

interface SyncResult {
  id: string;
  sync_log_id: string;
  shop_domain: string;
  sku: string;
  product_title: string;
  status: "updated" | "not_found" | "filtered" | "error" | "created";
  action: string;
  message: string;
  shopify_product_id: string;
  row_number: number;
  created_at: string;
}

const STATUS_STYLES: Record<string, { badge: string }> = {
  success: { badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  error: { badge: "bg-red-50 text-red-700 border-red-200" },
};

const SYNC_MODE_STYLES: Record<string, string> = {
  all: "bg-blue-50 text-blue-700 border-blue-200",
  "all-no-images": "bg-violet-50 text-violet-700 border-violet-200",
  "price-stock-meta": "bg-cyan-50 text-cyan-700 border-cyan-200",
  custom: "bg-orange-50 text-orange-700 border-orange-200",
  stock: "bg-purple-50 text-purple-700 border-purple-200",
  price: "bg-teal-50 text-teal-700 border-teal-200",
  images: "bg-pink-50 text-pink-700 border-pink-200",
};

const SYNC_MODE_LABELS: Record<string, string> = {
  all: "Sync All",
  "all-no-images": "All (No Images)",
  "price-stock-meta": "Price+Stock+Meta",
  custom: "Custom",
  stock: "Stock Only",
  price: "Price Only",
  images: "Images Only",
};

const RESULT_STATUS_STYLES: Record<string, string> = {
  updated: "bg-emerald-50 text-emerald-700 border-emerald-200",
  created: "bg-blue-50 text-blue-700 border-blue-200",
  not_found: "bg-amber-50 text-amber-700 border-amber-200",
  filtered: "bg-gray-50 text-gray-600 border-gray-200",
  error: "bg-red-50 text-red-700 border-red-200",
};

function formatDuration(ms: number): string {
  if (!ms) return "\u2014";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }) + ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}

interface SyncHistoryProps {
  shopDomain?: string;
}

export default function SyncHistory({ shopDomain }: SyncHistoryProps) {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SyncResult[]>>({});
  const [loadingResults, setLoadingResults] = useState<string | null>(null);
  const [resultFilter, setResultFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");

  const token = () => localStorage.getItem("token") || "";

  useEffect(() => { loadHistory(); }, []);

  async function loadHistory() {
    setLoading(true);
    try {
      const res = await fetch("/api/sync/history", { headers: { Authorization: `Bearer ${token()}` } });
      const data = await res.json();
      if (Array.isArray(data)) setLogs(data);
    } catch (e) { console.error("Failed to load sync history:", e); }
    finally { setLoading(false); }
  }

  async function toggleExpand(logId: string) {
    if (expandedLogId === logId) { setExpandedLogId(null); return; }
    setExpandedLogId(logId);
    if (!results[logId]) {
      setLoadingResults(logId);
      try {
        const res = await fetch(`/api/sync/history/${logId}/results`, { headers: { Authorization: `Bearer ${token()}` } });
        const data = await res.json();
        setResults((prev) => ({ ...prev, [logId]: Array.isArray(data) ? data : [] }));
      } catch (e) { setResults((prev) => ({ ...prev, [logId]: [] })); }
      finally { setLoadingResults(null); }
    }
  }

  function handleExportCsv(logId: string) {
    fetch(`/api/sync/history/export.csv?logId=${encodeURIComponent(logId)}`, { headers: { Authorization: `Bearer ${token()}` } })
      .then((res) => res.blob())
      .then((blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sync-results-${logId}.csv`; a.click(); URL.revokeObjectURL(a.href); })
      .catch((e) => console.error("CSV export failed:", e));
  }

  const filteredLogs = logs.filter((log) => !shopDomain || log.shop_domain.toLowerCase() === shopDomain.toLowerCase());

  if (loading) {
    return (<div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[#FFA500]" /></div>);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-black text-black uppercase tracking-widest">Sync History</h2>
          <p className="text-xs text-gray-400 font-medium mt-1">View all product sync operations</p>
        </div>
        <button onClick={loadHistory} className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-gray-500 hover:text-[#FFA500] transition-colors px-4 py-2 rounded-xl hover:bg-gray-50">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {filteredLogs.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-[2rem] py-20 text-center shadow-sm">
          <Clock className="w-10 h-10 text-gray-200 mx-auto mb-4" />
          <p className="text-xs font-black text-gray-400 uppercase tracking-widest">No sync history yet</p>
          <p className="text-xs text-gray-400 font-medium mt-1">Run your first sync to see history here</p>
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-100 rounded-2xl px-6 py-3 shadow-sm">
            <span className="text-xs font-bold text-gray-500">Recent Syncs ({filteredLogs.length})</span>
          </div>

          <div className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Date & Time</th>
                  <th className="text-left px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Status</th>
                  <th className="text-left px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Sync Type</th>
                  <th className="text-left px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Progress</th>
                  <th className="text-right px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Created</th>
                  <th className="text-right px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Updated</th>
                  <th className="text-right px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Skipped</th>
                  <th className="text-right px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Failed</th>
                  <th className="text-right px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Duration</th>
                  <th className="text-right px-5 py-3.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => {
                  const styles = STATUS_STYLES[log.status] || STATUS_STYLES.error;
                  const modeStyle = SYNC_MODE_STYLES[log.sync_mode] || SYNC_MODE_STYLES.all;
                  const modeLabel = SYNC_MODE_LABELS[log.sync_mode] || log.sync_mode || "Sync All";
                  const isExpanded = expandedLogId === log.id;
                  const logResults = results[log.id] || [];
                  const isLoadingThis = loadingResults === log.id;
                  const processed = (log.updated_count || 0) + (log.created_count || 0) + (log.skipped_count || 0) + (log.error_count || 0);
                  const countByStatus = logResults.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
                  const filteredResults = logResults.filter((r) => {
                    const matchesFilter = resultFilter === "all" || r.status === resultFilter;
                    const matchesSearch = !searchTerm || r.sku.toLowerCase().includes(searchTerm.toLowerCase()) || (r.product_title || "").toLowerCase().includes(searchTerm.toLowerCase());
                    return matchesFilter && matchesSearch;
                  });

                  return (
                    <React.Fragment key={log.id}>
                      <tr className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors cursor-pointer ${isExpanded ? "bg-gray-50/80" : ""}`} onClick={() => toggleExpand(log.id)}>
                        <td className="px-5 py-4 text-gray-700 font-medium whitespace-nowrap text-xs">{formatDate(log.created_at)}</td>
                        <td className="px-5 py-4"><span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border ${styles.badge}`}>{log.status === "success" ? "Completed" : "Failed"}</span></td>
                        <td className="px-5 py-4"><span className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border ${modeStyle}`}>{modeLabel}</span></td>
                        <td className="px-5 py-4 text-gray-600 text-xs font-medium">{processed}/{log.total_count || processed}</td>
                        <td className="px-5 py-4 text-right text-gray-600 text-xs">{log.created_count || 0}</td>
                        <td className="px-5 py-4 text-right text-gray-600 text-xs">{log.updated_count || 0}</td>
                        <td className="px-5 py-4 text-right text-gray-600 text-xs">{log.skipped_count || 0}</td>
                        <td className="px-5 py-4 text-right text-gray-600 text-xs">{log.error_count || 0}</td>
                        <td className="px-5 py-4 text-right text-gray-500 text-xs">{formatDuration(log.duration)}</td>
                        <td className="px-5 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button onClick={(e) => { e.stopPropagation(); handleExportCsv(log.id); }} className="px-2.5 py-1.5 text-[10px] font-bold text-gray-500 hover:text-[#FFA500] hover:bg-orange-50 border border-gray-200 rounded-lg transition-all" title="Export CSV"><Download className="w-3 h-3" /></button>
                            <span className="text-gray-300">{isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
                          </div>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr><td colSpan={10} className="p-0">
                          <div className="border-t border-gray-100 px-6 py-5 bg-gray-50/30 space-y-4">
                            <div className="flex items-center justify-between gap-4 flex-wrap">
                              <div className="flex items-center gap-1.5 bg-white border border-gray-100 rounded-xl p-1">
                                {["all", "updated", "created", "not_found", "filtered", "error"].map((s) => (
                                  <button key={s} onClick={() => setResultFilter(s)} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${resultFilter === s ? "bg-white text-black shadow-sm ring-1 ring-black/5" : "text-gray-400 hover:text-black"}`}>
                                    {s === "not_found" ? "Not Found" : s}{s !== "all" && countByStatus[s] !== undefined && <span className="ml-1 opacity-60">({countByStatus[s]})</span>}
                                  </button>
                                ))}
                              </div>
                              <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300" />
                                <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search SKU or title..." className="bg-white border border-gray-100 rounded-xl pl-9 pr-4 py-2 text-xs font-bold outline-none focus:ring-2 focus:ring-[#FFA500]/50 w-48" />
                              </div>
                            </div>

                            {isLoadingThis ? (
                              <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-[#FFA500]" /></div>
                            ) : logResults.length === 0 ? (
                              <div className="py-8 text-center text-xs font-bold text-gray-400 uppercase tracking-widest">No per-row data available for this sync</div>
                            ) : filteredResults.length === 0 ? (
                              <div className="py-8 text-center text-xs font-bold text-gray-400 uppercase tracking-widest">No results match the current filter</div>
                            ) : (
                              <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
                                <table className="w-full text-sm">
                                  <thead className="bg-gray-50 border-b border-gray-100">
                                    <tr>
                                      <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">SKU</th>
                                      <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Product Title</th>
                                      <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Status</th>
                                      <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Action</th>
                                      <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Message</th>
                                      <th className="text-right px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Row</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-50">
                                    {filteredResults.slice(0, 200).map((r) => {
                                      const rs = RESULT_STATUS_STYLES[r.status] || RESULT_STATUS_STYLES.error;
                                      return (
                                        <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                                          <td className="px-5 py-3 font-bold text-black font-mono text-xs">{r.sku}</td>
                                          <td className="px-5 py-3 text-xs text-gray-600 max-w-[200px] truncate" title={r.product_title || ""}>{r.product_title || <span className="text-gray-300 italic">{"\u2014"}</span>}</td>
                                          <td className="px-5 py-3"><span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border ${rs}`}>{r.status === "not_found" ? "Not Found" : r.status}</span></td>
                                          <td className="px-5 py-3 text-xs text-gray-500 font-medium">{r.action?.replace(/_/g, " ") || "\u2014"}</td>
                                          <td className="px-5 py-3 text-xs text-gray-500 font-medium max-w-xs truncate" title={r.message || ""}>{r.message || "\u2014"}</td>
                                          <td className="px-5 py-3 text-xs text-gray-400 font-medium text-right">{r.row_number > 0 ? `#${r.row_number}` : "\u2014"}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                                {filteredResults.length > 200 && (
                                  <div className="px-5 py-3 border-t border-gray-50 bg-gray-50 text-xs text-gray-400 font-medium text-center">Showing first 200 of {filteredResults.length} results. Export CSV for full data.</div>
                                )}
                              </div>
                            )}
                          </div>
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
