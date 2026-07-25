/* ============================================================
   Vaks — Projects panel : onglet Charter (PMBOK) + documents d'offre
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Icon } from '../primitives';
import { api } from '../../api/client';
import {
  CHARTER_SECTIONS,
  ProjectStatus,
  type ProjectCharterDto,
  type ProjectDto,
  type ProjectDocumentDto,
  type UpsertProjectCharterDto,
} from '@vaks-pm/shared';
import { useAuth } from '../../auth/AuthContext';
import { useFormat } from '../../lib/format';
import { ConfirmDialog, fmtBytes, statusLabel } from './shared';

interface CharterEditorProps {
  project: ProjectDto;
  onProjectChanged: (p: ProjectDto) => void;
  pushToast: (text: string, warn?: boolean) => void;
}

export function CharterEditor({ project, onProjectChanged, pushToast }: CharterEditorProps) {
  const { t } = useTranslation('projects');
  const { t: tc } = useTranslation('common');
  const fmt = useFormat();
  const [charter, setCharter] = useState<ProjectCharterDto | null>(null);
  const [draft, setDraft] = useState<UpsertProjectCharterDto>({});
  // Sponsor exécutif lié à l'identité : userId d'un membre du projet (ou null).
  const [sponsorUserId, setSponsorUserId] = useState<string | null>(null);
  const [members, setMembers] = useState<{ userId: string; user: { id: string; name: string } }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloadingSigned, setDownloadingSigned] = useState(false);

  const readOnly =
    project.status !== ProjectStatus.DRAFT && project.status !== ProjectStatus.CHARTER_REVIEW;

  function triggerBrowserDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportWord() {
    setExporting(true);
    try {
      const { blob, filename } = await api.downloadCharterDocx(project.id);
      triggerBrowserDownload(blob, filename);
    } catch (e) {
      pushToast(t('charter.exportFailed', { message: (e as Error).message }), true);
    } finally {
      setExporting(false);
    }
  }

  async function downloadSignedDoc() {
    setDownloadingSigned(true);
    try {
      const { blob, filename } = await api.downloadSignedCharter(project.id);
      triggerBrowserDownload(blob, filename);
    } catch (e) {
      pushToast(t('charter.downloadFailed', { message: (e as Error).message }), true);
    } finally {
      setDownloadingSigned(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getProjectCharter(project.id)
      .then((c) => {
        if (cancelled) return;
        setCharter(c);
        const d: UpsertProjectCharterDto = {};
        for (const s of CHARTER_SECTIONS) d[s.key] = (c as any)[s.key] ?? '';
        setDraft(d);
        setSponsorUserId(c.sponsorUserId ?? null);
      })
      .catch((e) => pushToast(t('charter.loadFailed', { message: (e as Error).message }), true))
      .finally(() => !cancelled && setLoading(false));
    // Membres du projet (candidats sponsor). Best-effort : un échec ne bloque
    // pas l'édition de la charte, le picker sera simplement vide.
    api
      .listProjectMembers(project.id)
      .then((m) => {
        if (!cancelled) setMembers(m.map((x) => ({ userId: x.userId, user: x.user })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id, pushToast]);

  const filledCount = useMemo(
    () =>
      CHARTER_SECTIONS.filter((s) => ((draft as any)[s.key] ?? '').toString().trim().length > 0)
        .length,
    [draft],
  );

  async function saveCharter() {
    setSaving(true);
    try {
      const patch: UpsertProjectCharterDto = {};
      for (const s of CHARTER_SECTIONS) {
        const v = ((draft as any)[s.key] ?? '').toString();
        patch[s.key] = v.trim() === '' ? null : (v as any);
      }
      // Sponsor lié à l'identité : envoie le userId (ou null). Le serveur résout
      // le nom, synchronise le tag ProjectMember.isSponsor.
      patch.sponsorUserId = sponsorUserId;
      const next = await api.upsertProjectCharter(project.id, patch);
      setCharter(next);
      setSponsorUserId(next.sponsorUserId ?? null);
      pushToast(t('charter.saved'));
    } catch (e) {
      pushToast(t('charter.saveFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  }

  async function submitForReview() {
    setSubmitting(true);
    try {
      const next = await api.updateProject(project.id, { status: ProjectStatus.CHARTER_REVIEW });
      onProjectChanged(next);
      pushToast(t('charter.submittedForReview'));
    } catch (e) {
      pushToast((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function backToDraft() {
    setSubmitting(true);
    try {
      const next = await api.updateProject(project.id, { status: ProjectStatus.DRAFT });
      onProjectChanged(next);
      pushToast(t('charter.reopened'));
    } catch (e) {
      pushToast((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadSigned(file: File) {
    setUploading(true);
    try {
      const next = await api.uploadSignedCharter(project.id, file);
      setCharter(next);
      pushToast(t('charter.signedUploaded', { filename: next.signedDocument?.filename ?? '' }));
    } catch (e) {
      pushToast((e as Error).message, true);
    } finally {
      setUploading(false);
    }
  }

  async function activate() {
    setActivating(true);
    try {
      const next = await api.updateProject(project.id, { status: ProjectStatus.ACTIVE });
      onProjectChanged(next);
      pushToast(t('charter.activated', { key: project.key }));
    } catch (e) {
      pushToast((e as Error).message, true);
    } finally {
      setActivating(false);
    }
  }

  if (loading) {
    return <div className="md-empty">{t('charter.loading')}</div>;
  }

  return (
    <>
      <div className="md-field">
        <div className="md-label row" style={{ justifyContent: 'space-between' }}>
          <span>
            {t('charter.title')}
            {!readOnly && (
              <>
                {' '}
                <span className="md-count">
                  {filledCount}/{CHARTER_SECTIONS.length}
                </span>
              </>
            )}
          </span>
          {readOnly && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {t('charter.frozen', { status: statusLabel(t, project.status).toLowerCase() })}
            </span>
          )}
        </div>

        {/* Les 13 sections d'édition n'ont du sens qu'en DRAFT/CHARTER_REVIEW.
            Une fois le projet ACTIVE/COMPLETED/ARCHIVED, on ne montre plus que
            les actions de download (Word + charter signé). */}
        {readOnly ? (
          <div className="md-span" style={{ marginTop: 4 }}>
            {t('charter.locked')}
            {(charter?.sponsorUser || charter?.sponsor) && (
              <div style={{ marginTop: 6 }}>
                {t('charter.sponsorLabel')} :{' '}
                <b>{charter?.sponsorUser?.name ?? charter?.sponsor}</b>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {CHARTER_SECTIONS.map((s) => (
              <label key={s.key as string} className="md-date" style={{ alignItems: 'stretch' }}>
                <span
                  className="md-date-cap"
                  style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                  <span>{s.label}</span>
                  <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{s.hint}</span>
                </span>
                <textarea
                  className="atext"
                  value={((draft as any)[s.key] ?? '') as string}
                  rows={s.rows}
                  disabled={readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                  style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                />
              </label>
            ))}

            {/* Sponsor exécutif = vrai membre du projet (lien d'identité). Choisir
                ici synchronise le tag isSponsor (audience de communication). */}
            <label className="md-date" style={{ alignItems: 'stretch' }}>
              <span
                className="md-date-cap"
                style={{ display: 'flex', justifyContent: 'space-between' }}
              >
                <span>{t('charter.sponsorLabel')}</span>
                <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
                  {t('charter.sponsorHint')}
                </span>
              </span>
              <select
                className="atext"
                value={sponsorUserId ?? ''}
                disabled={readOnly}
                onChange={(e) => setSponsorUserId(e.target.value || null)}
                style={{ width: '100%', fontFamily: 'inherit' }}
              >
                <option value="">{t('charter.sponsorNone')}</option>
                {/* Sponsor courant absent de la liste (membre retiré depuis) : on
                    le conserve en option pour ne pas le perdre silencieusement. */}
                {sponsorUserId &&
                  !members.some((m) => m.userId === sponsorUserId) &&
                  charter?.sponsorUser && (
                    <option value={charter.sponsorUser.id}>{charter.sponsorUser.name}</option>
                  )}
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.name}
                  </option>
                ))}
              </select>
              {members.length === 0 && (
                <span className="md-hint" style={{ marginTop: 4 }}>
                  {t('charter.sponsorNoMembers')}
                </span>
              )}
            </label>
          </div>
        )}

        {/* Actions */}
        <div className="row gap2" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          {!readOnly && (
            <button className="btn btn-accent" onClick={saveCharter} disabled={saving}>
              <Icon name="check" size={14} /> {saving ? tc('saving') : t('charter.save')}
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={exportWord}
            disabled={exporting}
            title={t('charter.exportTitle')}
          >
            {exporting ? t('charter.generating') : t('charter.exportWord')}
          </button>
          {charter?.signedDocument && (
            <button
              className="btn btn-ghost"
              onClick={downloadSignedDoc}
              disabled={downloadingSigned}
              title={t('charter.downloadSignedTitle')}
            >
              {downloadingSigned ? t('charter.downloading') : t('charter.signedCharter')}
            </button>
          )}
          {project.status === ProjectStatus.DRAFT && project.billable && (
            <button
              className="btn btn-accent"
              disabled={submitting || filledCount < 5}
              title={filledCount < 5 ? t('charter.submitTitle') : ''}
              onClick={submitForReview}
            >
              {submitting ? t('charter.submitting') : t('charter.submit')}
            </button>
          )}
          {project.status === ProjectStatus.DRAFT && !project.billable && (
            <button
              className="btn btn-accent"
              disabled={activating}
              title={t('charter.activateNonBillableTitle')}
              onClick={activate}
            >
              {activating ? t('charter.activating') : t('charter.activate')}
            </button>
          )}
          {project.status === ProjectStatus.CHARTER_REVIEW && (
            <>
              <button className="btn btn-ghost" disabled={submitting} onClick={backToDraft}>
                {t('charter.reopenAsDraft')}
              </button>
              <label className="btn btn-ghost" style={{ cursor: uploading ? 'wait' : 'pointer' }}>
                {uploading
                  ? t('charter.uploading')
                  : charter?.signedDocument
                    ? t('charter.replaceSigned')
                    : t('charter.uploadSigned')}
                <input
                  type="file"
                  accept=".pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadSigned(f);
                    e.target.value = '';
                  }}
                  style={{ display: 'none' }}
                />
              </label>
              <button
                className="btn btn-accent"
                disabled={activating || !charter?.signedDocument}
                title={charter?.signedDocument ? '' : t('charter.activateNeedSignedTitle')}
                onClick={activate}
              >
                {activating ? t('charter.activating') : t('charter.activate')}
              </button>
            </>
          )}
        </div>

        {/* Motif de grisage du bouton « Soumettre » rendu visible (pas seulement
            en infobulle) : la sauvegarde reste possible à tout moment, seule la
            soumission pour revue exige au moins 5 sections remplies. */}
        {!readOnly && project.status === ProjectStatus.DRAFT && project.billable && filledCount < 5 && (
          <div className="md-hint" style={{ marginTop: 6 }}>
            <Icon name="warn" size={12} />{' '}
            {t('charter.submitHint', { remaining: 5 - filledCount, filled: filledCount })}
          </div>
        )}

        {charter?.signedDocument && (
          <div className="md-span" style={{ marginTop: 8 }}>
            {charter.signedDocument.uploadedBy ? (
              <Trans
                t={t}
                i18nKey="charter.signedOnFileBy"
                values={{
                  filename: charter.signedDocument.filename,
                  date: fmt.dateTime(charter.signedDocument.uploadedAt),
                  name: charter.signedDocument.uploadedBy.name,
                }}
                components={[<b />]}
              />
            ) : (
              <Trans
                t={t}
                i18nKey="charter.signedOnFile"
                values={{
                  filename: charter.signedDocument.filename,
                  date: fmt.dateTime(charter.signedDocument.uploadedAt),
                }}
                components={[<b />]}
              />
            )}
          </div>
        )}
      </div>

      {/* Documents d'offre / propositions — disponibles quel que soit le statut. */}
      <ProjectDocumentsSection projectId={project.id} pushToast={pushToast} />
    </>
  );
}

