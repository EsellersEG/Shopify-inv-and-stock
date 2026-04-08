import React, { useState, useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { Settings, RefreshCw, Database, CheckCircle2, AlertCircle, Play, Save, LayoutGrid, Store, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { motion } from "framer-motion";

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
    setStoreName(store.name || "");
    setShopDomain(store.shopDomain);
    setAccessToken(store.accessToken);
    setSpreadsheetId(store.spreadsheetId);
    setServiceAccountJson(store.serviceAccountJson);
    setSheetName(store.sheet_name || "Sheet1");
    setSkuCol(store.sku_col || "SKU");
    setPriceCol(store.price_col || "Price");
    setCompareAtPriceCol(store.compare_at_price_col || "Compare At Price");
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
      <header className="flex items-center justify-between mb-12">
        <div>
          <h1 className="text-4xl font-black text-black tracking-tight uppercase italic underline decoration-[#FFA500] underline-offset-8">Inventory Bridge</h1>
          <p className="text-gray-500 mt-4 font-bold uppercase text-[10px] tracking-widest leading-relaxed">Automatic Stock & Price reconciliation for <span className="text-black italic font-black">{shopDomain || 'your store'}</span></p>
        </div>
        <div className="flex items-center space-x-4">
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

          <div className="grid grid-cols-3 gap-6 mb-16 w-full max-w-xl">
            {[
              { id: 'both', name: 'Price & Stock' },
              { id: 'stock', name: 'Stock Only' },
              { id: 'price', name: 'Price Only' }
            ].map(mode => (
              <button
                key={mode.id}
                onClick={() => setSyncMode(mode.id as any)}
                className={`py-5 rounded-2xl font-black text-xs uppercase tracking-widest border-2 transition-all ${
                  syncMode === mode.id 
                  ? "bg-[#FFA500] border-[#FFA500] text-white shadow-2xl shadow-orange-500/20 italic" 
                  : "bg-white border-gray-100 text-gray-400 hover:border-[#FFA500] hover:text-[#FFA500]"
                }`}
              >
                {mode.name}
              </button>
            ))}
          </div>

          <button
             onClick={handleSync}
             disabled={syncStatus === "loading"}
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
    </div>
  );
}


