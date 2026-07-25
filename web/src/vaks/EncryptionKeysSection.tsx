/* ============================================================
   Clés de chiffrement — section admin (Sécurité & Conformité).
   Statut du chiffrement at-rest : provider de KEK actif (local /
   KMS / HSM), distribution des DEK par KEK, et rotations KEK
   (re-wrap, données intactes) / DEK (re-chiffrement des secrets).
   Endpoints /admin/crypto/* (crypto:manage). DORA workstreams B/G.
   ============================================================ */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { CryptoStatusDto } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

type Provider = 'local' | 'kms' | 'hsm' | 'kmip';

/** Provider propriétaire d'une kekRef (schéma `<provider>:…` ; non préfixé = local). */
function providerOf(kekRef: string): Provider {
  const i = kekRef.indexOf(':');
  if (i <= 0) return 'local';
  const s = kekRef.slice(0, i) as Provider;
  return (['local', 'kms', 'hsm', 'kmip'] as Provider[]).includes(s) ? s : 'local';
}

export default function EncryptionKeysSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('security');
  const confirm = useConfirm();
  const [status, setStatus] = useState<CryptoStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'kek' | 'dek' | null>(null);

  const providerLabel: Record<Provider, string> = {
    local: t('crypto.providerLocal'),
    kms: t('crypto.providerKms'),
    hsm: t('crypto.providerHsm'),
    kmip: t('crypto.providerKmip'),
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.cryptoStatus());
    } catch (e) {
      flash((e as Error).message || t('crypto.loadError'), 'err');
    } finally {
      setLoading(false);
    }
  }, [flash, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotateKek = useCallback(async () => {
    const ok = await confirm({
      title: t('crypto.rotateKekTitle'),
      message: t('crypto.rotateKekConfirm'),
      confirmLabel: t('crypto.rotateKek'),
    });
    if (!ok) return;
    setBusy('kek');
    try {
      const r = await api.cryptoRewrapKeks();
      flash(t('crypto.rotateKekDone', { rewrapped: r.rewrapped, total: r.total }), 'ok');
      await load();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  }, [confirm, flash, t, load]);

  const rotateDek = useCallback(async () => {
    const ok = await confirm({
      title: t('crypto.rotateDekTitle'),
      message: t('crypto.rotateDekConfirm'),
      confirmLabel: t('crypto.rotateDek'),
      danger: true,
    });
    if (!ok) return;
    setBusy('dek');
    try {
      const r = await api.cryptoRotateDek();
      flash(t('crypto.rotateDekDone', { processed: r.processed, failed: r.failed }), r.failed ? 'err' : 'ok');
      await load();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  }, [confirm, flash, t, load]);

  const activeProvider = status ? providerOf(status.activeKek) : 'local';
  const dist = status?.kekDistribution ?? {};

  return (
    <div className="asection-card" style={{ padding: 24 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          paddingBottom: 20,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>{t('crypto.title')}</h3>
          <p className="muted" style={{ marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.55 }}>
            {t('crypto.intro')}
          </p>
        </div>
        <button className="btn" onClick={() => void load()} disabled={loading} style={{ flexShrink: 0 }}>
          <Icon name="refresh" /> {t('crypto.refresh')}
        </button>
      </div>

      {loading && !status ? (
        <p className="muted" style={{ marginTop: 24 }}>
          {t('crypto.loading')}
        </p>
      ) : status ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28, marginTop: 24 }}>
          {/* Provider actif + KEK */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            <Stat label={t('crypto.activeProvider')} value={providerLabel[activeProvider] ?? activeProvider} />
            <Stat label={t('crypto.activeKek')} value={status.activeKek} mono />
            <Stat label={t('crypto.dekCount')} value={String(status.deks.length)} />
          </div>

          {/* Distribution des DEK par KEK */}
          <section>
            <h4 style={{ margin: '0 0 6px' }}>{t('crypto.distributionTitle')}</h4>
            <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 13, maxWidth: 640, lineHeight: 1.5 }}>
              {t('crypto.distributionIntro')}
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH}>{t('crypto.colProvider')}</th>
                  <th style={TH}>{t('crypto.colKek')}</th>
                  <th style={{ ...TH, textAlign: 'right' }}>{t('crypto.colDeks')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(dist).map(([kek, n]) => (
                  <tr key={kek}>
                    <td style={TD}>{providerLabel[providerOf(kek)] ?? providerOf(kek)}</td>
                    <td style={{ ...TD, fontFamily: 'var(--mono, monospace)', wordBreak: 'break-all' }}>{kek}</td>
                    <td style={{ ...TD, textAlign: 'right' }}>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Rotations */}
          <section>
            <h4 style={{ margin: '0 0 10px' }}>{t('crypto.actionsTitle')}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <ActionRow
                title={t('crypto.rotateKekTitle')}
                desc={t('crypto.rotateKekDesc')}
                button={
                  <button className="btn" onClick={rotateKek} disabled={busy !== null}>
                    {busy === 'kek' ? t('crypto.working') : t('crypto.rotateKek')}
                  </button>
                }
              />
              <ActionRow
                title={t('crypto.rotateDekTitle')}
                desc={t('crypto.rotateDekDesc')}
                button={
                  <button className="btn btn-danger" onClick={rotateDek} disabled={busy !== null}>
                    {busy === 'dek' ? t('crypto.working') : t('crypto.rotateDek')}
                  </button>
                }
              />
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

const TH: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 12,
  color: 'var(--text-3)',
  borderBottom: '1px solid var(--border)',
};
const TD: React.CSSProperties = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid var(--border)' };

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, fontFamily: mono ? 'var(--mono, monospace)' : undefined, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

function ActionRow({ title, desc, button }: { title: string; desc: string; button: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '14px 16px',
      }}
    >
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 3, maxWidth: 560, lineHeight: 1.5 }}>
          {desc}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>{button}</div>
    </div>
  );
}
