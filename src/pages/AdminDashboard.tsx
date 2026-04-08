import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Plus, Users, Store, Key, ChevronRight, Mail, UserPlus, Info, Database, ShieldCheck, Globe, FileJson, Edit2, Trash2, Loader2 } from 'lucide-react';
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
    name: '',
    shopDomain: '',
    accessToken: '',
    spreadsheetId: '',
    serviceAccountJson: '',
    sheetName: 'Sheet1',
    skuCol: 'SKU',
    priceCol: 'Price',
    compareAtPriceCol: 'Compare At Price',
    inventoryCol: 'Inventory'
  });

  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [selectedMasterStoreId, setSelectedMasterStoreId] = useState('');
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    if (res.id) {
      setShowAddClient(false);
      setNewClient({ name: '', email: '', password: '' });
      fetchData();
    }
  };

  const handleAddMasterStore = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = editingStoreId 
        ? await api.put(`/api/admin/master-stores/${editingStoreId}`, newMasterStore)
        : await api.post('/api/admin/master-stores', newMasterStore);
      
      if (res.id || res.success) {
        setShowAddMasterStore(false);
        setEditingStoreId(null);
        setNewMasterStore({ name: '', shopDomain: '', accessToken: '', spreadsheetId: '', serviceAccountJson: '', sheetName: 'Sheet1', skuCol: 'SKU', priceCol: 'Price', compareAtPriceCol: 'Compare At Price', inventoryCol: 'Inventory' });
        fetchData();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditStore = (store: any) => {
    setEditingStoreId(store.id);
    setNewMasterStore({
      name: store.name || '',
      shopDomain: store.shop_domain,
      accessToken: store.access_token,
      spreadsheetId: store.spreadsheet_id,
      serviceAccountJson: store.service_account_json,
      sheetName: store.sheet_name || 'Sheet1',
      skuCol: store.sku_col || 'SKU',
      priceCol: store.price_col || 'Price',
      compareAtPriceCol: store.compare_at_price_col || 'Compare At Price',
      inventoryCol: store.inventory_col || 'Inventory'
    });
    setShowAddMasterStore(true);
  };

  const handleDeleteStore = async (id: string) => {
    if (!confirm('Are you sure? This will unpin this store from all linked clients.')) return;
    const res = await api.delete(`/api/admin/master-stores/${id}`);
    if (res.success) {
      fetchData();
    }
  };

  const handleAssignStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMasterStoreId) return;
    const res = await api.post(`/api/admin/clients/${selectedClient.id}/stores`, { masterStoreId: selectedMasterStoreId });
    if (res.success) {
      setSelectedMasterStoreId('');
      fetchData();
      // Update local state to reflect new assignment immediately in modal
      const updatedClients = clients.map(c => {
        if (c.id === selectedClient.id) {
          const newStore = masterStores.find(ms => ms.id === selectedMasterStoreId);
          return { ...c, stores: [...(c.stores || []), newStore] };
        }
        return c;
      });
      setClients(updatedClients);
      setSelectedClient(updatedClients.find(c => c.id === selectedClient.id));
    }
  };

  const handleUnassignStore = async (masterStoreId: string) => {
    if (!confirm('Are you sure you want to unassign this store?')) return;
    const res = await api.delete(`/api/admin/clients/${selectedClient.id}/stores/${masterStoreId}`);
    if (res.success) {
      fetchData();
      // Update local state
      const updatedClients = clients.map(c => {
        if (c.id === selectedClient.id) {
          return { ...c, stores: c.stores.filter((s: any) => s.id !== masterStoreId) };
        }
        return c;
      });
      setClients(updatedClients);
      setSelectedClient(updatedClients.find(c => c.id === selectedClient.id));
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-10 pb-20 bg-white">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-black text-black tracking-tight uppercase italic">Master Panel</h1>
          <p className="text-gray-600 mt-2 font-medium">Internal Operations & Multi-Tenant Management</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => {
              setEditingStoreId(null);
              setNewMasterStore({ name: '', shopDomain: '', accessToken: '', spreadsheetId: '', serviceAccountJson: '', sheetName: 'Sheet1', skuCol: 'SKU', priceCol: 'Price', compareAtPriceCol: 'Compare At Price', inventoryCol: 'Inventory' });
              setShowAddMasterStore(true);
            }}
            className="flex items-center space-x-2 bg-[#FFA500] hover:bg-orange-600 text-white px-6 py-3.5 rounded-2xl font-bold shadow-lg shadow-orange-500/20 transition-all active:scale-95 text-xs uppercase tracking-widest"
          >
            <Database className="w-4 h-4 text-white" />
            <span>Register Store</span>
          </button>
          <button
            onClick={() => setShowAddClient(true)}
            className="flex items-center space-x-2 bg-[#FFA500] hover:bg-orange-600 text-white px-6 py-3.5 rounded-2xl font-bold shadow-lg shadow-orange-500/20 transition-all active:scale-95 text-xs uppercase tracking-widest"
          >
            <UserPlus className="w-4 h-4" />
            <span>Onboard Client</span>
          </button>
        </div>
      </header>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { name: 'Total Clients', value: clients.length, icon: Users, color: 'text-[#FFA500]' },
          { name: 'Store Database', value: masterStores.length, icon: Database, color: 'text-black' },
          { name: 'Active Links', value: clients.reduce((acc, c) => acc + (c.stores?.length || 0), 0), icon: Store, color: 'text-emerald-500' },
          { name: 'Security', value: 'JWT + BCrypt', icon: Key, color: 'text-orange-500' },
        ].map((stat, i) => (
          <div key={i} className="bg-gray-50 border border-gray-100 rounded-[2rem] p-6 flex items-center space-x-5">
            <div className={`p-4 rounded-2xl bg-white ${stat.color} shadow-sm ring-1 ring-black/5`}>
              <stat.icon className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{stat.name}</p>
              <p className="text-xl font-black text-black mt-0.5">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex space-x-2 bg-gray-50 p-1.5 rounded-2xl w-fit border border-gray-100">
        <button
          onClick={() => setActiveTab('clients')}
          className={`px-6 py-3 text-sm font-bold rounded-xl transition-all ${
            activeTab === 'clients' ? "bg-white text-black shadow-lg ring-1 ring-black/5" : "text-gray-500 hover:text-black"
          }`}
        >
          Clients ({clients.length})
        </button>
        <button
          onClick={() => setActiveTab('master-stores')}
          className={`px-6 py-3 text-sm font-bold rounded-xl transition-all ${
            activeTab === 'master-stores' ? "bg-white text-black shadow-lg ring-1 ring-black/5" : "text-gray-500 hover:text-black"
          }`}
        >
          Store Database ({masterStores.length})
        </button>
      </div>

      {activeTab === 'clients' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
             {loading ? (
                <div className="p-20 text-center text-gray-500 bg-gray-50 rounded-[3rem] border border-dashed border-gray-200">Loading clients...</div>
             ) : clients.length === 0 ? (
                <div className="p-20 text-center text-gray-500 bg-gray-50 rounded-[3rem] border border-dashed border-gray-200 uppercase tracking-tighter font-black">No Clients Onboarded</div>
             ) : clients.map((client) => (
                <motion.div
                  key={client.id}
                  className="bg-white border border-gray-100 rounded-[2.5rem] p-8 hover:border-[#FFA500]/20 transition-all group relative overflow-hidden shadow-sm hover:shadow-xl"
                >
                   <div className="flex items-center justify-between relative z-10">
                    <div className="flex items-center space-x-6">
                      <div className="w-16 h-16 rounded-[1.5rem] bg-gradient-to-br from-[#FFA500] to-orange-400 p-0.5 shadow-lg shadow-orange-500/20">
                        <div className="w-full h-full bg-white rounded-[1.4rem] flex items-center justify-center text-black text-2xl font-black">
                          {client.name[0]}
                        </div>
                      </div>
                      <div>
                        <h3 className="text-2xl font-black text-black">{client.name}</h3>
                        <div className="flex items-center space-x-4 mt-2 text-sm">
                          <span className="flex items-center text-gray-500 font-medium"><Mail className="w-4 h-4 mr-2 text-[#FFA500]/50" /> {client.email}</span>
                          <span className="flex items-center text-[#FFA500] bg-[#FFA500]/5 px-3 py-1 rounded-full text-xs font-bold ring-1 ring-[#FFA500]/20 uppercase">
                             {client.stores?.length || 0} ACTIVE STORES
                          </span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedClient(client)}
                      className="flex items-center space-x-2 bg-[#FFA500] hover:bg-orange-600 text-white px-6 py-4 rounded-2xl font-black text-xs transition-all shadow-xl shadow-orange-500/20 uppercase tracking-widest"
                    >
                      <Plus className="w-4 h-4" />
                      <span>ASSIGN STORE</span>
                    </button>
                  </div>
                </motion.div>
             ))}
          </div>
          <div>
            <div className="bg-gradient-to-br from-[#FFA500]/5 to-transparent border border-[#FFA500]/10 rounded-[2.5rem] p-10 sticky top-10">
              <ShieldCheck className="w-10 h-10 text-[#FFA500] mb-6" />
              <h3 className="text-2xl font-black text-black mb-4 italic uppercase">Security Note</h3>
              <p className="text-gray-600 leading-relaxed text-sm mb-6 font-medium">
                SyncFlow uses isolated tenant environments. Clients can only interact with Shopify stores that you link to their profile.
              </p>
              <div className="p-5 bg-black/5 rounded-2xl border border-black/5">
                 <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-2">Internal Rule</p>
                 <p className="text-sm text-gray-700 font-medium italic">"One Store, Many Faces. Register once, assign to anyone."</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'master-stores' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
           {masterStores.length === 0 ? (
              <div className="col-span-full p-20 text-center text-gray-500 bg-gray-50 rounded-[3rem] border border-dashed border-gray-200 uppercase tracking-tighter font-black">Database Empty</div>
           ) : masterStores.map((store) => (
              <div key={store.id} className="bg-white border border-gray-100 rounded-[2.5rem] p-8 space-y-6 shadow-sm hover:shadow-xl transition-all">
                <div className="flex items-center justify-between">
                   <div className="p-4 bg-orange-500/5 rounded-2xl">
                      <Store className="w-6 h-6 text-[#FFA500]" />
                   </div>
                    <div className="flex items-center space-x-2">
                       <button 
                         onClick={() => handleEditStore(store)}
                         className="p-2.5 bg-gray-50 hover:bg-black hover:text-white text-gray-600 rounded-xl transition-all border border-gray-100"
                       >
                         <Edit2 className="w-4 h-4" />
                       </button>
                       <button 
                         onClick={() => handleDeleteStore(store.id)}
                         className="p-2.5 bg-gray-50 hover:bg-red-500 hover:text-white text-gray-400 rounded-xl transition-all border border-gray-100"
                       >
                         <Trash2 className="w-4 h-4" />
                       </button>
                    </div>
                </div>
                <div>
                   <h3 className="text-xl font-black text-black truncate">{store.name || 'Unlabeled Store'}</h3>
                   <p className="text-[10px] text-[#FFA500] font-black uppercase tracking-[0.2em] mt-1">{store.shop_domain}</p>
                   <div className="flex items-center space-x-2 mt-4">
                      <Database className="w-3.5 h-3.5 text-gray-400" />
                      <p className="text-xs text-gray-500 font-mono truncate">{store.spreadsheet_id}</p>
                   </div>
                </div>
                <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
                   <div className="flex -space-x-2">
                       <div className="w-8 h-8 rounded-full bg-black border-2 border-white flex items-center justify-center text-[10px] font-bold text-[#FFA500]">E</div>
                   </div>
                   <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Active Database Item</p>
                </div>
              </div>
           ))}
        </div>
      )}

      {/* Modals */}
      <AnimatePresence>
        {/* Onboard Client Modal */}
        {showAddClient && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-md z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white border border-gray-200 rounded-[3rem] w-full max-w-xl p-12 shadow-2xl relative overflow-hidden"
            >
              <h2 className="text-4xl font-black text-black mb-2 italic uppercase">New Client</h2>
              <p className="text-gray-400 mb-10 font-bold uppercase text-xs tracking-widest">Platform Access Credentials</p>
              
              <form onSubmit={handleAddClient} className="space-y-6">
                <div className="grid grid-cols-1 gap-6">
                  <div>
                     <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Display Identity</label>
                    <div className="relative">
                       <UserPlus className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                       <input
                        type="text"
                        required
                        className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
                        placeholder="e.g. Mira Medical Ltd."
                        value={newClient.name}
                        onChange={(e) => setNewClient({ ...newClient, name: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                     <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Login Email</label>
                    <div className="relative">
                       <Mail className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                       <input
                        type="email"
                        required
                        className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
                        placeholder="client@esellers.net"
                        value={newClient.email}
                        onChange={(e) => setNewClient({ ...newClient, email: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                     <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Master Password</label>
                    <div className="relative">
                       <Key className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                       <input
                        type="password"
                        required
                        className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
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
                    className="flex-1 py-5 px-8 bg-white border border-gray-200 text-black font-black rounded-2xl transition-all uppercase text-[10px] tracking-widest hover:bg-gray-50 active:scale-95"
                  >
                    Discard
                  </button>
                  <button
                    type="submit"
                    className="flex-2 py-5 px-12 bg-[#FFA500] hover:bg-orange-600 text-white font-black rounded-2xl transition-all shadow-xl shadow-orange-500/20 uppercase text-xs tracking-widest italic"
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
          <div className="fixed inset-0 bg-white/80 backdrop-blur-md z-50 flex items-center justify-center p-6">
            <motion.div
               initial={{ scale: 0.9, opacity: 0 }}
               animate={{ scale: 1, opacity: 1 }}
               exit={{ scale: 0.9, opacity: 0 }}
               className="bg-white border border-gray-200 rounded-[3rem] w-full max-w-2xl p-12 shadow-2xl relative overflow-hidden max-h-[90vh] overflow-y-auto"
            >
               <h2 className="text-4xl font-black text-black mb-2 italic uppercase">{editingStoreId ? 'Edit Store' : 'Store DB'}</h2>
               <p className="text-gray-400 mb-10 font-bold uppercase text-xs tracking-widest">
                  {editingStoreId ? 'Update Existing Shopify Configuration' : 'Register New Shopify Integrity Point'}
               </p>

                <form onSubmit={handleAddMasterStore} className="space-y-6">
                  <div className="grid grid-cols-2 gap-6">
                     <div className="col-span-full">
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Store Name (Internal)</label>
                        <div className="relative">
                            <Store className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                            <input
                              type="text"
                              required
                              className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
                              placeholder="e.g. Mira Medical - Warehouse A"
                              value={newMasterStore.name}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, name: e.target.value })}
                            />
                        </div>
                     </div>
                     <div className="col-span-full">
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Shopify Domain</label>
                        <div className="relative">
                            <Globe className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                            <input
                              type="text"
                              required
                              className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
                              placeholder="store.myshopify.com"
                              value={newMasterStore.shopDomain}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, shopDomain: e.target.value })}
                            />
                        </div>
                     </div>
                     <div className="col-span-full">
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Admin Access Token (shpat_...)</label>
                        <div className="relative">
                            <Key className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                            <input
                              type="password"
                              required
                              className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
                              placeholder="••••••••••••••••"
                              value={newMasterStore.accessToken}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, accessToken: e.target.value })}
                            />
                        </div>
                     </div>
                     <div>
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Google Sheet ID</label>
                        <div className="relative">
                            <Database className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                            <input
                              type="text"
                              required
                              className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
                              placeholder="1BxiMVs..."
                              value={newMasterStore.spreadsheetId}
                              onChange={(e) => setNewMasterStore({ ...newMasterStore, spreadsheetId: e.target.value })}
                            />
                        </div>
                     </div>
                     <div>
                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Default Tab Name</label>
                        <input
                          type="text"
                          required
                          className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all"
                          placeholder="Sheet1"
                          value={newMasterStore.sheetName}
                          onChange={(e) => setNewMasterStore({ ...newMasterStore, sheetName: e.target.value })}
                        />
                     </div>
                      <div className="col-span-full border-t border-gray-100 pt-6 mt-4">
                         <label className="block text-[10px] font-black text-[#FFA500] uppercase tracking-[0.2em] mb-6 ml-1 italic">Field Mapping (Column Names in Sheet)</label>
                         <div className="grid grid-cols-3 gap-4">
                            <div>
                               <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">SKU Column</label>
                               <input
                                 type="text"
                                 required
                                 className="w-full bg-gray-50 border border-gray-100 rounded-xl p-4 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all text-sm"
                                 value={newMasterStore.skuCol}
                                 onChange={(e) => setNewMasterStore({ ...newMasterStore, skuCol: e.target.value })}
                               />
                            </div>
                            <div>
                               <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Price Column</label>
                               <input
                                 type="text"
                                 required
                                 className="w-full bg-gray-50 border border-gray-100 rounded-xl p-4 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all text-sm"
                                 value={newMasterStore.priceCol}
                                 onChange={(e) => setNewMasterStore({ ...newMasterStore, priceCol: e.target.value })}
                               />
                            </div>
                            <div>
                               <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Compare At Price Column</label>
                               <input
                                 type="text"
                                 className="w-full bg-gray-50 border border-gray-100 rounded-xl p-4 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all text-sm"
                                 value={newMasterStore.compareAtPriceCol}
                                 onChange={(e) => setNewMasterStore({ ...newMasterStore, compareAtPriceCol: e.target.value })}
                               />
                            </div>
                            <div>
                               <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Inventory Column</label>
                               <input
                                 type="text"
                                 required
                                 className="w-full bg-gray-50 border border-gray-100 rounded-xl p-4 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-bold transition-all text-sm"
                                 value={newMasterStore.inventoryCol}
                                 onChange={(e) => setNewMasterStore({ ...newMasterStore, inventoryCol: e.target.value })}
                               />
                            </div>
                         </div>
                      </div>
                      <div className="col-span-full border-t border-gray-100 pt-6 mt-4">
                         <label className="block text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-3 ml-1">Service Account JSON</label>
                        <div className="relative">
                            <FileJson className="absolute left-5 top-5 w-5 h-5 text-gray-300" />
                            <textarea
                              required
                              rows={5}
                              className="w-full bg-gray-50 border border-gray-100 rounded-2xl p-5 pl-14 text-black placeholder-gray-400 outline-none focus:ring-2 focus:ring-[#FFA500] font-mono text-xs transition-all"
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
                        className="flex-1 py-5 px-8 bg-white border border-gray-200 text-black font-black rounded-2xl transition-all uppercase text-[10px] tracking-widest hover:bg-gray-50 active:scale-95"
                    >
                        Discard
                    </button>
                     <button
                        type="submit"
                        disabled={isSubmitting}
                        className="flex-2 py-5 px-12 bg-[#FFA500] hover:bg-orange-600 disabled:bg-gray-400 disabled:opacity-50 text-white font-black rounded-2xl transition-all shadow-xl shadow-orange-500/20 uppercase text-xs tracking-widest flex items-center justify-center space-x-3 cursor-pointer italic"
                    >
                        {isSubmitting ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Processing...</span>
                          </>
                        ) : (
                          <span>{editingStoreId ? 'Update Database' : 'Save to Database'}</span>
                        )}
                    </button>
                  </div>
                </form>
            </motion.div>
          </div>
        )}

        {/* Assign Linked Store Modal */}
        {selectedClient && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-md z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white border border-gray-200 rounded-[3rem] w-full max-w-xl p-12 shadow-2xl relative overflow-hidden"
            >
              <h2 className="text-4xl font-black text-black mb-2 italic uppercase">Assign Store</h2>
              <p className="text-gray-400 mb-10 font-bold uppercase text-xs tracking-widest">Connect {selectedClient.name} to Database</p>
              
              <form onSubmit={handleAssignStore} className="space-y-8">
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-4 ml-1">Select from Database</label>
                  <select
                    required
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl p-6 text-black outline-none focus:ring-2 focus:ring-[#FFA500] font-black text-lg appearance-none cursor-pointer hover:bg-gray-100 transition-all"
                    value={selectedMasterStoreId}
                    onChange={(e) => setSelectedMasterStoreId(e.target.value)}
                  >
                    <option value="" className="bg-white">-- Select Saved Store --</option>
                    {masterStores.map((ms) => (
                      <option key={ms.id} value={ms.id} className="bg-white">{ms.name} ({ms.shop_domain})</option>
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
                        <div key={i} className="flex items-center justify-between p-4 bg-gray-50 border border-gray-100 rounded-2xl">
                          <div className="flex flex-col">
                            <span className="text-black font-black text-xs italic">{s.name || 'Unlabeled Store'}</span>
                            <span className="text-gray-600 font-bold text-[9px] uppercase tracking-tighter mt-1">{s.shop_domain}</span>
                          </div>
                          <div className="flex items-center space-x-2">
                             <ShieldCheck className="w-4 h-4 text-emerald-500/50" />
                             <button
                               type="button"
                               onClick={() => handleUnassignStore(s.id)}
                               className="p-2 hover:bg-red-50 text-red-400 hover:text-red-600 rounded-xl transition-all"
                               title="Unassign Store"
                             >
                               <Trash2 className="w-4 h-4" />
                             </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center space-x-4 pt-8 border-t border-gray-100">
                  <button
                    type="button"
                    onClick={() => setSelectedClient(null)}
                    className="flex-1 py-5 px-8 bg-white border border-gray-200 text-black font-black rounded-2xl transition-all uppercase text-[10px] tracking-widest hover:bg-gray-50 active:scale-95"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!selectedMasterStoreId}
                    className="flex-2 py-5 px-12 bg-[#FFA500] hover:bg-orange-600 disabled:opacity-30 text-white font-black rounded-2xl transition-all shadow-xl shadow-orange-500/20 uppercase text-xs tracking-widest italic"
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
