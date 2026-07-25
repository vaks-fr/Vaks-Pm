import { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { LICENSE_FEATURE_LABELS, type LicenseFeature } from '@vaks-pm/shared';
import { useAuth } from '../auth/AuthContext';

/**
 * Masque/grise une section **premium** si la feature n'est pas couverte par la
 * licence active (SPEC §16.5). Le gating réel est côté serveur (les routes
 * renvoient 403) ; ceci n'est qu'un confort UI + CTA commercial.
 *
 *  - feature couverte → rend `children`.
 *  - non couverte + `mode="hide"` → ne rend rien.
 *  - non couverte + `mode="cta"` (défaut) → encart « Contacter pour activer ».
 */
export function FeatureGate({
  feature,
  children,
  mode = 'cta',
  fallback,
}: {
  feature: LicenseFeature;
  children: ReactNode;
  mode?: 'cta' | 'hide';
  fallback?: ReactNode;
}) {
  const { hasFeature } = useAuth();
  if (hasFeature(feature)) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (mode === 'hide') return null;
  return <FeatureLockedCta feature={feature} />;
}

/** Encart « fonctionnalité sous licence » réutilisable. */
export function FeatureLockedCta({ feature }: { feature: LicenseFeature }) {
  const { t } = useTranslation('admin');
  const label = LICENSE_FEATURE_LABELS[feature] ?? feature;
  return (
    <div
      style={{
        border: '1px dashed var(--border-2)',
        borderRadius: 10,
        padding: '20px 22px',
        background: 'var(--surface-2)',
        color: 'var(--text-2)',
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
      }}
    >
      <span aria-hidden style={{ fontSize: 20, lineHeight: '24px' }}>
        🔒
      </span>
      <div>
        <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          {t('featureGate.licensedFeature', { label })}
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          <Trans t={t} i18nKey="featureGate.body" components={[<strong />]} />
        </p>
      </div>
    </div>
  );
}
