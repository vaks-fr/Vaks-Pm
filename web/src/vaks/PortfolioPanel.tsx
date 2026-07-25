/* ============================================================
   Vaks — Portfolio panel
   Grid of clients (with contact / project counts) + Manage modal
   for editing client fields and managing their contacts.
   Visibility gated by `client:view` permission (ORG_ADMIN /
   PORTFOLIO_MANAGER) ; mutations gated by `client:manage`
   (boutons masqués + modal en lecture seule sinon).
   Liste paginée côté serveur (12/page) ; la recherche couvre
   nom / société / email / téléphone + noms de contacts.
   ============================================================ */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './primitives';
import { api } from '../api/client';
import { ClientStatus, type ClientDto, type ContactDto } from '@vaks-pm/shared';
import { useAuth } from '../auth/AuthContext';
import { useEscapeKey, ConfirmDialog } from './projects/shared';

type ClientRow = ClientDto;

const PAGE_SIZE = 12;

const CLIENT_STATUS_META: Record<ClientStatus, { i18nKey: string; hue: number }> = {
  [ClientStatus.PROSPECT]: { i18nKey: 'prospect', hue: 50 },
  [ClientStatus.ACTIVE]: { i18nKey: 'active', hue: 155 },
  [ClientStatus.ARCHIVED]: { i18nKey: 'archived', hue: 25 },
};
const CLIENT_STATUS_OPTIONS: ClientStatus[] = [
  ClientStatus.PROSPECT,
  ClientStatus.ACTIVE,
  ClientStatus.ARCHIVED,
];

function ClientStatusPill({ status }: { status: ClientStatus }) {
  const { t } = useTranslation('finances');
  const s = CLIENT_STATUS_META[status] ?? CLIENT_STATUS_META[ClientStatus.ACTIVE];
  return (
    <span
      className="pj-status"
      style={{ color: `oklch(0.5 0.13 ${s.hue})`, background: `oklch(0.95 0.05 ${s.hue})` }}
    >
      <span className="pj-status-dot" style={{ background: `oklch(0.62 0.16 ${s.hue})` }} />
      {t('finances:clients.status.' + s.i18nKey)}
    </span>
  );
}

