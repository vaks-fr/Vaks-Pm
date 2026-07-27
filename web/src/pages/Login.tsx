import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { SsoProviderPublicDto } from '@vaks-pm/shared';
import { useAuth } from '../auth/AuthContext';
import { BrandMark, Icon } from '../vaks/primitives';
import { api } from '../api/client';
import { useOrgName } from '../api/orgName';

/**
 * Destination post-login. Un flow qui exige un login (ex. consentement OAuth
 * MCP) stocke son URL de retour dans `sessionStorage` AVANT de rediriger vers
 * /login (sessionStorage survit au round-trip SSO Entra, contrairement à un
 * query param effacé par le callback). Garde anti-open-redirect : chemin interne
 * uniquement.
 */
function popPostLoginRedirect(): string {
  const dest = sessionStorage.getItem('postLoginRedirect');
  if (dest) sessionStorage.removeItem('postLoginRedirect');
  return dest && dest.startsWith('/') && !dest.startsWith('//') ? dest : '/';
}

export default function Login() {
  const { login, completeMfaLogin, completeForcedEnrollment, loginWithTokens } = useAuth();
  const orgName = useOrgName();
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // SSO : providers fédérés activés pour ce tenant + état du callback.
  const [ssoProviders, setSsoProviders] = useState<SsoProviderPublicDto[]>([]);
  const [ssoBusy, setSsoBusy] = useState(false);

  // Callback SSO : l'API redirige vers /login#sso=1&access=…&refresh=… après un
  // login OIDC réussi (tokens dans le FRAGMENT — jamais envoyé au serveur). On
  // les consomme au montage puis on nettoie l'URL. Une erreur arrive en
  // ?sso_error=… (query, pas fragment) car émise avant l'émission des tokens.
  useEffect(() => {
    const hash = window.location.hash.startsWith('#')
      ? new URLSearchParams(window.location.hash.slice(1))
      : null;
    if (hash?.get('sso') === '1' && hash.get('access') && hash.get('refresh')) {
      setSsoBusy(true);
      const access = hash.get('access')!;
      const refresh = hash.get('refresh')!;
      // Nettoie immédiatement le fragment (évite que les tokens restent dans
      // l'historique / la barre d'URL).
      window.history.replaceState(null, '', window.location.pathname);
      loginWithTokens(access, refresh)
        .then(() => navigate(popPostLoginRedirect()))
        .catch((e) => setError(t('ssoFailed', { message: (e as Error).message })))
        .finally(() => setSsoBusy(false));
      return;
    }
    const q = new URLSearchParams(window.location.search);
    const ssoErr = q.get('sso_error');
    if (ssoErr) {
      setError(decodeURIComponent(ssoErr));
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [loginWithTokens, navigate]);

  // Charge la liste des providers SSO de ce tenant (boutons de login).
  useEffect(() => {
    api
      .listSsoProviders()
      .then((p) => setSsoProviders(p))
      .catch(() => setSsoProviders([]));
  }, []);
  // Étape 2 quand MFA est activé sur le compte. challengeToken vit ~5min.
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  // Étape 2 quand la policy force MFA et l'user n'a pas encore enrollé.
  const [enrollToken, setEnrollToken] = useState<string | null>(null);
  const [enrollQr, setEnrollQr] = useState<string | null>(null);
  const [enrollSecret, setEnrollSecret] = useState<string | null>(null);
  const [enrollCode, setEnrollCode] = useState('');

  // 1Password (et consorts) injecte `data-com-onepassword-filled` sur tous les
  // inputs qu'il "voit" et applique un fond bleu via une stylesheet/inline
  // style qu'on ne peut pas écraser par CSS externe. Solution : un
  // MutationObserver qui supprime l'attribut dès qu'il apparaît, sur tous
  // les inputs du form. Sans l'attribut, leur sélecteur ne matche plus.
  useEffect(() => {
    const ATTRS = [
      'data-com-onepassword-filled',
      'data-com-bitwarden-filled',
      'data-bw-handler',
      'data-lastpass-icon-root',
    ];
    const scrub = (el: Element) => {
      for (const a of ATTRS) if (el.hasAttribute(a)) el.removeAttribute(a);
      // 1P pose parfois un style inline avec !important — on l'efface aussi.
      if (el instanceof HTMLElement && el.style.cssText) {
        const cleaned = el.style.cssText
          .split(';')
          .filter((d) => !/^\s*(background|box-shadow|-webkit-box-shadow)/i.test(d))
          .join(';');
        if (cleaned !== el.style.cssText) el.style.cssText = cleaned;
      }
    };
    const scrubAll = () => document.querySelectorAll('input').forEach(scrub);
    scrubAll();
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.target instanceof Element) scrub(m.target);
      }
    });
    document.querySelectorAll('input').forEach((el) =>
      obs.observe(el, {
        attributes: true,
        attributeFilter: [...ATTRS, 'style'],
      }),
    );
    // Re-attache l'observer quand on bascule d'écran (le DOM des inputs change).
    const reattach = setInterval(() => {
      scrubAll();
      document
        .querySelectorAll('input')
        .forEach((el) =>
          obs.observe(el, { attributes: true, attributeFilter: [...ATTRS, 'style'] }),
        );
    }, 500);
    return () => {
      obs.disconnect();
      clearInterval(reattach);
    };
  }, []);

  // Match the workspace's default dark theme so the login matches the app design.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', prev ?? 'dark');
    root.style.setProperty('--accent-h', '31');
    root.style.setProperty('--accent-c', '0.165');
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await login(email, password);
      if (r.kind === 'mfa') {
        setMfaChallenge(r.challengeToken);
        setMfaCode('');
      } else if (r.kind === 'enroll') {
        // Policy force MFA et l'user n'a pas encore enrollé → on récupère
        // immédiatement le QR via l'enrollToken et on passe à l'écran QR.
        try {
          const qr = await api.mfaForcedEnrollStart(r.enrollToken);
          setEnrollToken(r.enrollToken);
          setEnrollQr(qr.qrCodeDataUrl);
          setEnrollSecret(qr.secret);
          setEnrollCode('');
        } catch (e) {
          setError(t('enrollStartFailed', { message: (e as Error).message }));
        }
      } else {
        navigate(popPostLoginRedirect());
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSubmitForcedEnroll = async (e: FormEvent) => {
    e.preventDefault();
    if (!enrollToken) return;
    setError(null);
    setBusy(true);
    try {
      await completeForcedEnrollment(enrollToken, enrollCode);
      navigate(popPostLoginRedirect());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSubmitMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfaChallenge) return;
    setError(null);
    setBusy(true);
    try {
      await completeMfaLogin(mfaChallenge, mfaCode);
      navigate(popPostLoginRedirect());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        color: 'var(--text)',
        padding: 24,
      }}
    >
      <form
        onSubmit={enrollToken ? onSubmitForcedEnroll : mfaChallenge ? onSubmitMfa : onSubmit}
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg, 14px)',
          padding: 28,
          boxShadow: '0 8px 24px hsl(var(--shadow-color, 240 10% 8%) / 0.25)',
        }}
      >
        <div className="brand" style={{ padding: '0 0 14px', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark">
            <BrandMark />
          </div>
          <div className="brand-name">{orgName}</div>
        </div>

        {enrollToken ? (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 4px' }}>{t('enrollTitle')}</h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 14 }}>
              {t('enrollIntro')}
            </p>
            {enrollQr && (
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <img
                  src={enrollQr}
                  alt={t('qrAlt')}
                  style={{ width: 180, height: 180, background: 'white', padding: 8, borderRadius: 8 }}
                />
              </div>
            )}
            {enrollSecret && (
              <div
                style={{
                  fontSize: 11,
                  fontFamily: 'monospace',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)',
                  padding: '6px 10px',
                  marginBottom: 12,
                  wordBreak: 'break-all',
                  textAlign: 'center',
                }}
                title={t('manualSecretTitle')}
              >
                {enrollSecret}
              </div>
            )}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
              {t('authCode')}
            </label>
            <div className="searchbox login-field" style={{ width: '100%', marginBottom: 14 }}>
              <Icon name="settings" size={16} style={{ color: 'var(--text-3)' }} />
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={enrollCode}
                onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                autoComplete="one-time-code"
                name="vaks-otp"
                data-1p-ignore="true"
                data-op-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                autoFocus
                maxLength={6}
                required
              />
            </div>
          </>
        ) : !mfaChallenge ? (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 4px' }}>{t('signInTitle')}</h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 18 }}>
              {t('signInIntro')}
            </p>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
              {t('emailLabel')}
            </label>
            <div className="searchbox login-field" style={{ width: '100%', marginBottom: 12 }}>
              <Icon name="user" size={16} style={{ color: 'var(--text-3)' }} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="username"
                required
              />
            </div>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
              {t('passwordLabel')}
            </label>
            <div className="searchbox login-field" style={{ width: '100%', marginBottom: 14 }}>
              <Icon name="settings" size={16} style={{ color: 'var(--text-3)' }} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>

            {ssoProviders.length > 0 && (
              <div style={{ marginTop: 4, marginBottom: 6 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    margin: '6px 0 12px',
                    color: 'var(--text-3)',
                    fontSize: 11.5,
                  }}
                >
                  <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  {t('or')}
                  <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
                {ssoProviders.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    className="btn btn-ghost btn-block"
                    style={{ padding: '9px 13px', marginBottom: 8, gap: 8 }}
                    disabled={ssoBusy || busy}
                    onClick={() => {
                      setError(null);
                      setSsoBusy(true);
                      // Navigation full-page : le backend répond par un 302 vers
                      // l'IdP (Entra). Pas de fetch — c'est un flow navigateur.
                      // Route selon le protocole du provider (OIDC vs SAML).
                      window.location.assign(api.ssoLoginUrl(p.slug, p.type));
                    }}
                  >
                    <Icon name="user" size={15} style={{ color: 'var(--text-3)' }} />
                    {ssoBusy ? t('redirecting') : t('continueWith', { provider: p.displayName })}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 4px' }}>{t('mfaTitle')}</h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 18 }}>
              {t('mfaIntro')}
            </p>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
              {t('authCode')}
            </label>
            <div className="searchbox login-field" style={{ width: '100%', marginBottom: 14 }}>
              <Icon name="settings" size={16} style={{ color: 'var(--text-3)' }} />
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                autoComplete="one-time-code"
                name="vaks-otp"
                data-1p-ignore="true"
                data-op-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                autoFocus
                maxLength={6}
                required
              />
            </div>
          </>
        )}

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
          type="submit"
          disabled={busy || (!!enrollToken && enrollCode.length !== 6)}
          className="btn btn-accent btn-block"
          style={{ padding: '10px 13px' }}
        >
          {busy
            ? (enrollToken ? t('activating') : mfaChallenge ? t('verifying') : t('signingIn'))
            : (enrollToken ? t('activateAndSignIn') : mfaChallenge ? t('verify') : t('signInTitle'))}
        </button>

        {(mfaChallenge || enrollToken) && (
          <button
            type="button"
            onClick={() => {
              setMfaChallenge(null); setMfaCode('');
              setEnrollToken(null); setEnrollQr(null); setEnrollSecret(null); setEnrollCode('');
              setError(null);
            }}
            className="btn btn-ghost btn-block"
            style={{ padding: '8px 13px', marginTop: 8, fontSize: 12 }}
          >
            {t('backToSignIn')}
          </button>
        )}

        <div style={{ marginTop: 16, fontSize: 11.5, color: 'var(--text-faint, var(--text-3))', textAlign: 'center' }}>
          {t('footer')}
        </div>
      </form>
    </div>
  );
}
