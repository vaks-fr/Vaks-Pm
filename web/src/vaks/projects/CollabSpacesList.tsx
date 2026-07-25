import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { CollabSpaceDto } from '@vaks-pm/shared';
import { useConfirm } from '../confirm';

/** Libellés courts des fournisseurs connus (les autres s'affichent bruts). */
const PROVIDER_LABELS: Record<string, string> = {
  msteams: 'Microsoft Teams',
  slack: 'Slack',
  gchat: 'Google Chat',
};

/**
 * Espaces de collaboration liés au projet, dans l'onglet Intégrations.
 * Volontairement **hors licence `teams-provisioning`** : un espace Slack créé
 * par un outil tiers et déclaré via l'API doit rester visible même sans le
 * provisioning Teams. Rend `null` s'il n'y a rien à montrer.
 */
export function CollabSpacesList({
  projectId,
  canManage,
  flash,
}: {
  projectId: string;
  /** Autorise le retrait d'un lien externe (admin / PM). */
  canManage?: boolean;
  flash: (msg: string, kind?: 'ok' | 'err') => void;
}) {
  const { t } = useTranslation('integrations');
  const confirm = useConfirm();
  const [items, setItems] = useState<CollabSpaceDto[] | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.listProjectCollabSpaces(projectId));
    } catch {
      setItems([]); // pas d'accès / pas de donnée → bloc masqué
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const unlink = async (s: CollabSpaceDto) => {
    if (
      !(await confirm({
        title: t('common:confirm'),
        message: t('collabSpaces.unlinkConfirm', { name: PROVIDER_LABELS[s.provider] ?? s.provider }),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteProjectCollabSpace(projectId, s.provider);
      flash(t('collabSpaces.unlinked'), 'ok');
      await load();
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  if (!items || items.length === 0) return null;

  return (
    <div className="md-field" style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="md-label">{t('collabSpaces.title')}</div>
      <div className="md-hint" style={{ marginBottom: 8 }}>{t('collabSpaces.hint')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((s) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{PROVIDER_LABELS[s.provider] ?? s.provider}</span>
            <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
              {s.name || s.url}
            </a>
            <span className="pill" style={{ fontSize: 11 }}>
              {s.source === 'provisioned' ? t('collabSpaces.sourceProvisioned') : t('collabSpaces.sourceExternal')}
            </span>
            {/* Un espace géré par Vaks ne se délie pas ici (il suit le projet). */}
            {canManage && s.source === 'external' && (
              <button className="btn btn-ghost btn-sm" onClick={() => unlink(s)} style={{ marginLeft: 'auto' }}>
                {t('collabSpaces.unlink')}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default CollabSpacesList;
