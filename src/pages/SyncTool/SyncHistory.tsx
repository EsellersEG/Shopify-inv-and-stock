import React, { useState, useEffect } from "react";
import { Clock, CheckCircle2, XCircle, Download, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Filter } from "lucide-react";

interface SyncLog {
  id: string;
  shop_domain: string;
  status: "success" | "error";
  message: string;
  updated_count: number;
  error_count: number;
  duration: number;
  logs: string[];
  created_at: string;
}

interface SyncResult {
  id: string;
  sync_log_id: string;
  shop_domain: string;
  sku: string;
  status: "updated" | "not_found" | "filtered" | "error";
  action: string;
  message: string;
  row_number: number;
  created_at: string;
}

const STATUS_STYLES: Record<string, { badge: string; dot: string }> = {
  success: { badge: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  error: { badge: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" },
  updated: { badge: "bg-blue-50 text-blue-700 border-blue-200", dot: "bg-blue-500" },
  not_found: { badge: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-400" },
  filtered: { badge: "bg-gray-50 text-gray-600 border-gray-200", dot: "bg-gray-400" },
};

function formatDuration(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

  useEffect(() => {
    loadHistory();
  }, []);

  async function loadHistory() {
    setLoading(true);
    try {
      const res = await fetch("/api/sync/history", {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const data = await res.json();
      if (Array.isArray(data)) setLogs(data);
    } catch (e) {
      console.error("Failed to load sync history:", e);
    } finally {
      setLoading(false);
    }
  }

  async function toggleExpand(logId: string) {
    if (expandedLogId === logId) {
      setExpandedLogId(null);
      return;
    }
    setExpandedLogId(logId);
    if (!results[logId]) {
      setLoadingResults(logId);
      try {
        const res = await fetch(`/api/sync/history/${logId}/results`, {
          headers: { Authorization: `Bearer ${token()}` },
        });
        const data = await res.json();
        setResults((prev) => ({ ...prev, [logId]: Array.isArray(data) ? data : [] }));
      } catch (e) {
        console.error("Failed to load sync results:", e);
        setResults((prev) => ({ ...prev, [logId]: [] }));
      } finally {
        setLoadingResults(null);
      }
    }
  }

  function handleExportCsv(logId: string) {
    const token = localStorage.getItem("token") || "";
    const url = `/api/sync/history/export.csv?logId=${encodeURIComponent(logId)}`;
    // Use a fetch with auth header and trigger download
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `sync-results-${logId}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => console.error("CSV export failed:", e));
  }

  const filteredLogs = logs.filter((log) =>
    !shopDomain || log.shop_domain === shopDomain
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[#FFA500]" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-black text-black uppercase tracking-widest">Sync History</h2>
          <p className="text-xs text-gray-400 font-medium mt-1">
            {filteredLogs.length} sync{filteredLogs.length !== 1 ? "s" : ""} recorded
          </p>
        </div>
        <button
          onClick={loadHistory}
          className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-gray-500 hover:text-[#FFA500] transition-colors px-4 py-2 rounded-xl hover:bg-gray-50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {filteredLogs.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-[2rem] py-20 text-center shadow-sm">
          <Clock className="w-10 h-10 text-gray-200 mx-auto mb-4" />
          <p className="text-xs font-black text-gray-400 uppercase tracking-widest">No sync history yet</p>
          <p className="text-xs text-gray-400 font-medium mt-1">Run your first sync to see history here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredLogs.map((log) => {
            const styles = STATUS_STYLES[log.status] || STATUS_STYLES.error;
            const isExpanded = expandedLogId === log.id;
            const logResults = results[log.id] || [];
            const isLoadingThis = loadingResults === log.id;

            // Summary counts from results
            const countByStatus = logResults.reduce<Record<string, number>>((acc, r) => {
              acc[r.status] = (acc[r.status] || 0) + 1;
              return acc;
            }, {});

            const filteredResults = logResults.filter((r) => {
              const matchesFilter = resultFilter === "all" || r.status === resultFilter;
              const matchesSearch = !searchTerm || r.sku.toLowerCase().includes(searchTerm.toLowerCase());
              return matchesFilter && matchesSearch;
            });

            return (
              <div
                key={log.id}
                className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm"
              >
                {/* Log row */}
                <button
                  className="w-full px-8 py-5 flex items-center gap-6 hover:bg-gray-50/50 transition-colors text-left"
                  onClick={() => toggleExpand(log.id)}
                >
                  {/* Status dot */}
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${styles.dot}`} />

                  {/* Domain & date */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-black text-black truncate">{log.shop_domain}</p>
                    <p className="text-[10px] text-gray-400 font-medium mt-0.5 uppercase tracking-widest">
                      {formatDate(log.created_at)}
                    </p>
                  </div>

                  {/* Metrics */}
                  <div className="flex items-center gap-6 shrink-0">
                    <div className="text-center">
                      <p className="text-xl font-black text-emerald-600">{log.updated_count}</p>
                      <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest">Updated</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xl font-black text-red-500">{log.error_count}</p>
                      <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest">Errors</p>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-black text-gray-500">{formatDuration(log.duration)}</p>
                      <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest">Duration</p>
                    </div>
                  </div>

                  {/* Status badge */}
                  <span
                    className={`text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg border ${styles.badge}`}
                  >
                    {log.status}
                  </span>

                  {/* Expand icon */}
                  <div className="shrink-0 text-gray-400">
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </div>
                </button>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="border-t border-gray-50 px-8 py-6 space-y-6">
                    {/* Server log messages */}
                    {log.logs && log.logs.length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">
                          Server Logs
                        </h4>
                        <div className="bg-gray-50 rounded-2xl p-5 max-h-48 overflow-y-auto space-y-2 font-mono text-xs">
                          {log.logs.map((l, i) => (
                            <div key={i} className="flex gap-4">
                              <span className="text-gray-300 shrink-0">
                                {String(i).padStart(3, "0")}
                              </span>
                              <span className="text-gray-600">{l}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Per-row validation */}
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                          Row-Level Validation
                        </h4>
                        <div className="flex items-center gap-3">
                          {/* Status filter */}
                          <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-xl p-1">
                            {["all", "updated", "not_found", "filtered", "error"].map((s) => (
                              <button
                                key={s}
                                onClick={() => setResultFilter(s)}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                                  resultFilter === s
                                    ? "bg-white text-black shadow-sm"
                                    : "text-gray-400 hover:text-black"
                                }`}
                              >
                                {s}
                                {s !== "all" && countByStatus[s] !== undefined && (
                                  <span className="ml-1 opacity-60">({countByStatus[s]})</span>
                                )}
                              </button>
                            ))}
                          </div>

                          {/* Search */}
                          <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300" />
                            <input
                              type="text"
                              value={searchTerm}
                              onChange={(e) => setSearchTerm(e.target.value)}
                              placeholder="Search SKU..."
                              className="bg-gray-50 border border-gray-100 rounded-xl pl-9 pr-4 py-2 text-xs font-bold outline-none focus:ring-2 focus:ring-[#FFA500]/50 w-40"
                            />
                          </div>

                          {/* CSV Export */}
                          <button
                            onClick={() => handleExportCsv(log.id)}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 text-xs font-black uppercase tracking-widest text-gray-600 hover:border-[#FFA500] hover:text-[#FFA500] transition-all"
                          >
                            <Download className="w-3.5 h-3.5" />
                            CSV
                          </button>
                        </div>
                      </div>

                      {isLoadingThis ? (
                        <div className="flex items-center justify-center py-10">
                          <Loader2 className="w-6 h-6 animate-spin text-[#FFA500]" />
                        </div>
                      ) : logResults.length === 0 ? (
                        <div className="py-10 text-center text-xs font-bold text-gray-400 uppercase tracking-widest">
                          No per-row data — recorded on syncs after this feature was added
                        </div>
                      ) : filteredResults.length === 0 ? (
                        <div className="py-8 text-center text-xs font-bold text-gray-400 uppercase tracking-widest">
                          No results match the current filter
                        </div>
                      ) : (
                        <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50 border-b border-gray-100">
                              <tr>
                                <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">SKU</th>
                                <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Status</th>
                                <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Action</th>
                                <th className="text-left px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Message</th>
                                <th className="text-right px-5 py-3 text-[10px] font-black text-gray-400 uppercase tracking-widest">Row</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {filteredResults.slice(0, 200).map((r) => {
                                const rs = STATUS_STYLES[r.status] || STATUS_STYLES.error;
                                return (
                                  <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                                    <td className="px-5 py-3 font-bold text-black font-mono">{r.sku}</td>
                                    <td className="px-5 py-3">
                                      <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border ${rs.badge}`}>
                                        {r.status}
                                      </span>
                                    </td>
                                    <td className="px-5 py-3 text-xs text-gray-500 font-medium">{r.action}</td>
                                    <td className="px-5 py-3 text-xs text-gray-500 font-medium max-w-xs truncate">{r.message || "—"}</td>
                                    <td className="px-5 py-3 text-xs text-gray-400 font-medium text-right">
                                      {r.row_number > 0 ? `#${r.row_number}` : "—"}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {filteredResults.length > 200 && (
                            <div className="px-5 py-3 border-t border-gray-50 bg-gray-50 text-xs text-gray-400 font-medium text-center">
                              Showing first 200 of {filteredResults.length} results. Export CSV for full data.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
