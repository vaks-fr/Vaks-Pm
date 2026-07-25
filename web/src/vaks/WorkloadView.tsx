/* ============================================================
   Vaks — Workload / capacity view (Phase 5 — real API)
   People × days grid · capacity vs allocation · drag to reassign
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { AutoplanResultDto, WorkloadGridDto } from '@vaks-pm/shared';
import { type User } from './data';
import { Avatar, Icon } from './primitives';
import { startPointerDrag } from './dnd';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useFormat } from '../lib/format';
import { TimeOffManager } from './TimeOffManager';
import { useIsMobile } from './useIsMobile';
/* NB: les jours fériés sont désormais résolus côté API par utilisateur
 * (selon son `countryCode` ou le défaut org) — voir `WorkloadCellDto.isHoliday`. */

const LS_MODE = 'vaks.workload.mode';
const LS_ANCHOR = 'vaks.workload.anchor';
const LS_PRESERVE = 'vaks.workload.autoplanPreserve';
const LS_ASSIGNMODE = 'vaks.workload.autoplanAssignMode';

type PreserveMode = 'manual_autosplit' | 'manual' | 'none';
const PRESERVE_MODES: PreserveMode[] = ['none', 'manual_autosplit', 'manual'];
/** Mode d'affectation des tâches sans assigné lors de l'auto-plan. */
type AssignMode = 'off' | 'suggest' | 'auto';
const ASSIGN_MODES: AssignMode[] = ['off', 'suggest', 'auto'];

interface ToastInput {
  actor: User;
  text: string;
  warn?: boolean;
}

interface UndoOp {
  expiresAt: number;
  snapshot: NonNullable<import('@vaks-pm/shared').MoveAllocationDayResultDto['snapshot']>;
  createdIds: string[];
  description: string;
}

/** Déplacement d'allocation en attente de confirmation (overtime / jour non
 * ouvré). Stocké en state pour afficher une modale in-app plutôt que le
 * `window.confirm` natif du navigateur. */
interface PendingMove {
  allocId: string;
  fromUserId: string;
  fromDate: string;
  toUserId: string;
  toDate: string;
  hours: number;
  /** Libellé humain de la raison (weekend, férié, sick day, over capacity…). */
  reason: string;
  /** Capacité (h) du jour cible — affichée dans la modale. */
  capacity: number;
  dayName: string;
  /** true = la date cible est dans le passé (travail sûrement déjà commencé). */
  pastWarning?: boolean;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Calcule le premier jour de la semaine courante (00:00 UTC) selon le
 * paramètre org `weekStart`. Mon-first = lundi de la semaine, Sun-first =
 * dimanche précédent.
 */
function thisWeekStartUTC(weekStart: 'monday' | 'sunday', now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (weekStart === 'sunday') {
    d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // dim=0 → 0 jour à reculer
  } else {
    const dow = (d.getUTCDay() + 6) % 7; // lun=0..dim=6
    d.setUTCDate(d.getUTCDate() - dow);
  }
  return d;
}

/** Snap n'importe quelle date au début de sa semaine selon `weekStart`. */
function snapToWeekStartUTC(date: Date, weekStart: 'monday' | 'sunday'): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = weekStart === 'sunday' ? d.getUTCDay() : (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
}

/** Color band based on the load ratio (relative to capacity). */
function loadState(alloc: number, cap: number): string {
  if (cap === 0) return alloc > 0 ? 'over' : 'off';
  if (alloc === 0) return 'empty';
  const r = alloc / cap;
  if (r < 0.7) return 'free';
  if (r <= 1.001) return 'ok';
  if (r <= 1.15) return 'warn';
  return 'over';
}

function shortName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
/** Hash UUID → 0..359 hue (cohérent avec l'adapter Vaks). */
function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}
function asUser(u: { userId: string; name: string; email: string }): User {
  return {
    id: u.userId,
    name: u.name,
    short: shortName(u.name),
    initials: initials(u.name),
    role: 'Member',
    hue: hueFromId(u.userId),
    online: true,
  };
}

