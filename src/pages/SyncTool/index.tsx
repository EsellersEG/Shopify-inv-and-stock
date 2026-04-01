import React, { useState, useEffect, useRef } from "react";
import { Settings, RefreshCw, Database, CheckCircle2, AlertCircle, Play, Save, LayoutGrid, Store } from "lucide-react";
import { useLocation } from "react-router-dom";
import { motion } from "framer-motion";

export default function SyncTool() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState("credentials");
  const [stores, setStores] = useState<any[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  
  // State for the sync process
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [sheetName, setSheetName] = useState("Sheet1");

  const [skuCol, setSkuCol] = useState("SKU");
  const [priceCol, setPriceCol] = useState("Price");
  const [inventoryCol, setInventoryCol] = useState("Inventory");

  const [syncStatus, setSyncStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [syncMode, setSyncMode] = useState<"both" | "stock" | "price">("both");
  const [syncProgress, setSyncProgress] = useState({ current: 0, total: 0 });
  const [syncMessage, setSyncMessage] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [syncResult, setSyncResult] = useState<{ updated: number; errors: number; duration?: number } | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

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
      if (data.length > 0 && !location.state?.store) {
        applyStore(data[0]);
      }
    }
  };

  const applyStore = (store: any) => {
    setSelectedStoreId(store.id);
    setShopDomain(store.shopDomain);
    setAccessToken(store.accessToken);
    setSpreadsheetId(store.spreadsheetId);
    setServiceAccountJson(store.serviceAccountJson);
    setSheetName(store.sheet_name || "Sheet1");
    setSkuCol(store.sku_col || "SKU");
    setPriceCol(store.price_col || "Price");
    setInventoryCol(store.inventory_col || "Inventory");
  };

  const handleSync = async () => {
    setSyncStatus("loading");
    setLogs([]);
    setSyncResult(null);
    setSyncProgress({ current: 0, total: 0 });
    setSyncMessage("Requesting server to start background sync...");
    
    try {
      const token = localStorage.getItem('token');
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
          syncMode,
          mapping: {
            sku: skuCol,
            price: priceCol,
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

  return (
    <div className="max-w-6xl mx-auto pb-20">
      <header className="flex items-center justify-between mb-12">
        <div>
          <h1 className="text-4xl font-bold text-white tracking-tight">Inventory Bridge</h1>
          <p className="text-gray-500 mt-2 font-medium">Automatic Stock & Price reconciliation for {shopDomain || 'your store'}</p>
        </div>
        <div className="flex items-center space-x-4">
          <select 
            className="bg-[#141414] border border-white/10 rounded-2xl px-4 py-3 text-white outline-none focus:ring-2 focus:ring-blue-500/50 min-w-[200px]"
            value={selectedStoreId}
            onChange={(e) => {
              const s = stores.find(st => st.id === e.target.value);
              if (s) applyStore(s);
            }}
          >
            {stores.map(s => <option key={s.id} value={s.id}>{s.shopDomain}</option>)}
          </select>
        </div>
      </header>

      {/* Removed Tabs to consolidate configuration into Store DB */}

      <div className="bg-[#141414] rounded-[2.5rem] border border-white/10 overflow-hidden shadow-2xl backdrop-blur-xl">
        <div className="p-16 flex flex-col items-center">
          <motion.div 
            animate={syncStatus === "loading" ? { rotate: 360 } : {}}
            transition={syncStatus === "loading" ? { repeat: Infinity, duration: 10, ease: "linear" } : {}}
            className="bg-blue-600/10 p-10 rounded-[3rem] mb-10 border border-blue-500/10"
          >
            <RefreshCw className={`w-20 h-20 text-blue-500 ${syncStatus === "loading" ? "animate-spin-slow" : ""}`} />
          </motion.div>

          <h2 className="text-4xl font-black text-white mb-4">Execute Sync</h2>
          <p className="text-gray-500 max-w-sm text-center mb-12 text-sm font-medium">
            Ready to synchronize <b>{shopDomain}</b> credentials and mapping set in the master database.
          </p>

          <div className="grid grid-cols-3 gap-6 mb-12 w-full max-w-xl">
            {[
              { id: 'both', name: 'Price & Stock' },
              { id: 'stock', name: 'Stock Only' },
              { id: 'price', name: 'Price Only' }
            ].map(mode => (
              <button
                key={mode.id}
                onClick={() => setSyncMode(mode.id as any)}
                className={`py-4 rounded-2xl font-bold border-2 transition-all ${
                  syncMode === mode.id 
                  ? "bg-blue-600 border-blue-600 text-white shadow-xl shadow-blue-600/20" 
                  : "border-white/5 text-gray-500 hover:border-white/10"
                }`}
              >
                {mode.name}
              </button>
            ))}
          </div>

          <button
             onClick={handleSync}
             disabled={syncStatus === "loading"}
             className="w-full max-w-md py-6 bg-white text-black font-black text-xl rounded-2xl hover:bg-gray-200 disabled:opacity-50 transition-all flex items-center justify-center space-x-4 shadow-2l"
          >
            {syncStatus === "loading" ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Play className="w-6 h-6 fill-black" />}
            <span>{syncStatus === "loading" ? "Operation Running" : "Start Sync"}</span>
          </button>

          {syncStatus === "loading" && (
             <div className="w-full max-w-xl mt-16 space-y-4">
                <div className="flex justify-between font-bold text-gray-500 mb-2 px-2">
                  <div className="flex flex-col">
                    <span className="uppercase text-[10px] tracking-[0.2em] mb-1">{syncMessage}</span>
                    <span className="text-white text-lg font-mono tracking-tighter">
                      {syncProgress.current} <span className="text-gray-600">/ {syncProgress.total}</span>
                    </span>
                  </div>
                  <span className="text-blue-500 font-black text-2xl font-mono">{Math.round((syncProgress.current / (syncProgress.total || 1)) * 100)}%</span>
                </div>
                <div className="h-5 bg-white/5 rounded-full overflow-hidden border border-white/5 p-1">
                  <motion.div 
                    className="h-full bg-blue-600 rounded-full shadow-[0_0_30px_rgba(37,99,235,0.4)]"
                    initial={{ width: 0 }}
                    animate={{ width: `${(syncProgress.current / (syncProgress.total || 1)) * 100}%` }}
                    transition={{ type: 'spring', damping: 20 }}
                  />
                </div>
             </div>
          )}

          {syncResult && (
             <motion.div 
               initial={{ opacity: 0, scale: 0.9 }}
               animate={{ opacity: 1, scale: 1 }}
               className="grid grid-cols-2 gap-6 w-full max-w-xl mt-16"
              >
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-[2rem] p-8 text-center backdrop-blur-xl">
                  <p className="text-5xl font-black text-emerald-500 mb-2">{syncResult.updated}</p>
                  <p className="text-gray-500 font-bold uppercase text-xs tracking-widest">Successful Pulses</p>
                </div>
                <div className="bg-red-500/5 border border-red-500/20 rounded-[2rem] p-8 text-center backdrop-blur-xl">
                  <p className="text-5xl font-black text-red-500 mb-2">{syncResult.errors}</p>
                  <p className="text-gray-500 font-bold uppercase text-xs tracking-widest">Blocked items</p>
                </div>
             </motion.div>
          )}

          {logs.length > 0 && (
            <div className="mt-16 w-full max-w-4xl bg-[#0d0d0d] rounded-[2.5rem] border border-white/5 p-8 relative overflow-hidden group">
               <div className="flex items-center justify-between mb-6">
                  <h4 className="text-gray-500 font-black uppercase text-xs tracking-[0.3em]">Pipeline Terminal Log</h4>
                  <Database className="w-4 h-4 text-gray-800" />
               </div>
               <div className="max-h-60 overflow-y-auto space-y-2 font-mono text-sm pr-4 scrollbar-hide">
                  {logs.map((log, i) => (
                    <div key={i} className="flex space-x-4 p-2 rounded-lg hover:bg-white/5 transition-colors border-l-2 border-transparent hover:border-blue-500">
                      <span className="text-gray-700 select-none">[{i.toString().padStart(3, '0')}]</span>
                      <span className="text-gray-300">{log}</span>
                    </div>
                  ))}
               </div>
               <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#0d0d0d] pointer-events-none" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


