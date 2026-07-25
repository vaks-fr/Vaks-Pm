import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setTokens } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { useAuth } from '../auth/AuthContext';
import type { ActiveSessionDto } from '@vaks-pm/shared';

/**
 * Modal "Active sessions" — listing complet des refresh tokens non révoqués
 * et non expirés. Affiche un parsing simpliste du User-Agent (browser + OS)
 * pour rendre la ligne lisible. Bouton Revoke par session.
 *
 * Le backend fait déjà un lazy cleanup au moment du GET → on n'affiche que
 * les sessions encore actives (idle timeout pris en compte).
 */
export default function ActiveSessionsPanel({
  onClose,
  embedded,
}: {
  onClose?: () => void;
  /** Rendu inline (sans overlay/modale ni titre) pour s'intégrer dans une carte
   *  de section admin (Sécurité → Connexions actives → Sessions). */
  embedded?: boolean;
}) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const [sessions, setSessions] = useState<ActiveSessionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [forceLogoutBusy, setForceLogoutBusy] = useState(false);
  const [filter, setFilter] = useState('');

  // Heuristique « session courante » : sans identifiant de session dans le JWT,
  // on repère les sessions de l'utilisateur connecté ouvertes depuis CE
  // navigateur (même User-Agent) pour éviter qu'il révoque la sienne par erreur.
  const myUa = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isCurrent = (s: ActiveSessionDto) =>
    !!me && s.userId === me.id && !!s.userAgent && s.userAgent === myUa;

  const filtered = useMemo(() => {
    if (!sessions) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      (s.userName + ' ' + s.userEmail).toLowerCase().includes(q),
    );
  }, [sessions, filter]);

  const reload = async () => {
    setError(null);
    try {
      setSessions(await api.listActiveSessions());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const revoke = async (id: string) => {
    const s = sessions?.find((x) => x.id === id);
    const msg =
      s && isCurrent(s)
        ? t('sessions.revokeCurrentConfirm')
        : t('sessions.revokeConfirm');
    if (!(await confirm({ title: t('common:confirm'), message: msg, danger: true }))) return;
    setRevokingId(id);
    try {
      await api.revokeSession(id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRevokingId(null);
    }
  };

  const forceLogoutAll = async () => {
    if (!(await confirm({ title: t('common:confirm'), message: t('sessions.forceLogoutConfirm'), danger: true }))) return;
    setForceLogoutBusy(true);
    try {
      const r = await api.forceLogoutAll();
      alert(t('sessions.forceLogoutDone', { count: r.revokedCount }));
      // Le force-logout inclut la session de l'admin : on le déconnecte
      // IMMÉDIATEMENT en local (sinon son access token JWT, déjà émis, reste
      // valide jusqu'à expiration et il « reste connecté »). Redirection dure.
      setTokens(null, null);
      window.location.assign('/login');
    } catch (e) {
      setError((e as Error).message);
      setForceLogoutBusy(false);
    }
  };

  const inner = (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
          <div>
            {!embedded && <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{t('sessions.title')}</h2>}
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: embedded ? 0 : 4 }}>
              {t('sessions.subtitle')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="lfilter" style={{ margin: 0 }}>
              <Icon name="search" size={14} style={{ color: 'var(--text-3)' }} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('sessions.filterPlaceholder')}
                style={{ minWidth: 140 }}
              />
            </div>
            <button className="btn btn-line btn-sm" onClick={reload}>
              <Icon name="refresh" size={13} /> {t('sessions.refresh')}
            </button>
            <button className="btn btn-danger btn-sm" onClick={forceLogoutAll} disabled={forceLogoutBusy}>
              {forceLogoutBusy ? '…' : t('sessions.forceLogoutAll')}
            </button>
            {!embedded && (
              <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
                <Icon name="x" size={18} />
              </button>
            )}
          </div>
        </div>

        {error && (
          <div style={{ color: 'var(--c-over,#e5484d)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>
        )}

        {!filtered ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>{t('sessions.loading')}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
            {sessions && sessions.length > 0 ? t('sessions.noMatch') : t('sessions.none')}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase' }}>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}>{t('sessions.colUser')}</th>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}>{t('sessions.colDevice')}</th>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}>{t('sessions.colIp')}</th>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}>{t('sessions.colLastActivity')}</th>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}>{t('sessions.colSignedIn')}</th>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const current = isCurrent(s);
                return (
                <tr
                  key={s.id}
                  style={{
                    borderTop: '1px solid var(--border)',
                    background: current ? 'var(--surface-2)' : undefined,
                  }}
                >
                  <td style={{ padding: '10px 6px' }}>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {s.userName}
                      {current && (
                        <span
                          title={t('sessions.thisDeviceTitle')}
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#fff',
                            background: 'var(--accent)',
                            padding: '1px 6px',
                            borderRadius: 999,
                            letterSpacing: 0.3,
                          }}
                        >
                          {t('sessions.thisDevice')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{s.userEmail}</div>
                  </td>
                  <td style={{ padding: '10px 6px' }} title={s.userAgent ?? ''}>
                    {parseUA(s.userAgent, t('sessions.deviceUnknown'))}
                  </td>
                  <td style={{ padding: '10px 6px', fontFamily: 'monospace', fontSize: 12 }}>
                    {s.ipAddress || <span style={{ color: 'var(--text-faint)' }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 6px', fontSize: 12 }}>{relTime(s.lastActivityAt)}</td>
                  <td style={{ padding: '10px 6px', fontSize: 12 }}>{relTime(s.createdAt)}</td>
                  <td style={{ padding: '10px 6px', textAlign: 'right' }}>
                    <button
                      className="btn btn-line btn-sm"
                      disabled={revokingId === s.id}
                      onClick={() => revoke(s.id)}
                    >
                      {revokingId === s.id ? '…' : t('sessions.revoke')}
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-faint)' }}>
          {sessions
            ? filter.trim()
              ? t('sessions.countOfTotal', { shown: filtered?.length ?? 0, total: sessions.length })
              : t('sessions.count', { total: sessions.length })
            : null}
        </div>
      </>
  );

  if (embedded) {
    return (
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          background: 'var(--surface)',
          color: 'var(--text)',
        }}
      >
        {inner}
      </div>
    );
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'grid', placeItems: 'center', zIndex: 1100, padding: 16,
      }}
    >
      <div style={{
        width: '100%', maxWidth: 900, maxHeight: '85vh', overflow: 'auto',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg, 14px)', padding: 20,
        boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
      }}>
        {inner}
      </div>
    </div>
  );
}

/** Parsing super basique — détecte le browser + OS dominants pour rendre la
 *  cellule lisible. Pas de lib externe pour rester léger. */
function parseUA(ua: string | null, unknownLabel: string): string {
  if (!ua) return '—';
  let browser = unknownLabel;
  let os = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/curl/i.test(ua)) browser = 'curl';
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}

function relTime(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diffSec = Math.floor((Date.now() - t) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  } catch {
    return iso;
  }
}
