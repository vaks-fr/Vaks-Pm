import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ProjectDocumentKind } from '@db';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { S3Service } from '../storage/s3.service';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { ProjectsService } from './projects.service';
import { ProjectCreationPolicyService } from './project-creation-policy.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { AssignManagerDto } from './dto/assign-manager.dto';
import { AssignMemberDto, UpdateProjectMemberDto } from './dto/assign-member.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { RefuseOfferDto, EmailOfferDto } from './dto/offer.dto';

const MAX_CHARTER_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const charterKey = (projectId: string, filename: string) => `${projectId}/${filename}`;
const ALLOWED_CHARTER_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]);

// Documents projet (offres) : on accepte un éventail plus large que le charter
// (PDF, Word, Excel, PowerPoint, images, texte, archives). Limite 25 Mo.
const MAX_DOC_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_DOC_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/zip',
  // Espace documents projet (transcripts, contexte IA) : types texte usuels.
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'text/html',
  'application/x-yaml',
  'text/yaml',
]);
/** Clé S3 d'un document projet : préfixe `offers/` sous le dossier du projet. */
const docKey = (projectId: string, storedName: string) => `${projectId}/offers/${storedName}`;

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@PublicApi()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly s3: S3Service,
    private readonly creationPolicy: ProjectCreationPolicyService,
  ) {}

  /**
   * Renvoie, pour le user courant, sa capacité à créer chaque type de projet
   * selon la policy org + ses tags équipe/utilisateur. Le client UI s'en sert
   * pour activer/désactiver les radios "Facturable" / "Non-facturable" dans
   * le wizard de création.
   */
  @Get('creation-policy/me')
  getMyCreationCapabilities(@CurrentUser() user: AuthUser) {
    return this.creationPolicy.getCapabilities(user.orgId, user.userId, user.isAdmin);
  }

  @Get()
  @RequirePermissions('project:view')
  findAll(@CurrentUser() user: AuthUser, @Query('scope') scope?: string) {
    return this.projects.findAll(user.orgId, user.userId, user.isAdmin, {
      scope: scope === 'mine' ? 'mine' : scope === 'all' ? 'all' : undefined,
    });
  }

  @Get(':projectId')
  @RequirePermissions('project:view')
  findOne(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) id: string) {
    return this.projects.findOne(user.orgId, id, user.userId, user.isAdmin);
  }

  @Post()
  @RequirePermissions('project:create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.orgId, user.userId, user.isAdmin, dto);
  }

  /**
   * Duplique un projet existant : crée un nouveau projet en DRAFT et clone
   * toutes les tâches (titre, description, hierarchie, estimates, dates,
   * labels, dépendances). Le créateur devient PM du nouveau projet.
   */
  @Post(':projectId/copy')
  @RequirePermissions('project:create')
  copy(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) sourceId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projects.copy(user.orgId, sourceId, user.userId, user.isAdmin, dto);
  }

  @Patch(':projectId')
  @RequirePermissions('project:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(user.orgId, id, user.userId, user.isAdmin, dto);
  }

  // ------------------------------------------------------------
  // Étape commerciale « offre » (projets facturables)
  // Décision accept/refus via endpoints dédiés (le PATCH générique de statut
  // refuse ces arêtes) pour capter le compteur de refus + la raison.
  // ------------------------------------------------------------

  /** DRAFT → OFFER_SENT : marque l'offre comme envoyée (sans email). */
  @Post(':projectId/offer/send')
  @RequirePermissions('project:update')
  @ProjectAccess(fromProjectParam('projectId'))
  sendOffer(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) id: string,
  ) {
    return this.projects.sendOffer(user.orgId, id, user.userId, user.isAdmin);
  }

  /** Envoie l'offre par email au client (PJ = document OFFER) + passe en OFFER_SENT. */
  @Post(':projectId/offer/email')
  @RequirePermissions('project:update')
  @ProjectAccess(fromProjectParam('projectId'))
  emailOffer(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Body() dto: EmailOfferDto,
  ) {
    return this.projects.emailOffer(user.orgId, id, user.userId, user.isAdmin, {
      intro: dto.intro,
    });
  }

  /** OFFER_SENT → CHARTER_REVIEW : le client a accepté l'offre. */
  @Post(':projectId/offer/accept')
  @RequirePermissions('project:update')
  @ProjectAccess(fromProjectParam('projectId'))
  acceptOffer(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) id: string,
  ) {
    return this.projects.acceptOffer(user.orgId, id, user.userId, user.isAdmin);
  }

  /** OFFER_SENT → DRAFT : le client a refusé l'offre (compteur++ + raison). */
  @Post(':projectId/offer/refuse')
  @RequirePermissions('project:update')
  @ProjectAccess(fromProjectParam('projectId'))
  refuseOffer(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Body() dto: RefuseOfferDto,
  ) {
    return this.projects.refuseOffer(user.orgId, id, user.userId, user.isAdmin, dto.reason);
  }

  /**
   * Suppression définitive — DRAFT ou CHARTER_REVIEW uniquement. Une fois
   * ACTIVE/COMPLETED/ARCHIVED, le projet a potentiellement de l'historique
   * (tâches, temps, allocations) et seul l'archivage est possible.
   */
  @Delete(':projectId')
  @RequirePermissions('project:delete')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) id: string,
  ) {
    return this.projects.delete(user.orgId, id);
  }

  // ------------------------------------------------------------
  // Project Managers (admin)
  // Réservé aux rôles disposant de `project:assign_managers`.
  // ------------------------------------------------------------

  // Lecture seule : tout user qui peut voir le projet peut consulter la liste
  // des membres et de leurs rôles (utile à n'importe quel équipier pour savoir
  // qui pilote, qui contribue, qui est viewer/guest). Les mutations restent
  // gardées par `project:assign_managers`.
  @Get(':projectId/members')
  @RequirePermissions('project:view')
  @ProjectAccess(fromProjectParam('projectId'))
  listMembers(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.listMembers(user.orgId, projectId);
  }

  @Post(':projectId/managers')
  @RequirePermissions('project:assign_managers')
  addManager(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: AssignManagerDto,
  ) {
    return this.projects.addManager(user.orgId, projectId, dto.userId);
  }

  @Delete(':projectId/managers/:userId')
  @RequirePermissions('project:assign_managers')
  removeManager(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.projects.removeManager(user.orgId, projectId, userId);
  }

  /**
   * Ajoute (ou re-désigne) un membre du projet avec n'importe quel rôle
   * project-scoped — PROJECT_MANAGER, CONTRIBUTOR, VIEWER ou GUEST.
   */
  @Post(':projectId/members')
  @RequirePermissions('project:assign_managers')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: AssignMemberDto,
  ) {
    return this.projects.upsertMember(
      user.orgId,
      projectId,
      dto.userId,
      dto.roleKey,
      dto.isSponsor,
    );
  }

  /**
   * Flags orthogonaux au rôle d'un membre existant (pattern PATCH /teams/:id/
   * members/:userId pour isLead). Aujourd'hui : `isSponsor` — tag d'audience
   * de communication (annonces, jalons, statut projet), aucun droit associé.
   */
  @Patch(':projectId/members/:userId')
  @RequirePermissions('project:assign_managers')
  updateMember(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateProjectMemberDto,
  ) {
    return this.projects.updateMember(user.orgId, projectId, userId, dto);
  }

  @Delete(':projectId/members/:userId')
  @RequirePermissions('project:assign_managers')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.projects.removeMember(user.orgId, projectId, userId);
  }

  // ----------------------------------------------------------------
  // Teams assignées au projet (filtrent la visibilité côté users)
  // ----------------------------------------------------------------

  @Get(':projectId/teams')
  @RequirePermissions('project:view')
  @ProjectAccess(fromProjectParam('projectId'))
  listTeams(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.listTeams(user.orgId, projectId);
  }

  @Post(':projectId/teams')
  @RequirePermissions('project:assign_managers')
  addTeam(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: { teamId: string; roleKey?: string },
  ) {
    return this.projects.addTeam(user.orgId, projectId, dto.teamId, dto.roleKey ?? 'CONTRIBUTOR');
  }

  /** Change le niveau d'accès project-scopé d'une équipe déjà assignée. */
  @Patch(':projectId/teams/:teamId')
  @RequirePermissions('project:assign_managers')
  setTeamRole(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: { roleKey: string },
  ) {
    return this.projects.setTeamRole(user.orgId, projectId, teamId, dto.roleKey);
  }

  /**
   * `?removeMembers=1` retire aussi, atomiquement, les membres directs du
   * projet qui appartiennent au roster de l'équipe détachée.
   */
  @Delete(':projectId/teams/:teamId')
  @RequirePermissions('project:assign_managers')
  removeTeam(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Query('removeMembers') removeMembers?: string,
  ) {
    return this.projects.removeTeam(
      user.orgId,
      projectId,
      teamId,
      removeMembers === '1' || removeMembers === 'true',
    );
  }

  /** Candidats à ajouter comme membre direct : restreints aux équipes assignées. */
  @Get(':projectId/candidates')
  @RequirePermissions('project:assign_managers')
  listCandidates(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.listCandidates(user.orgId, projectId);
  }

  // ----------------------------------------------------------------
  // Project charter (initiation : DRAFT → CHARTER_REVIEW → ACTIVE)
  // ----------------------------------------------------------------

  @Get(':projectId/charter')
  @RequirePermissions('project:view')
  getCharter(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.getCharter(user.orgId, projectId, user.userId, user.isAdmin);
  }

  @Put(':projectId/charter')
  @RequirePermissions('project:update')
  upsertCharter(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() patch: Record<string, unknown>,
  ) {
    return this.projects.upsertCharter(user.orgId, projectId, user.userId, user.isAdmin, patch);
  }

  /**
   * Génère et renvoie le charter rempli au format Word (.docx). Disponible
   * à tout statut de projet (utile aussi pour archiver une copie post-ACTIVE).
   */
  @Get(':projectId/charter.docx')
  @RequirePermissions('project:view')
  async exportCharterDocx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ) {
    const { buffer, project } = await this.projects.exportCharterDocx(
      user.orgId,
      projectId,
      user.userId,
      user.isAdmin,
    );
    const safeName =
      `${project.key}-charter-${project.name}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) +
      '.docx';
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }

  /**
   * Re-téléchargement du charter signé déjà uploadé. v1 : lit depuis le
   * volume local de la réplique courante — peut renvoyer 404 si l'upload
   * avait atterri sur l'autre réplique (à migrer vers MinIO en v1.2).
   */
  @Get(':projectId/charter/signed-document')
  @RequirePermissions('project:view')
  async downloadSignedCharter(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ) {
    const charter = await this.projects.getCharter(
      user.orgId,
      projectId,
      user.userId,
      user.isAdmin,
    );
    if (!charter.signedDocument) {
      throw new NotFoundException('Aucun charter signé uploadé pour ce projet');
    }
    const key = charterKey(projectId, charter.signedDocument.filename);
    const exists = await this.s3.objectExists(this.s3.buckets.charters, key);
    if (!exists) {
      throw new NotFoundException('Fichier introuvable dans le stockage');
    }
    const buffer = await this.s3.getObjectBuffer(this.s3.buckets.charters, key);
    res.setHeader('Content-Type', charter.signedDocument.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${charter.signedDocument.filename}"`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }

  /**
   * Upload du charter signé par le client. v1 : stockage local sur le volume
   * de l'API (`CHARTER_BLOB_ROOT`). v1.2 : MinIO. Une fois cet upload accepté,
   * `PATCH /projects/:id { status: 'ACTIVE' }` deviendra autorisé.
   */
  @Post(':projectId/charter/signed-document')
  @RequirePermissions('project:update')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_CHARTER_UPLOAD_BYTES },
    }),
  )
  async uploadSignedCharter(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('Fichier manquant (champ "file")');
    if (!ALLOWED_CHARTER_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `MIME type non autorisé (${file.mimetype}). Attendu : PDF ou Word.`,
      );
    }
    // Stockage MinIO. Le nom est neutralisé pour éviter les soucis d'encodage.
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    await this.s3.putObject(
      this.s3.buckets.charters,
      charterKey(projectId, safeName),
      file.buffer,
      file.mimetype,
    );
    return this.projects.recordSignedCharter(
      user.orgId,
      projectId,
      user.userId,
      user.isAdmin,
      { filename: safeName, mimeType: file.mimetype, sizeBytes: file.size },
    );
  }

  // ----- Documents projet (offres commerciales, propositions…) -----

  @Get(':projectId/documents')
  @RequirePermissions('project:view')
  listDocuments(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.projects.listDocuments(user.orgId, projectId, user.userId, user.isAdmin);
  }

  // Upload : tout MEMBRE du projet (décision 2026-07-19 — l'espace documents est
  // collaboratif : transcripts, fichiers de travail). `findOne` du service borne
  // l'accès au projet ; `project:view` = plancher membre.
  @Post(':projectId/documents')
  @RequirePermissions('project:view')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOC_UPLOAD_BYTES } }))
  async uploadDocument(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('kind') kind?: string,
    @Query('folderId') folderId?: string,
    @Query('aiContext') aiContext?: string,
  ) {
    if (!file) throw new BadRequestException('Fichier manquant (champ "file")');
    if (!ALLOWED_DOC_MIME.has(file.mimetype)) {
      throw new BadRequestException(`Type de fichier non autorisé (${file.mimetype}).`);
    }
    const docKind =
      kind === 'OTHER' ? ProjectDocumentKind.OTHER : ProjectDocumentKind.OFFER;
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    // Préfixe UUID pour éviter les collisions de noms (plusieurs offres homonymes).
    const storedName = `${randomUUID()}-${safeName}`;
    const key = docKey(projectId, storedName);
    await this.s3.putObject(this.s3.buckets.charters, key, file.buffer, file.mimetype);
    return this.projects.recordDocument(user.orgId, projectId, user.userId, user.isAdmin, {
      kind: docKind,
      filename: safeName,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      storageKey: key,
      folderId: folderId || null,
      aiContext: aiContext === '1' || aiContext === 'true',
    });
  }

  /** Déplacer un document (folderId, null = racine) / toggle « Contexte IA ». */
  @Patch(':projectId/documents/:docId')
  @RequirePermissions('project:view')
  updateDocument(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() dto: { folderId?: string | null; aiContext?: boolean },
  ) {
    return this.projects.updateDocument(user.orgId, projectId, user.userId, user.isAdmin, docId, {
      folderId: dto.folderId,
      aiContext: typeof dto.aiContext === 'boolean' ? dto.aiContext : undefined,
    });
  }

  // ----- Dossiers de l'espace documents (arborescence libre) -----

  @Get(':projectId/folders')
  @RequirePermissions('project:view')
  listFolders(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.projects.listFolders(user.orgId, projectId, user.userId, user.isAdmin);
  }

  @Post(':projectId/folders')
  @RequirePermissions('project:view')
  createFolder(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: { name: string; parentId?: string | null },
  ) {
    return this.projects.createFolder(user.orgId, projectId, user.userId, user.isAdmin, dto);
  }

  @Patch(':projectId/folders/:folderId')
  @RequirePermissions('project:view')
  updateFolder(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('folderId', ParseUUIDPipe) folderId: string,
    @Body() dto: { name?: string; parentId?: string | null },
  ) {
    return this.projects.updateFolder(user.orgId, projectId, user.userId, user.isAdmin, folderId, dto);
  }

  @Delete(':projectId/folders/:folderId')
  @RequirePermissions('project:view')
  deleteFolder(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('folderId', ParseUUIDPipe) folderId: string,
  ) {
    return this.projects.deleteFolder(user.orgId, projectId, user.userId, user.isAdmin, folderId);
  }

  @Get(':projectId/documents/:docId/download')
  @RequirePermissions('project:view')
  async downloadDocument(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Res() res: Response,
  ) {
    const doc = await this.projects.getDocumentRaw(
      user.orgId,
      projectId,
      user.userId,
      user.isAdmin,
      docId,
    );
    const exists = await this.s3.objectExists(this.s3.buckets.charters, doc.storageKey);
    if (!exists) throw new NotFoundException('Blob du document introuvable');
    const buffer = await this.s3.getObjectBuffer(this.s3.buckets.charters, doc.storageKey);
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }

  // Suppression : tout membre (décision 2026-07-19, y compris les offres —
  // choix produit explicite « tout le monde tout »).
  @Delete(':projectId/documents/:docId')
  @RequirePermissions('project:view')
  async deleteDocument(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    const doc = await this.projects.deleteDocument(
      user.orgId,
      projectId,
      user.userId,
      user.isAdmin,
      docId,
    );
    // Best-effort cleanup du blob.
    await this.s3.removeObject(this.s3.buckets.charters, doc.storageKey).catch(() => {});
    return { ok: true };
  }
}