function colorFromKey(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/* ============================ Card ============================ */

function ClientCard({
  c,
  canManage,
  onManage,
}: {
  c: ClientRow;
  canManage: boolean;
  onManage: (c: ClientRow) => void;
}) {
  const { t } = useTranslation('finances');
  const hue = colorFromKey(c.name);
  return (
    <div className="pj-card">
      <div className="pj-card-top">
        <div
          className="pj-key mono"
          style={{ background: `oklch(0.55 0.15 ${hue})`, fontSize: 13 }}
        >
          {initialsOf(c.name) || '?'}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="pj-name truncate">{c.name}</div>
          <div className="pj-sub truncate">
            {c.company ? c.company : c.email ? c.email : t('finances:clients.clientFallback')}
          </div>
        </div>
        <ClientStatusPill status={c.status} />
      </div>

      {c.primaryContact ? (
        <p className="pj-desc truncate" title={t('finances:clients.card.primaryContactTitle')}>
          <Icon name="user" size={12} style={{ color: 'var(--text-3)', marginRight: 4 }} />
          {c.primaryContact.name}
          {c.primaryContact.title ? ` · ${c.primaryContact.title}` : ''}
        </p>
      ) : (
        c.notes && <p className="pj-desc">{c.notes}</p>
      )}

      <div className="pj-card-foot">
        <div className="pj-dates" style={{ flexWrap: 'wrap' }}>
          <span title={t('finances:clients.card.contactsTitle')}>
            <Icon name="user" size={13} style={{ color: 'var(--text-3)' }} /> {c.contactCount ?? 0}
          </span>
          <span title={t('finances:clients.card.projectsTitle')} style={{ marginLeft: 10 }}>
            <Icon name="board" size={13} style={{ color: 'var(--text-3)' }} /> {c.projectCount ?? 0}
          </span>
          {c.email && (
            <span style={{ marginLeft: 10, color: 'var(--text-3)' }} className="truncate">
              {c.email}
            </span>
          )}
        </div>
      </div>

      <button className="pj-manage" onClick={() => onManage(c)}>
        <Icon name={canManage ? 'settings' : 'search'} size={15} />{' '}
        {canManage ? t('finances:clients.manageClient') : t('finances:clients.viewClient')}
      </button>
    </div>
  );
}

/* ============================ Manage modal ============================ */

interface Draft {
  name: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  status: ClientStatus;
  /** Allowlist de modèles d'agent IA, saisie comme texte (séparé par virgule). */
  allowedAgentModels: string;
}

function ManageClientModal({
  client,
  canManage,
  onClose,
  onSaved,
  onDeleted,
  pushToast,
}: {
  client: ClientRow;
  canManage: boolean;
  onClose: () => void;
  onSaved: (c: ClientRow) => void;
  onDeleted: (id: string) => void;
  pushToast: (text: string, warn?: boolean) => void;
}) {
  const { t } = useTranslation('finances');
  const [draft, setDraft] = useState<Draft>({
    name: client.name,
    company: client.company ?? '',
    email: client.email ?? '',
    phone: client.phone ?? '',
    address: client.address ?? '',
    notes: client.notes ?? '',
    status: client.status ?? ClientStatus.ACTIVE,
    allowedAgentModels: (client.allowedAgentModels ?? []).join(', '),
  });
  const [saving, setSaving] = useState(false);
  const [clientTab, setClientTab] = useState<'general' | 'ia'>('general');
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [projects, setProjects] = useState<
    Array<{ id: string; key: string; name: string; status: string }>
  >([]);
  const [addingContact, setAddingContact] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmAnonClient, setConfirmAnonClient] = useState(false);
  const [anonContact, setAnonContact] = useState<{ id: string; name: string } | null>(null);

  useEscapeKey(onClose, !confirmDelete && !confirmAnonClient && !anonContact && !saving);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const refresh = useCallback(async () => {
    try {
      const full = await api.getClient(client.id);
      setContacts(full.contacts ?? []);
      setProjects(full.projects ?? []);
      // Tient les compteurs de la carte à jour quand les contacts changent.
      onSaved({
        ...client,
        contactCount: (full.contacts ?? []).length,
        projectCount: (full.projects ?? []).length,
        primaryContact:
          (full.contacts ?? []).find((ct) => ct.isPrimary) ?? null,
      });
    } catch (e) {
      pushToast(t('finances:clients.modal.loadFailed', { message: (e as Error).message }), true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id, pushToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setSaving(true);
    try {
      const next = await api.updateClient(client.id, {
        name: draft.name !== client.name ? draft.name : undefined,
        company: draft.company !== (client.company ?? '') ? draft.company || null : undefined,
        email: draft.email !== (client.email ?? '') ? draft.email || null : undefined,
        phone: draft.phone !== (client.phone ?? '') ? draft.phone || null : undefined,
        address: draft.address !== (client.address ?? '') ? draft.address || null : undefined,
        notes: draft.notes !== (client.notes ?? '') ? draft.notes || null : undefined,
        status: draft.status !== client.status ? draft.status : undefined,
        allowedAgentModels:
          draft.allowedAgentModels !== (client.allowedAgentModels ?? []).join(', ')
            ? draft.allowedAgentModels.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
            : undefined,
      });
      onSaved({ ...client, ...next });
      pushToast(t('finances:clients.modal.updated', { name: next.name }));
      onClose();
    } catch (e) {
      pushToast(t('finances:clients.modal.saveFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  }

  async function removeClient() {
    setSaving(true);
    try {
      await api.deleteClient(client.id);
      onDeleted(client.id);
      pushToast(t('finances:clients.modal.removed', { name: client.name }));
      onClose();
    } catch (e) {
      pushToast(t('finances:clients.modal.deleteFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
      setConfirmDelete(false);
    }
  }

  /** RGPD : blanchit les coordonnées PII du client (garde le nom du compte). */
  async function anonymizeClient() {
    setSaving(true);
    try {
      await api.anonymizeClient(client.id);
      await refresh();
      setConfirmAnonClient(false);
      pushToast(
        t('finances:clients.modal.anonymized', {
          defaultValue: 'Coordonnées de {{name}} anonymisées',
          name: client.name,
        }),
      );
    } catch (e) {
      pushToast(t('finances:clients.modal.deleteFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  }

  /** RGPD : anonymise entièrement un contact (personne). */
  async function anonymizeContact(contactId: string) {
    setSaving(true);
    try {
      await api.anonymizeContact(client.id, contactId);
      await refresh();
      setAnonContact(null);
      pushToast(t('finances:clients.modal.contactAnonymized', { defaultValue: 'Contact anonymisé' }));
    } catch (e) {
      pushToast(t('finances:clients.modal.contactDeleteFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  }

  const hue = colorFromKey(client.name);
  const ro = !canManage;

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="md-head">
          <div
            className="pj-key mono"
            style={{ background: `oklch(0.55 0.15 ${hue})`, width: 38, height: 38, fontSize: 13 }}
          >
            {initialsOf(client.name) || '?'}
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{canManage ? t('finances:clients.modal.manageEyebrow') : t('finances:clients.modal.clientEyebrow')}</div>
            <div className="md-title truncate">{client.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="md-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={clientTab === 'general'}
            className={'md-tab' + (clientTab === 'general' ? ' md-tab-on' : '')}
            onClick={() => setClientTab('general')}
          >
            <Icon name="board" size={14} />
            <span>{t('finances:clients.modal.tabGeneral', { defaultValue: 'General' })}</span>
          </button>
          <button
            role="tab"
            aria-selected={clientTab === 'ia'}
            className={'md-tab' + (clientTab === 'ia' ? ' md-tab-on' : '')}
            onClick={() => setClientTab('ia')}
          >
            <Icon name="zap" size={14} />
            <span>{t('finances:clients.modal.tabIa', { defaultValue: 'AI' })}</span>
          </button>
        </div>

        <div className="md-body">
          {clientTab === 'general' && (<>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.status')}</div>
            <div className="seg">
              {CLIENT_STATUS_OPTIONS.map((k) => (
                <button
                  key={k}
                  className={'seg-btn' + (draft.status === k ? ' seg-on' : '')}
                  disabled={ro}
                  onClick={() => set({ status: k })}
                >
                  {t('finances:clients.status.' + CLIENT_STATUS_META[k].i18nKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.name')}</div>
            <input
              className="atext"
              value={draft.name}
              disabled={ro}
              onChange={(e) => set({ name: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.company')}</div>
            <input
              className="atext"
              value={draft.company}
              disabled={ro}
              onChange={(e) => set({ company: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.email')}</div>
            <input
              className="atext"
              type="email"
              value={draft.email}
              disabled={ro}
              onChange={(e) => set({ email: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.phone')}</div>
            <input
              className="atext"
              value={draft.phone}
              disabled={ro}
              onChange={(e) => set({ phone: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.address')}</div>
            <textarea
              className="atext"
              value={draft.address}
              disabled={ro}
              onChange={(e) => set({ address: e.target.value })}
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.notes')}</div>
            <textarea
              className="atext"
              value={draft.notes}
              disabled={ro}
              onChange={(e) => set({ notes: e.target.value })}
              rows={3}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          {/* Contacts */}
          <div className="md-field">
            <div className="md-label row" style={{ justifyContent: 'space-between' }}>
              <span>
                {t('finances:clients.modal.contactsCount')} <span className="md-count">{contacts.length}</span>
              </span>
              {canManage && (
                <button
                  className="md-add"
                  onClick={() => {
                    setEditingContactId(null);
                    setAddingContact(true);
                  }}
                >
                  <Icon name="plus" size={14} /> {t('finances:clients.modal.addContact')}
                </button>
              )}
            </div>
            <div className="md-team">
              {contacts.map((ct) =>
                editingContactId === ct.id ? (
                  <ContactForm
                    key={ct.id}
                    initial={ct}
                    onCancel={() => setEditingContactId(null)}
                    onSubmit={async (dto) => {
                      try {
                        await api.updateContact(client.id, ct.id, dto);
                        await refresh();
                        setEditingContactId(null);
                        pushToast(t('finances:clients.modal.contactUpdated'));
                      } catch (e) {
                        pushToast(t('finances:clients.modal.contactUpdateFailed', { message: (e as Error).message }), true);
                      }
                    }}
                    onDelete={async () => {
                      try {
                        await api.deleteContact(client.id, ct.id);
                        await refresh();
                        setEditingContactId(null);
                        pushToast(t('finances:clients.modal.contactRemoved'));
                      } catch (e) {
                        pushToast(t('finances:clients.modal.contactDeleteFailed', { message: (e as Error).message }), true);
                      }
                    }}
                  />
                ) : (
                  <div key={ct.id} className="md-member">
                    <div
                      className="pj-key mono"
                      style={{
                        background: `oklch(0.55 0.15 ${colorFromKey(ct.name)})`,
                        width: 30,
                        height: 30,
                        fontSize: 11,
                      }}
                    >
                      {initialsOf(ct.name) || '?'}
                    </div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="md-member-name truncate">
                        {ct.isPrimary && (
                          <span title={t('finances:clients.modal.primaryContact')}>
                            <Icon
                              name="flag"
                              size={12}
                              style={{ color: 'var(--accent)', marginRight: 4 }}
                            />
                          </span>
                        )}
                        {ct.name}
                        {ct.title && (
                          <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>
                            {' · '}
                            {ct.title}
                          </span>
                        )}
                      </div>
                      <div className="md-member-role truncate">
                        {[ct.email, ct.phone].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                    {canManage && (
                      <>
                        <button
                          className="md-remove"
                          title={t('common:edit')}
                          onClick={() => {
                            setAddingContact(false);
                            setEditingContactId(ct.id);
                          }}
                          style={{ opacity: 0.6 }}
                        >
                          <Icon name="settings" size={14} />
                        </button>
                        <button
                          className="md-remove"
                          title={t('finances:clients.modal.anonymizeContact', { defaultValue: 'Anonymiser (RGPD)' })}
                          onClick={() => setAnonContact({ id: ct.id, name: ct.name })}
                          style={{ color: 'var(--accent)', opacity: 0.75 }}
                        >
                          <Icon name="shield" size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ),
              )}
              {addingContact && (
                <ContactForm
                  onCancel={() => setAddingContact(false)}
                  onSubmit={async (dto) => {
                    try {
                      await api.createContact(client.id, dto);
                      await refresh();
                      setAddingContact(false);
                      pushToast(t('finances:clients.modal.contactAdded'));
                    } catch (e) {
                      pushToast(t('finances:clients.modal.contactAddFailed', { message: (e as Error).message }), true);
                    }
                  }}
                />
              )}
              {contacts.length === 0 && !addingContact && (
                <div className="md-empty">{t('finances:clients.modal.noContact')}</div>
              )}
            </div>
          </div>

          {/* Projets rattachés */}
          <div className="md-field">
            <div className="md-label">
              {t('finances:clients.projects')} <span className="md-count">{projects.length}</span>
            </div>
            {projects.length === 0 ? (
              <div className="md-empty">{t('finances:clients.modal.noProjectLinked')}</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {projects.map((p) => (
                  <span key={p.id} className="skl-chip" title={p.status}>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        background: `oklch(0.55 0.15 ${colorFromKey(p.key)})`,
                        color: 'white',
                        padding: '1px 5px',
                        borderRadius: 3,
                      }}
                    >
                      {p.key}
                    </span>
                    <span className="truncate" style={{ maxWidth: 160 }}>
                      {p.name}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
          </>)}

          {clientTab === 'ia' && (
            <div className="md-field">
              <div className="md-label">
                {t('finances:clients.modal.allowedAgentModels', { defaultValue: 'Allowed AI agent models' })}
              </div>
              <input
                className="atext"
                value={draft.allowedAgentModels}
                disabled={ro}
                onChange={(e) => set({ allowedAgentModels: e.target.value })}
                placeholder="anthropic/claude-sonnet-5, anthropic/*"
                style={{ width: '100%' }}
              />
              <div className="md-hint" style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                {t('finances:clients.modal.allowedAgentModelsHint', {
                  defaultValue:
                    'Comma-separated provider/model (or provider/*). Empty = no restriction. AI agents whose model is not listed are refused from claiming this client’s tasks.',
                })}
              </div>
            </div>
          )}
        </div>

        <div className="md-foot">
          {canManage ? (
            <div className="row gap2">
              <button
                className="btn btn-ghost"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
                style={{ color: 'var(--c-over)' }}
              >
                <Icon name="x" size={14} /> {t('common:delete')}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setConfirmAnonClient(true)}
                disabled={saving}
                title={t('finances:clients.modal.anonymize', { defaultValue: 'Anonymiser (RGPD)' })}
                style={{
                  border: '1px solid color-mix(in oklch, var(--accent) 45%, var(--border))',
                  color: 'var(--accent)',
                  background: 'color-mix(in oklch, var(--accent) 12%, transparent)',
                }}
              >
                <Icon name="shield" size={14} />{' '}
                {t('finances:clients.modal.anonymize', { defaultValue: 'Anonymiser (RGPD)' })}
              </button>
            </div>
          ) : (
            <div />
          )}
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              {canManage ? t('common:cancel') : t('common:close')}
            </button>
            {canManage && (
              <button
                className="btn btn-accent"
                onClick={save}
                disabled={saving || !draft.name.trim()}
              >
                {saving ? t('common:saving') : t('finances:clients.modal.saveChanges')}
              </button>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <div
          className="md-overlay"
          onMouseDown={() => !saving && setConfirmDelete(false)}
          style={{ zIndex: 8000 }}
        >
          <div
            className="md-card"
            onMouseDown={(e) => e.stopPropagation()}
            style={{ width: 'min(420px, 100%)' }}
          >
            <div className="md-head">
              <div
                className="anav-mark"
                style={{
                  width: 38,
                  height: 38,
                  background: 'var(--c-over-bg)',
                  color: 'var(--c-over)',
                }}
              >
                <Icon name="warn" size={20} />
              </div>
              <div className="grow">
                <div className="md-eyebrow mono">{t('common:confirm')}</div>
                <div className="md-title truncate">{t('finances:clients.confirmDelete.title', { name: client.name })}</div>
              </div>
            </div>
            <div className="md-body">
              <div className="md-span">
                {t('finances:clients.confirmDelete.body')}
                {projects.length > 0 && (
                  projects.length > 1
                    ? t('finances:clients.confirmDelete.linkedMany', { count: projects.length })
                    : t('finances:clients.confirmDelete.linkedOne', { count: projects.length })
                )}
              </div>
            </div>
            <div className="md-foot">
              <div />
              <div className="row gap2">
                <button
                  className="btn btn-ghost"
                  disabled={saving}
                  onClick={() => setConfirmDelete(false)}
                >
                  {t('common:cancel')}
                </button>
                <button className="btn btn-danger btn-sm" disabled={saving} onClick={removeClient}>
                  {saving ? t('finances:clients.confirmDelete.removing') : t('common:delete')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmAnonClient && (
        <ConfirmDialog
          icon="shield"
          tone="accent"
          eyebrow={t('finances:clients.modal.anonymize', { defaultValue: 'Anonymiser (RGPD)' })}
          title={client.name}
          confirmLabel={t('finances:clients.modal.anonymize', { defaultValue: 'Anonymiser (RGPD)' })}
          busyLabel={t('common:saving')}
          busy={saving}
          onConfirm={anonymizeClient}
          onCancel={() => setConfirmAnonClient(false)}
        >
          <p style={{ margin: 0 }}>
            {t('finances:clients.modal.anonymizeConfirm', {
              defaultValue:
                'Anonymiser les coordonnées de « {{name}} » (email, téléphone, adresse, notes) ? Le nom du compte est conservé. Action irréversible.',
              name: client.name,
            })}
          </p>
        </ConfirmDialog>
      )}

      {anonContact && (
        <ConfirmDialog
          icon="shield"
          tone="accent"
          eyebrow={t('finances:clients.modal.anonymizeContact', { defaultValue: 'Anonymiser (RGPD)' })}
          title={anonContact.name}
          confirmLabel={t('finances:clients.modal.anonymizeContact', { defaultValue: 'Anonymiser (RGPD)' })}
          busyLabel={t('common:saving')}
          busy={saving}
          onConfirm={() => anonymizeContact(anonContact.id)}
          onCancel={() => setAnonContact(null)}
        >
          <p style={{ margin: 0 }}>
            {t('finances:clients.modal.anonymizeContactConfirm', {
              defaultValue:
                'Anonymiser définitivement le contact « {{name}} » ? Nom et coordonnées seront remplacés. Action irréversible.',
              name: anonContact.name,
            })}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/* ============================ Contact form ============================ */

function ContactForm({
  initial,
  onSubmit,
  onCancel,
  onDelete,
}: {
  initial?: ContactDto;
  onSubmit: (dto: {
    name: string;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
    isPrimary?: boolean;
  }) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const { t } = useTranslation('finances');
  const [name, setName] = useState(initial?.name ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [isPrimary, setIsPrimary] = useState(initial?.isPrimary ?? false);
  const [busy, setBusy] = useState(false);
  const canSubmit = name.trim().length > 0;

  return (
    <div
      style={{
        padding: 10,
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--surface-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <input
        className="atext"
        autoFocus
        placeholder={t('finances:clients.contactForm.namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="atext"
        placeholder={t('finances:clients.contactForm.titlePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <input
          className="atext"
          type="email"
          placeholder={t('finances:clients.contactForm.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="atext"
          placeholder={t('finances:clients.contactForm.phonePlaceholder')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      <textarea
        className="atext"
        rows={2}
        placeholder={t('finances:clients.contactForm.notesPlaceholder')}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ resize: 'vertical', fontFamily: 'inherit' }}
      />
      <label
        className="row gap1"
        style={{ alignItems: 'center', fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}
      >
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(e) => setIsPrimary(e.target.checked)}
        />
        {t('finances:clients.contactForm.primaryCheckbox')}
      </label>
      <div className="row gap2" style={{ justifyContent: 'flex-end' }}>
        {onDelete && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            style={{ color: 'var(--c-over)' }}
            onClick={async () => {
              setBusy(true);
              try {
                await onDelete();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('common:delete')}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
          {t('common:cancel')}
        </button>
        <button
          type="button"
          className="btn btn-accent btn-sm"
          disabled={!canSubmit || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit({
                name: name.trim(),
                title: title.trim() || null,
                email: email.trim() || null,
                phone: phone.trim() || null,
                notes: notes.trim() || null,
                isPrimary,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('common:saving') : initial ? t('common:save') : t('common:add')}
        </button>
      </div>
    </div>
  );
}

/* ============================ New client modal ============================ */

function NewClientModal({
  onClose,
  onCreated,
  pushToast,
}: {
  onClose: () => void;
  onCreated: (c: ClientRow) => void;
  pushToast: (text: string, warn?: boolean) => void;
}) {
  const { t } = useTranslation('finances');
  const [draft, setDraft] = useState<Draft>({
    name: '',
    company: '',
    email: '',
    phone: '',
    address: '',
    notes: '',
    status: ClientStatus.ACTIVE,
    allowedAgentModels: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  useEscapeKey(onClose, !saving);

  async function create() {
    setSaving(true);
    try {
      const c = await api.createClient({
        name: draft.name.trim(),
        company: draft.company.trim() || null,
        email: draft.email.trim() || null,
        phone: draft.phone.trim() || null,
        address: draft.address.trim() || null,
        notes: draft.notes.trim() || null,
        status: draft.status,
      });
      onCreated({ ...c, contactCount: 0, projectCount: 0 });
      pushToast(t('finances:clients.newModal.created', { name: c.name }));
      onClose();
    } catch (e) {
      pushToast(t('finances:clients.newModal.createFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div className="md-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="md-head">
          <div
            className="anav-mark"
            style={{ width: 38, height: 38, background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <Icon name="plus" size={20} />
          </div>
          <div className="grow">
            <div className="md-eyebrow mono">{t('finances:clients.newModal.eyebrow')}</div>
            <div className="md-title">{t('finances:clients.newModal.title')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          <div className="md-field">
            <div className="md-label">{t('finances:clients.newModal.namePlaceholder')}</div>
            <input
              className="atext"
              autoFocus
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.status')}</div>
            <div className="seg">
              {CLIENT_STATUS_OPTIONS.map((k) => (
                <button
                  key={k}
                  className={'seg-btn' + (draft.status === k ? ' seg-on' : '')}
                  onClick={() => set({ status: k })}
                >
                  {t('finances:clients.status.' + CLIENT_STATUS_META[k].i18nKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.company')}</div>
            <input
              className="atext"
              value={draft.company}
              onChange={(e) => set({ company: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="md-field">
              <div className="md-label">{t('finances:clients.modal.email')}</div>
              <input
                className="atext"
                type="email"
                value={draft.email}
                onChange={(e) => set({ email: e.target.value })}
              />
            </div>
            <div className="md-field">
              <div className="md-label">{t('finances:clients.modal.phone')}</div>
              <input
                className="atext"
                value={draft.phone}
                onChange={(e) => set({ phone: e.target.value })}
              />
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.address')}</div>
            <textarea
              className="atext"
              rows={2}
              value={draft.address}
              onChange={(e) => set({ address: e.target.value })}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('finances:clients.modal.notes')}</div>
            <textarea
              className="atext"
              rows={3}
              value={draft.notes}
              onChange={(e) => set({ notes: e.target.value })}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        </div>
        <div className="md-foot">
          <div />
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              {t('common:cancel')}
            </button>
            <button
              className="btn btn-accent"
              onClick={create}
              disabled={saving || !draft.name.trim()}
            >
              {saving ? t('finances:clients.newModal.creating') : t('finances:clients.newModal.createClient')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ Panel root ============================ */

export interface PortfolioPanelProps {
  pushToast: (text: string, warn?: boolean) => void;
}

export function PortfolioPanel({ pushToast }: PortfolioPanelProps) {
  const { t } = useTranslation('finances');
  const { can } = useAuth();
  const canManage = can('client:manage');
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ClientStatus | ''>('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Recherche déboucée (300 ms) → requête serveur.
  const [query, setQuery] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listClients({
        search: query || undefined,
        status: statusFilter || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setClients(r.items);
      setTotal(r.total);
      setError(null);
      // Page devenue vide (ex. dernier client de la page supprimé) → recule.
      if (r.items.length === 0 && r.total > 0 && page > 1) {
        setPage(Math.max(1, Math.ceil(r.total / PAGE_SIZE)));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter, page]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const managed = clients.find((c) => c.id === manageId) ?? null;

  async function importCsvFile(file: File) {
    setImporting(true);
    try {
      const text = await file.text();
      const res = await api.importClientsCsv(text);
      const errPart = res.errors.length
        ? t('finances:clients.toolbar.importErrorSuffix', { count: res.errors.length, line: res.errors[0].line, error: res.errors[0].error })
        : '';
      pushToast(
        t('finances:clients.toolbar.importResult', { created: res.created, updated: res.updated, errors: errPart }),
        res.errors.length > 0,
      );
      await refresh();
    } catch (e) {
      pushToast(t('finances:clients.toolbar.importFailed', { message: (e as Error).message }), true);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="pj-wrap">
      <div
        className="row gap2"
        style={{ marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <div>
          <h1 className="view-h1" style={{ margin: 0 }}>
            {t('finances:clients.title')}
          </h1>
          <div className="view-sub">{t('finances:clients.subtitle')}</div>
        </div>
        <div className="grow" />
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as ClientStatus | '');
            setPage(1);
          }}
          style={{
            fontFamily: 'inherit',
            fontSize: 13,
            color: 'var(--text)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
            padding: '7px 10px',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          <option value="">{t('finances:clients.status.all')}</option>
          {CLIENT_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {t('finances:clients.status.' + CLIENT_STATUS_META[s].i18nKey)}
            </option>
          ))}
        </select>
        <div className="searchbox" style={{ minWidth: 220 }}>
          <Icon name="search" size={16} style={{ color: 'var(--text-3)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('finances:clients.toolbar.searchPlaceholder')}
          />
        </div>
        <button
          className="btn btn-line"
          title={t('finances:clients.toolbar.exportTitle')}
          onClick={() =>
            api
              .downloadCsv('/clients/export.csv', 'clients.csv')
              .catch((e) => pushToast(t('finances:clients.toolbar.exportFailed', { message: (e as Error).message }), true))
          }
        >
          <Icon name="download" size={15} /> {t('finances:clients.toolbar.export')}
        </button>
        {canManage && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importCsvFile(f);
              }}
            />
            <button
              className="btn btn-line"
              disabled={importing}
              title={t('finances:clients.toolbar.importTitle')}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="inbox" size={15} /> {importing ? t('finances:clients.toolbar.importing') : t('finances:clients.toolbar.import')}
            </button>
            <button className="btn btn-accent" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> {t('finances:clients.toolbar.addClient')}
            </button>
          </>
        )}
      </div>

      {loading && clients.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>{t('finances:clients.list.loading')}</div>
      ) : error ? (
        <div className="row gap2" style={{ alignItems: 'center' }}>
          <span style={{ color: 'var(--c-over)' }}>{t('finances:clients.list.loadFailed', { message: error })}</span>
          <button className="btn btn-line btn-sm" onClick={() => void refresh()}>
            <Icon name="refresh" size={13} /> {t('finances:clients.list.retry')}
          </button>
        </div>
      ) : clients.length === 0 ? (
        <div className="placeholder" style={{ marginTop: 24 }}>
          <div className="ph-icon">
            <Icon name="users" size={30} />
          </div>
          <h2 className="ph-title">{total === 0 && !query && !statusFilter ? t('finances:clients.list.noClientYet') : t('finances:clients.list.noMatch')}</h2>
          <p className="ph-sub">
            {total === 0 && !query && !statusFilter
              ? canManage
                ? t('finances:clients.list.emptyManage')
                : t('finances:clients.list.emptyView')
              : t('finances:clients.list.noMatchSub')}
          </p>
        </div>
      ) : (
        <>
          <div className="pj-grid">
            {clients.map((c) => (
              <ClientCard key={c.id} c={c} canManage={canManage} onManage={() => setManageId(c.id)} />
            ))}
          </div>
          {totalPages > 1 && (
            <div
              className="row gap2"
              style={{ marginTop: 16, alignItems: 'center', justifyContent: 'center' }}
            >
              <button
                className="btn btn-line btn-sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <Icon name="chevL" size={13} /> {t('finances:clients.list.prev')}
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {total > 1
                  ? t('finances:clients.list.pageMany', { page, pages: totalPages, count: total })
                  : t('finances:clients.list.pageOne', { page, pages: totalPages, count: total })}
              </span>
              <button
                className="btn btn-line btn-sm"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t('finances:clients.list.next')} <Icon name="chevR" size={13} />
              </button>
            </div>
          )}
        </>
      )}

      {managed && (
        <ManageClientModal
          client={managed}
          canManage={canManage}
          onClose={() => setManageId(null)}
          onSaved={(next) =>
            setClients((cs) => cs.map((x) => (x.id === next.id ? { ...x, ...next } : x)))
          }
          onDeleted={(id) => {
            setClients((cs) => cs.filter((x) => x.id !== id));
            setTotal((t) => Math.max(0, t - 1));
          }}
          pushToast={pushToast}
        />
      )}
      {creating && (
        <NewClientModal
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setClients((cs) => [c, ...cs]);
            setTotal((t) => t + 1);
          }}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}
