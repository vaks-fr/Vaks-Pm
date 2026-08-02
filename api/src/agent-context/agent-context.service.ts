import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { FileSourcesService } from '../filesources/filesources.service';
import {
  composeAgentBrief,
  mergeAgentBrief,
  normalizeAgentBrief,
  type AgentBrief,
  type AgentBriefField,
  type BriefFacts,
} from '../agents/context/agent-brief';
import { agentCharterView, type AgentCharterView } from '../agents/context/agent-charter-view';
import { effectiveAiFolderIds, resolveDocFreshness } from '../projects/document-context';

/**
 * Point de composition UNIQUE du contexte agent d'un projet.
 *
 * CONTRAINTE NON NÉGOCIABLE : `TasksService.getWorkContext` (ce que reçoit
 * l'agent) et `GET /projects/:id/agent-context-preview` (ce que voit l'humain)
 * appellent tous les deux `buildPack`. Un écran de prévisualisation qui dérive
 * de la réalité est pire que pas d'écran du tout — c'est précisément parce que
 * l'humain ne pouvait pas vérifier ce que lisait l'agent qu'il surchargeait le
 * brief « par précaution ».
 *
 * Le pack est **actor-independent** : rien de ce qu'il contient ne dépend de
 * l'agent appelant. Les limites par agent (concurrence, budget quotidien,
 * confiance) remontent en codes d'erreur au claim, pas ici.
 */

/** Nombre de documents de contexte remontés. Au-delà : `truncated`. */
const MAX_CONTEXT_DOCUMENTS = 100;

export interface AgentContextPack {
  agentsEnabled: boolean;
  project: {
    key: string;
    name: string;
    /** Markdown RÉELLEMENT servi aux agents. */
    brief: string;
    briefStructured: AgentBrief | null;
    orgDefaultApplied: AgentBriefField[];
    freeNotes: string | null;
    guardrails: string | null;
    stakes: string;
  };
  facts: BriefFacts & {
    reviewerIds: string[];
    reviewerList: { id: string; name: string }[];
    verificationModeSource: 'project' | 'org';
  };
  charter: AgentCharterView | null;
  documents: {
    items: {
      id: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      freshAt: Date;
      source: 'own' | 'folder';
    }[];
    total: number;
    returned: number;
    truncated: boolean;
  };
  contextSources: { source: string; label: string; available: boolean; reason?: string }[];
  journal: { title: string; summary: string | null; taskId: string; at: Date }[];
}

