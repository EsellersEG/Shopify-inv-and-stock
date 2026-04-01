import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import AdminDashboard from './pages/AdminDashboard';
import ClientDashboard from './pages/ClientDashboard';
import Layout from './components/Layout';
import SyncTool from './pages/SyncTool'; // I will create this next

export default function App() {
  const { user, loading, login, logout, isAdmin } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-[#FFA500] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={login} />;
  }

  return (
    <BrowserRouter>
      <Layout user={user} onLogout={logout}>
        <Routes>
          <Route path="/" element={isAdmin ? <AdminDashboard /> : <ClientDashboard />} />
          <Route path="/clients" element={isAdmin ? <AdminDashboard /> : <Navigate to="/" />} />
          <Route path="/sync" element={<SyncTool />} />
          <Route path="/stores" element={<ClientDashboard />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
