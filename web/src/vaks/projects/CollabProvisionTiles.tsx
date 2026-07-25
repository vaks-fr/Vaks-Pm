import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { ProviderTile } from '../connectors/ProviderTile';
import { useConfirm } from '../confirm';

type Provision = Awaited<ReturnType<typeof api.getProjectCollabProvision>>[number];
type TeamsStatus = Awaited<ReturnType<typeof api.getMsTeamStatus>>;

/** Clé de logo (`PROVIDER_LOGOS`) + couleur de marque, par fournisseur. */
const BRAND: Record<string, { logoKey: string; accent: string; short: string }> = {
  msteams: { logoKey: 'msteams', accent: '#6264A7', short: 'MT' },
  slack: { logoKey: 'slack', accent: '#4A154B', short: 'SL' },
  gchat: { logoKey: 'gchat', accent: '#00AC47', short: 'GC' },
  // Pas de logo dédié : monogramme sur fond bleu Drive.
  gdrive: { logoKey: 'gdrive', accent: '#1a73e8', short: 'GD' },
};

/** Statut serveur → suffixe de clé i18n (`teamsProvisioning.status.*`). */
const STATUS_KEY: Record<string, string> = {
  NONE: 'none',
  PENDING: 'pending',
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  FAILED: 'failed',
};

/**
 * Onglet Intégrations du projet — **espaces de collaboration**, une tuile par
 * fournisseur (Microsoft Teams / Slack / Google Chat) : logo de la marque,
 * statut, et le bouton d'action dessous. Remplace l'ancien bloc Teams en texte
 * brut, et expose enfin Slack et Google Chat au niveau projet (ils n'avaient
 * qu'un endpoint admin).
 *
 * Le bouton provisionne **sans transition de statut** : le déclenchement
 * automatique n'a lieu qu'à l'entrée en ACTIF, et rejouer un aller-retour aurait
 * des effets de bord (autre provisioning, notifications sponsors, webhooks).
 *
 * Ne montre que les fournisseurs pertinents : activés au niveau organisation,
 * ou déjà provisionnés pour ce projet. Rend `null` s'il n'y en a aucun (tenant
 * sans provisioning configuré → aucune UI premium exposée).
 */
