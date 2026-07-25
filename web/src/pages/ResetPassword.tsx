import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BrandMark, Icon } from '../vaks/primitives';
import { api } from '../api/client';
import { useOrgName } from '../api/orgName';

/**
 * Page publique (non authentifiée) de réinitialisation de mot de passe (#3).
 * Le tenant est résolu côté API par le Host (sous-domaine) — la page est servie
 * sur le sous-domaine du tenant via le lien email. La password policy est
 * appliquée **côté serveur** (la page étant publique, on ne peut pas la lire).
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const orgName = useOrgName();
  const { t } = useTranslation('auth');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [state, setState] = useState<'checking' | 'valid' | 'invalid' | 'done'>(
    'checking',
  );
  const [email, setEmail] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Thème sombre cohérent avec le login.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', root.getAttribute('data-theme') ?? 'dark');
    root.style.setProperty('--accent-h', '31');
    root.style.setProperty('--accent-c', '0.165');
  }, []);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    api
      .validateResetToken(token)
      .then((r) => {
        if (r.valid) {
          setEmail(r.email ?? null);
          setState('valid');
        } else {
          setState('invalid');
        }
      })
      .catch(() => setState('invalid'));
  }, [token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== confirm) {
      setError(t('pwMismatch'));
      return;
    }
    setBusy(true);
    try {
      await api.consumeResetToken(token, pw);
      setState('done');
    } catch (err) {
      // Le serveur renvoie le message de policy (longueur/complexité/historique).
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
      <div
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

        {state === 'checking' && (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('checkingLink')}</p>
        )}

        {state === 'invalid' && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 6px' }}>
              {t('linkInvalidTitle')}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
              {t('linkInvalidIntro')}
            </p>
            <button
              className="btn btn-accent btn-block"
              style={{ padding: '10px 13px' }}
              onClick={() => navigate('/login')}
            >
              {t('backToSignIn')}
            </button>
          </>
        )}

        {state === 'done' && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 6px' }}>
              {t('pwUpdatedTitle')}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
              {t('pwUpdatedIntro')}
            </p>
            <button
              className="btn btn-accent btn-block"
              style={{ padding: '10px 13px' }}
              onClick={() => navigate('/login')}
            >
              {t('goToSignIn')}
            </button>
          </>
        )}

        {state === 'valid' && (
          <form onSubmit={onSubmit}>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 4px' }}>
              {t('chooseNewPwTitle')}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 18 }}>
              {email ? <>{t('forEmailPrefix')} <strong>{email}</strong>. </> : null}
              {t('chooseNewPwIntro')}
            </p>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
              {t('newPwLabel')}
            </label>
            <div className="searchbox" style={{ width: '100%', marginBottom: 12 }}>
              <Icon name="settings" size={16} style={{ color: 'var(--text-3)' }} />
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                autoFocus
                required
              />
            </div>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
              {t('confirmPwLabel')}
            </label>
            <div className="searchbox" style={{ width: '100%', marginBottom: 14 }}>
              <Icon name="settings" size={16} style={{ color: 'var(--text-3)' }} />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />
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
              type="submit"
              disabled={busy || !pw || !confirm}
              className="btn btn-accent btn-block"
              style={{ padding: '10px 13px' }}
            >
              {busy ? t('common:saving') : t('setNewPw')}
            </button>
          </form>
        )}

        <div style={{ marginTop: 16, fontSize: 11.5, color: 'var(--text-faint, var(--text-3))', textAlign: 'center' }}>
          {t('footer')}
        </div>
      </div>
    </div>
  );
}