/* ============================ Project documents (offres) ============================ */

export function ProjectDocumentsSection({
  projectId,
  pushToast,
}: {
  projectId: string;
  pushToast: (text: string, warn?: boolean) => void;
}) {
  const { t } = useTranslation('projects');
  const fmt = useFormat();
  const { can } = useAuth();
  const canManage = can('project:update');
  const [docs, setDocs] = useState<ProjectDocumentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [confirmDoc, setConfirmDoc] = useState<ProjectDocumentDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .listProjectDocuments(projectId)
      .then(setDocs)
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      await api.uploadProjectDocument(projectId, file, 'OFFER');
      pushToast(t('documents.added', { name: file.name }));
      reload();
    } catch (e) {
      pushToast(t('documents.uploadFailed', { message: (e as Error).message }), true);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const download = async (d: ProjectDocumentDto) => {
    try {
      const { blob, filename } = await api.downloadProjectDocument(projectId, d.id, d.filename);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      pushToast(t('documents.downloadFailed', { message: (e as Error).message }), true);
    }
  };

  const remove = async (d: ProjectDocumentDto) => {
    setDeleting(true);
    try {
      await api.deleteProjectDocument(projectId, d.id);
      setDocs((cur) => cur.filter((x) => x.id !== d.id));
      setConfirmDoc(null);
    } catch (e) {
      pushToast(t('documents.deleteFailed', { message: (e as Error).message }), true);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="md-field">
      <div className="md-label row" style={{ justifyContent: 'space-between' }}>
        <span>
          {t('documents.title')} <span className="md-count">{docs.length}</span>
        </span>
        {canManage && (
          <>
            <button className="md-add" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Icon name="plus" size={14} /> {uploading ? t('documents.uploading') : t('documents.add')}
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </>
        )}
      </div>
      <div className="md-hint" style={{ marginBottom: 4 }}>
        {t('documents.hint')}
      </div>
      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('documents.loading')}</div>
      ) : docs.length === 0 ? (
        <div className="md-span" style={{ color: 'var(--text-3)' }}>
          {t('documents.empty')} {canManage ? t('documents.emptyHintManage') : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {docs.map((d) => (
            <div key={d.id} className="doc-row">
              <button className="doc-name" onClick={() => download(d)} title={t('documents.downloadTitle')}>
                <Icon name="download" size={14} />
                <span className="truncate">{d.filename}</span>
              </button>
              <span className="doc-meta mono">{fmtBytes(d.sizeBytes)}</span>
              <span className="doc-meta truncate">
                {fmt.dateTime(d.uploadedAt)}
                {d.uploadedBy ? ` · ${d.uploadedBy.name}` : ''}
              </span>
              {canManage && (
                <button className="icon-btn" title={t('documents.deleteTitle')} onClick={() => setConfirmDoc(d)}>
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {confirmDoc && (
        <ConfirmDialog
          eyebrow={t('documents.confirmDeleteEyebrow')}
          title={t('documents.confirmDeleteTitle', { filename: confirmDoc.filename })}
          confirmLabel={t('documents.deleteTitle')}
          busyLabel={t('documents.confirmDeleteBusy')}
          busy={deleting}
          onConfirm={() => remove(confirmDoc)}
          onCancel={() => setConfirmDoc(null)}
        >
          <div className="md-span">
            {t('documents.confirmDeleteBody', { size: fmtBytes(confirmDoc.sizeBytes) })}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
