/* ============================================================
   Primitives connecteurs — bandeau « secret montré une seule fois ».
   Extrait de ApiTokensSection (jetons API) pour être réutilisé par
   les cartes inbound. Strings sur `security:tokens.*` (namespace
   historique des jetons, déjà traduit ×4).
   ============================================================ */
import { Trans, useTranslation } from 'react-i18next';

export default function SecretOnceBanner({
  secret,
  onCopied,
  onDismiss,
}: {
  secret: string;
  /** Callback après copie réussie (pour flasher une confirmation). */
  onCopied?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('security');
  return (
    <div
      style={{
        border: '1px solid #15a37f',
        background: 'rgba(21,163,127,.08)',
        borderRadius: 8,
        padding: 12,
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, color: '#15a37f' }}>{t('tokens.secretWarning')}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code
          style={{
            flex: 1,
            fontSize: 12,
            wordBreak: 'break-all',
            background: 'var(--surface-2)',
            padding: '6px 8px',
            borderRadius: 6,
          }}
        >
          {secret}
        </code>
        <button
          className="btn btn-line btn-sm"
          onClick={() => {
            navigator.clipboard?.writeText(secret);
            onCopied?.();
          }}
        >
          {t('tokens.copy')}
        </button>
        <button className="btn btn-line btn-sm" onClick={onDismiss}>
          {t('tokens.ok')}
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
        <Trans t={t} i18nKey="tokens.usage" components={{ 1: <code /> }} />
      </div>
    </div>
  );
}
