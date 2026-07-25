/* ============================================================
   Primitives connecteurs — carte d'une connexion configurée.
   Purement présentational : en-tête (label + pills + actions), slot
   `meta` (URL webhook CI, dernière sync agents, …), children (ligne
   de résultat de test). Le pill de statut inline (ok/muted) est
   factorisé ici — une seule implémentation au lieu de trois.
   ============================================================ */
import type { ReactNode } from 'react';
import type { NormalizedProvider } from './types';
import { ProviderTile } from './ProviderTile';

export interface ConnectorCardAction {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export default function ConnectorCard({
  title,
  provider,
  providerLabel,
  status,
  warnPill,
  actions,
  meta,
  children,
}: {
  title: string;
  /** Provider dont afficher le logo/monogramme à gauche du titre (optionnel). */
  provider?: Pick<NormalizedProvider, 'label' | 'accent' | 'short'> & { key?: string };
  /** Libellé du provider (pill accent). */
  providerLabel?: string;
  /** Pill de statut on/off (activé / désactivé, actif / suspendu…). */
  status?: { on: boolean; onLabel: string; offLabel: string };
  /** Pill d'avertissement (dernier test/sync/event en échec, secret manquant…). */
  warnPill?: string;
  actions: ConnectorCardAction[];
  /** Bloc libre sous l'en-tête (URL webhook, date de dernière sync…). */
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md, 10px)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {provider && <ProviderTile p={provider} size={26} />}
        <span style={{ fontWeight: 600 }}>{title}</span>
        {providerLabel && <span className="pill pill-role">{providerLabel}</span>}
        {status && (
          <span
            className="pill"
            style={{
              background: status.on ? 'var(--ok-bg, #1c3329)' : 'var(--surface-2)',
              color: status.on ? 'var(--ok, #3fb950)' : 'var(--text-3)',
            }}
          >
            {status.on ? status.onLabel : status.offLabel}
          </span>
        )}
        {warnPill && (
          <span className="pill" style={{ background: 'var(--surface-2)', color: 'var(--danger, #f85149)' }}>
            {warnPill}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {actions.map((a) => (
            <button
              key={a.key}
              className="btn btn-ghost"
              onClick={a.onClick}
              disabled={a.disabled}
              style={{ fontSize: 12, ...(a.danger ? { color: 'var(--danger, #f85149)' } : {}) }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      {meta}
      {children}
    </div>
  );
}
