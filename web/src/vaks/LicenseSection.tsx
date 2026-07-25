import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  LICENSE_FEATURES,
  LICENSE_FEATURE_LABELS,
  type LicenseFeature,
  type LicenseHistoryRowDto,
  type LicenseStatusDto,
} from '@vaks-pm/shared';
import { api } from '../api/client';
import { useConfirm } from './confirm';
import { useAuth } from '../auth/AuthContext';

type Flash = (msg: string) => void;

/** Couleurs de statut — dérivées en oklch, lisibles en clair ET en sombre
 *  (le fond est mixé avec `--surface`, donc il s'adapte au thème). */
const STATUS_META: Record<
  LicenseStatusDto['status'],
  { labelKey: string; fg: string; bg: string }
> = {
  active: {
    labelKey: 'license.statusActive',
    fg: 'oklch(0.62 0.15 150)',
    bg: 'color-mix(in oklch, oklch(0.62 0.15 150) 16%, var(--surface))',
  },
  grace: {
    labelKey: 'license.statusGrace',
    fg: 'oklch(0.70 0.14 80)',
    bg: 'color-mix(in oklch, oklch(0.70 0.14 80) 18%, var(--surface))',
  },
  expired: {
    labelKey: 'license.statusExpired',
    fg: 'oklch(0.63 0.18 25)',
    bg: 'color-mix(in oklch, oklch(0.63 0.18 25) 16%, var(--surface))',
  },
  invalid: {
    labelKey: 'license.statusInvalid',
    fg: 'oklch(0.63 0.18 25)',
    bg: 'color-mix(in oklch, oklch(0.63 0.18 25) 16%, var(--surface))',
  },
  suspended: {
    labelKey: 'license.statusSuspended',
    fg: 'oklch(0.63 0.18 25)',
    bg: 'color-mix(in oklch, oklch(0.63 0.18 25) 16%, var(--surface))',
  },
  none: { labelKey: 'license.statusNone', fg: 'var(--text-2)', bg: 'var(--surface-3)' },
};

const OK_GREEN = 'oklch(0.62 0.15 150)';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  background: 'var(--surface)',
  color: 'var(--text)',
};

/**
 * Admin → Licence (open-core, SPEC §16.5). État de la licence du tenant,
 * matrice des features, import (fichier OU collage), historique. Entièrement
 * stylé via les tokens `--surface/--text/--border/--accent` → OK en thème sombre.
 */