@Injectable()
export class AgentContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Assemble le pack de contexte d'un projet.
   *
   * Toutes les lectures optionnelles sont **fail-open, fait par fait** : une
   * panne de lecture omet la ligne concernée plutôt que de priver l'agent de
   * tout son contexte. Un fait non résolu n'est jamais rendu comme un
   * placeholder vide (« Reviewer: — »), qu'un agent prendrait pour une info.
   */
  async buildPack(orgId: string, projectId: string): Promise<AgentContextPack | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
      select: {
        key: true,
        name: true,
        agentsEnabled: true,
        agentContext: true,
        agentBrief: true,
        agentGuardrails: true,
        agentCostBudget: true,
        stakes: true,
        verificationMode: true,
        verificationCapabilities: true,
      },
    });
    if (!project) return null;

    const [orgSettings, reviewers, charter, docsBundle, journal, contextSources, agentSpend] =
      await Promise.all([
        // UN seul getAll : briefDefault + mode de vérification + langue en sortent.
        this.settings.getAll(orgId).catch(() => ({}) as Record<string, unknown>),
        this.resolveReviewers(projectId),
        this.resolveCharter(projectId),
        this.resolveDocuments(orgId, projectId),
        this.resolveJournal(orgId, projectId),
        this.resolveContextSources(orgId, projectId),
        this.resolveAgentSpend(orgId, projectId),
      ]);

    const { brief, inheritedFields } = mergeAgentBrief(
      project.agentBrief,
      normalizeAgentBrief(orgSettings['agents.briefDefault']),
    );

    const verificationMode =
      project.verificationMode ??
      (typeof orgSettings['agents.verification.mode'] === 'string'
        ? (orgSettings['agents.verification.mode'] as string)
        : null) ??
      'report_only';
    const locale =
      typeof orgSettings['i18n.defaultLanguage'] === 'string'
        ? (orgSettings['i18n.defaultLanguage'] as string)
        : typeof orgSettings['locale'] === 'string'
          ? (orgSettings['locale'] as string)
          : null;

    const budget = project.agentCostBudget != null ? Number(project.agentCostBudget) : null;
    const facts: BriefFacts = {
      reviewers: reviewers.map((r) => r.name),
      verificationMode,
      stakes: project.stakes ?? 'low',
      verificationCapabilities: Array.isArray(project.verificationCapabilities)
        ? (project.verificationCapabilities as string[])
        : [],
      locale,
      // Budget : QUALITATIF uniquement — le montant reste derrière `finance:view`.
      hasCostBudget: budget != null && budget > 0,
      costBudgetSpentPct:
        budget != null && budget > 0 ? Math.min(999, (agentSpend / budget) * 100) : null,
    };

    return {
      agentsEnabled: project.agentsEnabled,
      project: {
        key: project.key,
        name: project.name,
        brief: composeAgentBrief(brief, project.agentContext, facts),
        briefStructured: brief,
        orgDefaultApplied: inheritedFields,
        freeNotes: project.agentContext ?? null,
        guardrails: project.agentGuardrails ?? null,
        stakes: project.stakes ?? 'low',
      },
      facts: {
        ...facts,
        reviewerIds: reviewers.map((r) => r.id),
        reviewerList: reviewers,
        verificationModeSource: project.verificationMode ? 'project' : 'org',
      },
      charter,
      documents: docsBundle,
      contextSources,
      journal,
    };
  }

  /**
   * Reviewers = PROJECT_MANAGER du projet. C'est déjà l'audience notifiée à
   * `IN_REVIEW` : on réutilise la même définition plutôt que de calculer les
   * titulaires de `task:review` (union rôle org × projet × équipe = requête
   * lourde et liste ingérable).
   */
  private async resolveReviewers(projectId: string): Promise<{ id: string; name: string }[]> {
    try {
      const pms = await this.prisma.projectMember.findMany({
        where: { projectId, role: { key: 'PROJECT_MANAGER' } },
        select: { user: { select: { id: true, name: true } } },
      });
      return pms.map((m) => m.user).filter((u): u is { id: string; name: string } => !!u);
    } catch {
      return [];
    }
  }

  /** Charter filtré par l'allowlist agent (jamais budget/parties prenantes). */
  private async resolveCharter(projectId: string): Promise<AgentCharterView | null> {
    try {
      const charter = await this.prisma.projectCharter.findUnique({ where: { projectId } });
      return agentCharterView(charter as unknown as Record<string, unknown> | null);
    } catch {
      return null;
    }
  }

  /**
   * Documents « contexte IA » : drapeau propre OU dossier marqué (héritage
   * calculé en mémoire). Le total est compté séparément pour que la troncature
   * soit VISIBLE — l'ancien `take: 50` coupait en silence.
   */
  private async resolveDocuments(orgId: string, projectId: string) {
    const empty = { items: [], total: 0, returned: 0, truncated: false };
    try {
      const folders = await this.prisma.projectDocumentFolder.findMany({
        where: { projectId, organizationId: orgId },
        select: { id: true, parentId: true, aiContext: true },
      });
      const aiFolderIds = effectiveAiFolderIds(folders);
      const where = {
        projectId,
        organizationId: orgId,
        OR: [
          { aiContext: true },
          ...(aiFolderIds.size ? [{ folderId: { in: [...aiFolderIds] } }] : []),
        ],
      };
      const [docs, total] = await Promise.all([
        this.prisma.projectDocument.findMany({
          where,
          orderBy: { uploadedAt: 'desc' },
          take: MAX_CONTEXT_DOCUMENTS,
          select: {
            id: true,
            filename: true,
            mimeType: true,
            sizeBytes: true,
            uploadedAt: true,
            contentUpdatedAt: true,
            aiContext: true,
            folderId: true,
          },
        }),
        this.prisma.projectDocument.count({ where }),
      ]);
      return {
        items: docs.map((d) => ({
          id: d.id,
          filename: d.filename,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          freshAt: resolveDocFreshness(d),
          source: (d.aiContext ? 'own' : 'folder') as 'own' | 'folder',
        })),
        total,
        returned: docs.length,
        truncated: total > docs.length,
      };
    } catch {
      return empty;
    }
  }

  private async resolveJournal(orgId: string, projectId: string) {
    try {
      const rows = await this.prisma.agentJournalEntry.findMany({
        where: { organizationId: orgId, projectId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { title: true, summary: true, taskId: true, createdAt: true },
      });
      // Ordre chronologique (le plus ancien d'abord) pour la lecture.
      return rows
        .reverse()
        .map((j) => ({ title: j.title, summary: j.summary, taskId: j.taskId, at: j.createdAt }));
    } catch {
      return [];
    }
  }

  /**
   * Sources externes (SharePoint…) avec le motif d'indisponibilité, tel que
   * l'agent le voit. C'est ce qui rend `FS_GRANT_PENDING` enfin lisible dans
   * l'UI au lieu d'échouer en silence.
   */
  private async resolveContextSources(orgId: string, projectId: string) {
    try {
      const fs = this.moduleRef.get(FileSourcesService, { strict: false });
      return await fs.availabilityForProject(orgId, projectId, null, 'agent');
    } catch {
      return [];
    }
  }

  /** Coût agent réel déjà consommé sur le projet (pour le % qualitatif). */
  private async resolveAgentSpend(orgId: string, projectId: string): Promise<number> {
    try {
      const agg = await this.prisma.agentRun.aggregate({
        where: { organizationId: orgId, projectId },
        _sum: { cost: true },
      });
      return agg._sum.cost != null ? Number(agg._sum.cost) : 0;
    } catch {
      return 0;
    }
  }
}