export function CollabProvisionTiles({
  projectId,
  canProvision,
  flash,
}: {
  projectId: string;
  /** `project:update` — sinon les tuiles restent en lecture seule. */
  canProvision?: boolean;
  flash: (msg: string, kind?: 'ok' | 'err') => void;
}) {
  const { t } = useTranslation('integrations');
  const confirm = useConfirm();
  const [items, setItems] = useState<Provision[] | null>(null);
  const [teams, setTeams] = useState<TeamsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.getProjectCollabProvision(projectId));
    } catch {
      setItems([]); // pas d'accès → bloc masqué
    }
    // Logs + archivage : propres à Teams, tolérant (403 si licence absente).
    setTeams(await api.getMsTeamStatus(projectId).catch(() => null));
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Le worker Teams est asynchrone : on repasse quelques fois après l'action. */
  const poll = useCallback(() => {
    let n = 0;
    const tick = async () => {
      await load();
      if (++n < 5) setTimeout(tick, 2500);
    };
    setTimeout(tick, 2000);
  }, [load]);

  const provision = async (p: Provision) => {
    setBusy(p.provider);
    try {
      const r = await api.provisionProjectCollab(projectId, p.provider);
      // `reason` porte le détail utile (membres invités / sans compte Slack) —
      // on l'affiche aussi en succès, pas seulement quand rien n'a été fait.
      flash(
        r.status === 'skipped'
          ? t('collabProvision.skipped', { reason: r.reason ?? r.status })
          : r.reason
            ? `${p.label} : ${r.reason}`
            : t('collabProvision.started', { name: p.label }),
        r.status === 'skipped' ? undefined : 'ok',
      );
      await load();
      if (p.provider === 'msteams') poll(); // création Graph en tâche de fond
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Archivage — destructif côté fournisseur, donc confirmation explicite.
   * Slack ne sait pas supprimer un canal (archiver est le seul nettoyage) et
   * délie l'espace au passage : la tuile repasse à « Provisionner maintenant ».
   */
  const archive = async (p: Provision) => {
    if (
      !(await confirm({
        title: t('collabProvision.archive'),
        message: t(
          p.provider === 'slack' ? 'collabProvision.archiveConfirmSlack' : 'collabProvision.archiveConfirm',
          { name: p.label },
        ),
        danger: true,
      }))
    )
      return;
    setBusy(p.provider);
    try {
      const r = await api.archiveProjectCollab(projectId, p.provider);
      flash(r.reason ? `${p.label} : ${r.reason}` : t('collabProvision.archive'), 'ok');
      await load();
      if (p.provider === 'msteams') poll();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Détache le lien LOCAL — échappatoire quand l'espace/équipe a été supprimé
   * côté fournisseur (archive/re-sync partent en 404). Ne touche PAS au distant,
   * donc confirmation pour bien dire que ce n'est PAS un archivage.
   */
  const detach = async (p: Provision) => {
    if (
      !(await confirm({
        title: t('collabProvision.detach'),
        message: t('collabProvision.detachConfirm', { name: p.label }),
        danger: true,
      }))
    )
      return;
    setBusy(p.provider);
    try {
      const r = await api.detachProjectCollab(projectId, p.provider);
      flash(r.reason ? `${p.label} : ${r.reason}` : t('collabProvision.detach'), 'ok');
      await load();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Suppression d'espace — Google Chat uniquement (Chat n'a pas d'archivage).
   * DESTRUCTIF et définitif côté Google → confirmation forte.
   */
  const deleteSpace = async (p: Provision) => {
    if (
      !(await confirm({
        title: t('collabProvision.deleteSpace'),
        message: t('collabProvision.deleteSpaceConfirm', { name: p.label }),
        danger: true,
      }))
    )
      return;
    setBusy(p.provider);
    try {
      const r = await api.deleteProjectCollabSpaceRemote(projectId, p.provider);
      flash(r.reason ? `${p.label} : ${r.reason}` : t('collabProvision.deleteSpace'), 'ok');
      await load();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };

  if (!items) return null;
  // Pertinent = activé côté org, ou déjà provisionné (garde l'historique visible).
  const visible = items.filter((p) => p.enabled || p.provisioned);
  if (visible.length === 0) return null;

  return (
    <div className="md-field" style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="md-label">{t('collabProvision.title')}</div>
      <div className="md-hint" style={{ marginBottom: 10 }}>{t('collabProvision.hint')}</div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {visible.map((p) => {
          const brand = BRAND[p.provider] ?? { logoKey: p.provider, accent: 'var(--accent)', short: '??' };
          const statusLabel = STATUS_KEY[p.status]
            ? t(`teamsProvisioning.status.${STATUS_KEY[p.status]}`)
            : p.status;
          const working = busy === p.provider;
          return (
            <div
              key={p.provider}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md, 10px)',
                background: 'var(--surface)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                overflow: 'hidden',
                height: '100%',
              }}
            >
              {/* Logo + nom + statut — `flex:1` pour aligner les boutons en bas. */}
              <div
                style={{
                  flex: 1,
                  width: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '16px 12px 12px',
                }}
              >
                <ProviderTile
                  p={{ key: brand.logoKey, label: p.label, accent: brand.accent, short: brand.short }}
                  size={40}
                />
                <span style={{ fontWeight: 600, fontSize: 13.5, textAlign: 'center' }}>{p.label}</span>
                <span
                  className="pill"
                  style={{
                    fontSize: 11,
                    background: p.provisioned ? 'var(--ok-bg, #1c3329)' : 'var(--surface-2)',
                    color: p.provisioned ? 'var(--ok, #3fb950)' : 'var(--text-3)',
                  }}
                >
                  {statusLabel}
                </span>
                {p.url && (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11.5, color: 'var(--accent)' }}
                  >
                    {t('collabProvision.open')}
                  </a>
                )}
              </div>

              {canProvision && (
                <button
                  onClick={() => provision(p)}
                  disabled={working}
                  style={{
                    width: '100%',
                    padding: '9px 0',
                    borderTop: '1px solid var(--border)',
                    background: 'transparent',
                    color: 'var(--accent)',
                    fontWeight: 600,
                    fontSize: 12.5,
                    cursor: working ? 'default' : 'pointer',
                    opacity: working ? 0.6 : 1,
                    marginTop: 'auto',
                  }}
                >
                  {working
                    ? t('common:loading')
                    : p.provisioned
                      ? t('collabProvision.reprovision')
                      : t('collabProvision.provisionNow')}
                </button>
              )}

              {/* Archivage : action DISTANTE réelle (Graph/Slack). Teams et Slack
                  (Google Chat pas encore supporté). Inchangé. */}
              {canProvision &&
                p.provisioned &&
                p.status !== 'ARCHIVED' &&
                (p.provider === 'msteams' || p.provider === 'slack') && (
                  <button
                    onClick={() => archive(p)}
                    disabled={working}
                    style={{
                      width: '100%',
                      padding: '8px 0',
                      borderTop: '1px solid var(--border)',
                      background: 'transparent',
                      color: 'var(--text-3)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {t('collabProvision.archive')}
                  </button>
                )}

              {/* Supprimer l'espace : Google Chat et Google Drive (aucun des deux
                  n'a d'archivage). Destructif/définitif côté Google → texte rouge. */}
              {canProvision && (p.provider === 'gchat' || p.provider === 'gdrive') && p.provisioned && (
                <button
                  onClick={() => deleteSpace(p)}
                  disabled={working}
                  style={{
                    width: '100%',
                    padding: '8px 0',
                    borderTop: '1px solid var(--border)',
                    background: 'transparent',
                    color: 'var(--danger, #f85149)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {t('collabProvision.deleteSpace')}
                </button>
              )}

              {/* Détacher : nettoyage LOCAL uniquement (aucun appel distant) —
                  débloque un projet dont l'espace/équipe a été supprimé côté
                  fournisseur. Dispo dès qu'il y a un lien local, y compris en
                  FAILED (le cas typique du blocage). */}
              {canProvision && (p.provisioned || p.status === 'FAILED') && (
                <button
                  onClick={() => detach(p)}
                  disabled={working}
                  style={{
                    width: '100%',
                    padding: '8px 0',
                    borderTop: '1px solid var(--border)',
                    background: 'transparent',
                    color: 'var(--danger, #f85149)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {t('collabProvision.detach')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Journal de provisioning Teams (utile au diagnostic). */}
      {teams && teams.logs.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
          {teams.logs.slice(0, 5).map((l) => (
            <div key={l.id} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
              <span style={{ width: 86, color: 'var(--muted)' }}>
                {new Date(l.createdAt).toLocaleTimeString()}
              </span>
              <span style={{ width: 80 }}>{l.action}</span>
              <strong
                style={{
                  width: 70,
                  color:
                    l.status === 'SUCCESS'
                      ? 'var(--ok, #0a8)'
                      : l.status === 'FAILED'
                        ? 'var(--danger, #c33)'
                        : 'inherit',
                }}
              >
                {l.status}
              </strong>
              <span style={{ flex: 1 }}>
                {l.error
                  ? l.error
                  : `${t('teamsProvisioning.membersAdded', { added: l.membersAdded })}${
                      l.membersSkipped
                        ? t('teamsProvisioning.membersSkipped', { skipped: l.membersSkipped })
                        : ''
                    }`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CollabProvisionTiles;
