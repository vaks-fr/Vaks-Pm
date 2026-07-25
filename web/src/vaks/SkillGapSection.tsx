/* ============================================================
   ProjectSkillGap (Reports → Skill Gap)
   + Admin > CSV bulk import / export
   + Admin > Grille de niveaux (levelScale).
   ============================================================ */
import React, { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, downloadFile, saveBlob } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { SkillRequestModal } from './TaskDetail';
import type { SkillGapRowDto, BulkImportUserSkillsResult } from '@vaks-pm/shared';

type GapTask = SkillGapRowDto['tasks'][number];

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

/* ----------------------- Skill gap PAR PROJET ---------------------------- */
/**
 * Vue agrégée pour un projet donné : compare la demande des tâches non-DONE
 * (niveau × heures) à la couverture des UserSkill du pool effectif (membres
 * directs + membres des équipes affectées). Réservée aux PM, leads d'équipe
 * affectée, Portfolio Manager, admins — gating côté serveur.
 */
export function ProjectSkillGapView({
  projectId,
  flash,
  onOpenTask,
}: {
  projectId: string;
  flash: (msg: string, kind?: 'info' | 'ok' | 'err') => void;
  /** Si fourni, le titre des tâches devient cliquable et ouvre la TaskDetail. */
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation('skills');
  const [rows, setRows] = useState<SkillGapRowDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canRequestSkill, setCanRequestSkill] = useState(false);
  // Modales actionnables : demande de compétence / application du split.
  const [reqModal, setReqModal] = useState<{ taskId: string; skillName: string } | null>(null);
  const [splitModal, setSplitModal] = useState<{ task: GapTask; skillName: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .availableProjectSkills(projectId)
      .then((r) => {
        if (!cancelled) setCanRequestSkill(!!r.canRequestSkill);
      })
      .catch(() => {
        if (!cancelled) setCanRequestSkill(false);
      });
    api
      .projectSkillGap(projectId)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e) => {
        if (!cancelled) {
          const msg = (e as Error).message;
          setError(msg);
          // Si on est 403 (gating), on n'embête pas l'user avec un toast.
          if (!/403|Forbidden|réservé/i.test(msg)) flash(msg, 'err');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, flash, reloadKey]);

  if (loading) return <div style={{ padding: 18, opacity: 0.6 }}>{t('skills:gap.loading')}</div>;
  if (error) {
    return (
      <div
        style={{
          padding: 18,
          color: 'var(--text-3)',
          fontSize: 13,
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--surface-2)',
        }}
      >
        {/403|Forbidden|réservé/i.test(error)
          ? t('skills:gap.forbidden')
          : error}
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <div
        style={{
          padding: 18,
          color: 'var(--text-3)',
          fontSize: 13,
          border: '1px solid var(--border)',
          borderRadius: 10,
        }}
      >
        {t('skills:gap.noData')}
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
          fontSize: 12,
          color: 'var(--text-3)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ flex: 1 }}>
          {t('skills:gap.summary', { count: rows.length })}
        </span>
        {(['csv', 'xlsx'] as const).map((fmt) => (
          <button
            key={fmt}
            className="btn btn-sm"
            type="button"
            style={{ flexShrink: 0 }}
            title={t('skills:gap.exportTitle', { format: fmt.toUpperCase() })}
            onClick={async () => {
              try {
                const { blob, filename } = await downloadFile(
                  `/projects/${projectId}/skills/gap.${fmt}`,
                  `skill-gap.${fmt}`,
                );
                saveBlob(blob, filename);
              } catch (e) {
                flash((e as Error).message, 'err');
              }
            }}
          >
            {fmt.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ padding: 8, display: 'grid', gap: 8 }}>
        {rows.map((r) => (
          <SkillGapRow
            key={r.skillId}
            row={r}
            canRequestSkill={canRequestSkill}
            onRequestSkill={(task) => setReqModal({ taskId: task.taskId, skillName: r.name })}
            onApplySplit={(task) => setSplitModal({ task, skillName: r.name })}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
      {reqModal && (
        <SkillRequestModal
          taskId={reqModal.taskId}
          projectId={projectId}
          initialName={reqModal.skillName}
          onClose={() => setReqModal(null)}
        />
      )}
      {splitModal && (
        <ApplySplitDialog
          task={splitModal.task}
          skillName={splitModal.skillName}
          flash={flash}
          onClose={() => setSplitModal(null)}
          onApplied={() => {
            setSplitModal(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/* ----------------------- Row par compétence (drill-down) -------------------- */

function SkillGapRow({
  row,
  canRequestSkill,
  onRequestSkill,
  onApplySplit,
  onOpenTask,
}: {
  row: SkillGapRowDto;
  canRequestSkill: boolean;
  onRequestSkill: (task: GapTask) => void;
  onApplySplit: (task: GapTask) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation('skills');
  const [expanded, setExpanded] = useState(false);
  const hasIssue = row.uncovered + row.partial + row.splittable > 0;
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text)',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{ width: 12, color: 'var(--text-3)' }}>{expanded ? '▾' : '▸'}</span>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 3,
            background: row.color ?? '#6d5efc',
            flexShrink: 0,
          }}
        />
        <strong style={{ minWidth: 0 }}>{row.name}</strong>
        {row.category && (
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {row.category}</span>
        )}
        <span style={{ flex: 1 }} />
        <Pill count={row.fully} kind="ok" label={t('skills:gap.pill.covered')} />
        <Pill count={row.splittable} kind="split" label={t('skills:gap.pill.split')} />
        <Pill count={row.partial} kind="partial" label={t('skills:gap.pill.partial')} />
        <Pill count={row.uncovered} kind="bad" label={t('skills:gap.pill.uncovered')} />
        <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 60, textAlign: 'right' }}>
          {t('skills:gap.taskCount', { count: row.totalTasks })}
        </span>
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 8, display: 'grid', gap: 6 }}>
          {row.tasks.map((tk) => (
            <TaskCoverageRow
              key={tk.taskId}
              task={tk}
              canRequestSkill={canRequestSkill}
              onRequestSkill={onRequestSkill}
              onApplySplit={onApplySplit}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Pill({
  count,
  label,
  kind,
}: {
  count: number;
  label: string;
  kind: 'ok' | 'split' | 'partial' | 'bad';
}) {
  if (count === 0) return null;
  const colors: Record<typeof kind, { bg: string; fg: string }> = {
    ok: { bg: '#16a34a', fg: '#fff' },
    split: { bg: '#2563eb', fg: '#fff' },
    partial: { bg: '#b45309', fg: '#fff' },
    bad: { bg: '#dc2626', fg: '#fff' },
  };
  const c = colors[kind];
  return (
    <span
      title={`${count} ${label}`}
      style={{
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
      }}
    >
      {count} {label}
    </span>
  );
}

const STATUS_META: Record<
  SkillGapRowDto['tasks'][number]['status'],
  { labelKey: string; bg: string; fg: string }
> = {
  fully: { labelKey: 'skills:gap.status.fully', bg: '#16a34a', fg: '#fff' },
  splittable: { labelKey: 'skills:gap.status.splittable', bg: '#2563eb', fg: '#fff' },
  partial: { labelKey: 'skills:gap.status.partial', bg: '#b45309', fg: '#fff' },
  uncovered: { labelKey: 'skills:gap.status.uncovered', bg: '#dc2626', fg: '#fff' },
};

function TaskCoverageRow({
  task,
  canRequestSkill,
  onRequestSkill,
  onApplySplit,
  onOpenTask,
}: {
  task: GapTask;
  canRequestSkill: boolean;
  onRequestSkill: (task: GapTask) => void;
  onApplySplit: (task: GapTask) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation('skills');
  const meta = STATUS_META[task.status];
  const near = task.nearQualified ?? [];
  return (
    <div
      style={{
        padding: '8px 10px',
        background: 'var(--surface-2)',
        borderRadius: 6,
        display: 'grid',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            background: meta.bg,
            color: meta.fg,
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 8px',
            borderRadius: 999,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          {t(meta.labelKey)}
        </span>
        {onOpenTask ? (
          <button
            type="button"
            onClick={() => onOpenTask(task.taskId)}
            title={t('skills:gap.openTask')}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--text)',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 700,
              textDecoration: 'underline',
              textDecorationColor: 'var(--border)',
              textUnderlineOffset: 3,
            }}
          >
            {task.title}
          </button>
        ) : (
          <strong style={{ fontSize: 13 }}>{task.title}</strong>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          · {t('skills:gap.requiredLevel')} <span className="mono">{task.requiredLevel}</span>
          {task.estimateHours != null && (
            <>
              {' '}· {t('skills:gap.remaining')}{' '}
              <span className="mono">
                {task.remainingHours ?? task.estimateHours}h
              </span>{' '}
              {t('skills:gap.remainingOf', { total: task.estimateHours })}
              {task.loggedHours > 0 && <>{t('skills:gap.loggedHours', { hours: task.loggedHours })}</>}
            </>
          )}
          {task.startDate && task.endDate && (
            <> · {task.startDate} → {task.endDate}</>
          )}
        </span>
      </div>

      {task.status === 'uncovered' && (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('skills:gap.uncoveredHint')}
        </div>
      )}

      {task.status === 'fully' && task.qualifiedUsers.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('skills:gap.canBeDoneBy')}{' '}
          {task.qualifiedUsers
            .filter((u) => u.canSolo)
            .slice(0, 3)
            .map((u, i, arr) => (
              <span key={u.userId}>
                <strong style={{ color: 'var(--text)' }}>{u.name}</strong>
                {u.assigned && (
                  <span style={{ fontSize: 10, color: '#2563eb' }}> {t('skills:gap.assigned')}</span>
                )}
                <span style={{ color: 'var(--text-3)' }}>
                  {' '}{t('skills:gap.userMeta', { level: u.level, hours: u.freeHours })}
                </span>
                {i < arr.length - 1 ? ', ' : ''}
              </span>
            ))}
          {task.qualifiedUsers.filter((u) => u.canSolo).length > 3 && (
            <span> {t('skills:gap.andOthers', { count: task.qualifiedUsers.filter((u) => u.canSolo).length - 3 })}</span>
          )}
        </div>
      )}

      {task.status === 'splittable' && task.split && (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('skills:gap.toSplitBetween')}{' '}
          {task.split.map((s, i, arr) => (
            <span key={s.userId}>
              <strong style={{ color: 'var(--text)' }}>{s.name}</strong>{' '}
              <span className="mono">({s.hours}h)</span>
              {i < arr.length - 1 ? ' + ' : ''}
            </span>
          ))}
        </div>
      )}

      {near.length > 0 && (task.status === 'uncovered' || task.status === 'partial') && (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('skills:gap.nearQualified', { count: near.length, level: near[0].level, required: task.requiredLevel })}{' '}
          {near.slice(0, 3).map((u, i, arr) => (
            <span key={u.userId}>
              <strong style={{ color: 'var(--text)' }}>{u.name}</strong>
              <span> {t('skills:gap.freeHours', { hours: u.freeHours })}</span>
              {i < arr.length - 1 ? ', ' : ''}
            </span>
          ))}
          {near.length > 3 && <span> {t('skills:gap.andOthers', { count: near.length - 3 })}</span>}
        </div>
      )}

      {(task.status === 'uncovered' ||
        task.status === 'partial' ||
        task.status === 'splittable') && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {task.status === 'splittable' && task.split && task.split.length > 0 && (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => onApplySplit(task)}
              title={t('skills:gap.planSplitTitle')}
            >
              {t('skills:gap.planSplit')}
            </button>
          )}
          {canRequestSkill && (task.status === 'uncovered' || task.status === 'partial') && (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => onRequestSkill(task)}
              title={t('skills:gap.requestSkillTitle')}
            >
              {t('skills:gap.requestSkill')}
            </button>
          )}
        </div>
      )}

      {task.status === 'partial' && (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('skills:gap.qualifiedCount', { count: task.qualifiedUsers.length })}{' '}
          {task.qualifiedUsers.slice(0, 4).map((u, i, arr) => (
            <span key={u.userId}>
              <strong style={{ color: 'var(--text)' }}>{u.name}</strong>
              {u.assigned && (
                <span style={{ fontSize: 10, color: '#2563eb' }}> {t('skills:gap.assigned')}</span>
              )}
              <span> {t('skills:gap.userMetaShort', { level: u.level, hours: u.freeHours })}</span>
              {i < arr.length - 1 ? ', ' : ''}
            </span>
          ))}
          {task.qualifiedUsers.length > 4 && (
            <span> {t('skills:gap.andOthers', { count: task.qualifiedUsers.length - 4 })}</span>
          )}{' '}
          <Trans
            i18nKey="skills:gap.butOnlyFree"
            values={{ hours: task.totalFreeHours }}
            components={[<span className="mono" />]}
          />
          {task.remainingHours != null && (
            <Trans
              i18nKey="skills:gap.needShortfall"
              values={{
                need: task.remainingHours,
                short: Math.max(0, task.remainingHours - task.totalFreeHours).toFixed(1),
              }}
              components={[<span className="mono" />]}
            />
          )}
          .
        </div>
      )}
    </div>
  );
}

/* ------------------- Appliquer le split proposé (Lot 3) ------------------ */
/**
 * Transforme le split greedy suggéré par le gap en allocations réelles :
 * 1. assigne à la tâche les personnes du split qui ne le sont pas encore,
 * 2. dry-run `auto-split-multi` (greedy) qui vérifie la faisabilité JOUR PAR
 *    JOUR (le chiffre du gap est une somme sur la fenêtre, pas un planning),
 * 3. crée une allocation par chunk et par personne (origin 'auto_split').
 */
function ApplySplitDialog({
  task,
  skillName,
  flash,
  onClose,
  onApplied,
}: {
  task: GapTask;
  skillName: string;
  flash: Flash;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation('skills');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const split = task.split ?? [];
  const totalHours = task.remainingHours ?? task.estimateHours ?? 0;
  const todayIso = new Date().toISOString().slice(0, 10);
  const startDate =
    task.startDate && task.startDate > todayIso ? task.startDate : todayIso;
  const toAssign = split.filter(
    (s) => !task.qualifiedUsers.some((q) => q.userId === s.userId && q.assigned),
  );

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      // 1. Assigner les personnes manquantes (merge avec les assignees actuels
      // pour ne dégager personne).
      if (toAssign.length > 0) {
        const current = await api.getTask(task.taskId);
        const ids = new Set(current.assignees.map((a) => a.userId));
        for (const s of toAssign) ids.add(s.userId);
        await api.updateTask(task.taskId, { assigneeIds: Array.from(ids) });
      }
      // 2. Dry-run jour par jour.
      const preview = await api.autoSplitMultiAllocation({
        taskId: task.taskId,
        userIds: split.map((s) => s.userId),
        startDate,
        totalHours,
        strategy: 'greedy',
        mustFinishBy: task.endDate ?? undefined,
      });
      if (preview.shortfallHours > 0.01) {
        setError(
          t('skills:applySplit.shortfall', {
            hours: preview.shortfallHours.toFixed(1),
            people:
              preview.peopleShort > 0
                ? t('skills:applySplit.peopleShort', { count: preview.peopleShort })
                : '',
          }),
        );
        return;
      }
      // 3. Créer les allocations chunk par chunk.
      let created = 0;
      for (const p of preview.perUser) {
        for (const c of p.chunks) {
          await api.createAllocation({
            userId: p.userId,
            taskId: task.taskId,
            startDate: c.startDate,
            endDate: c.endDate,
            hoursPerDay: c.hoursPerDay,
            origin: 'auto_split',
          });
          created++;
        }
      }
      flash(
        t('skills:applySplit.planned', {
          count: created,
          people: preview.peopleUsed,
          hours: preview.effectiveHours,
        }),
        'ok',
      );
      onApplied();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,16,28,0.5)',
        display: 'grid', placeItems: 'center',
      }}
    >
      <div
        style={{
          width: 'min(520px, 92vw)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 18,
          display: 'grid',
          gap: 12,
          color: 'var(--text)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>{t('skills:applySplit.title')}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            <strong style={{ color: 'var(--text)' }}>{task.title}</strong> ·{' '}
            {t('skills:applySplit.subtitle', { skill: skillName, hours: totalHours, date: startDate })}
            {task.endDate && <>{t('skills:applySplit.deadline', { date: task.endDate })}</>}.
          </div>
        </div>
        <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
          {split.map((s) => (
            <div key={s.userId} style={{ display: 'flex', gap: 8 }}>
              <span style={{ flex: 1 }}>{s.name}</span>
              <span className="mono" style={{ color: 'var(--text-3)' }}>
                ~{s.hours}h
              </span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('skills:applySplit.recalcNote')}
          {toAssign.length > 0 && (
            <>
              {' '}
              <strong style={{ color: 'var(--text)' }}>
                {toAssign.map((s) => s.name).join(', ')}
              </strong>{' '}
              {t('skills:applySplit.willBeAssigned')}
            </>
          )}
        </div>
        {error && (
          <div style={{ fontSize: 12, color: '#dc2626' }}>{error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            {t('common:cancel')}
          </button>
          <button className="btn primary" type="button" onClick={apply} disabled={busy}>
            {busy ? t('skills:applySplit.planning') : t('skills:applySplit.assignAndPlan')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------- Bulk import CSV ----------------------------- */

export function SkillsImportSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('skills');
  const [csv, setCsv] = useState(
    'email,skill,level,category\n' +
      'alex@example.com,Microsoft Azure,5,Microsoft Azure (détaillé)\n' +
      'alex@example.com,Terraform,6,DevOps & Infra\n' +
      'jordan@example.com,React,7,Frontend\n',
  );
  const [createMissing, setCreateMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkImportUserSkillsResult | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.bulkImportUserSkills(csv, createMissing);
      setResult(r);
      flash(
        t('skills:import.toast', {
          processed: r.processed,
          created: r.created,
          updated: r.updated,
          errors: r.errors.length,
        }),
        r.errors.length > 0 ? 'info' : 'ok',
      );
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="asection-card" style={{ padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
        {t('skills:import.intro1')}{' '}
        <code>email,skill,level</code> {t('skills:import.intro2')} <code>email,skill,level,category</code>{' '}
        {t('skills:import.intro3')}
        <br />
        {t('skills:import.intro4')}
      </div>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={10}
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: 12,
          padding: 10,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface-2)',
          color: 'var(--text)',
          resize: 'vertical',
        }}
        placeholder="email,skill,level,category"
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={createMissing}
          onChange={(e) => setCreateMissing(e.target.checked)}
        />
        {t('skills:import.createMissing')}
      </label>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button
          className="btn"
          onClick={() => {
            // Téléchargement direct depuis l'API (BOM + headers gérés côté serveur).
            const a = document.createElement('a');
            a.href = '/api/v1/admin/users/skills/export';
            a.download = '';
            a.click();
          }}
          title={t('skills:import.exportExistingTitle')}
        >
          {t('skills:import.exportExisting')}
        </button>
        <button className="btn primary" onClick={run} disabled={busy || !csv.trim()}>
          {busy ? t('skills:import.importing') : t('skills:import.import')}
        </button>
      </div>
      {result && (
        <div
          style={{
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--surface-2)',
            fontSize: 13,
          }}
        >
          <div>
            <strong>{t('skills:import.resultPrefix')}</strong>{' '}
            {t('skills:import.resultBody', {
              processed: result.processed,
              created: result.created,
              updated: result.updated,
              createdSkills: result.createdSkills,
            })}
          </div>
          {result.errors.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', color: '#dc2626', fontWeight: 600 }}>
                {t('skills:import.errorCount', { count: result.errors.length })}
              </summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20, color: 'var(--text-3)' }}>
                {result.errors.slice(0, 50).map((e, i) => (
                  <li key={i}>
                    {t('skills:import.errorLine', { line: e.line, reason: e.reason })}
                  </li>
                ))}
                {result.errors.length > 50 && (
                  <li>{t('skills:import.andMore', { count: result.errors.length - 50 })}</li>
                )}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------- Grille de niveaux (levelScale) --------------------- */
/**
 * Permet à l'admin de donner un libellé sémantique à chaque niveau (ex.
 * 1=Découverte, 3=Autonome, 5=Senior, 7=Expert). La grille est stockée
 * dans l'OrgSetting `skills.levelScale` et exposée par `/admin/settings/public`
 * pour que toutes les vues (UserSkillsDialog, TaskDetail) puissent l'afficher.
 */
export function SkillsLevelScaleSection({ flash }: { flash: Flash }) {
  type Row = { level: number; label: string };
  const { t } = useTranslation('skills');
  const { refreshOrgSettings } = useAuth();
  const [scale, setScale] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [maxLevel, setMaxLevel] = useState(10);
  const [inputMode, setInputMode] = useState<'number' | 'scale'>('number');

  useEffect(() => {
    let cancelled = false;
    api
      .getAdminSettings()
      .then((s: any) => {
        if (cancelled) return;
        const raw = s?.['skills.levelScale'];
        const arr: Row[] = Array.isArray(raw)
          ? raw
              .map((it: any) => ({
                level: Number(it?.level),
                label: String(it?.label ?? ''),
              }))
              .filter((r) => Number.isFinite(r.level) && r.label.trim())
              .sort((a, b) => a.level - b.level)
          : [];
        const ml = Number(s?.['skills.maxLevel']);
        setMaxLevel(Number.isFinite(ml) && ml > 0 ? ml : 10);
        setScale(arr);
        setInputMode(s?.['skills.levelInputMode'] === 'scale' ? 'scale' : 'number');
      })
      .catch((e) => flash(t('skills:levelScale.settingsLoadError', { message: (e as Error).message }), 'err'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [flash]);

  const addRow = () =>
    setScale((s) => [...s, { level: s.length ? s[s.length - 1].level + 1 : 1, label: '' }]);
  const removeRow = (i: number) => setScale((s) => s.filter((_, idx) => idx !== i));
  const updateRow = (i: number, patch: Partial<Row>) =>
    setScale((s) => s.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const clean = scale
        .map((r) => ({ level: Math.floor(Number(r.level)), label: r.label.trim() }))
        .filter((r) => Number.isFinite(r.level) && r.level >= 1 && r.label)
        .sort((a, b) => a.level - b.level);
      await api.putAdminSettings({
        'skills.levelScale': clean,
        'skills.levelInputMode': inputMode,
      } as any);
      setScale(clean);
      // Propage immédiatement à AuthContext.orgSettings pour que TaskDetail /
      // TeamView prennent en compte la nouvelle grille sans reload.
      await refreshOrgSettings();
      flash(t('skills:levelScale.saved'), 'ok');
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const presets = {
    [t('skills:levelScale.preset.itServices')]: [
      { level: 1, label: t('skills:levelScale.presetLabel.discovery') },
      { level: 3, label: t('skills:levelScale.presetLabel.autonomous') },
      { level: 5, label: t('skills:levelScale.presetLabel.senior') },
      { level: 7, label: t('skills:levelScale.presetLabel.expert') },
      { level: 9, label: t('skills:levelScale.presetLabel.reference') },
    ],
    [t('skills:levelScale.preset.scale15')]: [
      { level: 1, label: t('skills:levelScale.presetLabel.notion') },
      { level: 2, label: t('skills:levelScale.presetLabel.practice') },
      { level: 3, label: t('skills:levelScale.presetLabel.mastery') },
      { level: 4, label: t('skills:levelScale.presetLabel.expertise') },
      { level: 5, label: t('skills:levelScale.presetLabel.reference') },
    ],
  };

  if (loading) return <div style={{ padding: 18, opacity: 0.6 }}>{t('skills:levelScale.loading')}</div>;

  return (
    <div className="asection-card" style={{ padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
        {t('skills:levelScale.intro', { max: maxLevel })}
      </div>

      <div
        style={{
          display: 'grid',
          gap: 6,
          padding: 10,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface-2)',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
          {t('skills:levelScale.inputModeTitle')}
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <input
            type="radio"
            name="levelInputMode"
            checked={inputMode === 'number'}
            onChange={() => setInputMode('number')}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>{t('skills:levelScale.modeNumber')}</strong> {t('skills:levelScale.modeNumberDesc', { max: maxLevel })}
          </span>
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            fontSize: 13,
            cursor: scale.length === 0 ? 'not-allowed' : 'pointer',
            opacity: scale.length === 0 ? 0.6 : 1,
          }}
          title={
            scale.length === 0
              ? t('skills:levelScale.modeScaleDisabledTitle')
              : ''
          }
        >
          <input
            type="radio"
            name="levelInputMode"
            checked={inputMode === 'scale'}
            onChange={() => setInputMode('scale')}
            disabled={scale.length === 0}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>{t('skills:levelScale.modeScale')}</strong> {t('skills:levelScale.modeScaleDesc')}
            {scale.length === 0 && (
              <em style={{ display: 'block', fontSize: 11, color: 'var(--text-3)' }}>
                {t('skills:levelScale.modeScaleHint')}
              </em>
            )}
          </span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)', alignSelf: 'center' }}>
          {t('skills:levelScale.presetsLabel')}
        </span>
        {Object.entries(presets).map(([name, p]) => (
          <button
            key={name}
            className="btn btn-sm"
            onClick={() => setScale(p)}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {scale.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-3)', padding: '12px 0' }}>
            {t('skills:levelScale.noRows')}
          </div>
        ) : (
          scale.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 8,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface-2)',
              }}
            >
              <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 56 }}>
                {t('skills:levelScale.levelWord')}
              </span>
              <input
                type="number"
                value={r.level}
                min={1}
                max={maxLevel}
                onChange={(e) =>
                  updateRow(i, { level: parseInt(e.target.value, 10) || 1 })
                }
                style={{
                  width: 60,
                  padding: '4px 6px',
                  fontFamily: 'monospace',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  textAlign: 'center',
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>=</span>
              <input
                type="text"
                value={r.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
                placeholder={t('skills:levelScale.labelPlaceholder')}
                style={{
                  flex: 1,
                  padding: '4px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--surface)',
                  color: 'var(--text)',
                }}
              />
              <button className="btn btn-sm" onClick={() => removeRow(i)} type="button">
                ×
              </button>
            </div>
          ))
        )}
        <div>
          <button className="btn btn-sm" onClick={addRow} type="button">
            {t('skills:levelScale.addTier')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          className="btn"
          onClick={() => setScale([])}
          disabled={saving || scale.length === 0}
          type="button"
        >
          {t('skills:levelScale.clear')}
        </button>
        <button className="btn primary" onClick={save} disabled={saving} type="button">
          {saving ? t('common:saving') : t('common:save')}
        </button>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--text-3)',
};
const td: React.CSSProperties = { padding: '10px 14px', fontSize: 13 };
