import React from 'react';
import Sidebar from '../components/Sidebar';
import { motion, AnimatePresence } from 'framer-motion';

export default function Layout({ children, user, onLogout }: { children: React.ReactNode, user: any, onLogout: () => void }) {
  return (
    <div className="flex min-h-screen bg-[#0a0a0a] text-white selection:bg-blue-500/30">
      <Sidebar user={user} onLogout={onLogout} />
      <main className="flex-1 p-10 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={window.location.pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
