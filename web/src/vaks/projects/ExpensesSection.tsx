/* ============================================================
   Vaks — Projects panel : coûts hors main-d'œuvre
   (licences, matériel, cloud, sous-traitance) — onglet Budget & coûts
   ============================================================ */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../primitives';
import { api } from '../../api/client';
import type {
  ProjectExpenseDto,
  ProjectExpenseCategory,
  ProjectExpenseStatus,
  ProjectExpenseRecurrence,
  CreateProjectExpenseBody,
} from '@vaks-pm/shared';
import { ConfirmDialog } from './shared';
import { fmtMoney } from './money';

const EXPENSE_CATEGORIES: ProjectExpenseCategory[] = [
  'LICENSE',
  'HARDWARE',
  'CLOUD',
  'SUBCONTRACTOR',
  'OTHER',
];
const EXPENSE_STATUSES: ProjectExpenseStatus[] = ['PLANNED', 'INCURRED'];
const RECURRENCES: ProjectExpenseRecurrence[] = ['ONE_OFF', 'MONTHLY', 'ANNUAL'];

function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

interface FormState {
  id: string | null; // null = création
  category: ProjectExpenseCategory;
  label: string;
  amount: string;
  billAmount: string;
  quantity: string;
  status: ProjectExpenseStatus;
  recurrence: ProjectExpenseRecurrence;
  startDate: string;
  endDate: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  category: 'LICENSE',
  label: '',
  amount: '',
  billAmount: '',
  quantity: '1',
  status: 'INCURRED',
  recurrence: 'ONE_OFF',
  startDate: '',
  endDate: '',
};

interface ExpensesSectionProps {
  projectId: string;
  currency: string;
  billable: boolean;
  /** finance:manage — sinon lecture seule. */
  canManage: boolean;
  pushToast: (text: string, warn?: boolean) => void;
}

