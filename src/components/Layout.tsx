import React from 'react';
import Sidebar from '../components/Sidebar';
import { motion, AnimatePresence } from 'framer-motion';

export default function Layout({ children, user, onLogout }: { children: React.ReactNode, user: any, onLogout: () => void }) {
  return (
    <div className="flex min-h-screen bg-white text-black selection:bg-[#FFA500]/30 font-sans antialiased">
      <Sidebar user={user} onLogout={onLogout} />
      <main className="flex-1 p-12 overflow-y-auto bg-white">
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
