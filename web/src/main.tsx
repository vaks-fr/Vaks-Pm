import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import './i18n'; // initialise i18next (effet de bord : i18n.init)
import { I18nSync } from './i18n/I18nSync';
import { ConfirmProvider } from './vaks/confirm';
import './index.css';
import './vaks/tokens.css';
import './vaks/views.css';

// Basename = préfixe d'URL du déploiement (`import.meta.env.BASE_URL`). Vaut "/"
// en build normal (aucun effet) ; "/demo/" pour la démo servie en sous-chemin,
// pour que le routeur matche les routes sous /demo/ (sinon le catch-all renvoie
// à la racine du site). Trailing slash retiré (react-router le veut sans).
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={ROUTER_BASENAME}>
      <AuthProvider>
        <I18nSync />
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
