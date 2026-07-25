/* ============================================================
   Primitives connecteurs — cadre du formulaire création/édition.
   Titre, blurb du provider, champ label, champs du descripteur via
   FieldInput (aide + lien doc), slot `extraFields` (ex. sélecteur
   d'owner par défaut des annuaires d'agents), checkbox « activer »,
   pied Cancel/Save.
   ============================================================ */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NormalizedProvider } from './types';
import type { DraftState } from './draft';
import FieldInput from './FieldInput';

export default function ConnectorDraftForm({
  provider,
  draft,
  setDraft,
  saving,
  onCancel,
  onSave,
  isEdit,
  labels,
  extraFields,
  hideLabel,
  showSecretExpiry,
}: {
  provider: NormalizedProvider;
  draft: DraftState;
  setDraft: (fn: (d: DraftState) => DraftState) => void;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  isEdit: boolean;
  labels: { editTitle: string; newTitle: string; labelField: string; enableField: string };
  /** Champs additionnels spécifiques à la section, rendus après ceux du descripteur. */
  extraFields?: ReactNode;
  /** Masque le champ « nom d'affichage » quand le libellé est figé (ex. un
   *  fournisseur unique dont le nom n'est pas éditable). */
  hideLabel?: boolean;
  /** Affiche le champ optionnel « date d'expiration du secret » (alerte J-14).
   *  Réservé aux connecteurs dont le secret est géré côté tiers ET dont le
   *  backend persiste `config.secretExpiresAt` (annuaire agents, ticketing,
   *  sources de fichiers). PAS pour CI (secret HMAC statique) ni collab. */
  showSecretExpiry?: boolean;
}) {
  const { t } = useTranslation('integrations');
  return (
    <div
      style={{
        border: '1px solid var(--accent-line, var(--border))',
        borderRadius: 'var(--r-md, 10px)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14 }}>{isEdit ? labels.editTitle : labels.newTitle}</div>
      {provider.blurb && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{provider.blurb}</div>}

      {!hideLabel && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{labels.labelField}</span>
          <input
            className="td-in"
            value={draft.label}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
            style={{ width: '100%' }}
          />
        </label>
      )}

      {provider.fields.filter((f) => !f.hidden?.(draft.config)).map((f) => (
        <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {f.label}
            {f.required && <span style={{ color: 'var(--danger, #f85149)' }}> *</span>}
          </span>
          <FieldInput field={f} draft={draft} setDraft={setDraft} />
          {(f.help || f.helpUrl) && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {f.help}
              {f.helpUrl && (
                <>
                  {f.help ? ' ' : ''}
                  <a
                    href={f.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}
                  >
                    {t('connectors.docLink')} ↗
                  </a>
                </>
              )}
            </span>
          )}
        </label>
      ))}

      {extraFields}

      {/* Date d'expiration du secret — OPTIONNELLE. Affichée seulement si le
          provider a un secret géré côté tiers. Renseignée → alerte email J-14. */}
      {showSecretExpiry && provider.fields.some((f) => f.secret) && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{t('connectors.secretExpiry')}</span>
          <input
            className="td-in"
            type="date"
            value={typeof draft.config.secretExpiresAt === 'string' ? draft.config.secretExpiresAt : ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, config: { ...d.config, secretExpiresAt: e.target.value } }))
            }
            style={{ width: '100%' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('connectors.secretExpiryHelp')}</span>
        </label>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
        />
        {labels.enableField}
      </label>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          {t('common:cancel')}
        </button>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>
          {saving ? t('common:saving') : t('common:save')}
        </button>
      </div>
    </div>
  );
}
