import React, { useState, useEffect } from "react";
import { Loader2, RefreshCw, Search, Filter, CheckCircle2, XCircle, AlertTriangle, Eye, Download, ChevronLeft, ChevronRight } from "lucide-react";

interface SyncResult {
  id: string;
  sync_log_id: string;
  shop_domain: string;
  sku: string;
  status: "updated" | "not_found" | "filtered" | "error" | "created";
  action: string;
  message: string;
  row_number: number;
  created_at: string;
}

interface SyncLog {
  id: string;
  shop_domain: string;
  status: string;
  message: string;
  updated_count: number;
  error_count: number;
  duration: number;
  created_at: string;
}

const STATUS_CONFIG: Record<string, { label: string; badge: string; icon: any }> = {
  updated: { label: "Success", badge: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  created: { label: "Created", badge: "bg-blue-50 text-blue-700 border-blue-200", icon: CheckCircle2 },
  not_found: { label: "Not Found", badge: "bg-amber-50 text-amber-700 border-amber-200", icon: AlertTriangle },
  filtered: { label: "Filtered", badge: "bg-gray-50 text-gray-600 border-gray-200", icon: Filter },
  error: { label: "Failed", badge: "bg-red-50 text-red-700 border-red-200", icon: XCircle },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface SyncValidationProps {
  shopDomain?: string;
}

export default function SyncValidation({ shopDomain }: SyncValidationProps) {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<string>("");
  const [results, setResults] = useState<SyncResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const token = () => localStorage.getItem("token") || "";

  useEffect(() => {
    loadLogs();
  }, []);

  useEffect(() => {
    if (selectedLogId) {
      loadResults(selectedLogId);
    }
  }, [selectedLogId]);

  async function loadLogs() {
    setLoading(true);
    try {
      const res = await fetch("/api/sync/history", {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const data = await res.json();
      if (Array.isArray(data)) {
        const filtered = shopDomain ? data.filter((l: SyncLog) => l.shop_domain === shopDomain) : data;
        setLogs(filtered);
        if (filtered.length > 0 && !selectedLogId) {
          setSelectedLogId(filtered[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to load sync logs:", e);
    } finally {
      setLoading(false);
    }
  }

  async function loadResults(logId: string) {
    setLoadingResults(true);
    setPage(1);
    try {
      const res = await fetch(`/api/sync/history/${logId}/results`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to load sync results:", e);
      setResults([]);
    } finally {
      setLoadingResults(false);
    }
  }

  function handleExportCsv() {
    if (!selectedLogId) return;
    fetch(`/api/sync/history/export.csv?logId=${encodeURIComponent(selectedLogId)}`, {
      headers: { Authorization: `Bearer ${token()}` },
    })
      .then((res) => res.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `sync-results-${selectedLogId}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => console.error("CSV export failed:", e));
  }

  // Filter and paginate results
  const filteredResults = results.filter((r) => {
    const matchesStatus = statusFilter === "all" || r.status === statusFilter;
    const matchesSearch = !searchTerm || r.sku.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const totalPages = Math.ceil(filteredResults.length / pageSize);
  const paginatedResults = filteredResults.slice((page - 1) * pageSize, page * pageSize);

  // Summary counts
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[#FFA500]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-black text-black uppercase tracking-widest">Sync Validation</h2>
          <p className="text-xs text-gray-400 font-medium mt-1">
            View detailed results for each product across all syncs
          </p>
        </div>
        <button
          onClick={loadLogs}
          className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-gray-500 hover:text-[#FFA500] transition-colors px-4 py-2 rounded-xl hover:bg-gray-50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {logs.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-[2rem] py-20 text-center shadow-sm">
          <AlertTriangle className="w-10 h-10 text-gray-200 mx-auto mb-4" />
          <p className="text-xs font-black text-gray-400 uppercase tracking-widest">No sync history yet</p>
          <p className="text-xs text-gray-400 font-medium mt-1">Run your first sync to see validation results</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Sync Operation Selector */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-[200px]">
              <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 block">Sync Operation</label>
              <select
                value={selectedLogId}
                onChange={(e) => setSelectedLogId(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#FFA500]/50"
              >
                {logs.map((log) => (
                  <option key={log.id} value={log.id}>
                    {formatDate(log.created_at)} — {log.updated_count} updated, {log.error_count} errors
                  </option>
                ))}
              </select>
            </div>

            <div className="flex-1 min-w-[150px]">
              <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2 block">Status Filter</label>
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#FFA500]/50"
              >
                <option value="all">All Statuses</option>
                <option value="updated">Success</option>
                <option value="created">Created</option>
                <option value="not_found">Not Found</option>
                <option value="filtered">Filtered</option>
                <option value="error">Failed</option>
              </select>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="flex flex-wrap items-center gap-3 text-xs font-medium">
            <span className="text-gray-500">Showing {paginatedResults.length} of {filteredResults.length} results</span>
            <span className="text-gray-300">|</span>
            {counts.updated && <span className="text-emerald-600">Success: {counts.updated + (counts.created || 0)}</span>}
            {counts.error && <span className="text-red-600">Failed: {counts.error}</span>}
            {counts.not_found && <span className="text-amber-600">Not Found: {counts.not_found}</span>}
            {counts.filtered && <span className="text-gray-500">Filtered: {counts.filtered}</span>}
          </div>

          {/* Search + Export */}
          <div className="flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
              <input
                type="text"
                placeholder="Search by SKU..."
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
                className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#FFA500]/50"
              />
            </div>
            <button
              onClick={handleExportCsv}
              className="flex items-center gap-2 px-5 py-3 bg-white border border-gray-200 rounded-xl text-xs font-black uppercase tracking-widest text-gray-600 hover:bg-gray-50 hover:text-[#FFA500] transition-colors"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </button>
          </div>

          {/* Results Table */}
          <div className="bg-white border border-gray-100 rounded-[2rem] overflow-hidden shadow-sm">
            {loadingResults ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-[#FFA500]" />
              </div>
            ) : paginatedResults.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-xs text-gray-400 font-medium">No results match your filters</p>
              </div>
            ) : (
              <>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">SKU</th>
                      <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">Status</th>
                      <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">Action</th>
                      <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">Message</th>
                      <th className="px-6 py-4 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">Row</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedResults.map((result) => {
                      const config = STATUS_CONFIG[result.status] || STATUS_CONFIG.error;
                      const Icon = config.icon;
                      return (
                        <tr key={result.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                          <td className="px-6 py-4">
                            <span className="text-sm font-bold text-black">{result.sku}</span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase border ${config.badge}`}>
                              <Icon className="w-3 h-3" />
                              {config.label}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-xs text-gray-600 font-medium">{result.action?.replace(/_/g, " ") || "—"}</span>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-xs text-gray-500">{result.message || "—"}</span>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-xs text-gray-400">{result.row_number || "—"}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
                    <span className="text-xs text-gray-400">
                      Page {page} of {totalPages}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page === totalPages}
                        className="p-2 rounded-lg hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
