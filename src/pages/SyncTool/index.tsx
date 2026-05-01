import React, { useState, useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { Settings, RefreshCw, Database, CheckCircle2, AlertCircle, Play, Save, LayoutGrid, Store, X, MapPin, Filter, Clock, ClipboardCheck } from "lucide-react";
import { useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import FieldMapping from "./FieldMapping";
import RulesBuilder from "./RulesBuilder";
import SyncHistory from "./SyncHistory";
import SyncValidation from "./SyncValidation";

export default function SyncTool() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState("credentials");
  const [stores, setStores] = useState<any[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  
  // State for the sync process
  const [storeName, setStoreName] = useState("");
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [sheetName, setSheetName] = useState("Sheet1");

  const [skuCol, setSkuCol] = useState("SKU");
  const [priceCol, setPriceCol] = useState("Price");
  const [compareAtPriceCol, setCompareAtPriceCol] = useState("Compare At Price");
  const [inventoryCol, setInventoryCol] = useState("Inventory");

  const [syncStatus, setSyncStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [syncPreset, setSyncPreset] = useState<"all" | "all-no-images" | null>("all");
  const [customFields, setCustomFields] = useState<Set<string>>(new Set());
  const [syncProgress, setSyncProgress] = useState({ current: 0, total: 0 });
  const [syncMessage, setSyncMessage] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [syncResult, setSyncResult] = useState<{ updated: number; errors: number; duration?: number } | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const [currentView, setCurrentView] = useState<"sync" | "mapping" | "rules" | "history" | "validation">("sync");
  const [storeChosen, setStoreChosen] = useState(false);

  useEffect(() => {
    fetchMyStores();
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (location.state?.store) {
      applyStore(location.state.store);
    }
  }, [location.state]);

  useEffect(() => {
    if (shopDomain) {
      checkSyncStatus();
      setupStatusStream();
    }
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, [shopDomain]);

  const checkSyncStatus = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/sync/status?shopDomain=${shopDomain}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.status === 'loading') {
        setSyncStatus("loading");
        setSyncProgress(data.progress || { current: 0, total: 0 });
        setSyncMessage(data.message || "Syncing in background...");
      } else if (data.status === 'success') {
        setSyncStatus("success");
        setSyncResult(data.result);
        setLogs(data.logs || []);
        setSyncMessage(data.message || "Sync Complete");
      } else if (data.status === 'error') {
        setSyncStatus("error");
        setLogs(data.logs || []);
        setSyncMessage("Error occurred.");
      }
    } catch (e) {
      console.error("Failed to check sync status", e);
    }
  };

  const setupStatusStream = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/sync/stream?shopDomain=${shopDomain}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress') {
          setSyncStatus("loading");
          setSyncProgress({ current: data.current, total: data.total });
          if (data.message) setSyncMessage(data.message);
        } else if (data.type === 'complete') {
          setSyncStatus("success");
          setSyncResult({ updated: data.updatedCount, errors: data.errorCount, duration: data.duration });
          setLogs(data.logs || []);
          setSyncMessage(data.duration ? `Success! Processed in ${(data.duration / 1000).toFixed(1)}s` : "Sync Complete");
          // Auto-refresh history when sync completes
          setHistoryRefreshKey(prev => prev + 1);
        } else if (data.type === 'error') {
          setSyncStatus("error");
          setLogs([data.message]);
          setSyncMessage("Critical Error occurred.");
        }
      } catch (e) {
        console.error("Stream parse error", e);
      }
    };

    es.onerror = (e) => {
      console.error("SSE Error", e);
      es.close();
    };
  };

  const fetchMyStores = async () => {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/client/stores', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (Array.isArray(data)) {
      setStores(data);
      // If navigated with a specific store, apply it and skip picker
      if (data.length > 0 && location.state?.store) {
        applyStore(location.state.store);
        setStoreChosen(true);
      } else if (data.length === 1) {
        // Only one store — auto-select and skip picker
        applyStore(data[0]);
        setStoreChosen(true);
      }
      // else: show picker
    }
  };

  const applyStore = (store: any) => {
    setSelectedStoreId(store.id);
    setStoreName(store.name || "");
    setShopDomain(store.shopDomain || store.shop_domain);
    setAccessToken(store.accessToken || store.access_token);
    setSpreadsheetId(store.spreadsheetId || store.spreadsheet_id);
    setServiceAccountJson(store.serviceAccountJson || store.service_account_json);
    setSheetName(store.sheet_name || store.sheetName || "Sheet1");
    setSkuCol(store.sku_col || store.skuCol || "SKU");
    setPriceCol(store.price_col || store.priceCol || "Price");
    setCompareAtPriceCol(store.compare_at_price_col || store.compareAtPriceCol || "Compare At Price");
    setInventoryCol(store.inventory_col || store.inventoryCol || "Inventory");
  };

  const handleSync = async () => {
    setSyncStatus("loading");
    setLogs([]);
    setSyncResult(null);
    setSyncProgress({ current: 0, total: 0 });
    setSyncMessage("Requesting server to start background sync...");
    
    try {
      const token = localStorage.getItem('token');
      const computedMode = syncPreset ?? "custom";
      const computedFields = syncPreset ? [] : Array.from(customFields);
      const res = await fetch("/api/sync/sheets-to-shopify", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          shopDomain,
          accessToken,
          spreadsheetId,
          serviceAccountJson,
          sheetName,
          syncMode: computedMode,
          fields: computedFields,
          mapping: {
            sku: skuCol,
            price: priceCol,
            compareAtPrice: compareAtPriceCol,
            inventory: inventoryCol,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setSyncStatus("error");
        setSyncMessage(data.error || "Operation failed to start.");
        setLogs([data.error || "Check if another sync is already running."]);
      } else {
        // SSE will take over and update the UI
        setSyncMessage("Sync triggered. Monitoring process...");
      }
    } catch (e: any) {
      setSyncStatus("error");
      setLogs([e.message || "Network error"]);
      setSyncMessage("Sync operation failed.");
    }
  };

  const handleCancel = async () => {
    try {
      const token = localStorage.getItem('token');
      await api.post("/api/sync/cancel", { shopDomain });
    } catch (e) {
      console.error("Failed to cancel", e);
    }
  };

  return (
    <div className="max-w-6xl mx-auto pb-20 bg-white">

      {/* ── Store Picker (shown until user selects a store) ───────────── */}
      {!storeChosen && (
        <div className="min-h-[70vh] flex flex-col items-center justify-center">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-black text-black tracking-tight uppercase italic underline decoration-[#FFA500] underline-offset-8 mb-4">
              Inventory Bridge
            </h1>
            <p className="text-gray-400 text-xs font-black uppercase tracking-widest">Select a store to continue</p>
          </div>

          {stores.length === 0 ? (
            <div className="flex flex-col items-center gap-4 text-gray-400">
              <Store className="w-12 h-12 text-gray-200" />
              <p className="text-xs font-black uppercase tracking-widest">No stores assigned to your account</p>
              <p className="text-xs text-gray-400 font-medium">Ask your admin to assign a store first</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 w-full max-w-3xl">
              {stores.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { applyStore(s); setStoreChosen(true); }}
                  className="group bg-white border-2 border-gray-100 hover:border-[#FFA500] rounded-[2rem] p-8 text-left transition-all hover:shadow-2xl hover:shadow-orange-500/10 active:scale-95"
                >
                  <div className="w-12 h-12 rounded-2xl bg-orange-50 flex items-center justify-center mb-6 group-hover:bg-[#FFA500] transition-colors">
                    <Store className="w-6 h-6 text-[#FFA500] group-hover:text-white transition-colors" />
                  </div>
                  <p className="font-black text-black text-base truncate">{s.name || "Unlabeled Store"}</p>
                  <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1 truncate">{s.shopDomain || s.shop_domain}</p>
                  <div className="mt-5 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-[#FFA500] opacity-0 group-hover:opacity-100 transition-opacity">
                    <span>Select store</span>
                    <span>→</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Main UI (shown after store is chosen) ────────────────────── */}
      {storeChosen && (
      <>
      <header className="flex items-center justify-between mb-12">
        <div>
          <h1 className="text-4xl font-black text-black tracking-tight uppercase italic underline decoration-[#FFA500] underline-offset-8">Inventory Bridge</h1>
          <p className="text-gray-500 mt-4 font-bold uppercase text-[10px] tracking-widest leading-relaxed">Automatic Stock & Price reconciliation for <span className="text-black italic font-black">{shopDomain || 'your store'}</span></p>
        </div>
        <div className="flex items-center space-x-4">
          <button
            onClick={() => setStoreChosen(false)}
            className="text-xs font-black uppercase tracking-widest text-gray-400 hover:text-[#FFA500] transition-colors px-4 py-2 rounded-xl hover:bg-gray-50"
          >
            ← Change Store
          </button>
          <div className="relative group">
            <Store className="absolute left-4 top-4 w-4 h-4 text-gray-300 group-focus-within:text-[#FFA500] transition-colors" />
            <select 
              className="bg-gray-50 border border-gray-100 rounded-2xl pl-12 pr-6 py-4 text-black font-bold outline-none focus:ring-2 focus:ring-[#FFA500]/50 min-w-[240px] appearance-none cursor-pointer hover:bg-gray-100 transition-all shadow-sm"
              value={selectedStoreId}
              onChange={(e) => {
                const s = stores.find(st => st.id === e.target.value);
                if (s) applyStore(s);
              }}
            >
              {stores.map(s => <option key={s.id} value={s.id} className="bg-white">{s.name || s.shopDomain}</option>)}
            </select>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="flex space-x-2 bg-gray-50 p-1.5 rounded-2xl w-fit border border-gray-100 mb-8">
        <button
          onClick={() => setCurrentView("sync")}
          className={`px-6 py-3 text-xs font-black rounded-xl transition-all uppercase tracking-widest ${
            currentView === "sync" ? "bg-white text-black shadow-lg ring-1 ring-black/5" : "text-gray-500 hover:text-black"
          }`}
        >
          <span className="flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5" /> Execute Sync</span>
        </button>
        <button
          onClick={() => setCurrentView("mapping")}
          className={`px-6 py-3 text-xs font-black rounded-xl transition-all uppercase tracking-widest ${
            currentView === "mapping" ? "bg-white text-black shadow-lg ring-1 ring-black/5" : "text-gray-500 hover:text-black"
          }`}
        >
          <span className="flex items-center gap-2"><MapPin className="w-3.5 h-3.5" /> Attribute Mapping</span>
        </button>
        <button
          onClick={() => setCurrentView("rules")}
          className={`px-6 py-3 text-xs font-black rounded-xl transition-all uppercase tracking-widest ${
            currentView === "rules" ? "bg-white text-black shadow-lg ring-1 ring-black/5" : "text-gray-500 hover:text-black"
          }`}
        >
          <span className="flex items-center gap-2"><Filter className="w-3.5 h-3.5" /> Filter Rules</span>
        </button>
        <button
          onClick={() => setCurrentView("history")}
          className={`px-6 py-3 text-xs font-black rounded-xl transition-all uppercase tracking-widest ${
            currentView === "history" ? "bg-white text-black shadow-lg ring-1 ring-black/5" : "text-gray-500 hover:text-black"
          }`}
        >
          <span className="flex items-center gap-2"><Clock className="w-3.5 h-3.5" /> Sync History</span>
        </button>
        <button
          onClick={() => setCurrentView("validation")}
          className={`px-6 py-3 text-xs font-black rounded-xl transition-all uppercase tracking-widest ${
            currentView === "validation" ? "bg-white text-black shadow-lg ring-1 ring-black/5" : "text-gray-500 hover:text-black"
          }`}
        >
          <span className="flex items-center gap-2"><ClipboardCheck className="w-3.5 h-3.5" /> Sync Validation</span>
        </button>
      </div>

      {currentView === "mapping" && selectedStoreId && (
        <FieldMapping
          storeId={selectedStoreId}
          spreadsheetId={spreadsheetId}
          serviceAccountJson={serviceAccountJson}
          sheetName={sheetName}
          skuCol={skuCol}
          priceCol={priceCol}
          compareAtPriceCol={compareAtPriceCol}
          inventoryCol={inventoryCol}
        />
      )}

      {currentView === "rules" && selectedStoreId && (
        <RulesBuilder
          storeId={selectedStoreId}
          shopDomain={shopDomain}
          spreadsheetId={spreadsheetId}
          serviceAccountJson={serviceAccountJson}
          sheetName={sheetName}
        />
      )}

      {currentView === "history" && (
        <SyncHistory key={historyRefreshKey} shopDomain={shopDomain || undefined} />
      )}

      {currentView === "validation" && (
        <SyncValidation shopDomain={shopDomain || undefined} />
      )}

      {currentView === "sync" && (
      <div className="bg-gray-50 rounded-[3rem] border border-gray-100 overflow-hidden shadow-2xl backdrop-blur-xl relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#FFA500]/20 to-transparent" />
        
        <div className="p-16 flex flex-col items-center">
          <motion.div 
            animate={syncStatus === "loading" ? { rotate: 360 } : {}}
            transition={syncStatus === "loading" ? { repeat: Infinity, duration: 10, ease: "linear" } : {}}
            className="bg-white p-12 rounded-[3.5rem] mb-12 border border-orange-100 shadow-xl shadow-orange-500/5 ring-1 ring-orange-500/10"
          >
            <RefreshCw className={`w-24 h-24 text-[#FFA500] ${syncStatus === "loading" ? "animate-spin-slow" : ""}`} />
          </motion.div>

          <h2 className="text-4xl font-black text-black mb-4 uppercase italic">Execute Sync</h2>
          <p className="text-gray-500 max-w-sm text-center mb-16 text-[11px] font-bold uppercase tracking-widest leading-relaxed">
            Ready to synchronize <span className="text-[#FFA500] italic">"{storeName || shopDomain}"</span> credentials and mapping set in the master database.
          </p>

          {/* Sync Mode Selector */}
          <div className="w-full max-w-2xl mb-12 space-y-5">
            {/* Presets */}
            <div className="grid grid-cols-2 gap-4">
              {[
                { id: "all",           label: "Sync All",             desc: "Complete product data" },
                { id: "all-no-images", label: "Sync All (No Images)",  desc: "Faster — skips images" },
              ].map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => { setSyncPreset(preset.id as any); setCustomFields(new Set()); }}
                  className={`p-5 rounded-2xl border-2 transition-all text-left ${
                    syncPreset === preset.id
                      ? "bg-[#FFA500] border-[#FFA500] shadow-2xl shadow-orange-500/20"
                      : "bg-white border-gray-100 hover:border-[#FFA500]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 mb-1">
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      syncPreset === preset.id ? "border-white" : "border-gray-300"
                    }`}>
                      {syncPreset === preset.id && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                    <span className={`font-black text-xs uppercase tracking-widest ${
                      syncPreset === preset.id ? "text-white italic" : "text-gray-600"
                    }`}>{preset.label}</span>
                  </div>
                  <p className={`text-[10px] font-medium ml-6.5 ${
                    syncPreset === preset.id ? "text-white/70" : "text-gray-400"
                  }`}>{preset.desc}</p>
                </button>
              ))}
            </div>

            {/* Custom field checkboxes */}
            <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-5">Or select specific fields to sync:</p>
              <div className="flex flex-wrap gap-3">
                {[
                  { id: "stock",  label: "Stock"  },
                  { id: "price",  label: "Price"  },
                  { id: "tags",   label: "Tags"   },
                  { id: "status", label: "Status" },
                  { id: "images", label: "Images" },
                ].map((field) => {
                  const checked = customFields.has(field.id);
                  return (
                    <button
                      key={field.id}
                      onClick={() => {
                        setSyncPreset(null);
                        setCustomFields((prev) => {
                          const next = new Set(prev);
                          checked ? next.delete(field.id) : next.add(field.id);
                          return next;
                        });
                      }}
                      className={`flex items-center gap-2.5 px-5 py-3 rounded-xl border-2 text-xs font-black uppercase tracking-widest transition-all ${
                        checked
                          ? "bg-[#FFA500] border-[#FFA500] text-white shadow-lg shadow-orange-500/20 italic"
                          : "bg-gray-50 border-gray-100 text-gray-500 hover:border-[#FFA500] hover:text-[#FFA500]"
                      }`}
                    >
                      <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center shrink-0 ${
                        checked ? "border-white/60 bg-white/20" : "border-gray-300"
                      }`}>
                        {checked && <div className="w-1.5 h-1.5 rounded-sm bg-white" />}
                      </div>
                      {field.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <button
             onClick={handleSync}
             disabled={syncStatus === "loading" || (!syncPreset && customFields.size === 0)}
             className="w-full max-w-md py-8 bg-[#FFA500] hover:bg-orange-600 text-white font-black text-xs rounded-2xl disabled:opacity-50 transition-all flex items-center justify-center space-x-4 shadow-2xl shadow-orange-500/30 uppercase tracking-[0.2em] italic"
          >
            {syncStatus === "loading" ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Play className="w-6 h-6 fill-white" />}
            <span>{syncStatus === "loading" ? "Operation Running" : "Ignite Synchronisation"}</span>
          </button>

          {syncStatus === "loading" && (
              <div className="w-full max-w-xl mt-20 space-y-8">
                 <div className="flex justify-between font-black text-gray-400 mb-2 px-2">
                   <div className="flex flex-col">
                     <span className="uppercase text-[10px] tracking-[0.3em] mb-2 italic text-[#FFA500]">{syncMessage}</span>
                     <span className="text-black text-3xl font-black tracking-tighter italic">
                       {syncProgress.current} <span className="text-gray-200">/ {syncProgress.total}</span>
                     </span>
                   </div>
                   <span className="text-black font-black text-4xl italic">{Math.round((syncProgress.current / (syncProgress.total || 1)) * 100)}%</span>
                 </div>
                 <div className="h-6 bg-white rounded-full overflow-hidden border border-gray-100 p-1.5 shadow-inner">
                   <motion.div 
                     className="h-full bg-gradient-to-r from-[#FFA500] to-orange-400 rounded-full shadow-[0_0_40px_rgba(255,165,0,0.4)]"
                     initial={{ width: 0 }}
                     animate={{ width: `${(syncProgress.current / (syncProgress.total || 1)) * 100}%` }}
                     transition={{ type: 'spring', damping: 20 }}
                   />
                 </div>
                 <button 
                  onClick={handleCancel}
                  className="w-full py-5 text-[10px] font-black uppercase tracking-[0.3em] text-red-500 bg-red-50 hover:bg-red-500 hover:text-white border border-red-100 rounded-2xl transition-all shadow-xl shadow-red-500/5 flex items-center justify-center space-x-3 italic"
                 >
                   <X className="w-4 h-4" />
                   <span>Emergency Stop Sync</span>
                 </button>
              </div>
          )}

          {syncResult && (
             <motion.div 
               initial={{ opacity: 0, scale: 0.9 }}
               animate={{ opacity: 1, scale: 1 }}
               className="grid grid-cols-2 gap-6 w-full max-w-xl mt-20"
              >
                <div className="bg-white border border-emerald-100 rounded-[2.5rem] p-10 text-center shadow-xl shadow-emerald-500/5">
                  <p className="text-6xl font-black text-emerald-500 mb-3 italic">{syncResult.updated}</p>
                  <p className="text-gray-400 font-black uppercase text-[10px] tracking-[0.2em]">Successful Pulses</p>
                </div>
                <div className="bg-white border border-red-100 rounded-[2.5rem] p-10 text-center shadow-xl shadow-red-500/5">
                  <p className="text-6xl font-black text-red-500 mb-3 italic">{syncResult.errors}</p>
                  <p className="text-gray-400 font-black uppercase text-[10px] tracking-[0.2em]">Blocked items</p>
                </div>
             </motion.div>
          )}

          {logs.length > 0 && (
            <div className="mt-20 w-full max-w-4xl bg-white rounded-[3rem] border border-gray-100 p-10 relative overflow-hidden group shadow-2xl">
               <div className="flex items-center justify-between mb-8 border-b border-gray-50 pb-6">
                  <h4 className="text-black font-black uppercase text-xs tracking-[0.4em] italic underline decoration-[#FFA500] decoration-2 underline-offset-8">Pipeline Terminal Log</h4>
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[10px] font-black text-emerald-500 uppercase">Live Feed</span>
                  </div>
               </div>
               <div className="max-h-72 overflow-y-auto space-y-3 font-mono text-xs pr-6 scrollbar-hide">
                  {logs.map((log, i) => (
                    <div key={i} className="flex space-x-6 p-3 rounded-2xl hover:bg-gray-50 transition-all border-l-4 border-transparent hover:border-[#FFA500] group/log shadow-sm hover:shadow-md">
                      <span className="text-gray-300 select-none font-bold uppercase transition-colors group-hover/log:text-[#FFA500]/50 tracking-tighter">LINE-{i.toString().padStart(3, '0')}</span>
                      <span className="text-gray-600 font-medium leading-relaxed">{log}</span>
                    </div>
                  ))}
               </div>
               <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white pointer-events-none" />
            </div>
          )}
        </div>
      </div>
      )}
      </> /* end storeChosen */
      )}
    </div>
  );
}