export function ExpensesSection({
  projectId,
  currency,
  billable,
  canManage,
  pushToast,
}: ExpensesSectionProps) {
  const { t } = useTranslation('projects');
  const catLabel = (c: ProjectExpenseCategory) => t('expenses.category.' + c);
  const statusLbl = (s: ProjectExpenseStatus) => t('expenses.expenseStatus.' + s);
  const recurLbl = (r: ProjectExpenseRecurrence) => t('expenses.recurrence.' + r);
  const [items, setItems] = useState<ProjectExpenseDto[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState<ProjectExpenseDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(() => {
    api
      .listProjectExpenses(projectId)
      .then(setItems)
      .catch(() => setItems([]));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const setF = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const openCreate = () => setForm({ ...EMPTY_FORM });
  const openEdit = (e: ProjectExpenseDto) =>
    setForm({
      id: e.id,
      category: e.category,
      label: e.label,
      amount: e.amount != null ? String(e.amount) : '',
      billAmount: e.billAmount != null ? String(e.billAmount) : '',
      quantity: String(e.quantity ?? 1),
      status: e.status,
      recurrence: e.recurrence,
      startDate: e.startDate ? e.startDate.slice(0, 10) : '',
      endDate: e.endDate ? e.endDate.slice(0, 10) : '',
    });

  const save = async () => {
    if (!form) return;
    const amount = parseNum(form.amount);
    if (!form.label.trim()) {
      pushToast(t('expenses.labelRequired'), true);
      return;
    }
    if (amount === null) {
      pushToast(t('expenses.amountRequired'), true);
      return;
    }
    if (form.recurrence !== 'ONE_OFF' && !form.startDate) {
      pushToast(t('expenses.recurrenceNeedsStart'), true);
      return;
    }
    const body: CreateProjectExpenseBody = {
      category: form.category,
      label: form.label.trim(),
      amount,
      billAmount: parseNum(form.billAmount),
      quantity: parseNum(form.quantity) ?? 1,
      status: form.status,
      recurrence: form.recurrence,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
    };
    setSaving(true);
    try {
      if (form.id) await api.updateProjectExpense(projectId, form.id, body);
      else await api.createProjectExpense(projectId, body);
      pushToast(form.id ? t('expenses.updated') : t('expenses.added'));
      setForm(null);
      reload();
    } catch (e) {
      pushToast(t('expenses.saveFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (e: ProjectExpenseDto) => {
    setDeleting(true);
    try {
      await api.deleteProjectExpense(projectId, e.id);
      setItems((cur) => (cur ? cur.filter((x) => x.id !== e.id) : cur));
      setConfirmDel(null);
    } catch (err) {
      pushToast(t('expenses.deleteFailed', { message: (err as Error).message }), true);
    } finally {
      setDeleting(false);
    }
  };

  const totalActual = (items ?? [])
    .filter((e) => e.status === 'INCURRED')
    .reduce((s, e) => s + e.effectiveCost, 0);
  const totalPlanned = (items ?? [])
    .filter((e) => e.status === 'PLANNED')
    .reduce((s, e) => s + e.effectiveCost, 0);

  // Colonnes de la table : libellé(1fr) · catégorie · statut · coût · [refacturé] · actions
  const cols = billable
    ? 'minmax(0,1fr) 132px 76px 104px 104px 52px'
    : 'minmax(0,1fr) 132px 76px 104px 52px';

  return (
    <div className="md-field" style={{ marginTop: 14 }}>
      <div className="md-label row" style={{ justifyContent: 'space-between' }}>
        <span>
          {t('expenses.title')}{' '}
          {items && <span className="md-count">{items.length}</span>}
        </span>
        {canManage && !form && (
          <button className="btn btn-sm btn-accent" onClick={openCreate}>
            <Icon name="plus" size={14} /> {t('expenses.add')}
          </button>
        )}
      </div>
      <div className="md-hint" style={{ marginBottom: 6 }}>
        {t('expenses.hint')}
      </div>

      {/* Formulaire création / édition */}
      {form && (
        <div className="exp-form" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select
              className="atext"
              value={form.category}
              onChange={(e) => setF({ category: e.target.value as ProjectExpenseCategory })}
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {catLabel(c)}
                </option>
              ))}
            </select>
            <input
              className="atext grow"
              placeholder={t('expenses.labelPlaceholder')}
              value={form.label}
              onChange={(e) => setF({ label: e.target.value })}
              style={{ minWidth: 160 }}
            />
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <label className="bud-cell">
              <span className="bud-cap">{t('expenses.cost', { currency })}</span>
              <input className="atext mono" inputMode="decimal" value={form.amount} onChange={(e) => setF({ amount: e.target.value })} placeholder="0" style={{ width: 90 }} />
            </label>
            {billable && (
              <label className="bud-cell">
                <span className="bud-cap">{t('expenses.rebilled', { currency })}</span>
                <input className="atext mono" inputMode="decimal" value={form.billAmount} onChange={(e) => setF({ billAmount: e.target.value })} placeholder="—" style={{ width: 90 }} />
              </label>
            )}
            <label className="bud-cell">
              <span className="bud-cap">{t('expenses.quantity')}</span>
              <input className="atext mono" inputMode="decimal" value={form.quantity} onChange={(e) => setF({ quantity: e.target.value })} style={{ width: 64 }} />
            </label>
            <label className="bud-cell">
              <span className="bud-cap">{t('expenses.statusCap')}</span>
              <select className="atext" value={form.status} onChange={(e) => setF({ status: e.target.value as ProjectExpenseStatus })}>
                {EXPENSE_STATUSES.map((s) => (
                  <option key={s} value={s}>{statusLbl(s)}</option>
                ))}
              </select>
            </label>
            <label className="bud-cell">
              <span className="bud-cap">{t('expenses.recurrenceCap')}</span>
              <select className="atext" value={form.recurrence} onChange={(e) => setF({ recurrence: e.target.value as ProjectExpenseRecurrence })}>
                {RECURRENCES.map((r) => (
                  <option key={r} value={r}>{recurLbl(r)}</option>
                ))}
              </select>
            </label>
          </div>
          {form.recurrence !== 'ONE_OFF' && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <label className="bud-cell">
                <span className="bud-cap">{t('expenses.startCap')}</span>
                <input className="atext" type="date" value={form.startDate} onChange={(e) => setF({ startDate: e.target.value })} />
              </label>
              <label className="bud-cell">
                <span className="bud-cap">{t('expenses.endCap')}</span>
                <input className="atext" type="date" value={form.endDate} onChange={(e) => setF({ endDate: e.target.value })} />
              </label>
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm btn-accent" onClick={save} disabled={saving}>
              {saving ? t('expenses.savingBtn') : form.id ? t('expenses.updateBtn') : t('expenses.addCostBtn')}
            </button>
            <button className="btn btn-sm btn-line" onClick={() => setForm(null)} disabled={saving}>
              {t('expenses.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Liste */}
      {items === null ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('expenses.loading')}</div>
      ) : items.length === 0 ? (
        <div className="md-span" style={{ color: 'var(--text-3)' }}>
          {t('expenses.empty')}
        </div>
      ) : (
        <div className="exp-table">
          {/* En-tête de colonnes */}
          <div className="exp-row exp-head" style={{ gridTemplateColumns: cols }}>
            <span>{t('expenses.colLabel')}</span>
            <span>{t('expenses.colCategory')}</span>
            <span style={{ textAlign: 'center' }}>{t('expenses.colStatus')}</span>
            <span style={{ textAlign: 'right' }}>{t('expenses.colEffectiveCost')}</span>
            {billable && <span style={{ textAlign: 'right' }}>{t('expenses.colRebilled')}</span>}
            <span />
          </div>
          {items.map((e) => (
            <div
              key={e.id}
              className="exp-row"
              style={{ gridTemplateColumns: cols }}
              title={e.description ?? ''}
            >
              <span className="exp-name truncate">
                {e.label}
                {e.recurrence !== 'ONE_OFF' && (
                  <span className="exp-recur">
                    {t('expenses.recurSuffix', { recurrence: recurLbl(e.recurrence), periods: e.periods })}
                  </span>
                )}
              </span>
              <span className="exp-cat truncate" title={catLabel(e.category)}>
                {catLabel(e.category)}
              </span>
              <span style={{ textAlign: 'center' }}>
                <span
                  className="exp-badge"
                  style={
                    e.status === 'INCURRED'
                      ? { color: 'oklch(0.5 0.13 155)', background: 'oklch(0.95 0.04 155)' }
                      : { color: 'oklch(0.5 0.1 255)', background: 'oklch(0.95 0.03 255)' }
                  }
                >
                  {statusLbl(e.status)}
                </span>
              </span>
              <span className="mono" style={{ textAlign: 'right' }} title={t('expenses.effectiveCostTitle')}>
                {fmtMoney(e.effectiveCost, currency)}
              </span>
              {billable && (
                <span
                  className="mono"
                  style={{ textAlign: 'right', color: 'var(--text-3)' }}
                  title={t('expenses.rebilledClientTitle')}
                >
                  {e.effectiveBill > 0 ? fmtMoney(e.effectiveBill, currency) : '—'}
                </span>
              )}
              <span className="exp-actions">
                {canManage && (
                  <>
                    <button className="icon-btn" title={t('expenses.editTitle')} onClick={() => openEdit(e)}>
                      <Icon name="pencil" size={13} />
                    </button>
                    <button className="icon-btn" title={t('expenses.deleteTitle')} onClick={() => setConfirmDel(e)}>
                      <Icon name="x" size={13} />
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
          <div className="exp-totals">
            <span>{t('expenses.totalIncurred')} <b>{fmtMoney(totalActual, currency)}</b></span>
            <span>{t('expenses.totalPlanned')} <b>{fmtMoney(totalPlanned, currency)}</b></span>
          </div>
        </div>
      )}

      {confirmDel && (
        <ConfirmDialog
          eyebrow={t('expenses.confirmDeleteEyebrow')}
          title={t('expenses.confirmDeleteTitle', { label: confirmDel.label })}
          confirmLabel={t('expenses.deleteTitle')}
          busyLabel={t('expenses.confirmDeleteBusy')}
          busy={deleting}
          onConfirm={() => remove(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        >
          <div className="md-span">
            {t('expenses.confirmDeleteBody', { amount: fmtMoney(confirmDel.effectiveCost, currency) })}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
