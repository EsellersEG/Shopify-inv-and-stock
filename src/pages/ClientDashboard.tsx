import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Store, ArrowRight, LayoutGrid, CheckCircle2, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

export default function ClientDashboard() {
  const [stores, setStores] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchStores();
  }, []);

  const fetchStores = async () => {
    const data = await api.get('/api/client/stores');
    if (Array.isArray(data)) setStores(data);
    setLoading(false);
  };

  const handleOpenSync = (store: any) => {
    // Pass store details via state or just navigate and let the tool load from API
    navigate('/sync', { state: { store } });
  };

  return (
    <div className="max-w-6xl mx-auto space-y-12">
      <header>
        <h1 className="text-4xl font-bold text-white tracking-tight">Your Digital Storefronts</h1>
        <p className="text-gray-500 mt-2 font-medium">Monitoring {stores.length} connected Shopify stores</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          <div className="col-span-full py-20 text-center animate-pulse">
            <LayoutGrid className="w-12 h-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-500 font-medium">Synchronizing your store data...</p>
          </div>
        ) : stores.length === 0 ? (
          <div className="col-span-full py-20 text-center bg-[#141414] rounded-3xl border border-dashed border-white/10">
            <AlertCircle className="w-12 h-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-400 font-medium">No stores assigned to your profile yet.</p>
            <p className="text-gray-600 text-sm mt-1">Please contact your account manager at E-sellers Network.</p>
          </div>
        ) : stores.map((store, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className="bg-[#141414] border border-white/5 rounded-3xl p-8 hover:border-blue-500/30 transition-all group overflow-hidden relative"
          >
            <div className="absolute top-0 right-0 p-6 opacity-0 group-hover:opacity-10 transition-opacity">
              <Store className="w-24 h-24 text-blue-500" />
            </div>

            <div className="relative z-10">
              <div className="w-16 h-16 rounded-2xl bg-blue-600/10 flex items-center justify-center text-blue-500 mb-6 group-hover:scale-110 transition-transform">
                <Store className="w-8 h-8" />
              </div>
              
              <h3 className="text-xl font-bold text-white mb-2">{store.shopDomain}</h3>
              <div className="flex items-center space-x-2 text-emerald-500 text-sm font-medium mb-8">
                <CheckCircle2 className="w-4 h-4" />
                <span>Connected & Active</span>
              </div>

              <button
                onClick={() => handleOpenSync(store)}
                className="w-full flex items-center justify-between px-6 py-4 bg-white/5 hover:bg-blue-600 text-white rounded-2xl transition-all font-semibold group/btn"
              >
                <span>Launch Sync Flow</span>
                <ArrowRight className="w-5 h-5 group-hover/btn:translate-x-1 transition-transform" />
              </button>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="bg-gradient-to-tr from-blue-600/5 to-transparent border border-white/5 rounded-[2.5rem] p-10 flex flex-col md:flex-row items-center justify-between gap-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Need a custom link?</h2>
          <p className="text-gray-400 max-w-md">Our team can help you integrate additional Shopify stores or custom Google Sheet automations for your business.</p>
        </div>
        <a 
          href="mailto:support@e-sellers.net" 
          className="px-8 py-4 bg-white/5 hover:bg-white/10 text-white font-bold rounded-2xl transition-all border border-white/10"
        >
          Contact Support
        </a>
      </div>
    </div>
  );
}
