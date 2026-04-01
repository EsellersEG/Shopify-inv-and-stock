import React, { useState, useEffect } from "react";
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

  useEffect(() => {
    fetchMyStores();
  }, []);

  useEffect(() => {
    // If we came from a dashboard with a specific store
    if (location.state?.store) {
      applyStore(location.state.store);
    }
  }, [location.state]);

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
    setSheetName(store.sheetName || "Sheet1");
    setSkuCol(store.skuCol || "SKU");
    setPriceCol(store.priceCol || "Price");
    setInventoryCol(store.inventoryCol || "Inventory");
  };

  const handleSync = async () => {
    setSyncStatus("loading");
    setLogs([]);
    setSyncResult(null);
    setSyncProgress({ current: 0, total: 0 });
    setSyncMessage("Initializing server-side synchronization...");
    
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

      if (!res.body) throw new Error("ReadableStream not supported");

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'progress') {
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
                setSyncMessage("Critial Error occurred.");
              }
            } catch (e) {
              console.error("Stream parse error", e);
            }
          }
        }
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

      {/* Tabs */}
      <div className="flex space-x-2 bg-[#141414] p-1.5 rounded-2xl mb-10 w-fit border border-white/5">
        {[
          { id: 'credentials', name: 'Configuration', icon: Settings },
          { id: 'mapping', name: 'Field Mapping', icon: Database },
          { id: 'sync', name: 'Live Sync', icon: Play },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-5 py-2.5 text-sm font-bold rounded-xl transition-all duration-200 flex items-center ${
              activeTab === tab.id ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20" : "text-gray-400 hover:text-white"
            }`}
          >
            <tab.icon className="w-4 h-4 mr-2" />
            {tab.name}
          </button>
        ))}
      </div>

      <div className="bg-[#141414] rounded-[2.5rem] border border-white/10 overflow-hidden shadow-2xl backdrop-blur-xl">
        {activeTab === "credentials" && (
           <div className="p-10 grid grid-cols-1 md:grid-cols-2 gap-10">
              <div className="space-y-8">
                <div className="flex items-center space-x-4 text-white">
                  <div className="p-3 rounded-2xl bg-emerald-500/10 text-emerald-500">
                    <Store className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">Shopify Source</h2>
                    <p className="text-sm text-gray-500">Active store credentials</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Shop Domain</label>
                    <input disabled value={shopDomain} className="w-full bg-[#0a0a0a]/50 border border-white/5 rounded-2xl p-4 text-gray-400 cursor-not-allowed" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Access Token</label>
                    <input disabled type="password" value="••••••••••••••••" className="w-full bg-[#0a0a0a]/50 border border-white/5 rounded-2xl p-4 text-gray-400 cursor-not-allowed" />
                  </div>
                </div>
              </div>

              <div className="space-y-8">
                <div className="flex items-center space-x-4 text-white">
                  <div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500">
                    <LayoutGrid className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">Google Sheets Data</h2>
                    <p className="text-sm text-gray-500">Linked inventory document</p>
                  </div>
                </div>
                <div className="space-y-4">
                   <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Spreadsheet ID</label>
                    <input disabled value={spreadsheetId} className="w-full bg-[#0a0a0a]/50 border border-white/5 rounded-2xl p-4 text-gray-400 cursor-not-allowed" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Sheet Tab</label>
                      <input disabled value={sheetName} className="w-full bg-[#0a0a0a]/50 border border-white/5 rounded-2xl p-4 text-gray-400 cursor-not-allowed" />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Connection State</label>
                      <div className="w-full bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-4 text-emerald-500 font-bold text-center text-sm flex items-center justify-center">
                        Verified
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="col-span-full pt-8 border-t border-white/5 text-center">
                <p className="text-gray-500 text-sm">Need to update credentials? Contact your E-sellers Administrator.</p>
              </div>
           </div>
        )}

        {activeTab === "mapping" && (
          <div className="p-12 max-w-2xl mx-auto space-y-10">
            <div className="text-center">
              <h2 className="text-3xl font-bold text-white mb-2">Column definitions</h2>
              <p className="text-gray-500">Specify exactly which headers in your Google Sheet contain the product data.</p>
            </div>
            
            <div className="space-y-6">
              {[
                { label: 'SKU Identifier', desc: 'Used for product matching', value: skuCol, setter: setSkuCol, required: true },
                { label: 'Price Value', desc: 'Sale price to update in Shopify', value: priceCol, setter: setPriceCol },
                { label: 'Inventory Count', desc: 'Available quantity in warehouse', value: inventoryCol, setter: setInventoryCol }
              ].map((field, i) => (
                <div key={i} className="flex items-center justify-between p-6 bg-[#0a0a0a]/50 rounded-[2rem] border border-white/5 group hover:border-blue-500/20 transition-all">
                  <div>
                    <h4 className="font-bold text-white flex items-center">
                      {field.label} {field.required && <span className="ml-1 text-red-500">*</span>}
                    </h4>
                    <p className="text-xs text-gray-600 mt-1">{field.desc}</p>
                  </div>
                  <input
                    type="text"
                    className="w-40 bg-[#141414] border border-white/10 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 outline-none transition-all placeholder:text-gray-800"
                    placeholder="e.g. SKU"
                    value={field.value}
                    onChange={(e) => field.setter(e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "sync" && (
          <div className="p-16 flex flex-col items-center">
            <motion.div 
              animate={syncStatus === "loading" ? { rotate: 360 } : {}}
              transition={syncStatus === "loading" ? { repeat: Infinity, duration: 10, ease: "linear" } : {}}
              className="bg-blue-600/10 p-10 rounded-[3rem] mb-10 border border-blue-500/10"
            >
              <RefreshCw className={`w-20 h-20 text-blue-500 ${syncStatus === "loading" ? "animate-spin-slow" : ""}`} />
            </motion.div>

            <h2 className="text-4xl font-black text-white mb-4">Execute Sync</h2>
            <p className="text-gray-500 max-w-md text-center mb-12 text-lg">
              Initiate a live reconciliation between your Inventory Sheet and Storefront.
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
              <span>{syncStatus === "loading" ? "Operation Running" : "Ignite Pipeline"}</span>
            </button>

            {syncStatus === "loading" && (
               <div className="w-full max-w-xl mt-16 space-y-4">
                  <div className="flex justify-between font-bold text-gray-500 mb-2 px-2">
                    <span className="uppercase text-xs tracking-widest">{syncMessage}</span>
                    <span className="text-blue-500 font-mono">{Math.round((syncProgress.current / (syncProgress.total || 1)) * 100)}%</span>
                  </div>
                  <div className="h-4 bg-white/5 rounded-full overflow-hidden border border-white/5">
                    <motion.div 
                      className="h-full bg-blue-600 shadow-[0_0_20px_rgba(37,99,235,0.5)]"
                      initial={{ width: 0 }}
                      animate={{ width: `${(syncProgress.current / (syncProgress.total || 1)) * 100}%` }}
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
        )}
      </div>
    </div>
  );
}

const StoreIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);
