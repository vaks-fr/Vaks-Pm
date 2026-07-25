/**
 * Matrice d'événements notifiés aux sponsors d'un projet (`Project.sponsorNotify`,
 * JSON nullable). Sponsor = membre `ProjectMember.isSponsor` : audience de
 * communication en altitude — jamais du bruit tâche-par-tâche.
 *
 * Défauts (design validé 2026-07-18) : jalon atteint + statut projet ON,
 * jalon à risque + paliers budget OFF (opt-in par projet). Les paliers budget
 * sponsor sont toujours QUALITATIFS (palier franchi, jamais de montants).
 */
export interface SponsorNotifySettings {
  milestoneReached: boolean;
  projectStatus: boolean;
  milestoneAtRisk: boolean;
  budgetThresholds: boolean;
}

export const DEFAULT_SPONSOR_NOTIFY: SponsorNotifySettings = {
  milestoneReached: true,
  projectStatus: true,
  milestoneAtRisk: false,
  budgetThresholds: false,
};

/** Lit le JSON `Project.sponsorNotify` avec défauts (tolérant aux données historiques). */
export function readSponsorNotify(raw: unknown): SponsorNotifySettings {
  const out = { ...DEFAULT_SPONSOR_NOTIFY };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(out) as (keyof SponsorNotifySettings)[]) {
      if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
    }
  }
  return out;
}