export function WorkloadView({
  monday,
  scope,
  teamId,
  projectId,
  projectStatus,
  pushToast,
  onOpen,
  refreshKey,
}: {
  monday: Date;
  /** ignored for now — was used for design-time visualization tweaks */
  viz: string;
  /** dropdown selection ('all' | teamId). Kept for debug visibility. */
  scope: string;
  /** when set, filters the workload aggregate to members of the team. */
  teamId?: string;
  /** Projet sélectionné dans le picker top-left, s'il y en a un. Utilisé
   *  pour scoper l'auto-plan : sans projet (vue cross-projets) → global ;
   *  avec projet → scope:'project' + projectId. */
  projectId?: string;
  /** Statut du projet sélectionné — l'auto-plan n'opère que sur un projet
   *  ACTIVE ; sinon on affiche une popup explicative au clic. */
  projectStatus?: string;
  pushToast: (t: ToastInput) => void;
  onOpen?: (taskId: string) => void;
  /** Bump from the parent to force a reload (e.g. when a task panel closes). */
  refreshKey?: number;
}) {
  void scope;
  const { t } = useTranslation('workload');
  const { orgSettings, isTeamLead } = useAuth();
  const weekStart = orgSettings.weekStart;
  const [grid, setGrid] = useState<WorkloadGridDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [planPreview, setPlanPreview] = useState<AutoplanResultDto | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // Ce que l'auto-plan préserve (le passé/aujourd'hui est toujours gelé en
  // plus). Persisté pour retrouver le choix du PM d'une session à l'autre.
  const [preserveMode, setPreserveMode] = useState<PreserveMode>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LS_PRESERVE) : null;
    return v === 'manual' || v === 'none' ? v : 'manual_autosplit';
  });
  useEffect(() => {
    try { window.localStorage.setItem(LS_PRESERVE, preserveMode); } catch { /* ignore */ }
  }, [preserveMode]);
  // Affectation assistée : `off` (ne touche pas aux assignations), `suggest`
  // (propose le meilleur candidat skill+capacité, swappable dans l'aperçu) ou
  // `auto` (affecte sans demander de swap). Persisté. `assignOverrides` = swaps
  // PM (taskId → userIds) appliqués au re-preview puis à l'apply.
  const [assignMode, setAssignMode] = useState<AssignMode>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LS_ASSIGNMODE) : null;
    return v === 'suggest' || v === 'auto' ? v : 'off';
  });
  useEffect(() => {
    try { window.localStorage.setItem(LS_ASSIGNMODE, assignMode); } catch { /* ignore */ }
  }, [assignMode]);
  const [assignOverrides, setAssignOverrides] = useState<Record<string, string[]>>({});
  // Popup de configuration de l'auto-plan (préservation + mode d'affectation).
  const [planConfigOpen, setPlanConfigOpen] = useState(false);
  // Popup « projet non actif » : l'auto-plan ne planifie que les projets ACTIVE
  // (cf. AutoplanService — filtre `project.status=ACTIVE`). Si on est scopé sur
  // un projet non actif (ex. en revue de charte), on l'explique au lieu de
  // lancer un plan qui ne proposerait rien.
  const [notActiveOpen, setNotActiveOpen] = useState(false);
  const projectNotActive = !!projectId && !!projectStatus && projectStatus !== 'ACTIVE';
  // Point d'entrée unique du bouton Auto-plan (desktop + mobile) : garde le cas
  // projet non actif, sinon ouvre la configuration.
  const openAutoplan = useCallback(() => {
    if (projectNotActive) setNotActiveOpen(true);
    else setPlanConfigOpen(true);
  }, [projectNotActive]);
  const [timeOffOpen, setTimeOffOpen] = useState(false);
  // (14) Sort + search local state.
  const [sortBy, setSortBy] = useState<'hours-desc' | 'name'>('hours-desc');
  const [search, setSearch] = useState('');
  // (15) Undo queue : la dernière opération de drag, undoable pendant 30s.
  const [undoOp, setUndoOp] = useState<UndoOp | null>(null);
  // Confirmation in-app d'un déplacement en heures supp (jour non ouvré /
  // surcharge). Remplace le `window.confirm` natif.
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  // Confirmation d'un déplacement vers un jour OUVRÉ mais PASSÉ (le travail a
  // sûrement déjà commencé). Distinct de pendingMove (qui gère l'overtime).
  const [pastMove, setPastMove] = useState<PendingMove | null>(null);
  const fmt = useFormat();
  // Bascule vers une mise en page téléphone (jour-par-jour, liste de personnes).
  const isMobile = useIsMobile();

  // Navigation calendrier : mode + ancre, persistés en localStorage.
  const [mode, setMode] = useState<'week' | 'month'>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LS_MODE) : null;
    return v === 'month' ? 'month' : 'week';
  });
  const [anchor, setAnchor] = useState<Date>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LS_ANCHOR) : null;
    if (v) {
      const d = new Date(v);
      if (!isNaN(+d)) return d;
    }
    // À défaut d'ancre persistée, on snape sur le début de la semaine courante
    // selon le paramètre org (Mon ou Sun). `monday` (prop) reste utilisé comme
    // base de fallback mais n'est plus la source de vérité.
    return thisWeekStartUTC(weekStart);
  });

  // Si le mode est 'week' et que l'ancre stockée ne tombe pas pile sur le bon
  // jour de début (changement du paramètre weekStart depuis le dernier visit),
  // on re-snape pour éviter d'afficher une semaine "désalignée".
  useEffect(() => {
    if (mode !== 'week') return;
    const expectedDow = weekStart === 'sunday' ? 0 : 1;
    if (anchor.getUTCDay() !== expectedDow) {
      setAnchor((cur) => snapToWeekStartUTC(cur, weekStart));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, mode]);

  useEffect(() => {
    try { window.localStorage.setItem(LS_MODE, mode); } catch { /* ignore */ }
  }, [mode]);
  useEffect(() => {
    try { window.localStorage.setItem(LS_ANCHOR, anchor.toISOString()); } catch { /* ignore */ }
  }, [anchor]);

  // Calcule la fenêtre [from,to] en fonction du mode + ancre.
  const { fromIso, toIso, periodLabel } = useMemo(() => {
    if (mode === 'week') {
      const start = new Date(anchor);
      const end = new Date(anchor);
      end.setUTCDate(end.getUTCDate() + 6);
      return {
        fromIso: start.toISOString().slice(0, 10),
        toIso: end.toISOString().slice(0, 10),
        periodLabel: fmt.range(start, end),
      };
    }
    // month: du 1er au dernier jour du mois UTC de l'ancre
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth();
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    return {
      fromIso: start.toISOString().slice(0, 10),
      toIso: end.toISOString().slice(0, 10),
      periodLabel: fmt.monthYear(start),
    };
  }, [mode, anchor, fmt]);

  function shiftPeriod(dir: -1 | 0 | 1) {
    if (dir === 0) {
      setAnchor(mode === 'week' ? thisWeekStartUTC(weekStart) : new Date(monday));
      return;
    }
    setAnchor((cur) => {
      const n = new Date(cur);
      if (mode === 'week') {
        n.setUTCDate(n.getUTCDate() + dir * 7);
      } else {
        n.setUTCMonth(n.getUTCMonth() + dir, 1);
      }
      return n;
    });
  }

  function switchMode(next: 'week' | 'month') {
    if (next === mode) return;
    // Quand on passe en mois, on snap au 1er du mois de l'ancre.
    // Quand on passe en semaine, on snap au lundi du 1er jour du mois courant.
    setAnchor((cur) => {
      if (next === 'month') {
        return new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1));
      }
      // Snape vers le début de la semaine courante (selon weekStart) à partir
      // du 1er du mois courant.
      const first = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1));
      return snapToWeekStartUTC(first, weekStart);
    });
    setMode(next);
  }

  // Sur une vraie navigation (changement de fenêtre ou de team), on vide la
  // grille pour montrer un loader. Sur un simple `reload()` post-drag, on
  // garde la grille affichée et on swap silencieusement les nouvelles
  // données — sinon la div `.wl-scroll` est démontée et le scrollLeft saute
  // tout à gauche pile au moment où l'user vient de déplacer une chip à
  // droite. C'est désagréable sur la vue mois.
  useEffect(() => {
    let cancelled = false;
    setGrid(null);
    setError(null);
    api
      .getWorkload({ from: fromIso, to: toIso, teamId })
      .then((d) => {
        if (!cancelled) setGrid(d);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [fromIso, toIso, teamId]);

  // Refresh background — déclenché par les mutations (drop, time-off
  // changes…). Pas de `setGrid(null)`, donc la grille reste rendue et le
  // scroll horizontal est préservé.
  useEffect(() => {
    if (refreshTick === 0) return;
    let cancelled = false;
    api
      .getWorkload({ from: fromIso, to: toIso, teamId })
      .then((d) => {
        if (!cancelled) setGrid(d);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // On dépend de refreshTick uniquement ; from/to/team sont stables pendant
    // un drag-drop et leur changement est déjà géré par l'effet précédent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  // External refresh trigger (e.g. parent bumps refreshKey when the task
  // detail panel closes — allocations may have been edited / deleted there).
  useEffect(() => {
    if (refreshKey === undefined || refreshKey === 0) return;
    setRefreshTick((n) => n + 1);
  }, [refreshKey]);

  const runAutoplan = useCallback(
    async (persist: boolean, ovArg?: Record<string, string[]>) => {
      setPlanLoading(true);
      setPlanError(null);
      try {
        const autoAssign = assignMode !== 'off';
        const ov = ovArg ?? assignOverrides;
        const overridesList =
          autoAssign && Object.keys(ov).length
            ? Object.entries(ov).map(([taskId, userIds]) => ({ taskId, userIds }))
            : undefined;
        // Scoping de l'auto-plan : on respecte le projet sélectionné dans
        // le picker top-left si présent — sinon vue cross-projets → global.
        // Sans ça, persist() supprimerait toutes les allocations auto des
        // tâches concernées même quand on est censé être sur un projet vide.
        //
        // On ne passe PLUS `from`/`to` : l'autoplan planifie tout le scope
        // (le backend borne à un horizon de 2 ans). La fenêtre semaine/mois
        // de la vue ne sert qu'à l'affichage de la grille — la planifier
        // dessus laissait tout le travail au-delà de la fenêtre non alloué.
        // En mode suggestion, on propose AUSSI les tâches déjà assignées (par
        // défaut sur leur assigné actuel) pour que le PM puisse en swapper
        // l'assigné. Indépendant du mode de préservation.
        const reassignAssigned = assignMode === 'suggest';
        const r = await api.autoplan({
          scope: projectId ? 'project' : 'global',
          projectId: projectId ?? undefined,
          preserve: preserveMode,
          persist,
          autoAssign: autoAssign || undefined,
          reassignAssigned: reassignAssigned || undefined,
          assignmentOverrides: overridesList,
        });
        if (persist) {
          setPlanPreview(null);
          setAssignOverrides({});
          pushToast({
            actor: asUser({ userId: '', name: 'System', email: '' }),
            text: t('view.autoplanApplied', {
              added: r.diff.added.length,
              removed: r.diff.removed.length,
              modified: r.diff.modified.length,
            }),
          });
          reload();
        } else {
          setPlanPreview(r);
        }
      } catch (e) {
        setPlanError((e as Error).message);
      } finally {
        setPlanLoading(false);
      }
    },
    [projectId, preserveMode, assignMode, assignOverrides, pushToast, reload, t],
  );

  // Lance un aperçu propre depuis la popup de config (réinitialise les swaps).
  const launchPreview = useCallback(() => {
    setAssignOverrides({});
    setPlanConfigOpen(false);
    void runAutoplan(false, {});
  }, [runAutoplan]);

  // Swap PM d'un assignee proposé → re-preview avec l'override (allocations
  // recalculées pour le nouveau choix).
  const swapAssignee = useCallback(
    (taskId: string, userId: string) => {
      const next = { ...assignOverrides, [taskId]: [userId] };
      setAssignOverrides(next);
      void runAutoplan(false, next);
    },
    [assignOverrides, runAutoplan],
  );

  const totals = useMemo(() => {
    if (!grid) return { allocated: 0, capacity: 0, over: 0, under: 0 };
    let alloc = 0,
      cap = 0,
      over = 0,
      under = 0;
    for (const r of grid.rows) {
      let rowA = 0,
        rowC = 0;
      let rowOver = false;
      for (const c of r.cells) {
        alloc += c.allocatedHours;
        cap += c.capacityHours;
        rowA += c.allocatedHours;
        rowC += c.capacityHours;
        if (c.capacityHours > 0 && c.allocatedHours > c.capacityHours) rowOver = true;
        if (c.capacityHours === 0 && c.allocatedHours > 0) rowOver = true;
      }
      if (rowOver) over++;
      else if (rowC > 0 && rowA / rowC < 0.6) under++;
    }
    return { allocated: alloc, capacity: cap, over, under };
  }, [grid]);

  // Exécute le déplacement atomique (split + create) côté serveur. Extrait
  // pour être appelable soit directement (jour ouvré), soit après
  // confirmation de la modale heures-supp (jour non ouvré / surcharge).
  const performMove = useCallback(
    (
      allocId: string,
      fromUserId: string,
      fromDate: string,
      toUid: string,
      toDate: string,
      hours: number,
      mode: 'overtime' | 'resplit' = 'overtime',
    ) => {
      api
        .moveAllocationDay(allocId, {
          fromDate,
          toDate,
          toUserId: toUid !== fromUserId ? toUid : undefined,
          mode,
        })
        .then((res) => {
          // No-op côté serveur (drop dans la propre plage de l'alloc) :
          // rien n'a bougé → pas de toast trompeur "re-assigned".
          if (!res.snapshot && res.created.length === 0) {
            reload();
            return;
          }
          const targetRow = grid!.rows.find((r) => r.userId === toUid);
          const actor = targetRow ? asUser(targetRow) : asUser(grid!.rows[0]);
          const dow = new Date(toDate + 'T00:00:00Z').getUTCDay();
          const dayName = WEEKDAY_LABELS[(dow + 6) % 7];
          pushToast({
            actor,
            text:
              mode === 'resplit'
                ? t('view.resplit', { hours, count: res.created.length })
                : t('view.reassigned', { hours, day: dayName }),
          });
          if (res.snapshot) {
            // Mémorise l'opération pour permettre un undo.
            setUndoOp({
              expiresAt: Date.now() + 30_000,
              snapshot: res.snapshot,
              createdIds: res.created.map((c) => c.id),
              description: t('view.moveDescription', { hours, day: dayName }),
            });
          }
          reload();
        })
        .catch((err) => {
          pushToast({
            actor: asUser({ userId: '', name: 'System', email: '' }),
            text: t('view.reassignFailed', { message: (err as Error).message }),
            warn: true,
          });
        });
    },
    [grid, pushToast, reload, t],
  );

  // Décision de déplacement (jour ouvré direct / overtime / passé), partagée
  // entre le drag-drop desktop et le tap-to-reassign mobile. Donné la cible
  // (user × date), ouvre la modale de confirmation adéquate ou exécute direct.
  const requestMove = useCallback(
    (allocId: string, fromUserId: string, fromDate: string, toUid: string, toDate: string, hours: number) => {
      if (toUid === fromUserId && toDate === fromDate) return;
      const targetCell = grid?.rows
        .find((r) => r.userId === toUid)
        ?.cells.find((c) => c.date === toDate);
      const cap = targetCell?.capacityHours ?? 0;
      const already = targetCell?.allocatedHours ?? 0;
      const nonWorking = cap <= 0;
      const overbook = cap > 0 && already + hours > cap + 1e-6;
      const dow = new Date(toDate + 'T00:00:00Z').getUTCDay();
      const dayName = WEEKDAY_LABELS[(dow + 6) % 7];
      const todayIso = new Date().toISOString().slice(0, 10);
      const isPast = toDate < todayIso;
      if (nonWorking || overbook) {
        const r1 = (n: number) => Math.round(n * 10) / 10;
        const reason = targetCell?.timeOffType
          ? t('view.reasonTimeOff', {
              type: t('timeOffType.' + targetCell.timeOffType, {
                defaultValue: targetCell.timeOffType,
              }).toLowerCase(),
            })
          : targetCell?.isHoliday
            ? targetCell.holidayName
              ? t('view.reasonHolidayNamed', { name: targetCell.holidayName })
              : t('view.reasonHoliday')
            : nonWorking
              ? t('view.reasonNonWorking', { day: dayName })
              : t('view.reasonOverCapacity', { booked: r1(already + hours), available: r1(cap) });
        setPendingMove({
          allocId, fromUserId, fromDate, toUserId: toUid, toDate, hours,
          reason, capacity: cap, dayName, pastWarning: isPast,
        });
        return;
      }
      if (isPast) {
        setPastMove({
          allocId, fromUserId, fromDate, toUserId: toUid, toDate, hours,
          reason: dayName, capacity: cap, dayName, pastWarning: true,
        });
        return;
      }
      performMove(allocId, fromUserId, fromDate, toUid, toDate, hours);
    },
    [grid, t, performMove],
  );

  function onChipDown(
    e: React.PointerEvent,
    allocId: string,
    fromUserId: string,
    fromDate: string,
    hours: number,
  ) {
    if (e.button != null && e.button !== 0) return;
    const sourceEl = e.currentTarget as HTMLElement;
    setDragId(allocId);
    startPointerDrag({
      startEvent: e.nativeEvent,
      sourceEl,
      ghostScale: 1.04,
      onMove: ({ under }) => {
        const cell = under && (under.closest('[data-cell]') as HTMLElement | null);
        setHover(cell ? cell.getAttribute('data-cell') : null);
      },
      onDrop: ({ under }) => {
        const cell = under && (under.closest('[data-cell]') as HTMLElement | null);
        setDragId(null);
        setHover(null);
        if (!cell) return;
        const [toUid, toDate] = cell.getAttribute('data-cell')!.split('|');
        // La décision overtime / passé / direct est centralisée dans requestMove.
        requestMove(allocId, fromUserId, fromDate, toUid, toDate, hours);
      },
    });
  }

  // (15) Undo : restore source à son snapshot + delete les allocs créées.
  // Effectue les opérations en parallèle ; en cas d'erreur partielle on
  // log et reload pour que l'UI reflète la réalité serveur.
  const undo = useCallback(async () => {
    if (!undoOp) return;
    const op = undoOp;
    setUndoOp(null);
    try {
      const ops: Promise<unknown>[] = [];
      for (const id of op.createdIds) ops.push(api.deleteAllocation(id));
      ops.push(
        api.updateAllocation(op.snapshot.sourceId, {
          startDate: op.snapshot.startDate,
          endDate: op.snapshot.endDate,
          userId: op.snapshot.userId,
          hoursPerDay: op.snapshot.hoursPerDay,
          notes: op.snapshot.notes,
        }),
      );
      await Promise.all(ops);
      pushToast({
        actor: asUser({ userId: '', name: 'System', email: '' }),
        text: t('view.undone'),
      });
    } catch (err) {
      pushToast({
        actor: asUser({ userId: '', name: 'System', email: '' }),
        text: t('view.undoFailed', { message: (err as Error).message }),
        warn: true,
      });
    } finally {
      reload();
    }
  }, [undoOp, pushToast, reload, t]);

  // Expire automatiquement l'undo après 30s.
  useEffect(() => {
    if (!undoOp) return;
    const t = window.setTimeout(() => setUndoOp(null), Math.max(0, undoOp.expiresAt - Date.now()));
    return () => window.clearTimeout(t);
  }, [undoOp]);

  // (14) Filtre + tri. La recherche filtre AUSSI les chips dans chaque
  // cellule (pas juste les lignes) — sinon on cherche "toto" et la ligne
  // affiche en plus toutes les autres tâches de ce user.
  const visibleRows = useMemo(() => {
    if (!grid) return [];
    const q = search.trim().toLowerCase();
    const matches = (text: string) => text.toLowerCase().includes(q);
    const matchAlloc = (a: { taskTitle?: string; projectKey?: string; projectName?: string }) =>
      matches(a.taskTitle ?? '') ||
      matches(a.projectKey ?? '') ||
      matches(a.projectName ?? '');

    let rows: typeof grid.rows = grid.rows.slice();

    if (q) {
      const filtered: typeof rows = [];
      for (const r of rows) {
        const userMatches = matches(r.name) || matches(r.email);
        if (userMatches) {
          // User matched → on garde toute sa ligne intacte.
          filtered.push(r);
          continue;
        }
        // Sinon : on filtre les allocations par cellule. Une cellule sans
        // alloc matchée se retrouve avec `allocations: []` et
        // `allocatedHours` mis à 0 pour ne pas afficher d'overflow trompeur.
        const cells = r.cells.map((c) => {
          const kept = c.allocations.filter(matchAlloc);
          if (kept.length === c.allocations.length) return c;
          const allocatedHours = kept.reduce((s, a) => s + a.hours, 0);
          return { ...c, allocations: kept, allocatedHours };
        });
        if (cells.some((c) => c.allocations.length > 0)) {
          filtered.push({ ...r, cells });
        }
      }
      rows = filtered;
    }
    if (sortBy === 'hours-desc') {
      rows.sort((a, b) => {
        const sa = a.cells.reduce((s, c) => s + c.allocatedHours, 0);
        const sb = b.cells.reduce((s, c) => s + c.allocatedHours, 0);
        return sb - sa;
      });
    } else {
      rows.sort((a, b) => a.name.localeCompare(b.name));
    }
    return rows;
  }, [grid, search, sortBy]);

  if (error) {
    return (
      <div className="placeholder">
        <div className="ph-icon">
          <Icon name="gauge" size={30} />
        </div>
        <h2 className="ph-title">{t('view.unavailable')}</h2>
        <p className="ph-sub">{error}</p>
      </div>
    );
  }
  if (!grid) {
    return (
      <div style={{ padding: 24, opacity: 0.7, fontSize: 13 }}>
        {t('view.loading')}
      </div>
    );
  }

  // Modales partagées desktop ↔ mobile (rendues hors de la branche de layout).
  const modals = (
    <>
      {notActiveOpen && (
        <ProjectNotActiveModal
          status={projectStatus}
          onClose={() => setNotActiveOpen(false)}
        />
      )}
      {planConfigOpen && (
        <AutoplanConfigModal
          scopeIsProject={!!projectId}
          preserve={preserveMode}
          setPreserve={setPreserveMode}
          assignMode={assignMode}
          setAssignMode={setAssignMode}
          onRun={launchPreview}
          onClose={() => setPlanConfigOpen(false)}
          loading={planLoading}
        />
      )}
      {planPreview && (
        <AutoplanPreviewModal
          result={planPreview}
          viewFrom={fromIso}
          viewTo={toIso}
          onClose={() => setPlanPreview(null)}
          onApply={() => runAutoplan(true)}
          onSwap={swapAssignee}
          swappable={assignMode === 'suggest'}
          loading={planLoading}
        />
      )}
      {pendingMove && (
        <OvertimeConfirmModal
          move={pendingMove}
          onCancel={() => setPendingMove(null)}
          onConfirm={() => {
            const m = pendingMove;
            setPendingMove(null);
            performMove(m.allocId, m.fromUserId, m.fromDate, m.toUserId, m.toDate, m.hours, 'overtime');
          }}
          onResplit={() => {
            const m = pendingMove;
            setPendingMove(null);
            performMove(m.allocId, m.fromUserId, m.fromDate, m.toUserId, m.toDate, m.hours, 'resplit');
          }}
        />
      )}
      {pastMove && (
        <PastMoveConfirmModal
          move={pastMove}
          fmtDate={(iso) => fmt.dayMonthYear(new Date(iso + 'T00:00:00Z'))}
          onCancel={() => setPastMove(null)}
          onConfirm={() => {
            const m = pastMove;
            setPastMove(null);
            performMove(m.allocId, m.fromUserId, m.fromDate, m.toUserId, m.toDate, m.hours);
          }}
        />
      )}
      <TimeOffManager
        open={timeOffOpen}
        onClose={() => setTimeOffOpen(false)}
        onChanged={() => setRefreshTick((n) => n + 1)}
      />
    </>
  );

  // ---- Mise en page TÉLÉPHONE : la grille people×days ne tient pas en
  //      portrait. On réutilise les données + requestMove + les modales et on
  //      ne remplace que le rendu par une liste de personnes jour-par-jour. ----
  if (isMobile) {
    return (
      <>
        <WorkloadMobile
          grid={grid}
          rows={visibleRows}
          totals={totals}
          periodLabel={periodLabel}
          today={new Date().toISOString().slice(0, 10)}
          search={search}
          setSearch={setSearch}
          sortBy={sortBy}
          setSortBy={setSortBy}
          requestMove={requestMove}
          onOpen={onOpen}
          isTeamLead={isTeamLead}
          planLoading={planLoading}
          onAutoplan={openAutoplan}
          onTimeOff={() => setTimeOffOpen(true)}
          shiftPeriod={shiftPeriod}
        />
        {modals}
      </>
    );
  }

  return (
    <div className="wl-wrap">
      {/* Toolbar : navigation calendrier + auto-plan */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: '10px 18px',
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <div className="seg">
          {(['week', 'month'] as const).map((m) => (
            <button
              key={m}
              className={'seg-btn' + (mode === m ? ' seg-on' : '')}
              onClick={() => switchMode(m)}
            >
              {m === 'week' ? t('view.mode.week') : t('view.mode.month')}
            </button>
          ))}
        </div>
        <div className="row gap1">
          <button
            className="icon-btn"
            onClick={() => shiftPeriod(-1)}
            title={mode === 'week' ? t('view.nav.prevWeek') : t('view.nav.prevMonth')}
          >
            <Icon name="chevR" size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button
            className="btn"
            onClick={() => shiftPeriod(0)}
            title={t('view.nav.backToToday')}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            {t('view.nav.today')}
          </button>
          <button
            className="icon-btn"
            onClick={() => shiftPeriod(1)}
            title={mode === 'week' ? t('view.nav.nextWeek') : t('view.nav.nextMonth')}
          >
            <Icon name="chevR" size={14} />
          </button>
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {periodLabel}
        </span>
        <div style={{ flex: 1 }} />
        {(
          [
            ['CSV', 'csv', 'workload.csv', t('view.export.csvTitle')],
            ['XLSX', 'xlsx', 'workload.xlsx', t('view.export.xlsxTitle')],
            ['PDF', 'pdf', 'workload.pdf', t('view.export.pdfTitle')],
          ] as [string, string, string, string][]
        ).map(([label, ext, file, title]) => (
          <button
            key={ext}
            className="btn btn-sm btn-line"
            title={title}
            onClick={() =>
              api
                .downloadCsv(
                  `/${file}?from=${fromIso}&to=${toIso}${teamId ? `&teamId=${teamId}` : ''}`,
                  file,
                )
                .catch((e) => setError((e as Error).message))
            }
          >
            <Icon name="download" size={13} /> {label}
          </button>
        ))}
        {/* (14) Search + sort */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('view.searchPlaceholder')}
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 12,
            width: 240,
          }}
        />
        <button
          className="btn"
          onClick={() => setSortBy((s) => (s === 'hours-desc' ? 'name' : 'hours-desc'))}
          title={
            sortBy === 'hours-desc'
              ? t('view.sort.byLoadTitle')
              : t('view.sort.byNameTitle')
          }
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          <Icon name={sortBy === 'hours-desc' ? 'gauge' : 'list'} size={14} />
          <span style={{ marginLeft: 6 }}>
            {sortBy === 'hours-desc' ? t('view.sort.byLoad') : t('view.sort.byName')}
          </span>
        </button>
        {/* Gestion des congés réservée aux team leads / admins : un membre
            ne peut pas se rajouter de time off lui-même. */}
        {isTeamLead && (
          <button
            className="btn"
            onClick={() => setTimeOffOpen(true)}
            title={t('view.timeOffButtonTitle')}
          >
            <Icon name="cal" size={14} />
            <span style={{ marginLeft: 6 }}>{t('view.timeOffButton')}</span>
          </button>
        )}
        <button
          className="btn btn-primary"
          disabled={planLoading}
          onClick={openAutoplan}
          title={
            projectId
              ? t('view.autoplanProjectTitle')
              : t('view.autoplanGlobalTitle')
          }
          style={{ fontSize: 12, padding: '4px 12px' }}
        >
          <Icon name="gauge" size={14} />
          <span style={{ marginLeft: 6 }}>
            {planLoading ? t('view.computing') : t('view.autoplanButton')}
          </span>
        </button>
        {planError && (
          <span style={{ fontSize: 12, color: 'oklch(0.75 0.18 25)' }}>
            {planError}
          </span>
        )}
      </div>

      {/* (15) Undo banner pour le dernier drag — visible 30s. */}
      {undoOp && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 18px',
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border)',
            fontSize: 13,
          }}
        >
          <Icon name="refresh" size={14} />
          <span>{undoOp.description}</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn"
            onClick={undo}
            style={{ fontSize: 12, padding: '4px 12px' }}
          >
            {t('common:cancel')}
          </button>
          <button
            className="icon-btn"
            onClick={() => setUndoOp(null)}
            title={t('view.hide')}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {modals}

      {/* Top banner: overload count + helper text */}
      {(totals.over > 0 || totals.under > 0) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '12px 18px',
            flexWrap: 'wrap',
          }}
        >
          {totals.over > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 14px',
                borderRadius: 999,
                background: 'oklch(from oklch(0.65 0.18 25) l c h / 0.16)',
                color: 'oklch(0.75 0.18 25)',
                border: '1px solid oklch(from oklch(0.65 0.18 25) l c h / 0.4)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <Icon name="warn" size={14} />
              {t('view.overloaded', { count: totals.over })}
            </span>
          )}
          <span
            style={{
              fontSize: 13,
              color: 'var(--text-3)',
            }}
          >
            {t('view.rebalanceHint')}
          </span>
          <div style={{ flex: 1 }} />
          <span
            className="mono"
            style={{ fontSize: 12, color: 'var(--text-3)' }}
          >
            {Math.round(totals.allocated)}h / {Math.round(totals.capacity)}h
          </span>
          <button className="icon-btn" onClick={reload} title={t('view.refresh')}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
      )}

      <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border)' }}>
      <div
        className="wl-grid"
        data-viz="heatmap"
        data-mode={mode}
        style={{
          display: 'grid',
          gridTemplateColumns:
            mode === 'month'
              ? `220px repeat(${grid.days.length}, 110px)`
              : `220px repeat(${grid.days.length}, minmax(140px, 1fr))`,
          gridAutoRows: 'minmax(78px, max-content)',
          alignItems: 'stretch',
        }}
      >
        {/* header */}
        <div
          className="wl-corner"
          style={{
            position: 'sticky',
            top: 0,
            left: 0,
            zIndex: 4,
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            borderRight: '1px solid var(--border)',
            fontSize: 11,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 700,
            background: 'var(--surface-2)',
          }}
        >
          {t('view.teamMember')}
        </div>
        {grid.days.map((d, dayIdx) => {
          const dt = new Date(d.date + 'T00:00:00Z');
          // Le jour est marqué férié dans l'en-tête uniquement s'il l'est pour
          // *tout le monde* (sinon ça ne reflète plus la réalité multi-pays).
          // Un nom existe si au moins un user a un libellé — pratique en tooltip.
          const cellsForDay = grid.rows.map((r) => r.cells[dayIdx]).filter(Boolean);
          const allHoliday = cellsForDay.length > 0 && cellsForDay.every((c) => c?.isHoliday);
          const holidayName = cellsForDay.find((c) => c?.holidayName)?.holidayName || null;
          const closed = grid.rows.length > 0 && cellsForDay.every((c) => c?.capacityHours === 0 && !c?.isHoliday);
          const bg = allHoliday
            ? 'oklch(from oklch(0.65 0.18 25) l c h / 0.10)'
            : closed
              ? 'var(--surface-2)'
              : undefined;
          return (
            <div
              key={d.date}
              className={'wl-dayhead' + (allHoliday ? ' is-holiday' : '') + (closed ? ' is-closed' : '')}
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                padding: '12px 12px',
                borderBottom: '1px solid var(--border)',
                fontSize: 13,
                color: 'var(--text)',
                fontWeight: 600,
                background: bg ?? 'var(--surface)',
              }}
              title={allHoliday ? (holidayName || t('view.holiday')) : closed ? t('view.closedDay') : undefined}
            >
              <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                {WEEKDAY_LABELS[d.weekday]}
                {allHoliday && <Icon name="flag" size={10} style={{ color: 'oklch(0.78 0.18 25)' }} />}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginTop: 2,
                }}
              >
                {fmt.dayMonth(dt).toUpperCase()}
              </div>
            </div>
          );
        })}

        {/* rows */}
        {visibleRows.length === 0 && (
          <div
            style={{
              gridColumn: `1 / span ${grid.days.length + 1}`,
              padding: 40,
              textAlign: 'center',
              color: 'var(--text-3)',
              fontSize: 13,
            }}
          >
            {t('view.noMemberScope')}
          </div>
        )}
        {visibleRows.map((r) => {
          const u = asUser(r);
          return (
            <React.Fragment key={r.userId}>
              <div
                className="wl-user"
                style={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 1,
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--border)',
                  borderRight: '1px solid var(--border)',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  background: 'var(--surface-2)',
                }}
              >
                <Avatar user={u} size={36} title={false} />
                <div style={{ minWidth: 0 }}>
                  <div
                    className="truncate"
                    style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2 }}
                  >
                    {r.name}
                  </div>
                  <div
                    className="truncate"
                    style={{ fontSize: 12, color: 'var(--text-3)' }}
                  >
                    {r.email}
                  </div>
                </div>
              </div>
              {r.cells.map((c) => {
                const state = loadState(c.allocatedHours, c.capacityHours);
                const cellKey = `${r.userId}|${c.date}`;
                const isHover = hover === cellKey;
                const isOff = c.timeOffType != null;
                const isHoliday = !!c.isHoliday;
                const isClosed = !isOff && !isHoliday && c.capacityHours === 0;
                const tint = isHoliday
                  ? { background: 'var(--holiday-bg)' }
                  : isClosed
                    ? { background:
                        'repeating-linear-gradient(135deg, var(--weekend-stripe) 0 6px, var(--weekend-bg) 6px 12px)' }
                    : undefined;
                // Chips d'allocations — rendus aussi bien sur les jours ouvrés
                // que sur les jours non ouvrés (overtime : weekend, férié,
                // SICK/PTO), sinon une alloc posée sur un jour off devient
                // invisible et impossible à re-déplacer.
                const chips = c.allocations.map((a) => {
                  // Couleur effective héritée du groupe parent
                  // (si la tâche appartient à un groupe coloré).
                  const groupColor = a.color ?? null;
                  const chipStyle: React.CSSProperties = groupColor
                    ? {
                        borderLeftColor: groupColor,
                        borderLeftWidth: 4,
                        background: `color-mix(in oklch, ${groupColor} 10%, var(--surface))`,
                      }
                    : {};
                  const projLabel = a.projectName ?? a.projectKey;
                  return (
                    <div
                      key={a.allocationId}
                      data-block={a.allocationId}
                      className={'wl-chip wl-chip-rich' + (dragId === a.allocationId ? ' wl-chip-dim' : '')}
                      style={chipStyle}
                      onPointerDown={(e) =>
                        onChipDown(e, a.allocationId, r.userId, c.date, a.hours)
                      }
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onOpen?.(a.taskId);
                      }}
                      title={t('view.chipTitle', { project: projLabel, task: a.taskTitle, hours: a.hours })}
                    >
                      <span className="wl-chip-h mono">{a.hours}h</span>
                      <span className="wl-chip-body">
                        <span
                          className="wl-chip-proj truncate mono"
                          style={groupColor ? { color: groupColor } : undefined}
                        >
                          {projLabel}
                        </span>
                        <span className="wl-chip-t truncate">{a.taskTitle}</span>
                      </span>
                    </div>
                  );
                });
                return (
                  <div
                    key={c.date}
                    data-cell={cellKey}
                    className={
                      'wl-cell cell-' +
                      state +
                      (isHover ? ' wl-cell-hover' : '') +
                      (isHoliday ? ' is-holiday' : '') +
                      (isClosed ? ' is-closed' : '')
                    }
                    style={tint}
                    title={
                      isOff
                        ? t('view.timeOffTooltip', {
                            type: t('timeOffType.' + c.timeOffType, {
                              defaultValue: c.timeOffType ?? '',
                            }),
                          })
                        : isHoliday
                          ? t('view.holidayNamedTooltip', { name: c.holidayName ?? t('view.holiday') })
                          : isClosed
                            ? t('view.closedDay')
                            : t('view.capacityTooltip', {
                                allocated: c.allocatedHours,
                                capacity: c.capacityHours,
                              })
                    }
                  >
                    {isOff ? (
                      <>
                        <div className="wl-off">
                          {c.timeOffType === 'VACATION'
                            ? t('view.off.pto')
                            : c.timeOffType === 'SICK'
                              ? t('view.off.sick')
                              : c.timeOffType === 'PARENTAL'
                                ? t('view.off.parental')
                                : c.timeOffType === 'PERSONAL'
                                  ? t('view.off.personal')
                                  : t('view.off.generic')}
                        </div>
                        {/* Overtime posé sur un jour d'absence : on l'affiche
                            sous le badge OFF (sinon l'alloc disparaît). */}
                        {chips.length > 0 && <div className="wl-chips wl-chips-off">{chips}</div>}
                      </>
                    ) : (
                      <>
                        <div className="wl-cell-top mono">
                          <span className="wl-num">{c.allocatedHours}</span>
                          <span className="wl-cap">/{c.capacityHours}h</span>
                          {state === 'over' && (
                            <Icon
                              name="warn"
                              size={12}
                              style={{
                                color: 'var(--c-over, oklch(0.78 0.18 25))',
                                marginLeft: 6,
                                verticalAlign: -1,
                              }}
                            />
                          )}
                        </div>
                        <div className="wl-chips">{chips}</div>
                      </>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
      </div>
    </div>
  );
}

// ============================================================
// Auto-plan preview modal
// ============================================================

type ChangeKind = 'added' | 'removed' | 'modified';

interface UserChangeRow {
  userId: string;
  userName: string;
  added: import('@vaks-pm/shared').ProposedAllocationDto[];
  removed: import('@vaks-pm/shared').EnrichedAllocationDto[];
  modified: { before: import('@vaks-pm/shared').EnrichedAllocationDto; after: import('@vaks-pm/shared').ProposedAllocationDto }[];
  hoursDelta: number;
}

function fmtDateRange(start: string, end: string): string {
  if (start === end) return start;
  return `${start} → ${end}`;
}

function dayCount(start: string, end: string): number {
  const a = +new Date(start + 'T00:00:00Z');
  const b = +new Date(end + 'T00:00:00Z');
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

function totalHours(start: string, end: string, hoursPerDay: number): number {
  return Math.round(dayCount(start, end) * hoursPerDay * 10) / 10;
}

const KIND_STYLES: Record<ChangeKind, { bg: string; fg: string; sign: string }> = {
  added:    { bg: 'oklch(from oklch(0.7  0.18 145) l c h / 0.16)', fg: 'oklch(0.78 0.18 145)', sign: '+' },
  removed:  { bg: 'oklch(from oklch(0.65 0.18 25)  l c h / 0.16)', fg: 'oklch(0.78 0.18 25)',  sign: '−' },
  modified: { bg: 'oklch(from oklch(0.75 0.18 85)  l c h / 0.16)', fg: 'oklch(0.85 0.18 85)',  sign: '~' },
};

function KindChip({ kind, count }: { kind: ChangeKind; count: number }) {
  const { t } = useTranslation('workload');
  const s = KIND_STYLES[kind];
  const label = t('kind.' + kind);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <span className="mono">{s.sign}{count}</span>
      <span>{label}</span>
    </span>
  );
}

function ChangeLine({
  kind,
  taskTitle,
  projectKey,
  rangeBefore,
  rangeAfter,
  hoursBefore,
  hoursAfter,
}: {
  kind: ChangeKind;
  taskTitle: string;
  projectKey?: string;
  rangeBefore?: string;
  rangeAfter?: string;
  hoursBefore?: number;
  hoursAfter?: number;
}) {
  const { t } = useTranslation('workload');
  const s = KIND_STYLES[kind];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '14px 1fr auto',
        gap: 10,
        padding: '8px 12px',
        borderTop: '1px solid var(--border)',
        fontSize: 13,
        alignItems: 'center',
      }}
    >
      <span
        title={t('kind.' + kind)}
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: s.fg,
          display: 'inline-block',
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div className="truncate" style={{ fontWeight: 500 }}>
          {projectKey && (
            <span
              className="mono"
              style={{
                fontSize: 10,
                padding: '1px 5px',
                marginRight: 6,
                borderRadius: 3,
                background: 'var(--bg-2, rgba(255,255,255,0.06))',
                color: 'var(--text-3)',
              }}
            >
              {projectKey}
            </span>
          )}
          {taskTitle}
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
          {kind === 'modified' && rangeBefore !== rangeAfter ? (
            <>
              <s>{rangeBefore}</s> <span style={{ opacity: 0.6 }}>→</span> {rangeAfter}
            </>
          ) : (
            rangeAfter ?? rangeBefore
          )}
        </div>
      </div>
      <div className="mono" style={{ textAlign: 'right', fontSize: 12, whiteSpace: 'nowrap' }}>
        {kind === 'modified' && hoursBefore !== hoursAfter ? (
          <>
            <s style={{ color: 'var(--text-3)' }}>{hoursBefore}h/d</s>{' '}
            <span style={{ color: s.fg, fontWeight: 600 }}>{hoursAfter}h/d</span>
          </>
        ) : (
          <span style={{ color: s.fg, fontWeight: 600 }}>{hoursAfter ?? hoursBefore}h/d</span>
        )}
      </div>
    </div>
  );
}

