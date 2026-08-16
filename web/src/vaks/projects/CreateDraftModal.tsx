/* ============================================================
   Vaks — Projects panel : wizard de création / duplication de draft
   ============================================================ */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Icon } from '../primitives';
import { api } from '../../api/client';
import type { ProjectDto } from '@vaks-pm/shared';
import { StatusPill, colorFromKey, useEscapeKey } from './shared';
import { parseMoney } from './money';
import { useAuth } from '../../auth/AuthContext';

/* ============================ Copy-source picker ============================ */

interface CopyPickerModalProps {
  projects: ProjectDto[];
  onClose: () => void;
  onPick: (p: ProjectDto) => void;
}

export function CopyPickerModal({ projects, onClose, onPick }: CopyPickerModalProps) {
  const { t } = useTranslation('projects');
  const { t: tc } = useTranslation('common');
  const [query, setQuery] = useState('');
  useEscapeKey(onClose);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q),
    );
  }, [projects, query]);

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(560px, 100%)' }}
      >
        <div className="md-head">
          <div
            className="anav-mark"
            style={{
              width: 38,
              height: 38,
              background: `oklch(0.95 0.05 200)`,
              color: `oklch(0.5 0.13 200)`,
            }}
          >
            <Icon name="settings" size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('create.duplicateEyebrow')}</div>
            <div className="md-title">{t('create.pickToCopy')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={tc('close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="md-body">
          <div className="md-span" style={{ marginBottom: 10 }}>
            <Trans t={t} i18nKey="create.copyIntro" components={[<b />]} />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--r-sm)',
              marginBottom: 8,
            }}
          >
            <Icon name="search" size={13} style={{ color: 'var(--text-3)' }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('create.searchPlaceholder')}
              style={{
                border: 0,
                background: 'transparent',
                outline: 'none',
                width: '100%',
                fontSize: 13,
                color: 'var(--text)',
                fontFamily: 'inherit',
              }}
            />
          </div>
          <div style={{ display: 'grid', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
            {filtered.map((p) => {
              const hue = colorFromKey(p.key);
              return (
                <button
                  key={p.id}
                  className="dd-item"
                  onClick={() => onPick(p)}
                  style={{ alignItems: 'center', padding: 8, gap: 10 }}
                >
                  <span
                    className="pj-key mono"
                    style={{
                      background: `oklch(0.55 0.15 ${hue})`,
                      width: 32,
                      height: 32,
                      flexShrink: 0,
                    }}
                  >
                    {p.key}
                  </span>
                  <span className="grow" style={{ minWidth: 0, textAlign: 'left' }}>
                    <div className="truncate" style={{ fontWeight: 500 }}>
                      {p.name}
                    </div>
                    <div className="truncate" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {p.description || t('create.noDescription')}
                    </div>
                  </span>
                  <StatusPill status={p.status} />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="md-empty" style={{ padding: 12 }}>
                {projects.length === 0
                  ? t('create.noProjectToCopy')
                  : t('create.noProjectMatches', { query })}
              </div>
            )}
          </div>
        </div>

        <div className="md-foot">
          <div className="md-foot-meta">
            {t('create.ofProjects', { shown: filtered.length, total: projects.length, count: projects.length })}
          </div>
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose}>
              {tc('cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ Create draft wizard ============================ */

interface CreateDraftModalProps {
  onClose: () => void;
  onCreated: (p: ProjectDto) => void;
  pushToast: (text: string, warn?: boolean) => void;
  /** Liste réelle des projets visibles (détection de collision de clé). */
  existingProjects: ProjectDto[];
  /** Source project to clone from. When set, the modal title/CTA shift to
   *  "copy mode", description + client + billable are pre-filled, and submit
   *  hits `POST /projects/:id/copy` instead of `POST /projects`. */
  copyFrom?: ProjectDto | null;
}

export function CreateDraftModal({
  onClose,
  onCreated,
  pushToast,
  existingProjects,
  copyFrom,
}: CreateDraftModalProps) {
  const { t } = useTranslation('projects');
  const { t: tc } = useTranslation('common');
  const isCopy = !!copyFrom;
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState(copyFrom?.description ?? '');
  const [clientId, setClientId] = useState<string>(copyFrom?.clientId ?? '');
  const [clients, setClients] = useState<Array<{ id: string; name: string; company: string | null }>>([]);
  const [creating, setCreating] = useState(false);
  const [billable, setBillable] = useState<boolean>(copyFrom?.billable ?? true);
  const [caps, setCaps] = useState<{ canBillable: boolean; canNonBillable: boolean } | null>(null);
  const { can } = useAuth();
  const canBudget = can('finance:manage');
  const [budget, setBudget] = useState('');
  useEscapeKey(onClose, !creating);

  useEffect(() => {
    let cancelled = false;
    api
      .listClients({ pageSize: 200 })
      .then((r) => {
        if (cancelled) return;
        setClients(r.items.map((x) => ({ id: x.id, name: x.name, company: x.company })));
      })
      .catch(() => {
        // listing clients exige client:view — silencieux si non autorisé
      });
    api
      .getProjectCreationCapabilities()
      .then((c) => {
        if (cancelled) return;
        setCaps(c);
        // Si l'user ne peut faire que du non-facturable, défaut là.
        if (!c.canBillable && c.canNonBillable) setBillable(false);
      })
      .catch(() => {
        if (!cancelled) setCaps({ canBillable: true, canNonBillable: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const keyValid = /^[A-Z0-9]{2,3}$/.test(key);
  // Soft warning : un autre projet utilise déjà ce trigramme. Pas bloquant —
  // l'unicité n'est pas garantie côté API (cf. schema.prisma). On laisse créer
  // mais on prévient pour éviter les ambiguïtés visuelles (deux projets `LIFE`
  // afficheraient tous les deux `LIFE-12` sur leurs tâches). Détection sur la
  // liste RÉELLE chargée depuis l'API (pas le store mock).
  const keyCollision =
    keyValid && existingProjects.some((p) => p.key.toUpperCase() === key);
  const allowedKind = billable ? caps?.canBillable !== false : caps?.canNonBillable !== false;
  const canSubmit = keyValid && name.trim().length > 0 && !creating && allowedKind;

  async function submit() {
    setCreating(true);
    try {
      const payload = {
        key,
        name: name.trim(),
        description: description.trim() || undefined,
        clientId: clientId || null,
        billable,
      };
      const project = isCopy
        ? await api.copyProject(copyFrom!.id, payload)
        : await api.createProject(payload);
      // Budget optionnel (finance:manage) — posé après création (best-effort).
      const budgetAmount = parseMoney(budget);
      if (canBudget && budgetAmount != null) {
        await api
          .updateProjectBudget(project.id, { budgetAmount })
          .catch((e) => pushToast(t('create.budgetNotSaved', { message: (e as Error).message }), true));
      }
      pushToast(
        isCopy
          ? t('create.copied', { from: copyFrom!.key, to: project.key })
          : billable
            ? t('create.draftCreated', { key: project.key })
            : t('create.draftCreatedNonBillable', { key: project.key }),
      );
      onCreated(project);
    } catch (e) {
      pushToast(
        isCopy
          ? t('create.copyFailed', { message: (e as Error).message })
          : t('create.createFailed', { message: (e as Error).message }),
        true,
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="md-overlay" onMouseDown={() => !creating && onClose()}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(520px, 100%)' }}
      >
        <div className="md-head">
          <div
            className="anav-mark"
            style={{
              width: 38,
              height: 38,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
            }}
          >
            <Icon name="plus" size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{isCopy ? t('create.copyOfEyebrow', { key: copyFrom!.key }) : t('create.initiationEyebrow')}</div>
            <div className="md-title">{isCopy ? t('create.duplicateTitle', { name: copyFrom!.name }) : t('create.newDraftTitle')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={tc('close')} disabled={creating}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="md-body">
          <div className="md-span" style={{ marginBottom: 12 }}>
            {billable ? t('create.introBillable') : t('create.introNonBillable')}
          </div>

          <div className="md-field">
            <div className="md-label">{t('create.projectType')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { v: true, label: t('create.typeBillable'), desc: t('create.typeBillableDesc'), cap: caps?.canBillable !== false },
                { v: false, label: t('create.typeNonBillable'), desc: t('create.typeNonBillableDesc'), cap: caps?.canNonBillable !== false },
              ] as const).map((opt) => {
                const on = billable === opt.v;
                return (
                  <button
                    key={String(opt.v)}
                    type="button"
                    disabled={!opt.cap || creating}
                    onClick={() => setBillable(opt.v)}
                    title={opt.cap ? '' : t('create.notAllowedByPolicy')}
                    style={{
                      flex: 1,
                      padding: '10px 12px',
                      textAlign: 'left',
                      borderRadius: 'var(--r-md)',
                      border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                      background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                      color: on ? 'var(--accent)' : 'var(--text-1)',
                      cursor: opt.cap ? 'pointer' : 'not-allowed',
                      opacity: opt.cap ? 1 : 0.5,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{opt.label}</div>
                    <div style={{ fontSize: 11, marginTop: 2, color: on ? 'var(--accent)' : 'var(--text-3)' }}>{opt.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="md-field">
            <div className="md-label">
              {t('create.keyLabel')}{' '}
              <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
                {t('create.keyHint')}
              </span>
            </div>
            <input
              className="atext mono"
              value={key}
              maxLength={3}
              onChange={(e) =>
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3))
              }
              placeholder={t('create.keyPlaceholder')}
              style={{ width: '100%', textTransform: 'uppercase' }}
            />
            {!keyValid && key.length > 0 && (
              <div className="md-warn">
                <Icon name="warn" size={13} /> {t('create.keyInvalid')}
              </div>
            )}
            {keyCollision && (
              <div className="md-warn">
                <Icon name="warn" size={13} />{' '}
                <Trans t={t} i18nKey="create.keyCollision" values={{ key }} components={[<span className="mono" />]} />
              </div>
            )}
          </div>

          <div className="md-field">
            <div className="md-label">{t('create.nameLabel')}</div>
            <input
              className="atext"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('create.namePlaceholder')}
              style={{ width: '100%' }}
            />
          </div>

          <div className="md-field">
            <div className="md-label">{t('create.descLabel')}</div>
            <textarea
              className="atext"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          {clients.length > 0 && (
            <div className="md-field">
              <div className="md-label">{t('create.clientLabel')}</div>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: 'var(--text)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)',
                  padding: '8px 10px',
                  cursor: 'pointer',
                  outline: 'none',
                  width: '100%',
                }}
              >
                <option value="">{t('create.noClient')}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company ? ` (${c.company})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {canBudget && (
            <div className="md-field">
              <div className="md-label">{t('create.budgetLabel')}</div>
              <input
                className="atext mono"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder={t('create.budgetPlaceholder')}
                style={{ width: '100%' }}
              />
            </div>
          )}
        </div>

        <div className="md-foot">
          <div className="md-foot-meta">{t('create.statusWillBe')} <b>{t('status.DRAFT')}</b></div>
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={creating}>
              {tc('cancel')}
            </button>
            <button className="btn btn-accent" disabled={!canSubmit} onClick={submit}>
              {creating
                ? isCopy
                  ? t('create.copying')
                  : t('create.creating')
                : isCopy
                  ? t('create.duplicateCta')
                  : billable
                    ? t('create.createCta')
                    : t('create.createCtaNonBillable')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