export default function LicenseSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const { refreshLicense } = useAuth();
  const [status, setStatus] = useState<LicenseStatusDto | null>(null);
  const [history, setHistory] = useState<LicenseHistoryRowDto[]>([]);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [s, h] = await Promise.all([api.getLicense(), api.getLicenseHistory()]);
      setStatus(s);
      setHistory(h);
    } catch (e) {
      flash(t('license.unableToRead', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeFeatures = useMemo(() => new Set(status?.features ?? []), [status]);

  const readFile = async (file: File) => {
    if (file.size > 64 * 1024) {
      flash(t('license.fileTooLarge'));
      return;
    }
    const text = (await file.text()).trim();
    setToken(text);
    setFileName(file.name);
    if (!text.startsWith('v4.public.')) {
      flash(t('license.notALicense'));
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  };

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const s = await api.uploadLicense(token.trim());
      setStatus(s);
      setToken('');
      setFileName(null);
      await Promise.all([load(), refreshLicense()]);
      flash(t('license.imported'));
    } catch (e) {
      flash(t('license.importRefused', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!(await confirm({ title: t('common:confirm'), message: t('license.removeConfirm'), danger: true })))
      return;
    setBusy(true);
    try {
      const s = await api.clearLicense();
      setStatus(s);
      await Promise.all([load(), refreshLicense()]);
      flash(t('license.removed'));
    } catch (e) {
      flash(t('license.removeFailed', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-3)', padding: 12 }}>{t('license.loading')}</div>;

  const meta = STATUS_META[status?.status ?? 'none'];
  const days = status?.daysRemaining ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 720 }}>
      {/* État courant */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: '4px 10px',
              borderRadius: 999,
              color: meta.fg,
              background: meta.bg,
            }}
          >
            {t(meta.labelKey)}
          </span>
          {status?.customer && <span style={{ fontWeight: 600 }}>{status.customer}</span>}
          {status?.status === 'grace' && days != null && (
            <span style={{ color: STATUS_META.grace.fg, fontSize: 13 }}>
              {t('license.expiresInDays', { count: days })}
            </span>
          )}
          {status?.status === 'suspended' && (
            <span style={{ color: STATUS_META.suspended.fg, fontSize: 13 }}>
              {t('license.suspendedHint')}
            </span>
          )}
        </div>

        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            gap: '8px 18px',
            margin: 0,
            fontSize: 14,
          }}
        >
          <dt style={{ color: 'var(--text-3)' }}>{t('license.issuedOn')}</dt>
          <dd style={{ margin: 0 }}>{fmtDate(status?.issuedAt ?? null)}</dd>
          <dt style={{ color: 'var(--text-3)' }}>{t('license.expiresOn')}</dt>
          <dd style={{ margin: 0 }}>{fmtDate(status?.expiresAt ?? null)}</dd>
          <dt style={{ color: 'var(--text-3)' }}>{t('license.maxUsers')}</dt>
          <dd style={{ margin: 0 }}>{status?.maxUsers ?? t('license.unlimited')}</dd>
          <dt style={{ color: 'var(--text-3)' }}>{t('license.signature')}</dt>
          <dd style={{ margin: 0 }}>
            {status?.signatureValid ? t('license.signatureVerified') : t('license.signatureNone')}
          </dd>
          <dt style={{ color: 'var(--text-3)' }}>{t('license.onlineCheck')}</dt>
          <dd style={{ margin: 0 }}>
            {status?.requireOnline ? t('license.onlineRequired') : t('license.onlineOffline')}
          </dd>
          {status?.notes && (
            <>
              <dt style={{ color: 'var(--text-3)' }}>{t('license.notes')}</dt>
              <dd style={{ margin: 0 }}>{status.notes}</dd>
            </>
          )}
          {status?.organizationId && (
            <>
              <dt style={{ color: 'var(--text-3)' }}>{t('license.organizationId')}</dt>
              <dd style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{ fontFamily: 'monospace', fontSize: 13, userSelect: 'all' }}>
                  {status.organizationId}
                </code>
                <button
                  type="button"
                  title={t('license.copyId')}
                  onClick={() => void navigator.clipboard?.writeText(status.organizationId ?? '')}
                  style={{
                    cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6,
                    background: 'var(--surface)', color: 'var(--text-2)', fontSize: 12, padding: '2px 8px',
                  }}
                >
                  {t('license.copyId')}
                </button>
              </dd>
            </>
          )}
        </dl>

        {/* Matrice des features */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', marginBottom: 8, letterSpacing: 0.4 }}>
            {t('license.featuresHeading')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {LICENSE_FEATURES.map((f: LicenseFeature) => {
              const on = activeFeatures.has(f);
              return (
                <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
                  <span style={{ color: on ? OK_GREEN : 'var(--text-faint)' }}>{on ? '✓' : '○'}</span>
                  <span style={{ color: on ? 'var(--text)' : 'var(--text-faint)' }}>
                    {LICENSE_FEATURE_LABELS[f]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {status?.signatureValid && (
          <button
            onClick={clear}
            disabled={busy}
            style={{
              marginTop: 18,
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid color-mix(in oklch, oklch(0.63 0.18 25) 45%, var(--border))',
              background: 'transparent',
              color: 'oklch(0.63 0.18 25)',
              cursor: busy ? 'default' : 'pointer',
              fontSize: 13,
            }}
          >
            {t('license.removeLicense')}
          </button>
        )}
      </div>

      {/* Import : fichier OU collage */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('license.importTitle')}</div>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-3)' }}>
          <Trans t={t} i18nKey="license.importHint" components={[<code />, <code />]} />
        </p>

        {/* Bouton fichier */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            ref={fileInput}
            type="file"
            accept=".license,.txt,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void readFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid var(--border-2)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {t('license.chooseFile')}
          </button>
          {fileName && (
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
              📄 {fileName}
            </span>
          )}
        </div>

        {/* Zone collage + drop */}
        <textarea
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            if (fileName) setFileName(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          placeholder={t('license.dropPlaceholder')}
          spellCheck={false}
          style={{
            width: '100%',
            minHeight: 96,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
            padding: 10,
            borderRadius: 8,
            border: dragOver
              ? '1px dashed var(--accent)'
              : '1px solid var(--border)',
            background: dragOver
              ? 'color-mix(in oklch, var(--accent) 8%, var(--surface-2))'
              : 'var(--surface-2)',
            color: 'var(--text)',
            resize: 'vertical',
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
        <button
          onClick={submit}
          disabled={busy || !token.trim()}
          style={{
            marginTop: 12,
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: busy || !token.trim() ? 'var(--surface-3)' : 'var(--accent)',
            color: busy || !token.trim() ? 'var(--text-faint)' : 'var(--accent-fg)',
            cursor: busy || !token.trim() ? 'default' : 'pointer',
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          {busy ? t('license.verifying') : t('license.importLicense')}
        </button>
      </div>

      {/* Historique */}
      {history.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{t('license.history')}</div>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-3)' }}>
                <th style={{ padding: '4px 8px', fontWeight: 600 }}>{t('license.historyImported')}</th>
                <th style={{ padding: '4px 8px', fontWeight: 600 }}>{t('license.historyCustomer')}</th>
                <th style={{ padding: '4px 8px', fontWeight: 600 }}>{t('license.historyExpires')}</th>
                <th style={{ padding: '4px 8px', fontWeight: 600 }}>{t('license.historyBy')}</th>
                <th style={{ padding: '4px 8px', fontWeight: 600 }}>{t('license.historyState')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px' }}>{fmtDate(r.createdAt)}</td>
                  <td style={{ padding: '6px 8px' }}>{r.customer ?? '—'}</td>
                  <td style={{ padding: '6px 8px' }}>{fmtDate(r.expiresAt)}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-3)' }}>
                    {r.uploadedByEmail ?? '—'}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {r.active ? (
                      <span style={{ color: OK_GREEN, fontWeight: 600 }}>{t('license.historyActive')}</span>
                    ) : (
                      <span style={{ color: 'var(--text-faint)' }}>{t('license.historyReplaced')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
