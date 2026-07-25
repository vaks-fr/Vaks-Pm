import { SetMetadata } from '@nestjs/common';

/**
 * Décrit COMMENT retrouver le(s) projet(s) cible(s) d'une requête pour que
 * {@link ProjectAccessGuard} puisse vérifier l'appartenance projet.
 *
 *  - `kind` : type de l'entité pointée par la valeur lue
 *    (`project` = id de projet direct ; `task`/`comment`/… = on remonte au
 *    projet via l'entité).
 *  - `in`   : où lire la valeur (`param` d'URL, `body` JSON, `query` string).
 *  - `key`  : nom du paramètre / champ / clé de query.
 */
export type ProjectAccessSource = {
  kind:
    | 'project'
    | 'task'
    | 'comment'
    | 'dependency'
    | 'attachment'
    | 'allocation'
    | 'timeEntry';
  in: 'param' | 'body' | 'query';
  key: string;
};

export const PROJECT_ACCESS_KEY = 'project_access_sources';

/**
 * Déclare une ou plusieurs sources de résolution du projet pour une route (ou
 * un contrôleur entier). Le guard résout UNIQUEMENT les sources effectivement
 * présentes sur la requête et exige l'accès à **toutes** celles résolues ; une
 * source absente est simplement ignorée (ex. un contrôleur mêlant routes
 * scopées projet et routes org-globales). Aucune source résolue → aucun
 * contrôle d'appartenance (la route n'est pas scopée projet).
 */
export const ProjectAccess = (...sources: ProjectAccessSource[]) =>
  SetMetadata(PROJECT_ACCESS_KEY, sources);

export const TASK_WRITE_POLICY_KEY = 'task_write_policy';

/**
 * Marque une route d'**écriture de tâches** (create/update/move, dépendances,
 * required-skills). En plus de l'appartenance projet (`@ProjectAccess`), le
 * {@link ProjectAccessGuard} applique la policy d'édition :
 *
 *  - admin global / clé org / rôle org manager (porte `task:delete` :
 *    ORG_ADMIN, PORTFOLIO_MANAGER, TEAM_MANAGER) → autorisé partout ;
 *  - rôle projet explicite sur CE projet (PROJECT_MANAGER, CONTRIBUTOR)
 *    → autorisé, projet billable ou non (grant délibéré) ;
 *  - membre ordinaire (task:update org-level sans task:delete, i.e.
 *    ORG_MEMBER) → autorisé UNIQUEMENT si le projet est **non billable** ET
 *    qu'il en fait partie (membre direct ou via équipe affectée). Sur un
 *    projet billable il ne peut que consulter et logger du temps.
 */
export const TaskWritePolicy = () => SetMetadata(TASK_WRITE_POLICY_KEY, true);

// ---- Raccourcis concis pour les cas courants ----
export const fromProjectParam = (key = 'projectId'): ProjectAccessSource => ({ kind: 'project', in: 'param', key });
export const fromProjectBody = (key = 'projectId'): ProjectAccessSource => ({ kind: 'project', in: 'body', key });
export const fromProjectQuery = (key = 'projectId'): ProjectAccessSource => ({ kind: 'project', in: 'query', key });
export const fromTaskParam = (key = 'taskId'): ProjectAccessSource => ({ kind: 'task', in: 'param', key });
export const fromTaskBody = (key = 'taskId'): ProjectAccessSource => ({ kind: 'task', in: 'body', key });
export const fromTaskQuery = (key = 'taskId'): ProjectAccessSource => ({ kind: 'task', in: 'query', key });
export const fromCommentParam = (key = 'id'): ProjectAccessSource => ({ kind: 'comment', in: 'param', key });
export const fromDependencyParam = (key = 'id'): ProjectAccessSource => ({ kind: 'dependency', in: 'param', key });
export const fromAttachmentParam = (key = 'id'): ProjectAccessSource => ({ kind: 'attachment', in: 'param', key });
export const fromAllocationParam = (key = 'id'): ProjectAccessSource => ({ kind: 'allocation', in: 'param', key });
export const fromTimeEntryParam = (key = 'id'): ProjectAccessSource => ({ kind: 'timeEntry', in: 'param', key });
