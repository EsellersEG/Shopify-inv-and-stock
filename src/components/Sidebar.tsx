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
    <aside className="w-72 bg-[#0d0d0d] border-r border-white/5 flex flex-col h-screen sticky top-0">
      <div className="p-8">
        <div className="flex items-center space-x-3 mb-10">
          <div className="bg-blue-600 p-2 rounded-xl">
            <RefreshCw className="w-6 h-6 text-white" />
          </div>
          <span className="text-xl font-bold text-white tracking-tight">SyncFlow</span>
        </div>

        <nav className="space-y-1.5">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center space-x-3 px-4 py-3 rounded-xl transition-all duration-200 group ${
                  isActive 
                    ? 'bg-blue-600/10 text-blue-500 font-semibold' 
                    : 'text-gray-400 hover:bg-white/5 hover:text-white'
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
        <div className="bg-[#141414] rounded-2xl p-4 border border-white/5">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-600 to-blue-400 flex items-center justify-center text-white font-bold">
              {user?.name?.[0] || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate uppercase tracking-tighter">{user?.role}</p>
            </div>
          </div>
        </div>

        <button
          onClick={onLogout}
          className="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all duration-200 font-medium"
        >
          <LogOut className="w-5 h-5" />
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  );
}
