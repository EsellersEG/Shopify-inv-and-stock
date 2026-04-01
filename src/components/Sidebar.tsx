import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, RefreshCw, LogOut, Store, Settings } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Sidebar({ user, onLogout }: { user: any, onLogout: () => void }) {
  const isAdmin = user?.role === 'admin';

  const navItems = [
    { name: 'Dashboard', path: '/', icon: LayoutDashboard },
    ...(isAdmin ? [{ name: 'Clients', path: '/clients', icon: Users }] : []),
    { name: 'Inventory Sync', path: '/sync', icon: RefreshCw },
    { name: 'Stores', path: '/stores', icon: Store },
  ];

  return (
    <aside className="w-72 bg-white border-r border-gray-100 flex flex-col h-screen sticky top-0 shadow-sm">
      <div className="p-8">
        <div className="flex items-center space-x-3 mb-12">
          <div className="bg-[#FFA500] p-2 rounded-xl shadow-lg shadow-orange-500/20">
            <RefreshCw className="w-6 h-6 text-white" />
          </div>
          <span className="text-2xl font-black text-black tracking-tighter uppercase italic">SyncFlow</span>
        </div>

        <nav className="space-y-2">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center space-x-4 px-5 py-4 rounded-2xl transition-all duration-300 group text-xs uppercase tracking-widest font-black ${
                  isActive 
                    ? 'bg-black text-white shadow-xl shadow-black/10 italic' 
                    : 'text-gray-400 hover:bg-gray-50 hover:text-black'
                }`
              }
            >
              <item.icon className="w-5 h-5" />
              <span>{item.name}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="mt-auto p-6 space-y-4">
        <div className="bg-gray-50 rounded-[1.5rem] p-5 border border-gray-100 transition-all hover:shadow-inner">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 rounded-2xl bg-[#FFA500] flex items-center justify-center text-white font-black text-lg shadow-lg shadow-orange-500/10 italic">
              {user?.name?.[0] || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-black text-black truncate">{user?.name}</p>
              <p className="text-[9px] text-gray-400 truncate uppercase tracking-[0.2em] font-bold">{user?.role}</p>
            </div>
          </div>
        </div>

        <button
          onClick={onLogout}
          className="w-full flex items-center justify-center space-x-3 px-6 py-4 rounded-2xl bg-red-50 text-red-500 hover:bg-red-500 hover:text-white transition-all duration-300 font-black text-[10px] uppercase tracking-widest italic"
        >
          <LogOut className="w-5 h-5" />
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  );
}
