/* ============================================================
   Vue « Documents » d'un projet — bascule entre l'espace fichiers vaks natif
   (S3/Garage) et les sources de documents externes rattachées au projet en
   lecture seule (SharePoint de la team Teams, Drive partagé Google provisionné,
   …). Un onglet par source disponible : chaque source n'apparaît que si le gate
   serveur la déclare `available` (licence + toggles + identité + accès).
   ============================================================ */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ContextSourceAvailability } from '../../api/client';
import { ProjectDocumentsTab } from './ProjectDocumentsTab';
import { ContextFilesTab } from './ContextFilesTab';

interface Props {
  projectId: string;
  pushToast: (text: string, warn?: boolean) => void;
}

/** Couleur d'accent par source (l'API ne la renvoie pas). */
const SOURCE_ACCENT: Record<string, string> = {
  sharepoint: '#038387',
  'google-drive': '#1a73e8',
};

export function ProjectDocumentsView({ projectId, pushToast }: Props) {
  const { t } = useTranslation('projects');
  // 'vaks' = fichiers natifs ; sinon la clé machine de la source externe.
  const [tab, setTab] = useState<string>('vaks');
  const [sources, setSources] = useState<ContextSourceAvailability[]>([]);

  useEffect(() => {
    let alive = true;
    setSources([]);
    setTab('vaks');
    api
      .projectContextSources(projectId)
      .then((srcs) => {
        if (alive) setSources(srcs.filter((s) => s.available));
      })
      .catch(() => {
        /* sources indispo → onglets masqués, silencieux */
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const active = sources.find((s) => s.source === tab);

  return (
    <div>
      {sources.length > 0 && (
        <div className="seg seg-accent" style={{ marginBottom: 12 }}>
          <button className={'seg-btn' + (tab === 'vaks' ? ' seg-on' : '')} onClick={() => setTab('vaks')}>
            {t('documents.tabVaks')}
          </button>
          {sources.map((s) => (
            <button
              key={s.source}
              className={'seg-btn' + (tab === s.source ? ' seg-on' : '')}
              onClick={() => setTab(s.source)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      {active ? (
        <ContextFilesTab
          projectId={projectId}
          source={active.source}
          label={active.label}
          accent={SOURCE_ACCENT[active.source]}
          pushToast={pushToast}
        />
      ) : (
        <ProjectDocumentsTab projectId={projectId} pushToast={pushToast} />
      )}
    </div>
  );
}
