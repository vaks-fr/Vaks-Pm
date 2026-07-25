/* ============================================================
   Onglet « Documents » d'un projet — espace fichiers arborescent.
   Dossiers libres (breadcrumb + navigation) ; upload dans le dossier courant ;
   « Déplacer vers… », toggle « Contexte IA », download, delete. Tout membre du
   projet peut ajouter ET supprimer (décision produit). La liste des documents
   d'OFFRE (kind=OFFER) reste gérée dans l'onglet Charter — ici on montre TOUT.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Icon } from '../primitives';
import { useFormat } from '../../lib/format';
import { ConfirmDialog, fmtBytes } from './shared';
import type { ProjectDocumentDto, ProjectDocumentFolderDto } from '@vaks-pm/shared';

interface Props {
  projectId: string;
  pushToast: (text: string, warn?: boolean) => void;
}

export function ProjectDocumentsTab({ projectId, pushToast }: Props) {
  const { t } = useTranslation('projects');
  const fmt = useFormat();
  const [folders, setFolders] = useState<ProjectDocumentFolderDto[]>([]);
  const [docs, setDocs] = useState<ProjectDocumentDto[]>([]);
  const [cwd, setCwd] = useState<string | null>(null); // dossier courant (null = racine)
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [moving, setMoving] = useState<ProjectDocumentDto | null>(null);
  const [confirmDoc, setConfirmDoc] = useState<ProjectDocumentDto | null>(null);
  const [confirmFolder, setConfirmFolder] = useState<ProjectDocumentFolderDto | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([api.listProjectFolders(projectId), api.listProjectDocuments(projectId)])
      .then(([f, d]) => {
        setFolders(f);
        setDocs(d);
      })
      .catch((e) => pushToast((e as Error).message, true))
      .finally(() => setLoading(false));
  }, [projectId, pushToast]);

  useEffect(() => reload(), [reload]);

  // Si le dossier courant disparaît (supprimé), retour racine.
  useEffect(() => {
    if (cwd && !folders.some((f) => f.id === cwd)) setCwd(null);
  }, [folders, cwd]);

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const childFolders = useMemo(
    () => folders.filter((f) => (f.parentId ?? null) === cwd).sort((a, b) => a.name.localeCompare(b.name)),
    [folders, cwd],
  );
  const childDocs = useMemo(
    () => docs.filter((d) => (d.folderId ?? null) === cwd),
    [docs, cwd],
  );

  // Fil d'Ariane : de la racine jusqu'au dossier courant.
  const breadcrumb = useMemo(() => {
    const chain: ProjectDocumentFolderDto[] = [];
    let cur = cwd;
    const seen = new Set<string>();
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const f = byId.get(cur)!;
      chain.unshift(f);
      cur = f.parentId ?? null;
    }
    return chain;
  }, [cwd, byId]);

  const doUpload = async (file: File, aiContext: boolean) => {
    setUploading(true);
    try {
      await api.uploadProjectDocument(projectId, file, 'OTHER', { folderId: cwd, aiContext });
      pushToast(t('documents.added', { name: file.name }));
      reload();
    } catch (e) {
      pushToast(t('documents.uploadFailed', { message: (e as Error).message }), true);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return setCreatingFolder(false);
    try {
      await api.createProjectFolder(projectId, { name, parentId: cwd });
      setNewFolderName('');
      setCreatingFolder(false);
      reload();
    } catch (e) {
      pushToast((e as Error).message, true);
    }
  };

  const submitRename = async (folderId: string) => {
    const name = renameVal.trim();
    setRenaming(null);
    if (!name) return;
    try {
      await api.updateProjectFolder(projectId, folderId, { name });
      reload();
    } catch (e) {
      pushToast((e as Error).message, true);
    }
  };

  const removeFolder = async (f: ProjectDocumentFolderDto) => {
    setBusy(true);
    try {
      await api.deleteProjectFolder(projectId, f.id);
      setConfirmFolder(null);
      reload();
    } catch (e) {
      pushToast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const removeDoc = async (d: ProjectDocumentDto) => {
    setBusy(true);
    try {
      await api.deleteProjectDocument(projectId, d.id);
      setConfirmDoc(null);
      reload();
    } catch (e) {
      pushToast((e as Error).message, true);
    } finally {
      setBusy(false);
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

  const toggleAi = async (d: ProjectDocumentDto) => {
    // Optimiste.
    setDocs((cur) => cur.map((x) => (x.id === d.id ? { ...x, aiContext: !x.aiContext } : x)));
    try {
      await api.updateProjectDocument(projectId, d.id, { aiContext: !d.aiContext });
    } catch (e) {
      setDocs((cur) => cur.map((x) => (x.id === d.id ? { ...x, aiContext: d.aiContext } : x)));
      pushToast((e as Error).message, true);
    }
  };

  const moveDoc = async (d: ProjectDocumentDto, folderId: string | null) => {
    setMoving(null);
    try {
      await api.updateProjectDocument(projectId, d.id, { folderId });
      reload();
    } catch (e) {
      pushToast((e as Error).message, true);
    }
  };

  return (
    <div className="md-field">
      {/* Fil d'Ariane */}
      <div className="row gap1" style={{ flexWrap: 'wrap', marginBottom: 10, fontSize: 13 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setCwd(null)}
          style={cwd === null ? { color: 'var(--accent)' } : undefined}
        >
          <Icon name="folder" size={13} /> {t('documents.root')}
        </button>
        {breadcrumb.map((f) => (
          <React.Fragment key={f.id}>
            <Icon name="chevR" size={12} style={{ color: 'var(--text-3)' }} />
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setCwd(f.id)}
              style={f.id === cwd ? { color: 'var(--accent)' } : undefined}
            >
              {f.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Actions */}
      <div className="row gap2" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-accent btn-sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
          <Icon name="plus" size={13} /> {uploading ? t('documents.uploading') : t('documents.upload')}
        </button>
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }} title={t('documents.uploadAiHint')}>
          <Icon name="zap" size={13} /> {t('documents.uploadAi')}
          <input
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doUpload(f, true);
              e.target.value = '';
            }}
          />
        </label>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doUpload(f, false);
          }}
        />
        {creatingFolder ? (
          <input
            autoFocus
            className="td-in"
            style={{ width: 180 }}
            placeholder={t('documents.folderNamePlaceholder')}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFolder();
              else if (e.key === 'Escape') setCreatingFolder(false);
            }}
            onBlur={() => { if (!newFolderName.trim()) setCreatingFolder(false); }}
          />
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setCreatingFolder(true)}>
            <Icon name="plus" size={13} /> {t('documents.newFolder')}
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('documents.loading')}</div>
      ) : childFolders.length === 0 && childDocs.length === 0 ? (
        <div className="md-span" style={{ color: 'var(--text-3)' }}>{t('documents.emptyFolder')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Dossiers */}
          {childFolders.map((f) => (
            <div key={f.id} className="doc-row">
              {renaming === f.id ? (
                <input
                  autoFocus
                  className="td-in grow"
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename(f.id);
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => submitRename(f.id)}
                />
              ) : (
                <button className="doc-name" onClick={() => setCwd(f.id)} style={{ fontWeight: 600 }}>
                  <Icon name="folder" size={14} style={{ color: 'var(--accent)' }} />
                  <span className="truncate">{f.name}</span>
                </button>
              )}
              <span className="doc-meta mono">{t('documents.folder')}</span>
              <span className="doc-meta" />
              <div className="doc-actions">
                <button
                  className="icon-btn"
                  title={t('documents.rename')}
                  onClick={() => { setRenaming(f.id); setRenameVal(f.name); }}
                >
                  <Icon name="pencil" size={13} />
                </button>
                <button className="icon-btn" title={t('common:delete')} onClick={() => setConfirmFolder(f)}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            </div>
          ))}

          {/* Documents */}
          {childDocs.map((d) => (
            <div key={d.id} className="doc-row">
              <button className="doc-name" onClick={() => download(d)} title={t('documents.downloadTitle')}>
                <Icon name="download" size={14} />
                <span className="truncate">{d.filename}</span>
                {d.kind === 'OFFER' && (
                  <span className="pill pill-role" style={{ marginLeft: 4 }}>{t('documents.offerTag')}</span>
                )}
              </button>
              <span className="doc-meta mono">{fmtBytes(d.sizeBytes)}</span>
              <span className="doc-meta truncate">
                {fmt.dateTime(d.uploadedAt)}
                {d.uploadedBy ? ` · ${d.uploadedBy.name}` : ''}
              </span>
              <div className="doc-actions">
                <button
                  className="icon-btn"
                  title={d.aiContext ? t('documents.aiOn') : t('documents.aiOff')}
                  aria-pressed={d.aiContext}
                  onClick={() => toggleAi(d)}
                  style={d.aiContext ? { color: 'var(--accent)' } : undefined}
                >
                  <Icon name="zap" size={14} />
                </button>
                <div style={{ position: 'relative' }}>
                  <button className="icon-btn" title={t('documents.moveTo')} onClick={() => setMoving(d)}>
                    <Icon name="arrowRight" size={14} />
                  </button>
                  {moving?.id === d.id && (
                    <div className="dd-menu" style={{ right: 0, minWidth: 200, maxHeight: 260, overflowY: 'auto', zIndex: 60 }}>
                      <button className="dd-item" onClick={() => moveDoc(d, null)}>
                        <Icon name="folder" size={13} /> {t('documents.root')}
                      </button>
                      {folders
                        .filter((f) => f.id !== d.folderId)
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((f) => (
                          <button key={f.id} className="dd-item" onClick={() => moveDoc(d, f.id)}>
                            <Icon name="folder" size={13} /> {f.name}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
                <button className="icon-btn" title={t('common:delete')} onClick={() => setConfirmDoc(d)}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="md-hint" style={{ marginTop: 8 }}>
        {t('documents.aiExplainer')}
      </div>

      {confirmDoc && (
        <ConfirmDialog
          eyebrow={t('documents.confirmDeleteEyebrow')}
          title={t('documents.confirmDeleteTitle', { filename: confirmDoc.filename })}
          confirmLabel={t('common:delete')}
          busyLabel={t('documents.confirmDeleteBusy')}
          busy={busy}
          onConfirm={() => removeDoc(confirmDoc)}
          onCancel={() => setConfirmDoc(null)}
        >
          <div className="md-span">{t('documents.confirmDeleteBody', { size: fmtBytes(confirmDoc.sizeBytes) })}</div>
        </ConfirmDialog>
      )}

      {confirmFolder && (
        <ConfirmDialog
          eyebrow={t('documents.confirmDeleteFolderEyebrow')}
          title={t('documents.confirmDeleteFolderTitle', { name: confirmFolder.name })}
          confirmLabel={t('common:delete')}
          busyLabel={t('documents.confirmDeleteBusy')}
          busy={busy}
          onConfirm={() => removeFolder(confirmFolder)}
          onCancel={() => setConfirmFolder(null)}
        >
          <div className="md-span">{t('documents.confirmDeleteFolderBody')}</div>
        </ConfirmDialog>
      )}
    </div>
  );
}
