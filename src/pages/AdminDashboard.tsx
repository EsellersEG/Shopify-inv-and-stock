import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Plus, Users, Store, Key, ChevronRight, Mail, UserPlus, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function AdminDashboard() {
  const [clients, setClients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddClient, setShowAddClient] = useState(false);
  const [newClient, setNewClient] = useState({ name: '', email: '', password: '' });
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [newStore, setNewStore] = useState({
    shopDomain: '',
    accessToken: '',
    spreadsheetId: '',
    serviceAccountJson: '',
    sheetName: 'Sheet1'
  });

  useEffect(() => {
    fetchClients();
  }, []);

  const fetchClients = async () => {
    const data = await api.get('/api/admin/clients');
    if (Array.isArray(data)) setClients(data);
    setLoading(false);
  };

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await api.post('/api/admin/clients', newClient);
    if (res.success) {
      setShowAddClient(false);
      setNewClient({ name: '', email: '', password: '' });
      fetchClients();
    }
  };

  const handleAddStore = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await api.post(`/api/admin/clients/${selectedClient.id}/stores`, newStore);
    if (res.success) {
      setSelectedClient(null);
      setNewStore({ shopDomain: '', accessToken: '', spreadsheetId: '', serviceAccountJson: '', sheetName: 'Sheet1' });
      fetchClients();
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-white tracking-tight">Master Operations</h1>
          <p className="text-gray-500 mt-2 font-medium">Managing {clients.length} active clients across SyncFlow</p>
        </div>
        <button
          onClick={() => setShowAddClient(true)}
          className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3.5 rounded-2xl font-semibold shadow-lg shadow-blue-600/20 transition-all active:scale-95"
        >
          <UserPlus className="w-5 h-5" />
          <span>Onboard New Client</span>
        </button>
      </header>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[
          { name: 'Total Clients', value: clients.length, icon: Users, color: 'text-blue-500' },
          { name: 'Managed Stores', value: clients.reduce((acc, c) => acc + (c.stores?.length || 0), 0), icon: Store, color: 'text-emerald-500' },
          { name: 'System Security', value: 'JWT Enabled', icon: Key, color: 'text-amber-500' },
        ].map((stat, i) => (
          <div key={i} className="bg-[#141414] border border-white/5 rounded-3xl p-6 flex items-center space-x-6 backdrop-blur-sm">
            <div className={`p-4 rounded-2xl bg-white/5 ${stat.color}`}>
              <stat.icon className="w-7 h-7" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500 uppercase tracking-wider">{stat.name}</p>
              <p className="text-2xl font-bold text-white mt-1">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-2xl font-bold text-white flex items-center mb-6">
            <Users className="w-6 h-6 mr-3 text-blue-500" />
            Active Client List
          </h2>
          
          <div className="grid gap-4">
            {loading ? (
              <div className="p-12 text-center text-gray-500 bg-[#141414] rounded-3xl border border-dashed border-white/10 italic">
                Scanning for clients...
              </div>
            ) : clients.length === 0 ? (
              <div className="p-12 text-center text-gray-500 bg-[#141414] rounded-3xl border border-dashed border-white/10 italic">
                No clients found. Get started by onboarding a new partner.
              </div>
            ) : clients.map((client) => (
              <motion.div
                key={client.id}
                layoutId={client.id}
                className="bg-[#141414] border border-white/5 rounded-3xl p-6 hover:border-white/10 transition-all group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-5">
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600/20 to-blue-400/20 border border-blue-500/20 flex items-center justify-center text-blue-500 text-xl font-bold">
                      {client.name[0]}
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-white group-hover:text-blue-400 transition-colors">{client.name}</h3>
                      <div className="flex items-center space-x-3 mt-1 text-sm text-gray-500">
                        <span className="flex items-center"><Mail className="w-4 h-4 mr-1" /> {client.email || 'No email'}</span>
                        <span className="flex items-center"><Store className="w-4 h-4 mr-1" /> {client.stores?.length || 0} Stores</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedClient(client)}
                    className="flex items-center space-x-2 text-white/50 hover:text-white bg-white/5 hover:bg-white/10 px-4 py-2.5 rounded-xl transition-all"
                  >
                    <span>Manage Access</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <div>
          <div className="bg-gradient-to-br from-blue-600/10 to-transparent border border-blue-500/10 rounded-3xl p-8 sticky top-8">
            <h3 className="text-xl font-bold text-white mb-4">Quick Tip</h3>
            <p className="text-gray-400 leading-relaxed mb-6">
              When onboarding a new client, double-check that Shopify credentials include <code className="text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded font-mono">read_products</code> and <code className="text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded font-mono">write_products</code> scopes.
            </p>
            <div className="flex items-start space-x-3 text-sm text-blue-400/80 bg-blue-400/5 p-4 rounded-2xl border border-blue-400/10">
              <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <span>Clients can only view tools for stores that you manually assign to them.</span>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showAddClient && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#141414] border border-white/10 rounded-[2.5rem] w-full max-w-lg p-10 shadow-2xl"
            >
              <h2 className="text-3xl font-bold text-white mb-8">New Client Profile</h2>
              <form onSubmit={handleAddClient} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-500 mb-2">Display Name</label>
                  <input
                    type="text"
                    required
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50"
                    placeholder="e.g. Mira Medical"
                    value={newClient.name}
                    onChange={(e) => setNewClient({ ...newClient, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 mb-2">Login Email</label>
                  <input
                    type="email"
                    required
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50"
                    placeholder="client@esellers.net"
                    value={newClient.email}
                    onChange={(e) => setNewClient({ ...newClient, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 mb-2">Secret Password</label>
                  <input
                    type="password"
                    required
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50"
                    placeholder="••••••••"
                    value={newClient.password}
                    onChange={(e) => setNewClient({ ...newClient, password: e.target.value })}
                  />
                </div>
                <div className="flex items-center space-x-4 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddClient(false)}
                    className="flex-1 py-4 px-6 bg-white/5 hover:bg-white/10 text-white font-semibold rounded-2xl transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-2 py-4 px-10 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl transition-all shadow-lg shadow-blue-600/20"
                  >
                    Create Profile
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {selectedClient && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#141414] border border-white/10 rounded-[2.5rem] w-full max-w-4xl p-10 shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-10">
                <h2 className="text-3xl font-bold text-white tracking-tight">Assign Store: {selectedClient.name}</h2>
                <button 
                  onClick={() => setSelectedClient(null)}
                  className="text-gray-500 hover:text-white"
                >
                  <ChevronRight className="w-8 h-8 rotate-90" />
                </button>
              </div>

              <form onSubmit={handleAddStore} className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
                <div className="col-span-full">
                  <h3 className="text-lg font-semibold text-gray-300 border-b border-white/10 pb-2 mb-6">Credential Details</h3>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 mb-2">Shopify Domain</label>
                  <input
                    type="text"
                    required
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50"
                    placeholder="store.myshopify.com"
                    value={newStore.shopDomain}
                    onChange={(e) => setNewStore({ ...newStore, shopDomain: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 mb-2">Admin Access Token</label>
                  <input
                    type="password"
                    required
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50"
                    placeholder="shpat_..."
                    value={newStore.accessToken}
                    onChange={(e) => setNewStore({ ...newStore, accessToken: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 mb-2">Google Spreadsheet ID</label>
                  <input
                    type="text"
                    required
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50"
                    placeholder="1BxiMVs0XRY..."
                    value={newStore.spreadsheetId}
                    onChange={(e) => setNewStore({ ...newStore, spreadsheetId: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 mb-2">Sheet Name</label>
                  <input
                    type="text"
                    required
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50"
                    placeholder="Sheet1"
                    value={newStore.sheetName}
                    onChange={(e) => setNewStore({ ...newStore, sheetName: e.target.value })}
                  />
                </div>
                <div className="col-span-full">
                  <label className="block text-sm font-medium text-gray-500 mb-2">Service Account JSON</label>
                  <textarea
                    required
                    rows={4}
                    className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl p-4 text-white placeholder-gray-700 outline-none focus:ring-2 focus:ring-blue-500/50 font-mono text-xs"
                    placeholder='{"type": "service_account", ...}'
                    value={newStore.serviceAccountJson}
                    onChange={(e) => setNewStore({ ...newStore, serviceAccountJson: e.target.value })}
                  />
                </div>
                <button
                  type="submit"
                  className="col-span-full py-4 px-8 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-2xl transition-all shadow-xl shadow-blue-600/20"
                >
                  Confirm & Link Store Access
                </button>
              </form>

              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Existing Stores</h3>
                {selectedClient.stores?.length === 0 ? (
                  <p className="text-gray-600 italic">No stores assigned yet.</p>
                ) : (
                  <div className="grid gap-3">
                    {selectedClient.stores.map((s: any, i: number) => (
                      <div key={i} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                        <div className="flex items-center space-x-3">
                          <Store className="w-5 h-5 text-gray-400" />
                          <span className="text-gray-200 font-medium">{s.shopDomain}</span>
                        </div>
                        <span className="text-xs text-blue-500 font-mono uppercase">API: Active</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
