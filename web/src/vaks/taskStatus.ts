/* ============================================================
   Vaks — source unique de vérité des « status maps » de tâche.

   Une tâche a 8 statuts (`TaskStatus`). L'UI (boards, rapports, Gantt,
   PERT, dashboard) les REPLIE sur 5 colonnes canoniques. Historiquement
   6 fichiers redéfinissaient chacun leur propre table statut → {couleur/
   colonne/teinte/libellé} — dupliqué, divergent, et à risque d'écran
   blanc si un statut manquait à l'une d'elles. Ce module centralise le
   fold + les métadonnées visuelles. Cf. mémoire « agent statuses in
   status maps » / audit frontend 2026-08-02.

   Fold canonique (5 colonnes de board) :
     todo      ← TODO, CLAIMED
     progress  ← IN_PROGRESS, CHANGES_REQUESTED
     review    ← IN_REVIEW, APPROVED
     hold      ← ON_HOLD
     done      ← DONE
   ============================================================ */
import { TaskStatus, AGENT_STATUS_FOLD as SHARED_AGENT_FOLD, isAgentStatus } from '@vaks-pm/shared';

export { isAgentStatus };

/** Les 5 colonnes de board canoniques (base du fold). */
export type CanonicalStatus =
  | TaskStatus.TODO
  | TaskStatus.IN_PROGRESS
  | TaskStatus.IN_REVIEW
  | TaskStatus.ON_HOLD
  | TaskStatus.DONE;

/** Clé de colonne UI (attribut `data-status`, sous-clé i18n `tasks:status.*`). */
export type StatusColKey = 'todo' | 'progress' | 'review' | 'hold' | 'done';

/** Ordre d'affichage canonique (CFD, colonnes empilées des rapports). */
export const CANONICAL_ORDER: CanonicalStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.ON_HOLD,
  TaskStatus.DONE,
];

/** Statuts « agents » repliés sur leur colonne canonique. **Dérivé de la source
 *  de vérité partagée** (`@vaks-pm/shared`) pour ne jamais diverger du
 *  réalignement `boardColumnId` côté backend. CLAIMED→IN_PROGRESS,
 *  CHANGES_REQUESTED→IN_PROGRESS, APPROVED→IN_REVIEW. */
export const AGENT_STATUS_FOLD: Record<string, string> = SHARED_AGENT_FOLD as Record<string, string>;

export interface StatusMeta {
  /** Colonne de board canonique (cible du fold). */
  canonical: CanonicalStatus;
  /** Clé de colonne UI (`todo|progress|review|hold|done`). */
  colKey: StatusColKey;
  /** Teinte OKLCH (H) des barres Gantt / Timeline. */
  hue: number;
  /** Sous-clé i18n DISTINCTE par statut (camelCase), p.ex. `reports:status.<labelSubkey>`.
   *  Pour un libellé REPLIÉ, prendre celui de la base canonique :
   *  `STATUS_META[foldStatus(s)].labelSubkey`. */
  labelSubkey: string;
  /** Couleur d'accent distincte par statut (table « tâches sur la période » des Reports). */
  reportColor: string;
}

/** Table EXHAUSTIVE des 8 statuts. Typée `Record<TaskStatus,…>` : le compilateur
 *  REFUSE de builder si un statut manque (prévention d'écran blanc). */
export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  [TaskStatus.TODO]:               { canonical: TaskStatus.TODO,        colKey: 'todo',     hue: 250, labelSubkey: 'todo',             reportColor: 'var(--text-3)' },
  [TaskStatus.CLAIMED]:            { canonical: TaskStatus.IN_PROGRESS, colKey: 'progress', hue: 240, labelSubkey: 'claimed',          reportColor: 'var(--accent)' },
  [TaskStatus.IN_PROGRESS]:        { canonical: TaskStatus.IN_PROGRESS, colKey: 'progress', hue: 240, labelSubkey: 'inProgress',       reportColor: 'var(--accent)' },
  [TaskStatus.CHANGES_REQUESTED]:  { canonical: TaskStatus.IN_PROGRESS, colKey: 'progress', hue: 240, labelSubkey: 'changesRequested', reportColor: '#f97316' },
  [TaskStatus.IN_REVIEW]:          { canonical: TaskStatus.IN_REVIEW,   colKey: 'review',   hue: 90,  labelSubkey: 'inReview',         reportColor: 'var(--info)' },
  [TaskStatus.APPROVED]:           { canonical: TaskStatus.IN_REVIEW,   colKey: 'review',   hue: 90,  labelSubkey: 'approved',         reportColor: '#16a34a' },
  [TaskStatus.ON_HOLD]:            { canonical: TaskStatus.ON_HOLD,     colKey: 'hold',     hue: 300, labelSubkey: 'onHold',           reportColor: '#9333ea' },
  [TaskStatus.DONE]:               { canonical: TaskStatus.DONE,        colKey: 'done',     hue: 150, labelSubkey: 'done',             reportColor: '#16a34a' },
};

/** Fallback runtime défensif : un statut inconnu (nouveau statut backend non
 *  encore mappé) retombe sur « to do » au lieu de casser le rendu. */
export const STATUS_META_FALLBACK: StatusMeta = STATUS_META[TaskStatus.TODO];

/** Meta d'un statut, tolérante à un statut inconnu (fallback TODO). */
export function statusMeta(s: TaskStatus | string): StatusMeta {
  return STATUS_META[s as TaskStatus] ?? STATUS_META_FALLBACK;
}

/** Replie un statut sur sa base canonique (5 colonnes). */
export function foldStatus(s: TaskStatus | string): CanonicalStatus {
  return statusMeta(s).canonical;
}

/** Clé de colonne UI d'un statut (`todo|progress|review|hold|done`). */
export function statusColKey(s: TaskStatus | string): StatusColKey {
  return statusMeta(s).colKey;
}

/** Compteur d'une colonne canonique en **repliant** les statuts agents dessus —
 *  sinon les tâches d'agents (CLAIMED/CHANGES_REQUESTED/APPROVED) sont
 *  silencieusement omises des totaux de statut (audit frontend 2026-08-02). */
export function foldedStatusCount(counts: Record<string, number>, canonical: string): number {
  let total = counts[canonical] ?? 0;
  for (const [agentStatus, base] of Object.entries(AGENT_STATUS_FOLD)) {
    if (base === canonical) total += counts[agentStatus] ?? 0;
  }
  return total;
}
