import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Plus, Users, Store, Key, ChevronRight, Mail, UserPlus, Info, Database, ShieldCheck, Globe, FileJson } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<'clients' | 'master-stores'>('clients');
  const [clients, setClients] = useState<any[]>([]);
  const [masterStores, setMasterStores] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [showAddClient, setShowAddClient] = useState(false);
  const [newClient, setNewClient] = useState({ name: '', email: '', password: '' });
  
  const [showAddMasterStore, setShowAddMasterStore] = useState(false);
  const [newMasterStore, setNewMasterStore] = useState({
    shopDomain: '',
    accessToken: '',
    spreadsheetId: '',
    serviceAccountJson: '',
    sheetName: 'Sheet1'
  });

  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [selectedMasterStoreId, setSelectedMasterStoreId] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    const [clientsData, masterStoresData] = await Promise.all([
      api.get('/api/admin/clients'),
      api.get('/api/admin/master-stores')
    ]);
    if (Array.isArray(clientsData)) setClients(clientsData);
    if (Array.isArray(masterStoresData)) setMasterStores(masterStoresData);
    setLoading(false);
  };

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await api.post('/api/admin/clients', newClient);
    if (res.success) {
      setShowAddClient(false);
      setNewClient({ name: '', email: '', password: '' });
      fetchData();
    }
  };

  const handleAddMasterStore = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await api.post('/api/admin/master-stores', newMasterStore);
    if (res.success) {
      setShowAddMasterStore(false);
      setNewMasterStore({ shopDomain: '', accessToken: '', spreadsheetId: '', serviceAccountJson: '', sheetName: 'Sheet1' });
      fetchData();
    }
  };

  const handleAssignStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMasterStoreId) return;

    const res = await api.post(`/api/admin/clients/${selectedClient.id}/stores`, {
      masterStoreId: selectedMasterStoreId
    });
    
    if (res.success) {
      setSelectedClient(null);
      setSelectedMasterStoreId('');
      fetchData();
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-10 pb-20">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-black text-white tracking-tight">Master Panel</h1>
          <p className="text-gray-500 mt-2 font-medium">Internal Operations & Multi-Tenant Management</p>
        </div>
        <div className="flex items-center space-x-3">
           <button
            onClick={() => setShowAddMasterStore(true)}
            className="flex items-center space-x-2 bg-white/5 hover:bg-white/10 text-white px-6 py-3.5 rounded-2xl font-semibold border border-white/5 transition-all text-sm"
          >
            <Database className="w-4 h-4 text-blue-500" />
            <span>Register Store in DB</span>
          </button>
          <button
            onClick={() => setShowAddClient(true)}
            className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3.5 rounded-2xl font-semibold shadow-lg shadow-blue-600/20 transition-all active:scale-95 text-sm"
          >
            <UserPlus className="w-4 h-4" />
            <span>Onboard New Client</span>
          </button>
        </div>
      </header>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { name: 'Total Clients', value: clients.length, icon: Users, color: 'text-blue-500' },
          { name: 'Store Database', value: masterStores.length, icon: Database, color: 'text-purple-500' },
          { name: 'Active Links', value: clients.reduce((acc, c) => acc + (c.stores?.length || 0), 0), icon: Store, color: 'text-emerald-500' },
          { name: 'Security', value: 'JWT + BCrypt', icon: Key, color: 'text-amber-500' },
        ].map((stat, i) => (
          <div key={i} className="bg-[#141414] border border-white/5 rounded-[2rem] p-6 flex items-center space-x-5">
            <div className={`p-4 rounded-2xl bg-white/5 ${stat.color}`}>
              <stat.icon className="w-6 h-6" />
            </div>
            <div>
              <p className="text-xs font-bold text-gray-600 uppercase tracking-widest">{stat.name}</p>
              <p className="text-xl font-black text-white mt-0.5">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex space-x-2 bg-[#141414] p-1.5 rounded-2xl w-fit border border-white/5">
        <button
          onClick={() => setActiveTab('clients')}
          className={`px-6 py-3 text-sm font-bold rounded-xl transition-all ${
            activeTab === 'clients' ? "bg-white text-black shadow-xl" : "text-gray-500 hover:text-white"
          }`}
        >
          Clients ({clients.length})
        </button>
        <button
          onClick={() => setActiveTab('master-stores')}
          className={`px-6 py-3 text-sm font-bold rounded-xl transition-all ${
            activeTab === 'master-stores' ? "bg-white text-black shadow-xl" : "text-gray-500 hover:text-white"
          }`}
        >
          Store Database ({masterStores.length})
        </button>
      </div>

      {activeTab === 'clients' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
             {loading ? (
                <div className="p-20 text-center text-gray-500 bg-[#141414] rounded-[3rem] border border-dashed border-white/10">Loading clients...</div>
             ) : clients.length === 0 ? (
                <div className="p-20 text-center text-gray-500 bg-[#141414] rounded-[3rem] border border-dashed border-white/10 uppercase tracking-tighter font-black">No Clients Onboarded</div>
             ) : clients.map((client) => (
                <motion.div
                  key={client.id}
                  className="bg-[#141414] border border-white/5 rounded-[2.5rem] p-8 hover:border-blue-500/20 transition-all group relative overflow-hidden"
                >
                   <div className="flex items-center justify-between relative z-10">
                    <div className="flex items-center space-x-6">
                      <div className="w-16 h-16 rounded-[1.5rem] bg-gradient-to-br from-blue-600 to-blue-400 p-0.5 shadow-lg shadow-blue-600/20">
                        <div className="w-full h-full bg-[#0a0a0a] rounded-[1.4rem] flex items-center justify-center text-white text-2xl font-black">
                          {client.name[0]}
                        </div>
                      </div>
                      <div>
                        <h3 className="text-2xl font-black text-white">{client.name}</h3>
                        <div className="flex items-center space-x-4 mt-2 text-sm">
                          <span className="flex items-center text-gray-500 font-medium"><Mail className="w-4 h-4 mr-2 text-blue-500/50" /> {client.email}</span>
                          <span className="flex items-center text-emerald-500 bg-emerald-500/5 px-3 py-1 rounded-full text-xs font-bold ring-1 ring-emerald-500/20">
                             {client.stores?.length || 0} ACTIVE STORES
                          </span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedClient(client)}
                      className="flex items-center space-x-2 bg-white text-black px-6 py-4 rounded-2xl font-black text-sm hover:bg-blue-600 hover:text-white transition-all shadow-xl shadow-white/5"
                    >
                      <Plus className="w-4 h-4" />
                      <span>ASSIGN STORE</span>
                    </button>
                  </div>
                </motion.div>
             ))}
          </div>
          <div>
            <div className="bg-gradient-to-br from-blue-600/10 to-transparent border border-blue-500/10 rounded-[2.5rem] p-10 sticky top-10">
              <ShieldCheck className="w-10 h-10 text-blue-500 mb-6" />
              <h3 className="text-2xl font-black text-white mb-4 italic">Security Note</h3>
              <p className="text-gray-500 leading-relaxed text-sm mb-6 font-medium">
                SyncFlow uses isolated tenant environments. Clients can only interact with Shopify stores that you specifically link to their profile in this panel.
              </p>
              <div className="p-5 bg-white/5 rounded-2xl border border-white/5">
                 <p className="text-xs text-gray-600 uppercase font-bold tracking-widest mb-2">Internal Rule</p>
                 <p className="text-sm text-gray-400 font-medium italic">"One Store, Many Faces. Register once in DB, assign to anyone."</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'master-stores' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
           {masterStores.length === 0 ? (
              <div className="col-span-full p-20 text-center text-gray-500 bg-[#141414] rounded-[3rem] border border-dashed border-white/10 uppercase tracking-tighter font-black">Database Empty</div>
           ) : masterStores.map((store) => (
              <div key={store.id} className="bg-[#141414] border border-white/10 rounded-[2.5rem] p-8 space-y-6">
                <div className="flex items-center justify-between">
                   <div className="p-4 bg-blue-500/10 rounded-2xl">
                      <Store className="w-6 h-6 text-blue-500" />
                   </div>
                   <span className="bg-emerald-500/10 text-emerald-500 text-[10px] font-black px-3 py-1 rounded-full tracking-widest ring-1 ring-emerald-500/20">VERIFIED</span>
                </div>
                <div>
                   <h3 className="text-xl font-black text-white truncate">{store.shopDomain}</h3>
                   <div className="flex items-center space-x-2 mt-2">
                      <Database className="w-3.5 h-3.5 text-gray-600" />
                      <p className="text-xs text-gray-600 font-mono truncate">{store.spreadsheetId}</p>
                   </div>
                </div>
                <div className="pt-4 border-t border-white/5 flex items-center justify-between">
                   <div className="flex -space-x-2">
                       {/* Placeholder for showing which clients use this store */}
                       <div className="w-8 h-8 rounded-full bg-blue-600 border-2 border-[#141414] flex items-center justify-center text-[10px] font-bold">Y</div>
                   </div>
                   <p className="text-[10px] text-gray-600 font-bold uppercase tracking-widest">Active Database Item</p>
                </div>
              </div>
           ))}
        </div>
      )}

      {/* Modals */}
      <AnimatePresence>
        {/* Onboard Client Modal */}
        {showAddClient && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#0a0a0a] border border-white/10 rounded-[3rem] w-full max-w-xl p-12 shadow-2xl relative overflow-hidden"
            >
              <h2 className="text-4xl font-black text-white mb-2 italic">New Client</h2>
              <p className="text-gray-500 mb-10 font-bold uppercase text-xs tracking-widest">Platform Access Credentials</p>
              
              <form onSubmit={handleAddClient} className="space-y-6">
                <div className="grid grid-cols-1 gap-6">
                  <div>
                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Display Identity</label>
                    <div className="relative">
                       <UserPlus className="absolute left-5 top-5 w-5 h-5 text-gray-700" />
                       <input
                        type="text"
                        required
                        className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 pl-14 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-bold transition-all"
                        placeholder="e.g. Mira Medical Ltd."
                        value={newClient.name}
                        onChange={(e) => setNewClient({ ...newClient, name: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Login Email</label>
                    <div className="relative">
                       <Mail className="absolute left-5 top-5 w-5 h-5 text-gray-700" />
                       <input
                        type="email"
                        required
                        className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 pl-14 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-bold transition-all"
                        placeholder="client@esellers.net"
                        value={newClient.email}
                        onChange={(e) => setNewClient({ ...newClient, email: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Master Password</label>
                    <div className="relative">
                       <Key className="absolute left-5 top-5 w-5 h-5 text-gray-700" />
                       <input
                        type="password"
                        required
                        className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 pl-14 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-bold transition-all"
                        placeholder="••••••••"
                        value={newClient.password}
                        onChange={(e) => setNewClient({ ...newClient, password: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
                <div className="flex items-center space-x-4 pt-8">
                  <button
                    type="button"
                    onClick={() => setShowAddClient(false)}
                    className="flex-1 py-5 px-8 bg-white/5 hover:bg-white/10 text-white font-black rounded-2xl transition-all uppercase text-xs tracking-widest"
                  >
                    Discard
                  </button>
                  <button
                    type="submit"
                    className="flex-2 py-5 px-12 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-2xl transition-all shadow-xl shadow-blue-600/20 uppercase text-xs tracking-widest"
                  >
                    Confirm Access
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {/* Register Master Store Modal */}
        {showAddMasterStore && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-6">
            <motion.div
               initial={{ scale: 0.9, opacity: 0 }}
               animate={{ scale: 1, opacity: 1 }}
               exit={{ scale: 0.9, opacity: 0 }}
               className="bg-[#0a0a0a] border border-white/10 rounded-[3rem] w-full max-w-2xl p-12 shadow-2xl relative overflow-hidden max-h-[90vh] overflow-y-auto"
            >
               <h2 className="text-4xl font-black text-white mb-2 italic">Store DB</h2>
               <p className="text-gray-500 mb-10 font-bold uppercase text-xs tracking-widest">Register New Shopify Integrity Point</p>

               <form onSubmit={handleAddMasterStore} className="space-y-6">
                  <div className="grid grid-cols-2 gap-6">
                     <div className="col-span-full">
                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Shopify Domain</label>
                        <div className="relative">
                            <Globe className="absolute left-5 top-5 w-5 h-5 text-gray-700" />
                            <input
                              type="text"
                              required
                              className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 pl-14 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-bold transition-all"
                              placeholder="store.myshopify.com"
                              value={newMasterStore.shopDomain}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, shopDomain: e.target.value })}
                            />
                        </div>
                     </div>
                     <div className="col-span-full">
                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Admin Access Token (shpat_...)</label>
                        <div className="relative">
                            <Key className="absolute left-5 top-5 w-5 h-5 text-gray-700" />
                            <input
                              type="password"
                              required
                              className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 pl-14 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-bold transition-all"
                              placeholder="••••••••••••••••"
                              value={newMasterStore.accessToken}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, accessToken: e.target.value })}
                            />
                        </div>
                     </div>
                     <div>
                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Google Sheet ID</label>
                        <div className="relative">
                            <Database className="absolute left-5 top-5 w-5 h-5 text-gray-700" />
                            <input
                              type="text"
                              required
                              className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 pl-14 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-bold transition-all"
                              placeholder="1BxiMVs..."
                              value={newMasterStore.spreadsheetId}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, spreadsheetId: e.target.value })}
                            />
                        </div>
                     </div>
                     <div>
                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Default Tab Name</label>
                        <input
                          type="text"
                          required
                          className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-bold transition-all"
                          placeholder="Sheet1"
                          value={newMasterStore.sheetName}
                          onChange={(e) => setNewMasterStore({ ...newMasterStore, sheetName: e.target.value })}
                        />
                     </div>
                     <div className="col-span-full">
                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3 ml-1">Service Account JSON</label>
                        <div className="relative">
                            <FileJson className="absolute left-5 top-5 w-5 h-5 text-gray-700" />
                            <textarea
                              required
                              rows={5}
                              className="w-full bg-[#141414] border border-white/5 rounded-2xl p-5 pl-14 text-white placeholder-gray-800 outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs transition-all"
                              placeholder='{"type": "service_account", ...}'
                              value={newMasterStore.serviceAccountJson}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, serviceAccountJson: e.target.value })}
                            />
                        </div>
                     </div>
                  </div>
                  <div className="flex items-center space-x-4 pt-8">
                    <button
                        type="button"
                        onClick={() => setShowAddMasterStore(false)}
                        className="flex-1 py-5 px-8 bg-white/5 hover:bg-white/10 text-white font-black rounded-2xl transition-all uppercase text-xs tracking-widest"
                    >
                        Discard
                    </button>
                    <button
                        type="submit"
                        className="flex-2 py-5 px-12 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-2xl transition-all shadow-xl shadow-blue-600/20 uppercase text-xs tracking-widest"
                    >
                        Save to Database
                    </button>
                  </div>
               </form>
            </motion.div>
          </div>
        )}

        {/* Assign Linked Store Modal */}
        {selectedClient && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#0a0a0a] border border-white/10 rounded-[3rem] w-full max-w-xl p-12 shadow-2xl relative overflow-hidden"
            >
              <h2 className="text-4xl font-black text-white mb-2 italic">Assign Store</h2>
              <p className="text-gray-500 mb-10 font-bold uppercase text-xs tracking-widest">Connect {selectedClient.name} to Database</p>
              
              <form onSubmit={handleAssignStore} className="space-y-8">
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-4 ml-1">Select from Database</label>
                  <select
                    required
                    className="w-full bg-[#141414] border border-white/10 rounded-2xl p-6 text-white outline-none focus:ring-2 focus:ring-blue-500 font-black text-lg appearance-none cursor-pointer hover:bg-white/5 transition-all"
                    value={selectedMasterStoreId}
                    onChange={(e) => setSelectedMasterStoreId(e.target.value)}
                  >
                    <option value="" className="bg-[#0a0a0a]">-- Select Saved Store --</option>
                    {masterStores.map((ms) => (
                      <option key={ms.id} value={ms.id} className="bg-[#0a0a0a]">{ms.shopDomain}</option>
                    ))}
                  </select>
                  {masterStores.length === 0 && (
                     <p className="text-amber-500 text-[10px] font-black uppercase mt-4 text-center tracking-widest">Database is Empty. Register stores first.</p>
                  )}
                </div>
                
                <div className="space-y-4">
                  <h3 className="text-[10px] font-black text-gray-700 uppercase tracking-[0.3em]">Currently Assigned</h3>
                  {selectedClient.stores?.length === 0 ? (
                    <p className="text-gray-600 italic text-sm">No connections for this client.</p>
                  ) : (
                    <div className="grid gap-2">
                      {selectedClient.stores.map((s: any, i: number) => (
                        <div key={i} className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-2xl">
                          <span className="text-gray-400 font-bold text-xs">{s.shopDomain}</span>
                          <ShieldCheck className="w-4 h-4 text-emerald-500/50" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center space-x-4 pt-8 border-t border-white/5">
                  <button
                    type="button"
                    onClick={() => setSelectedClient(null)}
                    className="flex-1 py-5 px-8 bg-white/5 hover:bg-white/10 text-white font-black rounded-2xl transition-all uppercase text-xs tracking-widest"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!selectedMasterStoreId}
                    className="flex-2 py-5 px-12 bg-white text-black hover:bg-blue-600 hover:text-white disabled:opacity-30 disabled:hover:bg-white disabled:hover:text-black font-black rounded-2xl transition-all shadow-xl uppercase text-xs tracking-widest"
                  >
                    Link Identity
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
