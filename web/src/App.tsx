import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth/AuthContext';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import OAuthConsent from './pages/OAuthConsent';
import Workspace from './vaks/Workspace';

// React 19 : le namespace global `JSX` n'est plus exposé par @types/react →
// on type explicitement via `ReactElement`.
function Protected({ children }: { children: ReactElement }) {
  const { isAuthenticated, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <div className="p-8 text-slate-500">{t('common:loading')}</div>;
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      {/* Consentement OAuth MCP (phase 11) — gère lui-même l'auth (login si besoin). */}
      <Route path="/oauth-consent" element={<OAuthConsent />} />
      <Route
        path="/"
        element={
          <Protected>
            <Workspace />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
