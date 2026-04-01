import React, { useState } from 'react';
import { RefreshCw, Lock, Mail, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';

export default function LoginPage({ onLogin }: { onLogin: (token: string, user: any) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      
      if (res.ok) {
        onLogin(data.token, data.user);
      } else {
        setError(data.error || 'Invalid credentials');
      }
    } catch (err) {
      setError('Connection failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6 font-sans selection:bg-[#FFA500]/30">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(255,165,0,0.05),transparent_50%)] pointer-events-none" />
      
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-10">
          <motion.div 
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
            className="inline-flex p-3 rounded-2xl bg-gradient-to-tr from-[#FFA500] to-orange-400 shadow-xl shadow-orange-500/20 mb-6"
          >
            <RefreshCw className="w-8 h-8 text-white" />
          </motion.div>
          <h1 className="text-4xl font-black text-black tracking-tight mb-2 uppercase italic">SyncFlow</h1>
          <p className="text-gray-500 font-medium">Elevating your Shopify operations</p>
        </div>

        <div className="bg-gray-50 border border-gray-100 rounded-[2.5rem] p-10 shadow-2xl backdrop-blur-xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3 ml-1">Email Address</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none text-gray-300 group-focus-within:text-[#FFA500] transition-colors">
                  <Mail className="w-5 h-5" />
                </div>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="block w-full pl-14 pr-4 py-4 bg-white border border-gray-100 rounded-2xl text-black placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-[#FFA500]/40 focus:border-[#FFA500] transition-all font-bold"
                  placeholder="name@company.com"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3 ml-1">Password</label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none text-gray-300 group-focus-within:text-[#FFA500] transition-colors">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-14 pr-4 py-4 bg-white border border-gray-100 rounded-2xl text-black placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-[#FFA500]/40 focus:border-[#FFA500] transition-all font-bold"
                  placeholder="••••••••"
                />
              </div>
            </div>

            {error && (
              <motion.div 
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center space-x-2 text-red-500 bg-red-50 p-4 rounded-2xl border border-red-100 text-xs font-bold"
              >
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{error}</span>
              </motion.div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-5 px-6 bg-black hover:bg-[#FFA500] disabled:bg-gray-400 text-white font-black rounded-2xl transition-all shadow-xl shadow-black/5 active:scale-[0.98] flex items-center justify-center space-x-3 uppercase tracking-widest text-xs"
            >
              {loading ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <span>Sign In to Dashboard</span>
              )}
            </button>
          </form>
        </div>

        <p className="text-center mt-12 text-gray-400 text-[10px] font-bold uppercase tracking-[0.2em]">
          &copy; 2024 E-sellers Network. All rights reserved.
        </p>
      </motion.div>
    </div>
  );
}
