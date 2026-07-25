import { useEffect, useState, type CSSProperties } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { useOrgName } from '../api/orgName';
import { BrandMark } from '../vaks/primitives';

/**
 * Écran de consentement OAuth pour MCP (phase 11).
 *
 * Le client IA (Claude, ChatGPT, Copilot Studio…) a lancé le flux sur
 * `GET /auth/oauth/authorize`, qui a redirigé le navigateur ici avec un `tx`.
 * L'utilisateur doit être authentifié : sinon on mémorise l'URL de retour et on
 * l'envoie vers /login (qui revient ici après login, SSO inclus). Une fois
 * logué, il approuve/refuse ; on POST `/auth/oauth/consent` et on suit l'URL de
 * redirection renvoyée (vers le client IA, avec le code d'autorisation).
 *
 * i18n : clés sous le namespace `auth` avec `defaultValue` — fonctionne même
 * avant ajout des traductions dans les 4 locales (à compléter).
 */
export default function OAuthConsent() {
  const { isAuthenticated, loading, email } = useAuth();
  const orgName = useOrgName();
  const { t } = useTranslation('auth');
  const [params] = useSearchParams();
  const tx = params.get('tx') ?? '';
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Accès écriture accordé (toggle org `mcp.allowWrites`) → texte du consentement.
  const [writeAccess, setWriteAccess] = useState<boolean | null>(null);
  // Accès finance accordé (toggle org `mcp.allowFinance`).
  const [financeAccess, setFinanceAccess] = useState<boolean>(false);
  // Connecteur MCP activé pour l'org (opt-in admin). null = pas encore chargé.
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !tx) return;
    api
      .oauthConsentInfo(tx)
      .then((info) => {
        setWriteAccess(!!info.write);
        setFinanceAccess(!!info.finance);
        setMcpEnabled(!!info.enabled);
      })
      .catch(() => {
        setWriteAccess(false);
        setFinanceAccess(false);
        setMcpEnabled(true); // ne pas masquer à tort si l'info échoue : consent() reste le garde-fou.
      });
  }, [isAuthenticated, tx]);

  if (loading) {
    return <div style={{ padding: 32, color: 'var(--text-3)' }}>{t('common:loading', { defaultValue: 'Loading…' })}</div>;
  }

  // Pas authentifié : on stocke le retour (survit au round-trip SSO) et on
  // bascule sur l'écran de login.
  if (!isAuthenticated) {
    sessionStorage.setItem('postLoginRedirect', `/oauth-consent?tx=${encodeURIComponent(tx)}`);
    return <Navigate to="/login" replace />;
  }

  const decide = async (approve: boolean) => {
    setError(null);
    setBusy(approve ? 'approve' : 'deny');
    try {
      const { redirect } = await api.oauthConsent(tx, approve);
      // Navigation full-page vers le client IA (hors origine app).
      window.location.href = redirect;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const card: CSSProperties = {
    width: '100%',
    maxWidth: 420,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-lg, 14px)',
    padding: 28,
    boxShadow: '0 8px 24px hsl(var(--shadow-color, 240 10% 8%) / 0.25)',
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--text)', padding: 24 }}>
      <div style={card}>
        <div className="brand" style={{ padding: '0 0 14px', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark"><BrandMark /></div>
          <div className="brand-name">{orgName}</div>
        </div>

        {!tx ? (
          <p style={{ fontSize: 13, color: 'var(--c-over, #e5484d)' }}>
            {t('oauthConsent.noTx', { defaultValue: 'Invalid or expired authorization request. Please restart the connection from your AI client.' })}
          </p>
        ) : (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 8px' }}>
              {t('oauthConsent.title', { defaultValue: 'Authorize AI access' })}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 14 }}>
              {t('oauthConsent.intro', {
                defaultValue:
                  'An AI client is requesting access to {{org}} on your behalf, signed in as {{email}}.',
                org: orgName,
                email: email ?? '',
              })}
            </p>

            {mcpEnabled === false ? (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--c-over, #e5484d)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)',
                  padding: '12px 14px',
                }}
              >
                {t('oauthConsent.disabled', {
                  defaultValue:
                    'The AI connector (MCP) is disabled for {{org}}. Ask your administrator to enable it before connecting.',
                  org: orgName,
                })}
              </div>
            ) : (
              <>
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--text-2)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                padding: '10px 12px',
                marginBottom: 16,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {writeAccess
                  ? t('oauthConsent.scopeTitleWrite', { defaultValue: 'It will be able to:' })
                  : t('oauthConsent.scopeTitle', { defaultValue: 'It will be able to (read-only):' })}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                <li>{t('oauthConsent.scopeProjects', { defaultValue: 'View your projects and tasks' })}</li>
                <li>{t('oauthConsent.scopeWorkload', { defaultValue: 'View workload and reports' })}</li>
                {financeAccess && (
                  <li>{t('oauthConsent.scopeFinance', { defaultValue: 'View financial data (budgets, margins) you have access to' })}</li>
                )}
                {writeAccess && (
                  <li style={{ color: 'var(--c-warn, #d9822b)', fontWeight: 600 }}>
                    {t('oauthConsent.scopeWrite', {
                      defaultValue: 'Create and modify projects, tasks, assignments and time entries on your behalf',
                    })}
                  </li>
                )}
              </ul>
              <div style={{ marginTop: 8, color: 'var(--text-3)' }}>
                {t('oauthConsent.scopeBound', {
                  defaultValue: 'Strictly limited to what you can already access. It cannot exceed your own permissions.',
                })}
              </div>
            </div>

            {error && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--c-over, #e5484d)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)',
                  padding: '8px 10px',
                  marginBottom: 12,
                }}
              >
                {error}
              </div>
            )}

            <button
              type="button"
              className="btn btn-accent btn-block"
              style={{ padding: '10px 13px' }}
              disabled={busy !== null}
              onClick={() => decide(true)}
            >
              {busy === 'approve'
                ? t('oauthConsent.authorizing', { defaultValue: 'Authorizing…' })
                : t('oauthConsent.authorize', { defaultValue: 'Authorize' })}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              style={{ padding: '8px 13px', marginTop: 8, fontSize: 12 }}
              disabled={busy !== null}
              onClick={() => decide(false)}
            >
              {busy === 'deny'
                ? t('oauthConsent.denying', { defaultValue: 'Cancelling…' })
                : t('oauthConsent.deny', { defaultValue: 'Cancel' })}
            </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
