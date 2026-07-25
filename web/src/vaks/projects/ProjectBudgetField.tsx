/* ============================================================
   Vaks — Budget projet (réglage). Édité ici (réglages du projet),
   PAS depuis le rapport financier (lecture seule là-bas).
   Gardé finance:view (lecture) / finance:manage (édition).
   ============================================================ */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { fmtMoney, parseMoney } from './money';

interface Props {
  projectId: string;
  /** finance:manage — sinon lecture seule. */
  canManage: boolean;
  pushToast: (text: string, warn?: boolean) => void;
}

export function ProjectBudgetField({ projectId, canManage, pushToast }: Props) {
  const { t } = useTranslation('projects');
  const [currency, setCurrency] = useState('EUR');
  const [draft, setDraft] = useState('');
  const saved = useRef<string>('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getProjectRates(projectId)
      .then((r) => {
        if (!alive) return;
        setCurrency(r.currency);
        const v = r.budgetAmount != null ? String(r.budgetAmount) : '';
        setDraft(v);
        saved.current = v;
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, [projectId]);

  const save = async () => {
    if (!canManage || draft === saved.current) return;
    setSaving(true);
    try {
      await api.updateProjectBudget(projectId, { budgetAmount: parseMoney(draft) });
      saved.current = draft;
      pushToast(t('budget.updated'));
    } catch (e) {
      pushToast(t('budget.updateFailed', { message: (e as Error).message }), true);
      setDraft(saved.current); // rollback
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="md-field">
      <div className="md-label">{t('budget.label', { currency })}</div>
      <input
        className="atext"
        inputMode="decimal"
        value={draft}
        disabled={!canManage || saving || !loaded}
        placeholder={loaded ? '—' : '…'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        style={{ width: '100%' }}
      />
      <div className="md-hint">
        {canManage ? t('budget.hintManage') : t('budget.hintReadOnly')}
        {saved.current && t('budget.current', { amount: fmtMoney(Number(saved.current), currency) })}
      </div>
    </div>
  );
}
