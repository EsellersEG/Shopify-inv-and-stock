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
    <div className="max-w-6xl mx-auto space-y-12 bg-white">
      <header>
        <h1 className="text-4xl font-black text-black tracking-tight uppercase italic underline decoration-[#FFA500] underline-offset-8">Your Storefronts</h1>
        <p className="text-gray-500 mt-4 font-bold uppercase text-[10px] tracking-widest">Monitoring {stores.length} connected Shopify stores</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {loading ? (
          <div className="col-span-full py-20 text-center animate-pulse">
            <LayoutGrid className="w-12 h-12 text-gray-200 mx-auto mb-4" />
            <p className="text-gray-400 font-bold uppercase text-xs tracking-widest">Synchronizing your dashboard...</p>
          </div>
        ) : stores.length === 0 ? (
          <div className="col-span-full py-20 text-center bg-gray-50 rounded-[3rem] border border-dashed border-gray-200">
            <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 font-black uppercase text-xs tracking-widest italic">No stores assigned to your profile yet.</p>
            <p className="text-gray-400 text-[10px] font-bold uppercase mt-2 tracking-widest">Please contact your account manager at E-sellers Network.</p>
          </div>
        ) : stores.map((store, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className="bg-white border border-gray-100 rounded-[2.5rem] p-10 hover:border-[#FFA500]/30 transition-all group overflow-hidden relative shadow-sm hover:shadow-2xl"
          >
            <div className="absolute top-0 right-0 p-8 opacity-0 group-hover:opacity-5 transition-opacity">
              <Store className="w-24 h-24 text-[#FFA500]" />
            </div>

            <div className="relative z-10">
              <div className="w-16 h-16 rounded-[1.3rem] bg-orange-50 flex items-center justify-center text-[#FFA500] mb-8 group-hover:scale-110 transition-transform shadow-inner">
                <Store className="w-8 h-8" />
              </div>
              
              <h3 className="text-2xl font-black text-black mb-1 truncate">{store.name || 'Unlabeled Store'}</h3>
              <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-6">{store.shopDomain}</p>
              
              <div className="flex items-center space-x-2 text-emerald-500 text-[10px] font-black uppercase tracking-widest mb-10 bg-emerald-50 w-fit px-4 py-2 rounded-full ring-1 ring-emerald-500/20">
                <CheckCircle2 className="w-4 h-4" />
                <span>Connected & Active</span>
              </div>

              <button
                onClick={() => handleOpenSync(store)}
                className="w-full flex items-center justify-between px-8 py-5 bg-[#FFA500] hover:bg-orange-600 text-white rounded-2xl transition-all font-black text-xs uppercase tracking-widest group/btn shadow-xl shadow-orange-500/20"
              >
                <span>Launch Sync Flow</span>
                <ArrowRight className="w-5 h-5 group-hover/btn:translate-x-1 transition-transform" />
              </button>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="bg-gray-50 border border-gray-100 rounded-[3rem] p-12 flex flex-col md:flex-row items-center justify-between gap-8">
        <div>
          <h2 className="text-2xl font-black text-black mb-3 italic uppercase">Need a custom link?</h2>
          <p className="text-gray-500 max-w-md font-medium text-sm leading-relaxed">Our team can help you integrate additional Shopify stores or custom Google Sheet automations for your business.</p>
        </div>
        <a 
          href="mailto:support@e-sellers.net" 
          className="px-10 py-5 bg-black hover:bg-[#FFA500] text-white font-black rounded-2xl transition-all shadow-xl shadow-black/5 text-xs uppercase tracking-widest"
        >
          Contact Support
        </a>
      </div>
    </div>
  );
}
