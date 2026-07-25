/* ============================================================
   Vaks — Time off manager (modal)
   ----------------------------------------------------------------
   Permet aux Org Admins et Team Leads d'ajouter ou d'importer
   manuellement les jours de congés des utilisateurs pour que la
   vue Workload (capacité) en tienne compte. Volontairement minimal :
   l'outil n'est pas un SIRH — pas de workflow d'approbation, juste
   de la donnée brute.
   ============================================================ */
import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TimeOffDto, UserDto } from '@vaks-pm/shared';
import { TimeOffType } from '@vaks-pm/shared';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { api } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
  flash?: (msg: string, warn?: boolean) => void;
}

export function TimeOffManager({ open, onClose, onChanged, flash }: Props) {
  const { t } = useTranslation('workload');
  const confirm = useConfirm();
  const [users, setUsers] = useState<UserDto[]>([]);
  const [rows, setRows] = useState<TimeOffDto[]>([]);
  const [filterUserId, setFilterUserId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'list' | 'add' | 'import'>('list');

  useEffect(() => {
    if (!open) return;
    api.listUsers().then(setUsers).catch(() => setUsers([]));
    refresh();
  }, [open]);

  function refresh() {
    setLoading(true);
    api
      .listTimeOffs({})
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }

  const visibleRows = useMemo(
    () => (filterUserId ? rows.filter((r) => r.userId === filterUserId) : rows),
    [rows, filterUserId],
  );

  async function remove(id: string) {
    if (!(await confirm({ title: t('common:delete'), message: t('timeOff.deleteConfirm'), confirmLabel: t('common:delete'), danger: true }))) return;
    try {
      await api.deleteTimeOff(id);
      setRows((rs) => rs.filter((r) => r.id !== id));
      onChanged?.();
      flash?.(t('timeOff.deleted'));
    } catch (e) {
      flash?.(t('timeOff.failed', { message: (e as Error).message }), true);
    }
  }

  if (!open) return null;

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(820px, 96vw)' }}
      >
        <div className="md-head">
          <div className="anav-mark" style={{ width: 38, height: 38 }}>
            <Icon name="cal" size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('timeOff.eyebrow')}</div>
            <div className="md-title">{t('timeOff.title')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 0,
            borderBottom: '1px solid var(--border)',
            padding: '0 16px',
          }}
        >
          {(['list', 'add', 'import'] as const).map((tabKey) => (
            <button
              key={tabKey}
              className={'seg-btn' + (tab === tabKey ? ' seg-on' : '')}
              style={{ borderRadius: 0, border: 'none', padding: '10px 14px' }}
              onClick={() => setTab(tabKey)}
            >
              {t('timeOff.tab.' + tabKey)}
            </button>
          ))}
        </div>

        <div className="md-body" style={{ minHeight: 300 }}>
          {tab === 'list' && (
            <ListTab
              rows={visibleRows}
              users={users}
              filterUserId={filterUserId}
              setFilterUserId={setFilterUserId}
              loading={loading}
              onDelete={remove}
            />
          )}
          {tab === 'add' && (
            <AddTab
              users={users}
              onCreated={() => {
                refresh();
                onChanged?.();
                flash?.(t('timeOff.added'));
                setTab('list');
              }}
              flash={flash}
            />
          )}
          {tab === 'import' && (
            <ImportTab
              onImported={() => {
                refresh();
                onChanged?.();
              }}
              flash={flash}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ListTab({
  rows,
  users,
  filterUserId,
  setFilterUserId,
  loading,
  onDelete,
}: {
  rows: TimeOffDto[];
  users: UserDto[];
  filterUserId: string;
  setFilterUserId: (v: string) => void;
  loading: boolean;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation('workload');
  return (
    <div>
      <div className="md-field">
        <div className="md-label">{t('timeOff.list.filterByUser')}</div>
        <div className="asel" style={{ width: 320 }}>
          <select
            value={filterUserId}
            onChange={(e) => setFilterUserId(e.target.value)}
            style={{ width: '100%' }}
          >
            <option value="">{t('timeOff.list.allUsers')}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
          <span className="asel-chev">
            <Icon name="chevDown" size={15} />
          </span>
        </div>
      </div>
      {loading && <div className="md-span">{t('common:loading')}</div>}
      {!loading && rows.length === 0 && <div className="md-span">{t('timeOff.list.empty')}</div>}
      {!loading && rows.length > 0 && (
        <table style={{ width: '100%', fontSize: 13, marginTop: 10 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-3)' }}>
              <th style={{ padding: '6px 4px' }}>{t('timeOff.list.colUser')}</th>
              <th style={{ padding: '6px 4px' }}>{t('timeOff.list.colFrom')}</th>
              <th style={{ padding: '6px 4px' }}>{t('timeOff.list.colTo')}</th>
              <th style={{ padding: '6px 4px' }}>{t('timeOff.list.colType')}</th>
              <th style={{ padding: '6px 4px' }}>{t('timeOff.list.colSource')}</th>
              <th style={{ padding: '6px 4px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 4px' }}>
                  {r.user?.name ?? r.userId.slice(0, 8)}
                </td>
                <td className="mono" style={{ padding: '6px 4px' }}>
                  {r.startDate}
                </td>
                <td className="mono" style={{ padding: '6px 4px' }}>
                  {r.endDate}
                </td>
                <td style={{ padding: '6px 4px' }}>
                  {t('timeOffType.' + r.type, { defaultValue: r.type })}
                </td>
                <td className="mono" style={{ padding: '6px 4px', color: 'var(--text-3)' }}>
                  {r.source ?? 'MANUAL'}
                </td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                  <button className="icon-btn" onClick={() => onDelete(r.id)} title={t('common:delete')}>
                    <Icon name="x" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AddTab({
  users,
  onCreated,
  flash,
}: {
  users: UserDto[];
  onCreated: () => void;
  flash?: (msg: string, warn?: boolean) => void;
}) {
  const { t } = useTranslation('workload');
  const [userId, setUserId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [type, setType] = useState<TimeOffType>(TimeOffType.VACATION);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!userId || !startDate || !endDate) {
      flash?.(t('timeOff.add.selectUserAndDates'), true);
      return;
    }
    setSaving(true);
    try {
      await api.createTimeOff({
        userId,
        startDate,
        endDate,
        type,
        notes: notes || undefined,
      });
      onCreated();
    } catch (e) {
      flash?.(t('timeOff.failed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="md-field">
        <div className="md-label">{t('timeOff.add.user')}</div>
        <div className="asel" style={{ width: '100%' }}>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: '100%' }}>
            <option value="">{t('timeOff.add.choose')}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
          <span className="asel-chev">
            <Icon name="chevDown" size={15} />
          </span>
        </div>
      </div>
      <div className="md-field" style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="md-label">{t('timeOff.add.from')}</div>
          <input
            type="date"
            className="atext"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div className="md-label">{t('timeOff.add.to')}</div>
          <input
            type="date"
            className="atext"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="md-field">
        <div className="md-label">{t('timeOff.add.type')}</div>
        <div className="asel" style={{ width: 240 }}>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as TimeOffType)}
            style={{ width: '100%' }}
          >
            {Object.values(TimeOffType).map((tv) => (
              <option key={tv} value={tv}>
                {t('timeOffType.' + tv, { defaultValue: tv })}
              </option>
            ))}
          </select>
          <span className="asel-chev">
            <Icon name="chevDown" size={15} />
          </span>
        </div>
      </div>
      <div className="md-field">
        <div className="md-label">{t('timeOff.add.notes')}</div>
        <input
          className="atext"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={saving} onClick={save}>
          {saving ? t('common:saving') : t('common:add')}
        </button>
      </div>
    </div>
  );
}

function ImportTab({
  onImported,
  flash,
}: {
  onImported: () => void;
  flash?: (msg: string, warn?: boolean) => void;
}) {
  const { t } = useTranslation('workload');
  const [csv, setCsv] = useState('');
  const [dateFormat, setDateFormat] = useState<'' | 'iso' | 'eu' | 'us'>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    errors: { index: number; reason: string }[];
  } | null>(null);

  function handleFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(f);
  }

  async function submit() {
    if (!csv.trim()) {
      flash?.(t('timeOff.import.emptyCsv'), true);
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await api.importTimeOffsCsv({
        csv,
        dateFormat: dateFormat || undefined,
      });
      setResult({ created: r.created, updated: r.updated, errors: r.errors });
      onImported();
      flash?.(
        t('timeOff.import.summary', {
          created: r.created,
          updated: r.updated,
          errors: r.errors.length,
        }),
      );
    } catch (e) {
      flash?.(t('timeOff.failed', { message: (e as Error).message }), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="md-span" style={{ marginBottom: 12 }}>
        <Trans
          i18nKey="timeOff.import.columns"
          ns="workload"
          components={[
            <code key="0" />,
            <code key="1" />,
            <code key="2" />,
            <code key="3" />,
            <code key="4" />,
            <code key="5" />,
            <code key="6" />,
            <code key="7" />,
          ]}
        />
      </div>
      <div className="md-field">
        <div className="md-label">{t('timeOff.import.file')}</div>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </div>
      <div className="md-field">
        <div className="md-label">{t('timeOff.import.dateFormat')}</div>
        <div className="asel" style={{ width: 280 }}>
          <select
            value={dateFormat}
            onChange={(e) => setDateFormat(e.target.value as never)}
            style={{ width: '100%' }}
          >
            <option value="">{t('timeOff.import.dateFormatAuto')}</option>
            <option value="iso">{t('timeOff.import.dateFormatIso')}</option>
            <option value="eu">{t('timeOff.import.dateFormatEu')}</option>
            <option value="us">{t('timeOff.import.dateFormatUs')}</option>
          </select>
          <span className="asel-chev">
            <Icon name="chevDown" size={15} />
          </span>
        </div>
        <div className="md-span">
          <Trans i18nKey="timeOff.import.isoAlwaysAccepted" ns="workload" components={[<code key="0" />]} />
        </div>
      </div>
      <div className="md-field">
        <div className="md-label">{t('timeOff.import.preview')}</div>
        <textarea
          className="atext mono"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          style={{ width: '100%', minHeight: 140, fontSize: 12 }}
          placeholder={'employeeId,startDate,endDate,type\nEMP-001,01/07/2026,15/07/2026,VACATION'}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {busy ? t('timeOff.import.running') : t('timeOff.import.run')}
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 16, fontSize: 13 }}>
          <div>
            <Trans
              i18nKey="timeOff.import.result"
              ns="workload"
              values={{
                created: result.created,
                updated: result.updated,
                errors: result.errors.length,
              }}
              components={[<strong key="0" />, <strong key="1" />, <strong key="2" />]}
            />
          </div>
          {result.errors.length > 0 && (
            <ul style={{ marginTop: 6, color: 'oklch(0.75 0.18 25)' }}>
              {result.errors.slice(0, 20).map((e, i) => (
                <li key={i}>
                  {t('timeOff.import.lineError', { line: e.index + 1, reason: e.reason })}
                </li>
              ))}
              {result.errors.length > 20 && (
                <li>{t('timeOff.import.andMore', { count: result.errors.length - 20 })}</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
