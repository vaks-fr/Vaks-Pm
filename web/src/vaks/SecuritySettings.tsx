import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, saveBlob } from '../api/client';
import type { UserNotificationPrefsDto } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Icon } from './primitives';
import ChangePasswordDialog from './ChangePasswordDialog';
import ApiTokensSection from './ApiTokensSection';

/**
 * Préférences notif **par utilisateur** (#14). Sémantique opt-out : par défaut
 * chaque événement suit le réglage de l'organisation ; l'utilisateur peut
 * couper ceux qu'il ne veut pas recevoir. Toggle OFF → `false` (muté) ;
 * toggle ON → `null` (hérite du défaut org). Auto-save à chaque changement.
 */
const NOTIF_EVENTS: Array<{ key: keyof UserNotificationPrefsDto }> = [
  { key: 'assignment' },
  { key: 'mention' },
  { key: 'dueReminder' },
  { key: 'statusChange' },
];

/**
 * RGPD — portabilité (Art. 20). L'utilisateur télécharge SES propres données
 * (JSON). Self-service, aucune permission spéciale.
 */
function MyDataExportSection({ onError }: { onError: (m: string) => void }) {
  const { t } = useTranslation('security');
  const [busy, setBusy] = useState(false);

  const exportMine = async () => {
    setBusy(true);
    try {
      const data = await api.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      saveBlob(blob, 'my-data-export.json');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
        {t('myData.title', { defaultValue: 'Mes données personnelles' })}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
        {t('myData.intro', {
          defaultValue:
            'Téléchargez une copie de vos données (profil, temps, allocations, commentaires, compétences) au format JSON.',
        })}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={exportMine} disabled={busy}>
        <Icon name="download" size={14} />{' '}
        {busy
          ? t('myData.exporting', { defaultValue: 'Export…' })
          : t('myData.export', { defaultValue: 'Exporter mes données' })}
      </button>
    </div>
  );
}

function AiConnectionsSection({ onError }: { onError: (m: string) => void }) {
  const { t } = useTranslation('security');
  const [conns, setConns] = useState<
    Array<{ connId: string; clientName: string; createdAt: number; lastUsedAt: number }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listAiConnections()
      .then(setConns)
      .catch(() => setConns([]))
      .finally(() => setLoading(false));
  }, []);

  const revoke = async (connId: string) => {
    try {
      await api.revokeAiConnection(connId);
      setConns((c) => c.filter((x) => x.connId !== connId));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
        {t('aiConn.title', { defaultValue: 'Connexions IA' })}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
        {t('aiConn.intro', {
          defaultValue:
            'Clients IA (Claude, ChatGPT, Copilot…) connectés à votre compte via le connecteur MCP. Déconnecter en coupe l’accès — le client devra se reconnecter.',
        })}
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>…</div>
      ) : conns.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('aiConn.none', { defaultValue: 'Aucune connexion IA active.' })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {conns.map((c) => (
            <div
              key={c.connId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 12px',
                background: 'var(--surface-2)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{c.clientName}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  {t('aiConn.lastUsed', { defaultValue: 'Dernière utilisation' })}:{' '}
                  {new Date(c.lastUsedAt).toLocaleString()}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ color: 'var(--c-over, #e5484d)' }}
                onClick={() => void revoke(c.connId)}
              >
                {t('aiConn.revoke', { defaultValue: 'Déconnecter' })}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationPrefsSection() {
  const { t } = useTranslation('security');
  const [prefs, setPrefs] = useState<UserNotificationPrefsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getMyNotificationPrefs().then(setPrefs).catch(() => setPrefs(null));
  }, []);

  const toggle = async (key: keyof UserNotificationPrefsDto) => {
    if (!prefs) return;
    // OFF (false) ⇄ ON (null = hérite). On considère "muté" si === false.
    const next: UserNotificationPrefsDto = {
      ...prefs,
      [key]: prefs[key] === false ? null : false,
    };
    setPrefs(next);
    setSaving(true);
    setErr(null);
    try {
      const saved = await api.putMyNotificationPrefs(next);
      setPrefs(saved);
    } catch (e) {
      setErr((e as Error).message);
      setPrefs(prefs); // rollback
    } finally {
      setSaving(false);
    }
  };

  if (!prefs) {
    return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('notifPrefs.loading')}</div>;
  }

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{t('notifPrefs.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
        {t('notifPrefs.intro')}
        {saving && <span style={{ color: 'var(--accent)' }}>{t('notifPrefs.savingSuffix')}</span>}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {NOTIF_EVENTS.map((ev) => {
          const muted = prefs[ev.key] === false;
          return (
            <div
              key={ev.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 10px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t(`notifPrefs.events.${ev.key}.label`)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t(`notifPrefs.events.${ev.key}.desc`)}</div>
              </div>
              <button
                type="button"
                onClick={() => toggle(ev.key)}
                disabled={saving}
                className={'seg-btn' + (muted ? '' : ' seg-on')}
                style={{ minWidth: 64, whiteSpace: 'nowrap' }}
                title={muted ? t('notifPrefs.tooltipMuted') : t('notifPrefs.tooltipOn')}
              >
                {muted ? t('notifPrefs.muted') : t('notifPrefs.on')}
              </button>
            </div>
          );
        })}
      </div>
      {err && <div style={{ color: 'var(--c-over,#e5484d)', fontSize: 12, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

/**
 * Panneau "Sécurité du compte" — affiché en modal depuis le footer sidebar.
 * V1 minimal : statut MFA + flow enrôlement TOTP (QR code → code 6 chiffres),
 * désactivation MFA (mot de passe + code requis).
 */
export default function SecuritySettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('security');
  const { user, refreshUser } = useAuth();
  const [step, setStep] = useState<'home' | 'enrolling' | 'disabling'>('home');
  const [pwOpen, setPwOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Enrôlement
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // Désactivation
  const [pwd, setPwd] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const mfaEnabled = !!user?.mfaEnabled;

  const startEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.mfaEnrollStart();
      setQr(r.qrCodeDataUrl);
      setSecret(r.secret);
      setStep('enrolling');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.mfaEnrollVerify(code);
      await refreshUser();
      setStep('home');
      setCode('');
      setQr(null);
      setSecret(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.mfaDisable(pwd, disableCode);
      await refreshUser();
      setStep('home');
      setPwd('');
      setDisableCode('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setError(null);
  }, [step]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '88vh',
          overflowY: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg, 14px)',
          padding: 24,
          boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t('settings.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {step === 'home' && (
          <div>
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md, 10px)',
                padding: 16,
                marginBottom: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('settings.mfa.title')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                    {mfaEnabled
                      ? t('settings.mfa.activeDesc')
                      : t('settings.mfa.inactiveDesc')}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '3px 8px',
                    borderRadius: 999,
                    background: mfaEnabled ? 'rgba(34,197,94,0.15)' : 'var(--surface-2)',
                    color: mfaEnabled ? '#22c55e' : 'var(--text-3)',
                    fontWeight: 600,
                  }}
                >
                  {mfaEnabled ? t('settings.mfa.enabled') : t('settings.mfa.disabled')}
                </span>
              </div>
              <div style={{ marginTop: 14 }}>
                {!mfaEnabled ? (
                  <button className="btn btn-accent" disabled={busy} onClick={startEnroll}>
                    {busy ? t('common:loading') : t('settings.mfa.enable')}
                  </button>
                ) : (
                  <button className="btn btn-ghost" onClick={() => setStep('disabling')}>
                    {t('settings.mfa.disable')}
                  </button>
                )}
              </div>
            </div>

            {/* "Change password" disponible dès qu'on a un mot de passe local :
                LOCAL users + break-glass (authProvider != LOCAL avec
                allowLocalLogin=true). Pour les SSO purs (sans break-glass),
                pas de mot de passe local → on cache la section. */}
            {(user?.authProvider === 'LOCAL' || user?.allowLocalLogin) && (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md, 10px)',
                  padding: 16,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{t('settings.password.title')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                      {user?.authProvider === 'LOCAL'
                        ? t('settings.password.localDesc')
                        : t('settings.password.breakGlassDesc')}
                    </div>
                  </div>
                  <button className="btn btn-line btn-sm" onClick={() => setPwOpen(true)}>
                    {t('settings.password.change')}
                  </button>
                </div>
              </div>
            )}

            {user?.allowLocalLogin && user?.authProvider !== 'LOCAL' && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-3)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)',
                  padding: 10,
                }}
              >
                <Icon name="warn" size={13} />{' '}
                <Trans t={t} i18nKey="settings.breakGlassNotice" components={{ 1: <strong /> }} />
              </div>
            )}

            {error && (
              <div style={{ color: 'var(--c-over,#e5484d)', fontSize: 12.5, marginTop: 10 }}>{error}</div>
            )}

            <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 12px' }} />
            <NotificationPrefsSection />

            <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 12px' }} />
            <ApiTokensSection mode="user" flash={(m, k) => (k === 'err' ? setError(m) : undefined)} />

            <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 12px' }} />
            <AiConnectionsSection onError={setError} />

            <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 12px' }} />
            <MyDataExportSection onError={setError} />
          </div>
        )}

        {step === 'enrolling' && (
          <div>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 0 }}>
              {t('settings.enroll.intro')}
            </p>
            {qr && (
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <img
                  src={qr}
                  alt={t('settings.enroll.qrAlt')}
                  style={{ width: 180, height: 180, background: 'white', padding: 8, borderRadius: 8 }}
                />
              </div>
            )}
            {secret && (
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
                title={t('settings.enroll.secretTitle')}
              >
                {secret}
              </div>
            )}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('settings.enroll.codeLabel')}</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={t('settings.enroll.codePlaceholder')}
              maxLength={6}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                color: 'var(--text)',
                fontSize: 14,
                marginBottom: 12,
              }}
              autoFocus
            />
            {error && (
              <div style={{ color: 'var(--c-over,#e5484d)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setStep('home')}>{t('common:cancel')}</button>
              <button className="btn btn-accent" disabled={busy || code.length !== 6} onClick={verifyEnroll}>
                {busy ? t('settings.enroll.verifying') : t('settings.enroll.verifyEnable')}
              </button>
            </div>
          </div>
        )}

        {step === 'disabling' && (
          <div>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 0 }}>
              {t('settings.disable.intro')}
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('settings.disable.passwordLabel')}</label>
            <input
              type="password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              style={{
                width: '100%', padding: '8px 10px', background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                color: 'var(--text)', fontSize: 14, marginBottom: 12,
              }}
              autoFocus
            />
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t('settings.disable.codeLabel')}</label>
            <input
              type="text"
              inputMode="numeric"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={t('settings.disable.codePlaceholder')}
              maxLength={6}
              style={{
                width: '100%', padding: '8px 10px', background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                color: 'var(--text)', fontSize: 14, marginBottom: 12,
              }}
            />
            {error && (
              <div style={{ color: 'var(--c-over,#e5484d)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setStep('home')}>{t('common:cancel')}</button>
              <button className="btn btn-accent" disabled={busy || !pwd || disableCode.length !== 6} onClick={disable}>
                {busy ? t('settings.disable.disabling') : t('settings.mfa.disable')}
              </button>
            </div>
          </div>
        )}
      </div>
      {pwOpen && <ChangePasswordDialog mode="voluntary" onClose={() => setPwOpen(false)} />}
    </div>
  );
}
