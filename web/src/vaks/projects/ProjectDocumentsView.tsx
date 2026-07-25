/* ============================================================
   Vue « Documents » d'un projet — bascule entre l'espace fichiers vaks natif
   (S3/Garage) et le SharePoint de la team Microsoft provisionnée (lecture seule,
   membres invités uniquement). L'onglet SharePoint n'apparaît que si la source
   est disponible pour l'utilisateur courant (gate serveur : licence + toggles +
   grant + appartenance à la team).
   ============================================================ */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { ProjectDocumentsTab } from './ProjectDocumentsTab';
import { SharePointDocumentsTab } from './SharePointDocumentsTab';

interface Props {
  projectId: string;
  pushToast: (text: string, warn?: boolean) => void;
}

export function ProjectDocumentsView({ projectId, pushToast }: Props) {
  const { t } = useTranslation('projects');
  const [tab, setTab] = useState<'vaks' | 'sharepoint'>('vaks');
  const [spAvailable, setSpAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    setSpAvailable(false);
    setTab('vaks');
    api
      .projectContextSources(projectId)
      .then((srcs) => {
        if (alive) setSpAvailable(srcs.some((s) => s.source === 'sharepoint' && s.available));
      })
      .catch(() => {
        /* source indispo → onglet masqué, silencieux */
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  return (
    <div>
      {spAvailable && (
        <div className="seg seg-accent" style={{ marginBottom: 12 }}>
          <button className={'seg-btn' + (tab === 'vaks' ? ' seg-on' : '')} onClick={() => setTab('vaks')}>
            {t('documents.tabVaks')}
          </button>
          <button
            className={'seg-btn' + (tab === 'sharepoint' ? ' seg-on' : '')}
            onClick={() => setTab('sharepoint')}
          >
            {t('documents.tabSharePoint')}
          </button>
        </div>
      )}
      {tab === 'sharepoint' && spAvailable ? (
        <SharePointDocumentsTab projectId={projectId} pushToast={pushToast} />
      ) : (
        <ProjectDocumentsTab projectId={projectId} pushToast={pushToast} />
      )}
    </div>
  );
}
