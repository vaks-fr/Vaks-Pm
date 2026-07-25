/* ============================================================
   Primitives connecteurs — carte « inbound ».
   Un système EXTERNE pousse vers Vaks (SIRH → congés, plateforme
   d'agents → enregistrement) authentifié par une clé API organisation
   à périmètre FIXE que la carte mint. La carte documente les endpoints,
   liste les clés existantes et affiche le secret une seule fois.

   Composant CONTRÔLÉ : le parent détient la liste des clés (il en a
   besoin pour savoir s'il doit afficher la carte du tout — une carte
   inbound ne s'affiche pas d'office, elle s'ajoute depuis le picker) et
   recharge via `onChanged` après chaque mutation.
   ============================================================ */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiTokenDto } from '../../api/client';
import { Icon } from '../primitives';
import { useConfirm } from '../confirm';
import { ProviderTile } from './ProviderTile';
import SecretOnceBanner from './SecretOnceBanner';

type Flash = (msg: string) => void;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const plusYears = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return d;
};
// Même règle que les jetons API : expiry obligatoire, défaut +1 an, max +2 ans.
const EXP_DEFAULT = () => isoDate(plusYears(1));
const EXP_MAX = () => isoDate(plusYears(2));
const EXP_MIN = () => isoDate(new Date(Date.now() + 86_400_000));

export interface InboundEndpointDoc {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  desc: string;
}

export default function InboundConnectorCard({
  tile,
  title,
  blurb,
  endpoints,
  scopes,
  purposePrefix,
  keys,
  onMint,
  onRevoke,
  onChanged,
  onDismiss,
  flash,
}: {
  tile: { key?: string; label: string; accent?: string; short?: string };
  title: string;
  blurb: string;
  /** Endpoints publics que la clé mintée peut appeler (doc affichée). */
  endpoints: InboundEndpointDoc[];
  /** Scopes FIXES de la clé (affichage — le mint les impose côté serveur). */
  scopes: string[];
  /** Convention de nommage des clés de cette carte (affichée en aide). */
  purposePrefix: string;
  /** Clés existantes, pré-filtrées par purpose + scopes exacts (parent). */
  keys: ApiTokenDto[];
  onMint: (dto: { expiresAt: string; label?: string }) => Promise<{ token: string }>;
  onRevoke: (id: string) => Promise<unknown>;
  /** Rechargement demandé au parent après une mutation. */
  onChanged: () => void | Promise<void>;
  /** Retire la carte (proposé seulement tant qu'aucune clé n'existe). */
  onDismiss?: () => void;
  flash: Flash;
}) {
  const { t } = useTranslation('integrations');
  const confirm = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState(EXP_DEFAULT());
  const [minting, setMinting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const mint = async () => {
    if (!expiresAt) return;
    setMinting(true);
    try {
      const r = await onMint({ expiresAt, label: label.trim() || undefined });
      setCreated(r.token);
      setShowForm(false);
      setLabel('');
      setExpiresAt(EXP_DEFAULT());
      await onChanged();
    } catch (e) {
      flash(t('inboundCard.mintFailed', { message: (e as Error).message }));
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (k: ApiTokenDto) => {
    if (
      !(await confirm({
        title: t('common:confirm'),
        message: t('inboundCard.revokeConfirm', { name: k.name }),
        danger: true,
      }))
    )
      return;
    try {
      await onRevoke(k.id);
      flash(t('inboundCard.revoked'));
      await onChanged();
    } catch (e) {
      flash(t('inboundCard.actionFailed', { message: (e as Error).message }));
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md, 10px)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* En-tête : tuile + titre + badge inbound + scopes */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <ProviderTile p={tile} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>{title}</span>
            <span className="pill pill-role">{t('inboundCard.badge')}</span>
            {scopes.map((s) => (
              <span key={s} className="badge-soft" style={{ fontSize: 11 }}>
                {s}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 2 }}>{blurb}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-accent btn-sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? t('common:cancel') : t('inboundCard.generateKey')}
          </button>
          {/* Retirer la carte : uniquement tant qu'aucune clé n'a été générée
              (sinon la carte reste, elle documente des clés actives). */}
          {onDismiss && keys.length === 0 && (
            <button className="icon-btn" onClick={onDismiss} title={t('inboundCard.remove')}>
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Secret montré UNE SEULE FOIS */}
      {created && (
        <SecretOnceBanner
          secret={created}
          onCopied={() => flash(t('inboundCard.copied'))}
          onDismiss={() => setCreated(null)}
        />
      )}

      {/* Mini-formulaire de mint */}
      {showForm && (
        <div
          style={{
            border: '1px solid var(--accent-line, var(--border))',
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('inboundCard.keyLabel')}</span>
            <input
              className="td-in"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('inboundCard.keyLabelPlaceholder')}
              style={{ width: 200 }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('inboundCard.expiry')}</span>
            <input
              className="td-in"
              type="date"
              required
              min={EXP_MIN()}
              max={EXP_MAX()}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              style={{ width: 170 }}
            />
          </label>
          <button className="btn btn-primary btn-sm" onClick={mint} disabled={minting}>
            {minting ? t('common:saving') : t('inboundCard.mint')}
          </button>
        </div>
      )}

      {/* Doc des endpoints appelables avec la clé */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)' }}>
          {t('inboundCard.endpointsHeading')}
        </span>
        {endpoints.map((ep) => (
          <div key={`${ep.method} ${ep.path}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <code
              style={{
                fontSize: 11.5,
                color: 'var(--text-2)',
                background: 'var(--surface-2)',
                padding: '3px 7px',
                borderRadius: 6,
                overflowWrap: 'anywhere',
              }}
            >
              {ep.method} {ep.path}
            </code>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{ep.desc}</span>
          </div>
        ))}
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {t('inboundCard.authHint', { prefix: purposePrefix })}
        </span>
      </div>

      {/* Clés existantes de cette carte */}
      {keys.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('inboundCard.noKeys')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)' }}>
            {t('inboundCard.existingKeys')}
          </span>
          {keys.map((k) => (
            <div
              key={k.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '6px 10px',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                {k.name.slice(purposePrefix.length) || k.name}
              </span>
              <code style={{ fontSize: 11, color: 'var(--text-3)' }}>{k.prefix}</code>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {k.lastUsedAt
                  ? t('inboundCard.lastUsed', { date: new Date(k.lastUsedAt).toLocaleString() })
                  : t('inboundCard.neverUsed')}
                {k.expiresAt
                  ? ` · ${t('inboundCard.expires', { date: new Date(k.expiresAt).toLocaleDateString() })}`
                  : ''}
              </span>
              <div style={{ marginLeft: 'auto' }}>
                <button
                  className="btn btn-ghost"
                  onClick={() => revoke(k)}
                  style={{ fontSize: 12, color: 'var(--danger, #f85149)' }}
                >
                  {t('inboundCard.revoke')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
