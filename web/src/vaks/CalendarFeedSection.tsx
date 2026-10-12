/* ============================================================
   Flux calendrier ICS personnel (slice C). Abonnement Outlook/Google
   « S'abonner via URL » : échéances de tâches + allocations DE l'utilisateur
   courant, portées par un token opaque révocable/régénérable. Même esprit
   que ApiTokensSection : self-service, aucune permission spéciale.
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, BASE } from '../api/client';
import { useConfirm } from './confirm';

type Flash = (msg: string, kind?: 'info' | 'ok' | 'err') => void;

export default function CalendarFeedSection({ flash }: { flash?: Flash }) {
  const { t } = useTranslation('security');
  const confirm = useConfirm();
  const say = (m: string, k: 'info' | 'ok' | 'err' = 'info') => (flash ? flash(m, k) : k === 'err' && alert(m));

  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getMyCalendarFeed();
      setToken(r.token);
    } catch (e) {
      say((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const url = token ? `${window.location.origin}${BASE}/calendar/${token}.ics` : null;

  const copy = () => {
    if (!url) return;
    void navigator.clipboard?.writeText(url);
    say(t('calendarFeed.copied'), 'ok');
  };

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.rotateMyCalendarFeed();
      setToken(r.token);
      say(t('calendarFeed.generated'), 'ok');
    } catch (e) {
      say((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!(await confirm({ title: t('common:confirm'), message: t('calendarFeed.regenerateConfirm'), danger: true }))) return;
    await generate();
  };

  const revoke = async () => {
    if (!(await confirm({ title: t('common:confirm'), message: t('calendarFeed.revokeConfirm'), danger: true }))) return;
    setBusy(true);
    try {
      await api.revokeMyCalendarFeed();
      setToken(null);
      say(t('calendarFeed.revoked'), 'ok');
    } catch (e) {
      say((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{t('calendarFeed.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>{t('calendarFeed.desc')}</div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('common:loading')}</div>
      ) : url ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('calendarFeed.urlLabel')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <code
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12,
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                userSelect: 'all',
                wordBreak: 'break-all',
                flex: '1 1 260px',
              }}
            >
              {url}
            </code>
            <button type="button" className="btn btn-line btn-sm" onClick={copy}>
              {t('calendarFeed.copy')}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('calendarFeed.howto')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-line btn-sm" disabled={busy} onClick={regenerate}>
              {t('calendarFeed.regenerate')}
            </button>
            <button className="btn btn-line btn-sm" style={{ color: '#c92a2a' }} disabled={busy} onClick={revoke}>
              {t('calendarFeed.revoke')}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('calendarFeed.inactive')}</div>
          <button className="btn btn-accent btn-sm" style={{ justifySelf: 'start' }} disabled={busy} onClick={generate}>
            {t('calendarFeed.generate')}
          </button>
        </div>
      )}
    </div>
  );
}