/**
 * Confirmation in-app d'un déplacement d'allocation en heures supplémentaires
 * (dépôt sur un jour non ouvré : weekend, férié, SICK/PTO — ou sur un jour déjà
 * saturé). Remplace le `window.confirm` natif du navigateur.
 */
function OvertimeConfirmModal({
  move,
  onConfirm,
  onResplit,
  onCancel,
}: {
  move: PendingMove;
  onConfirm: () => void;
  onResplit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('workload');
  // Ferme sur Échap, confirme l'overtime sur Entrée.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  const r1 = (n: number) => Math.round(n * 10) / 10;
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(440px, 96vw)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Icon
            name="warn"
            size={18}
            style={{ color: 'var(--c-over, oklch(0.78 0.18 25))' }}
          />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{t('overtimeModal.title')}</h2>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 20px', fontSize: 14, lineHeight: 1.5 }}>
          {move.pastWarning && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                marginBottom: 12,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'oklch(0.95 0.05 60)',
                color: 'oklch(0.45 0.12 60)',
                fontSize: 13,
              }}
            >
              <Icon name="warn" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>
                <Trans i18nKey="overtimeModal.pastWarning" ns="workload" components={[<strong key="0" />]} />
              </span>
            </div>
          )}
          <p style={{ margin: 0 }}>
            <Trans
              i18nKey="overtimeModal.booking"
              ns="workload"
              values={{ hours: move.hours, reason: move.reason, capacity: r1(move.capacity) }}
              components={[<strong key="0" />, <strong key="1" />, <strong key="2" />]}
            />
          </p>
          <p style={{ margin: '10px 0 0', color: 'var(--text-3)', fontSize: 13 }}>
            {t('overtimeModal.chooseHandling')}
          </p>
          <ul
            style={{
              margin: '6px 0 0',
              paddingLeft: 18,
              color: 'var(--text-3)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <li>
              <strong style={{ color: 'var(--text)' }}>{t('overtimeModal.bookOvertimeLabel')}</strong>
              {' '}— {t('overtimeModal.bookOvertimeDesc', { hours: move.hours })}
            </li>
            <li>
              <strong style={{ color: 'var(--text)' }}>{t('overtimeModal.resplitLabel')}</strong>
              {' '}— {t('overtimeModal.resplitDesc', { hours: move.hours })}
            </li>
          </ul>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            flexWrap: 'wrap',
          }}
        >
          <button className="btn" onClick={onCancel} style={{ padding: '6px 14px' }}>
            {t('common:cancel')}
          </button>
          <button className="btn" onClick={onResplit} style={{ padding: '6px 14px' }}>
            {t('overtimeModal.resplitButton')}
          </button>
          <button
            className="btn btn-primary"
            onClick={onConfirm}
            autoFocus
            style={{ padding: '6px 14px' }}
          >
            {t('overtimeModal.bookOvertimeButton')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmation d'un déplacement d'allocation vers un jour OUVRÉ mais situé dans
 * le PASSÉ. Une date passée signifie que le travail a très probablement déjà
 * démarré / été réalisé — on demande une confirmation explicite avant d'écrire.
 */
function PastMoveConfirmModal({
  move,
  fmtDate,
  onConfirm,
  onCancel,
}: {
  move: PendingMove;
  fmtDate: (iso: string) => string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('workload');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(440px, 96vw)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Icon name="warn" size={18} style={{ color: 'oklch(0.7 0.16 60)' }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{t('pastMoveModal.title')}</h2>
        </div>

        <div style={{ padding: '16px 20px', fontSize: 14, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            <Trans
              i18nKey="pastMoveModal.body"
              ns="workload"
              values={{ hours: move.hours, date: fmtDate(move.toDate), day: move.dayName }}
              components={[<strong key="0" />, <strong key="1" />, <strong key="2" />]}
            />
          </p>
          <p style={{ margin: '10px 0 0', color: 'var(--text-3)', fontSize: 13 }}>
            {t('pastMoveModal.explanation')}
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="btn" onClick={onCancel} style={{ padding: '6px 14px' }}>
            {t('common:cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={onConfirm}
            autoFocus
            style={{ padding: '6px 14px' }}
          >
            {t('pastMoveModal.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Popup affichée quand on lance l'auto-plan sur un projet NON actif. L'auto-plan
// ne planifie que les projets ACTIVE (filtre serveur) : sans cette garde, il ne
// proposerait rien sans aucune explication. On informe l'utilisateur de la cause
// et de l'action à mener (activer le projet).
function ProjectNotActiveModal({
  status,
  onClose,
}: {
  status?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('workload');
  const { t: tp } = useTranslation('projects');
  const statusLabel = status ? tp('status.' + status, status) : '';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(460px, 96vw)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Icon name="warn" size={18} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {t('notActive.title')}
          </h2>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title={t('common:close')}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>
          {t('notActive.body', { status: statusLabel })}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}
        >
          <button className="btn btn-primary" onClick={onClose}>
            {t('notActive.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Popup de configuration de l'auto-plan : choix de la préservation + du mode
// d'affectation, avant de lancer l'aperçu. Remplace les 3 contrôles de barre.
function AutoplanConfigModal({
  scopeIsProject,
  preserve,
  setPreserve,
  assignMode,
  setAssignMode,
  onRun,
  onClose,
  loading,
}: {
  scopeIsProject: boolean;
  preserve: PreserveMode;
  setPreserve: (m: PreserveMode) => void;
  assignMode: AssignMode;
  setAssignMode: (m: AssignMode) => void;
  onRun: () => void;
  onClose: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation('workload');

  const Option = <T extends string>(props: {
    name: string;
    value: T;
    current: T;
    onPick: (v: T) => void;
    label: string;
    desc: string;
  }) => {
    const active = props.current === props.value;
    return (
      <label
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          padding: '10px 12px',
          border: `1px solid ${active ? 'oklch(0.7 0.15 250)' : 'var(--border)'}`,
          background: active ? 'oklch(from oklch(0.7 0.15 250) l c h / 0.08)' : 'transparent',
          borderRadius: 8,
          cursor: 'pointer',
        }}
      >
        <input
          type="radio"
          name={props.name}
          checked={active}
          onChange={() => props.onPick(props.value)}
          style={{ marginTop: 2 }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{props.label}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{props.desc}</div>
        </div>
      </label>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(560px, 96vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Icon name="gauge" size={18} />
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{t('config.title')}</h2>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              {scopeIsProject ? t('config.scopeProject') : t('config.scopeGlobal')}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title={t('common:close')}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', display: 'grid', gap: 18 }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                color: 'var(--text-3)',
              }}
            >
              {t('config.preserveLabel')}
            </div>
            {PRESERVE_MODES.map((m) => (
              <Option
                key={m}
                name="autoplan-preserve"
                value={m}
                current={preserve}
                onPick={setPreserve}
                label={t('preserve.' + m)}
                desc={t('config.preserveDesc.' + m)}
              />
            ))}
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                color: 'var(--text-3)',
              }}
            >
              {t('config.assignLabel')}
            </div>
            {ASSIGN_MODES.map((m) => (
              <Option
                key={m}
                name="autoplan-assign"
                value={m}
                current={assignMode}
                onPick={setAssignMode}
                label={t('config.assign.' + m)}
                desc={t('config.assignDesc.' + m)}
              />
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}
        >
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={loading}>
            {t('common:cancel')}
          </button>
          <button className="btn btn-primary" onClick={onRun} disabled={loading}>
            <Icon name="gauge" size={14} />
            <span style={{ marginLeft: 6 }}>
              {loading ? t('view.computing') : t('config.run')}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function AutoplanPreviewModal({
  result,
  viewFrom,
  viewTo,
  onClose,
  onApply,
  onSwap,
  swappable,
  loading,
}: {
  result: AutoplanResultDto;
  viewFrom: string;
  viewTo: string;
  onClose: () => void;
  onApply: () => void;
  onSwap?: (taskId: string, userId: string) => void;
  swappable?: boolean;
  loading: boolean;
}) {
  const { t } = useTranslation('workload');
  const { added, removed, modified } = result.diff;
  const total = added.length + removed.length + modified.length;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [warnOpen, setWarnOpen] = useState(true);

  // Le plan couvre TOUT le projet (pas la fenêtre affichée). On calcule son
  // span calendaire complet + combien d'allocations tombent hors de la vue
  // courante, pour que l'utilisateur sache qu'il y a du planning à voir en
  // naviguant dans le calendrier.
  const planSpan = useMemo(() => {
    if (result.proposed.length === 0) return null;
    let min = result.proposed[0].startDate;
    let max = result.proposed[0].endDate;
    let outOfView = 0;
    for (const p of result.proposed) {
      if (p.startDate < min) min = p.startDate;
      if (p.endDate > max) max = p.endDate;
      // Hors-vue = aucun chevauchement avec [viewFrom, viewTo].
      if (p.endDate < viewFrom || p.startDate > viewTo) outOfView++;
    }
    return { min, max, outOfView };
  }, [result.proposed, viewFrom, viewTo]);

  // Regrouper les changements par user.
  const byUser = useMemo<UserChangeRow[]>(() => {
    const m = new Map<string, UserChangeRow>();
    const touch = (uid: string, name?: string): UserChangeRow => {
      let r = m.get(uid);
      if (!r) {
        r = {
          userId: uid,
          userName: name ?? uid.slice(0, 8),
          added: [],
          removed: [],
          modified: [],
          hoursDelta: 0,
        };
        m.set(uid, r);
      } else if (name && r.userName === uid.slice(0, 8)) {
        r.userName = name;
      }
      return r;
    };
    for (const p of added) {
      const r = touch(p.userId, p.userName);
      r.added.push(p);
      r.hoursDelta += totalHours(p.startDate, p.endDate, p.hoursPerDay);
    }
    for (const c of removed) {
      const r = touch(c.userId, c.userName);
      r.removed.push(c);
      r.hoursDelta -= totalHours(c.startDate, c.endDate, c.hoursPerDay);
    }
    for (const mod of modified) {
      const r = touch(mod.after.userId, mod.after.userName);
      r.modified.push(mod);
      r.hoursDelta +=
        totalHours(mod.after.startDate, mod.after.endDate, mod.after.hoursPerDay) -
        totalHours(mod.before.startDate, mod.before.endDate, mod.before.hoursPerDay);
    }
    return Array.from(m.values()).sort((a, b) => a.userName.localeCompare(b.userName));
  }, [added, removed, modified]);

  const toggleUser = (uid: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });

  // Auto-expand si peu d'utilisateurs (≤2) ou peu de changements.
  useEffect(() => {
    if (byUser.length <= 2) {
      setExpanded(new Set(byUser.map((r) => r.userId)));
    }
  }, [byUser]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(820px, 96vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Icon name="gauge" size={18} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              {t('autoplanModal.title')}
            </h2>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              {total === 0
                ? t('autoplanModal.subtitle_noChange', { count: result.proposed.length })
                : t('autoplanModal.subtitle_changes', {
                    count: byUser.length,
                    proposed: result.proposed.length,
                    changes: total,
                  })}
              {planSpan && (
                <>
                  {' '}· <span className="mono">{planSpan.min} → {planSpan.max}</span>
                </>
              )}
              <br />
              <span style={{ fontSize: 11 }}>
                {t('autoplanModal.frozenNote')}
              </span>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title={t('common:close')}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Summary chips */}
        <div style={{ display: 'flex', gap: 8, padding: '12px 20px', flexWrap: 'wrap' }}>
          <KindChip kind="added" count={added.length} />
          <KindChip kind="removed" count={removed.length} />
          <KindChip kind="modified" count={modified.length} />
          {result.warnings.length > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: 'oklch(from oklch(0.75 0.18 85) l c h / 0.18)',
                color: 'oklch(0.88 0.18 85)',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <Icon name="warn" size={12} />
              {t('autoplanModal.warnings', { count: result.warnings.length })}
            </span>
          )}
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 20px 20px' }}>
          {/* Allocations hors de la fenêtre affichée : le plan couvre tout le
              projet, l'utilisateur doit naviguer dans le calendrier pour voir
              le reste. */}
          {planSpan && planSpan.outOfView > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                marginBottom: 16,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'oklch(from oklch(0.7 0.15 250) l c h / 0.08)',
                fontSize: 12.5,
                color: 'var(--text-2)',
              }}
            >
              <Icon name="cal" size={14} />
              <span>
                <Trans
                  i18nKey="autoplanModal.outOfView"
                  ns="workload"
                  count={planSpan.outOfView}
                  values={{
                    count: planSpan.outOfView,
                    from: viewFrom,
                    to: viewTo,
                    min: planSpan.min,
                    max: planSpan.max,
                  }}
                  components={[<b key="0" />]}
                />
              </span>
            </div>
          )}

          {/* Affectations proposées (autoAssign) */}
          {result.assignments.length > 0 && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                marginBottom: 16,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '10px 12px',
                  background: 'oklch(from oklch(0.7 0.15 250) l c h / 0.08)',
                  fontSize: 13,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Icon name="user" size={14} />
                {t('autoplanModal.assignmentsHeading', { count: result.assignments.length })}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', padding: '6px 12px 0' }}>
                {t('autoplanModal.assignmentsHint')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '3px 12px 2px', fontStyle: 'italic' }}>
                {t('autoplanModal.skillLegend')}
              </div>
              {result.assignments.map((a) => {
                const chosenIds = new Set(a.chosen.map((c) => c.userId));
                // Pool de swap = choisis (multi) ∪ alternatives, dédupliqué.
                const swapPool = [
                  ...a.chosen,
                  ...a.alternatives.filter((c) => !chosenIds.has(c.userId)),
                ];
                const single = a.chosen.length <= 1;
                return (
                  <div
                    key={a.taskId}
                    style={{
                      padding: '9px 12px',
                      borderTop: '1px solid var(--border)',
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: 10,
                      alignItems: 'center',
                      fontSize: 12.5,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.projectKey ? <span className="mono" style={{ color: 'var(--text-3)', marginRight: 6 }}>{a.projectKey}</span> : null}
                        {a.taskTitle ?? a.taskId.slice(0, 8)}
                        {a.wasAssigned && (
                          <span
                            title={t('autoplanModal.reassignHintTip')}
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: 0.3,
                              padding: '1px 5px',
                              borderRadius: 4,
                              color: 'oklch(0.7 0.15 250)',
                              background: 'oklch(from oklch(0.7 0.15 250) l c h / 0.12)',
                            }}
                          >
                            {t('autoplanModal.reassignTag')}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                        {a.chosen.length > 0
                          ? a.chosen.map((c) => `${c.name}${c.meetsRequired === false ? ' ⚠' : ''} (${c.freeHours}h)`).join(', ')
                          : t(`autoplanModal.assignWarn_${a.warning ?? 'no_qualified'}`)}
                        {a.source === 'override' && a.chosen.length > 0 && (
                          <span style={{ marginLeft: 6, color: 'oklch(0.7 0.15 250)' }}>
                            · {t('autoplanModal.assignSourceOverride')}
                          </span>
                        )}
                        {a.warning && a.chosen.length > 0 && (
                          <span style={{ marginLeft: 6, color: 'oklch(0.78 0.16 65)' }}>
                            · {t(`autoplanModal.assignWarn_${a.warning}`)}
                          </span>
                        )}
                      </div>
                    </div>
                    {swappable && onSwap && single && swapPool.length > 1 && (
                      <select
                        className="btn"
                        value={a.chosen[0]?.userId ?? ''}
                        disabled={loading}
                        onChange={(e) => onSwap(a.taskId, e.target.value)}
                        title={t('autoplanModal.assignTo')}
                        style={{ fontSize: 11.5, padding: '3px 6px', maxWidth: 170 }}
                      >
                        {a.chosen.length === 0 && <option value="">—</option>}
                        {swapPool.map((c) => (
                          <option key={c.userId} value={c.userId}>
                            {c.name} · {c.freeHours}h{c.meetsRequired === false ? ' ⚠' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Warnings */}
          {result.warnings.length > 0 && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                marginBottom: 16,
                overflow: 'hidden',
              }}
            >
              <button
                onClick={() => setWarnOpen((v) => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '10px 12px',
                  background: 'oklch(from oklch(0.75 0.18 85) l c h / 0.08)',
                  border: 'none',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <Icon name="warn" size={14} />
                {t('autoplanModal.warningsHeading', { count: result.warnings.length })}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {warnOpen ? t('autoplanModal.hide') : t('autoplanModal.show')}
                </span>
              </button>
              {warnOpen && (
                <div>
                  {result.warnings.map((w, i) => (
                    <div
                      key={i}
                      style={{
                        padding: '8px 12px',
                        borderTop: '1px solid var(--border)',
                        display: 'grid',
                        gridTemplateColumns: '110px 1fr',
                        gap: 10,
                        fontSize: 12,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'oklch(from oklch(0.75 0.18 85) l c h / 0.22)',
                          color: 'oklch(0.88 0.18 85)',
                          alignSelf: 'start',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          fontWeight: 700,
                          textAlign: 'center',
                        }}
                      >
                        {w.type.replace('_', ' ')}
                      </span>
                      <span>{w.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* No-change empty state */}
          {total === 0 ? (
            <div
              style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: 'var(--text-3)',
                fontSize: 13,
              }}
            >
              <div style={{ marginBottom: 8 }}>
                <Icon name="gauge" size={28} />
              </div>
              {t('autoplanModal.noChange')}
            </div>
          ) : (
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-3)',
                  margin: '4px 0 8px',
                }}
              >
                {t('autoplanModal.changesByMember')}
              </div>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                {byUser.map((row, idx) => {
                  const isOpen = expanded.has(row.userId);
                  const count = row.added.length + row.removed.length + row.modified.length;
                  return (
                    <div
                      key={row.userId}
                      style={{
                        borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                      }}
                    >
                      <button
                        onClick={() => toggleUser(row.userId)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '10px 14px',
                          background: isOpen
                            ? 'var(--surface-2)'
                            : 'transparent',
                          border: 'none',
                          color: 'var(--text)',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: 13,
                        }}
                      >
                        <span style={{ width: 12, color: 'var(--text-3)' }}>
                          {isOpen ? '▾' : '▸'}
                        </span>
                        <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }} className="truncate">
                          {row.userName}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {t('autoplanModal.changes', { count })}
                        </span>
                        {row.added.length > 0 && <KindChip kind="added" count={row.added.length} />}
                        {row.modified.length > 0 && <KindChip kind="modified" count={row.modified.length} />}
                        {row.removed.length > 0 && <KindChip kind="removed" count={row.removed.length} />}
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color:
                              row.hoursDelta > 0
                                ? 'oklch(0.78 0.18 145)'
                                : row.hoursDelta < 0
                                  ? 'oklch(0.78 0.18 25)'
                                  : 'var(--text-3)',
                            width: 60,
                            textAlign: 'right',
                          }}
                          title={t('autoplanModal.netHoursTitle')}
                        >
                          {row.hoursDelta > 0 ? '+' : ''}
                          {Math.round(row.hoursDelta * 10) / 10}h
                        </span>
                      </button>
                      {isOpen && (
                        <div>
                          {row.added.map((p, i) => (
                            <ChangeLine
                              key={`a${i}`}
                              kind="added"
                              taskTitle={p.taskTitle ?? p.taskId.slice(0, 8)}
                              projectKey={p.projectKey}
                              rangeAfter={fmtDateRange(p.startDate, p.endDate)}
                              hoursAfter={p.hoursPerDay}
                            />
                          ))}
                          {row.modified.map((m, i) => (
                            <ChangeLine
                              key={`m${i}`}
                              kind="modified"
                              taskTitle={m.after.taskTitle ?? m.after.taskId.slice(0, 8)}
                              projectKey={m.after.projectKey}
                              rangeBefore={fmtDateRange(m.before.startDate, m.before.endDate)}
                              rangeAfter={fmtDateRange(m.after.startDate, m.after.endDate)}
                              hoursBefore={m.before.hoursPerDay}
                              hoursAfter={m.after.hoursPerDay}
                            />
                          ))}
                          {row.removed.map((c, i) => (
                            <ChangeLine
                              key={`r${i}`}
                              kind="removed"
                              taskTitle={c.taskTitle ?? c.taskId.slice(0, 8)}
                              projectKey={c.projectKey}
                              rangeBefore={fmtDateRange(c.startDate, c.endDate)}
                              hoursBefore={c.hoursPerDay}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {t('autoplanModal.manualNeverOverwritten')}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={loading}>
            {t('common:cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={loading || (total === 0 && result.assignments.length === 0)}
            onClick={onApply}
          >
            {loading
              ? t('autoplanModal.applying')
              : total === 0 && result.assignments.length === 0
                ? t('autoplanModal.nothingToApply')
                : t('autoplanModal.apply', { count: total })}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Mise en page TÉLÉPHONE (≤620px) — liste de personnes jour-par-jour.
   La grille people × days ne tient pas en portrait. On réutilise toute la
   logique (données, requestMove, modales) et on remplace le rendu : un
   sélecteur de jour + une liste de personnes (capacité, charge, allocations).
   Le drag-drop devient un tap sur une allocation → feuille d'action (ouvrir la
   tâche / réassigner à quelqu'un d'autre le même jour).
   ============================================================ */
function WorkloadMobile({
  grid,
  rows,
  periodLabel,
  today,
  search,
  setSearch,
  sortBy,
  setSortBy,
  requestMove,
  onOpen,
  isTeamLead,
  planLoading,
  onAutoplan,
  onTimeOff,
  shiftPeriod,
}: {
  grid: WorkloadGridDto;
  rows: WorkloadGridDto['rows'];
  totals: { allocated: number; capacity: number; over: number; under: number };
  periodLabel: string;
  today: string;
  search: string;
  setSearch: (v: string) => void;
  sortBy: 'hours-desc' | 'name';
  setSortBy: (v: 'hours-desc' | 'name') => void;
  requestMove: (
    allocId: string,
    fromUserId: string,
    fromDate: string,
    toUid: string,
    toDate: string,
    hours: number,
  ) => void;
  onOpen?: (taskId: string) => void;
  isTeamLead: boolean;
  planLoading: boolean;
  onAutoplan: () => void;
  onTimeOff: () => void;
  shiftPeriod: (dir: -1 | 0 | 1) => void;
}) {
  const { t } = useTranslation('workload');
  const days = grid.days;
  const defaultDate = days.some((d) => d.date === today) ? today : days[0]?.date ?? today;
  const [selDate, setSelDate] = useState(defaultDate);
  useEffect(() => {
    if (!days.some((d) => d.date === selDate)) setSelDate(defaultDate);
  }, [days, selDate, defaultDate]);

  // Allocation tapée → feuille d'action (ouvrir tâche / réassigner).
  const [sheet, setSheet] = useState<{
    allocId: string;
    fromUserId: string;
    taskId: string;
    title: string;
    sub: string;
    hours: number;
  } | null>(null);
  const [reassign, setReassign] = useState(false);

  const h1 = (n: number) => `${Math.round(n * 10) / 10}h`;

  // Pastille d'une puce de jour : rouge si quelqu'un est en surcharge ce jour.
  const dayDot = (dateIso: string) => {
    let anyOver = false;
    let anyAlloc = false;
    for (const r of rows) {
      const c = r.cells.find((x) => x.date === dateIso);
      if (!c) continue;
      if (c.allocatedHours > 0) anyAlloc = true;
      if (
        (c.capacityHours > 0 && c.allocatedHours > c.capacityHours + 1e-6) ||
        (c.capacityHours <= 0 && c.allocatedHours > 0)
      )
        anyOver = true;
    }
    return anyOver ? 'over' : anyAlloc ? 'full' : 'empty';
  };

  // Jour férié au niveau du jour : les fériés sont par utilisateur (cellule),
  // mais le cas courant est le férié du pays par défaut de l'org. On considère
  // le jour comme férié dès qu'une cellule l'est, et on récupère son nom — pour
  // l'afficher en ambre comme dans la timesheet.
  const dayHolidayName = (dateIso: string): string | null => {
    for (const r of rows) {
      const c = r.cells.find((x) => x.date === dateIso);
      if (c?.isHoliday) return c.holidayName ?? '';
    }
    return null;
  };
  const selHoliday = dayHolidayName(selDate);

  let dayAlloc = 0;
  let dayCap = 0;
  let dayOver = 0;
  const peopleToday = rows.map((r) => {
    const cell = r.cells.find((c) => c.date === selDate);
    const alloc = cell?.allocatedHours ?? 0;
    const cap = cell?.capacityHours ?? 0;
    dayAlloc += alloc;
    dayCap += cap;
    const over = (cap > 0 && alloc > cap + 1e-6) || (cap <= 0 && alloc > 0);
    if (over) dayOver++;
    return { row: r, cell, alloc, cap, over };
  });

  return (
    <div className="wlm-wrap">
      <div className="wlm-head">
        <div className="tsm-weeknav">
          <button className="ts-week-step" onClick={() => shiftPeriod(-1)} aria-label="previous">
            <Icon name="chevL" size={18} />
          </button>
          <div className="tsm-weeknav-label">
            <span>{periodLabel}</span>
          </div>
          <button className="ts-week-step" onClick={() => shiftPeriod(1)} aria-label="next">
            <Icon name="chevR" size={18} />
          </button>
          <button className="ts-today-btn" onClick={() => shiftPeriod(0)}>
            {t('view.today')}
          </button>
        </div>
        <div className="wlm-toolrow">
          <div className="searchbox login-field" style={{ flex: 1 }}>
            <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('view.searchPlaceholder')} />
          </div>
          <button
            className="btn btn-line btn-sm"
            onClick={() => setSortBy(sortBy === 'hours-desc' ? 'name' : 'hours-desc')}
            style={{ whiteSpace: 'nowrap' }}
          >
            <Icon name="sort" size={14} /> {sortBy === 'hours-desc' ? t('view.sort.byLoad') : t('view.sort.byName')}
          </button>
        </div>
      </div>

      {/* Sélecteur de jour */}
      <div className="tsm-days">
        {days.map((d) => {
          const dd = d.date.split('-')[2];
          const dow = (new Date(d.date + 'T00:00:00Z').getUTCDay() + 6) % 7;
          const sel = d.date === selDate;
          const hol = dayHolidayName(d.date) !== null;
          return (
            <button
              key={d.date}
              className={
                'tsm-day-chip' +
                (sel ? ' is-sel' : '') +
                (d.date === today ? ' is-today' : '') +
                (hol ? ' is-holiday' : dow >= 5 ? ' is-weekend' : '')
              }
              onClick={() => setSelDate(d.date)}
            >
              <span className="tsm-day-dow">{WEEKDAY_LABELS[dow]}</span>
              <span className="tsm-day-num">{Number(dd)}</span>
              <span className={'tsm-day-dot ' + (hol ? 'holiday' : dayDot(d.date))} />
            </button>
          );
        })}
      </div>

      {/* Résumé du jour */}
      <div className="wlm-day-sum">
        <span className="mono">
          {h1(dayAlloc)} / {h1(dayCap)}
        </span>
        <span className="wlm-sum-sep">·</span>
        <span>{t('view.mobile.peopleCount', { count: peopleToday.length })}</span>
        {dayOver > 0 && <span className="wlm-over-badge">{t('view.mobile.overCount', { count: dayOver })}</span>}
      </div>

      {/* Bandeau jour férié — même convention ambre que la timesheet */}
      {selHoliday !== null && (
        <div className="tsm-holiday-banner">
          <Icon name="cal" size={14} />
          <span>{selHoliday || t('timesheet.holiday')}</span>
        </div>
      )}

      {/* Personnes */}
      {peopleToday.map(({ row, cell, alloc, cap, over }) => {
        const st = loadState(alloc, cap);
        const pct = cap > 0 ? Math.min(alloc / cap, 1) * 100 : alloc > 0 ? 100 : 0;
        const allocs = cell?.allocations ?? [];
        const off = cap <= 0;
        return (
          <div key={row.userId} className={'wlm-person' + (over ? ' is-over' : '')}>
            <div className="wlm-person-head">
              <Avatar user={asUser(row)} size={30} title={false} />
              <div className="wlm-person-id">
                <div className="wlm-person-name">{row.name}</div>
                <div className={'wlm-person-load mono' + (cell?.isHoliday ? ' is-holiday' : '')}>
                  {off
                    ? cell?.timeOffType
                      ? t('timeOffType.' + cell.timeOffType, { defaultValue: cell.timeOffType })
                      : cell?.isHoliday
                        ? cell.holidayName ?? t('timesheet.holiday')
                        : t('view.mobile.dayOff')
                    : `${h1(alloc)} / ${h1(cap)}`}
                </div>
              </div>
              {!off && (
                <span className="wlm-bar">
                  <span className={'wlm-bar-fill load-' + st} style={{ width: pct + '%' }} />
                </span>
              )}
            </div>
            {allocs.length > 0 && (
              <div className="wlm-chips">
                {allocs.map((a) => (
                  <button
                    key={a.allocationId}
                    className="wlm-chip"
                    style={a.color ? { borderLeftColor: a.color } : undefined}
                    onClick={() => {
                      setReassign(false);
                      setSheet({
                        allocId: a.allocationId,
                        fromUserId: row.userId,
                        taskId: a.taskId,
                        title: a.taskTitle,
                        sub: `${a.projectKey}${a.projectName ? ' · ' + a.projectName : ''}`,
                        hours: a.hours,
                      });
                    }}
                  >
                    <span className="wlm-chip-h mono">{h1(a.hours)}</span>
                    <span className="wlm-chip-body">
                      <span className="wlm-chip-proj mono">{a.projectKey}</span>
                      <span className="wlm-chip-title">{a.taskTitle}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {peopleToday.length === 0 && <div className="tsm-empty">{t('view.mobile.noPeople')}</div>}

      {/* Actions de gestion */}
      <div className="wlm-actions">
        <button className="btn btn-line btn-sm" disabled={planLoading} onClick={onAutoplan}>
          <Icon name="zap" size={14} /> {t('view.autoplanButton')}
        </button>
        {isTeamLead && (
          <button className="btn btn-line btn-sm" onClick={onTimeOff}>
            <Icon name="cal" size={14} /> {t('view.timeOffButton')}
          </button>
        )}
      </div>

      {/* Feuille d'action sur une allocation */}
      {sheet && (
        <div className="wlm-sheet-bg" onClick={() => setSheet(null)}>
          <div className="wlm-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wlm-sheet-task">
              <div className="wlm-sheet-title">{sheet.title}</div>
              <div className="wlm-sheet-sub mono">
                {sheet.sub} · {h1(sheet.hours)}
              </div>
            </div>
            {!reassign ? (
              <>
                {onOpen && (
                  <button
                    className="wlm-sheet-act"
                    onClick={() => {
                      onOpen(sheet.taskId);
                      setSheet(null);
                    }}
                  >
                    <Icon name="arrowRight" size={15} /> {t('view.mobile.openTask')}
                  </button>
                )}
                <button className="wlm-sheet-act" onClick={() => setReassign(true)}>
                  <Icon name="user" size={15} /> {t('view.mobile.reassignTo')}
                </button>
                <button className="wlm-sheet-cancel" onClick={() => setSheet(null)}>
                  {t('common:cancel')}
                </button>
              </>
            ) : (
              <>
                <div className="wlm-sheet-hint">{t('view.mobile.reassignHint')}</div>
                <div className="wlm-sheet-people">
                  {rows
                    .filter((r) => r.userId !== sheet.fromUserId)
                    .map((r) => (
                      <button
                        key={r.userId}
                        className="wlm-sheet-person"
                        onClick={() => {
                          requestMove(sheet.allocId, sheet.fromUserId, selDate, r.userId, selDate, sheet.hours);
                          setSheet(null);
                          setReassign(false);
                        }}
                      >
                        <Avatar user={asUser(r)} size={24} title={false} />
                        <span>{r.name}</span>
                      </button>
                    ))}
                </div>
                <button className="wlm-sheet-cancel" onClick={() => setReassign(false)}>
                  {t('view.mobile.back')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
