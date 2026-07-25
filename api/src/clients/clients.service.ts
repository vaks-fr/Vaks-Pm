import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ClientStatus } from '@db';
import { normalizeAllowedAgentModels } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { parseCsvRows, toCsv } from '../common/csv.util';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { anonLabel } from '../common/rgpd.util';
import {
  CLIENT_STATUSES,
  CreateClientDto,
  CreateContactDto,
  ListClientsDto,
  UpdateClientDto,
  UpdateContactDto,
} from './dto/client.dto';

const DEFAULT_PAGE_SIZE = 12;

/** Filtre _count partagé : ne compte que les enfants non soft-deleted.
 *  `kind: STANDARD` : les projets EXTERNAL (conteneurs de tickets d'outils
 *  externes, timesheet only) sont invisibles côté clients aussi. */
const liveCounts = {
  _count: {
    select: {
      contacts: { where: { deletedAt: null } },
      projects: { where: { deletedAt: null, kind: 'STANDARD' as const } },
    },
  },
} as const;

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  private mapClient(c: {
    id: string;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    notes: string | null;
    status: ClientStatus;
    allowedAgentModels?: string[];
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: c.id,
      name: c.name,
      company: c.company,
      email: c.email,
      phone: c.phone,
      address: c.address,
      notes: c.notes,
      status: c.status,
      allowedAgentModels: c.allowedAgentModels ?? [],
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private mapContact(ct: {
    id: string;
    clientId: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    notes: string | null;
    isPrimary: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: ct.id,
      clientId: ct.clientId,
      name: ct.name,
      title: ct.title,
      email: ct.email,
      phone: ct.phone,
      notes: ct.notes,
      isPrimary: ct.isPrimary,
      createdAt: ct.createdAt.toISOString(),
      updatedAt: ct.updatedAt.toISOString(),
    };
  }

  private listWhere(orgId: string, query: ListClientsDto): Prisma.ClientWhereInput {
    const where: Prisma.ClientWhereInput = { organizationId: orgId, deletedAt: null };
    if (query.status) where.status = query.status as ClientStatus;
    const q = query.search?.trim();
    if (q) {
      // Recherche élargie : champs du client + nom des contacts vivants.
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { company: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { contacts: { some: { deletedAt: null, name: { contains: q, mode: 'insensitive' } } } },
      ];
    }
    return where;
  }

  async list(orgId: string, query: ListClientsDto) {
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const page = query.page ?? 1;
    const where = this.listWhere(orgId, query);
    const [total, clients] = await this.prisma.$transaction([
      this.prisma.client.count({ where }),
      this.prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          ...liveCounts,
          contacts: {
            where: { deletedAt: null, isPrimary: true },
            select: { id: true, name: true, title: true },
            take: 1,
          },
        },
      }),
    ]);
    return {
      items: clients.map((c) => ({
        ...this.mapClient(c),
        contactCount: c._count.contacts,
        projectCount: c._count.projects,
        primaryContact: c.contacts[0] ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(orgId: string, clientId: string) {
    const c = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId, deletedAt: null },
      include: {
        contacts: {
          where: { deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        },
        projects: {
          where: { deletedAt: null, kind: 'STANDARD' },
          select: { id: true, key: true, name: true, status: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!c) throw new NotFoundException('Client introuvable');
    return {
      ...this.mapClient(c),
      contacts: c.contacts.map((ct) => this.mapContact(ct)),
      projects: c.projects,
    };
  }

  async create(orgId: string, dto: CreateClientDto) {
    try {
      const c = await this.prisma.client.create({
        data: {
          organizationId: orgId,
          name: dto.name,
          company: dto.company ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          address: dto.address ?? null,
          notes: dto.notes ?? null,
          status: (dto.status as ClientStatus | undefined) ?? ClientStatus.ACTIVE,
          allowedAgentModels: normalizeAllowedAgentModels(dto.allowedAgentModels),
        },
      });
      return this.mapClient(c);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Un client avec ce nom existe déjà');
      }
      throw e;
    }
  }

  async update(orgId: string, clientId: string, dto: UpdateClientDto) {
    await this.assertClient(orgId, clientId);
    try {
      const c = await this.prisma.client.update({
        where: { id: clientId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.company !== undefined ? { company: dto.company } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.status !== undefined ? { status: dto.status as ClientStatus } : {}),
          ...(dto.allowedAgentModels !== undefined
            ? { allowedAgentModels: normalizeAllowedAgentModels(dto.allowedAgentModels) }
            : {}),
        },
      });
      return this.mapClient(c);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Un client avec ce nom existe déjà');
      }
      throw e;
    }
  }

  async remove(orgId: string, clientId: string) {
    const client = await this.assertClient(orgId, clientId);
    // Soft delete client + cascade soft-delete des contacts (les coordonnées
    // ne restent pas indéfiniment accessibles), et détache des projets pour
    // ne pas casser la FK affichage.
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.project.updateMany({
        where: { clientId, organizationId: orgId },
        data: { clientId: null },
      }),
      this.prisma.contact.updateMany({
        where: { clientId, organizationId: orgId, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.client.update({
        where: { id: clientId },
        data: { deletedAt: now },
      }),
    ]);
    return { id: clientId, name: client.name, deleted: true };
  }

  // ---- Import / export CSV ----

  async exportCsv(orgId: string): Promise<string> {
    const clients = await this.prisma.client.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      include: liveCounts,
    });
    return toCsv(
      ['name', 'company', 'email', 'phone', 'address', 'notes', 'status', 'contacts', 'projects'],
      clients.map((c) => [
        c.name,
        c.company,
        c.email,
        c.phone,
        c.address,
        c.notes,
        c.status,
        c._count.contacts,
        c._count.projects,
      ]),
    );
  }

  async exportContactsCsv(orgId: string): Promise<string> {
    const contacts = await this.prisma.contact.findMany({
      where: { organizationId: orgId, deletedAt: null, client: { deletedAt: null } },
      orderBy: [{ client: { name: 'asc' } }, { isPrimary: 'desc' }, { name: 'asc' }],
      include: { client: { select: { name: true } } },
    });
    return toCsv(
      ['client', 'name', 'title', 'email', 'phone', 'notes', 'isPrimary'],
      contacts.map((ct) => [
        ct.client.name,
        ct.name,
        ct.title,
        ct.email,
        ct.phone,
        ct.notes,
        ct.isPrimary ? 'yes' : '',
      ]),
    );
  }

  /**
   * Import CSV de clients — upsert par nom (clé unique org+name) : un nom
   * existant met à jour les champs fournis, un nom inconnu crée le client.
   * Colonnes : `name` (obligatoire) + `company,email,phone,address,notes,status`.
   */
  async importCsv(orgId: string, csv: string) {
    const parsed = parseCsvRows(csv);
    if (parsed.length === 0) throw new BadRequestException('CSV vide ou sans ligne de données');
    if (!('name' in parsed[0].row)) {
      throw new BadRequestException('Colonne obligatoire manquante : name');
    }
    let created = 0;
    let updated = 0;
    const errors: Array<{ line: number; error: string }> = [];
    const seen = new Set<string>();

    for (const { line, row } of parsed) {
      const name = (row.name ?? '').trim();
      if (!name) {
        errors.push({ line, error: 'name vide' });
        continue;
      }
      if (name.length > 160) {
        errors.push({ line, error: 'name trop long (160 max)' });
        continue;
      }
      const dedupeKey = name.toLowerCase();
      if (seen.has(dedupeKey)) {
        errors.push({ line, error: `doublon dans le fichier : ${name}` });
        continue;
      }
      seen.add(dedupeKey);

      const status = (row.status ?? '').trim().toUpperCase();
      if (status && !(CLIENT_STATUSES as readonly string[]).includes(status)) {
        errors.push({ line, error: `status invalide : ${row.status} (PROSPECT/ACTIVE/ARCHIVED)` });
        continue;
      }
      const email = (row.email ?? '').trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({ line, error: `email invalide : ${email}` });
        continue;
      }

      // Champ présent dans le CSV mais vide → on n'écrase pas la valeur existante.
      const opt = (key: string, max: number): string | undefined => {
        if (!(key in row)) return undefined;
        const v = row[key].trim();
        if (!v) return undefined;
        return v.slice(0, max);
      };

      const data = {
        company: opt('company', 160),
        email: email || undefined,
        phone: opt('phone', 40),
        address: opt('address', 500),
        notes: opt('notes', 2000),
        status: (status || undefined) as ClientStatus | undefined,
      };

      try {
        const existing = await this.prisma.client.findFirst({
          where: { organizationId: orgId, name, deletedAt: null },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.client.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await this.prisma.client.create({
            data: {
              organizationId: orgId,
              name,
              company: data.company ?? null,
              email: data.email ?? null,
              phone: data.phone ?? null,
              address: data.address ?? null,
              notes: data.notes ?? null,
              status: data.status ?? ClientStatus.ACTIVE,
            },
          });
          created++;
        }
      } catch (e) {
        errors.push({ line, error: (e as Error).message.slice(0, 200) });
      }
    }
    return { created, updated, errors };
  }

  // ---- Contacts ----

  async listContacts(orgId: string, clientId: string) {
    await this.assertClient(orgId, clientId);
    const contacts = await this.prisma.contact.findMany({
      where: { clientId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
    return contacts.map((ct) => this.mapContact(ct));
  }

  /** Garantit l'unicité du contact principal : poser isPrimary démet l'ancien. */
  private async clearPrimary(tx: Prisma.TransactionClient, clientId: string, exceptId?: string) {
    await tx.contact.updateMany({
      where: { clientId, isPrimary: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isPrimary: false },
    });
  }

  async createContact(orgId: string, clientId: string, dto: CreateContactDto) {
    await this.assertClient(orgId, clientId);
    const ct = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) await this.clearPrimary(tx, clientId);
      return tx.contact.create({
        data: {
          organizationId: orgId,
          clientId,
          name: dto.name,
          title: dto.title ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          notes: dto.notes ?? null,
          isPrimary: dto.isPrimary ?? false,
        },
      });
    });
    return this.mapContact(ct);
  }

  async updateContact(
    orgId: string,
    clientId: string,
    contactId: string,
    dto: UpdateContactDto,
  ) {
    await this.assertContact(orgId, clientId, contactId);
    const ct = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary === true) await this.clearPrimary(tx, clientId, contactId);
      return tx.contact.update({
        where: { id: contactId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
        },
      });
    });
    return this.mapContact(ct);
  }

  async removeContact(orgId: string, clientId: string, contactId: string) {
    const contact = await this.assertContact(orgId, clientId, contactId);
    await this.prisma.contact.update({
      where: { id: contactId },
      data: { deletedAt: new Date(), isPrimary: false },
    });
    return { id: contactId, name: contact.name, deleted: true };
  }

  // ---- RGPD : anonymisation (pseudonymisation, jamais de suppression) ----

  /**
   * **RGPD** — un `Client` est un compte/société : on blanchit uniquement les
   * coordonnées PII (email/téléphone/adresse/notes) et on **conserve**
   * l'identité business (`name`/`company`, requise par la contrainte d'unicité
   * et le lien aux projets/finance). Idempotent (re-null = no-op). Audité.
   * Fonctionne aussi sur un client soft-deleted.
   */
  async anonymizeClient(orgId: string, clientId: string, actor?: { id?: string; email?: string }) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId },
      select: { id: true, name: true },
    });
    if (!client) throw new NotFoundException('Client introuvable');
    await this.prisma.client.update({
      where: { id: clientId },
      data: { email: null, phone: null, address: null, notes: null },
    });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CLIENT_ANONYMIZED,
      actorId: actor?.id ?? null,
      actorLabel: actor?.email ?? null,
      resourceType: 'client',
      resourceId: clientId,
      resourceLabel: client.name,
      detail: { reason: 'rgpd' },
    });
    return { id: clientId, anonymized: true };
  }

  /**
   * **RGPD** — un `Contact` est une personne : anonymisation complète (nom →
   * pseudonyme dérivé de l'id, coordonnées nullées) + soft-delete. Idempotent
   * (le pseudonyme est déterministe). Audité. Fonctionne sur un contact déjà
   * soft-deleted.
   */
  async anonymizeContact(
    orgId: string,
    clientId: string,
    contactId: string,
    actor?: { id?: string; email?: string },
  ) {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, clientId, organizationId: orgId },
      select: { id: true, deletedAt: true },
    });
    if (!contact) throw new NotFoundException('Contact introuvable');
    const newName = anonLabel('Contact anonymisé', contactId);
    await this.prisma.contact.update({
      where: { id: contactId },
      data: {
        name: newName,
        email: null,
        phone: null,
        title: null,
        notes: null,
        isPrimary: false,
        deletedAt: contact.deletedAt ?? new Date(),
      },
    });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONTACT_ANONYMIZED,
      actorId: actor?.id ?? null,
      actorLabel: actor?.email ?? null,
      resourceType: 'contact',
      resourceId: contactId,
      resourceLabel: newName,
      detail: { reason: 'rgpd', clientId },
    });
    return { id: contactId, anonymized: true };
  }

  private async assertClient(orgId: string, clientId: string) {
    const c = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!c) throw new NotFoundException('Client introuvable');
    return c;
  }

  private async assertContact(orgId: string, clientId: string, contactId: string) {
    const c = await this.prisma.contact.findFirst({
      where: {
        id: contactId,
        clientId,
        organizationId: orgId,
        deletedAt: null,
      },
      select: { id: true, name: true },
    });
    if (!c) throw new NotFoundException('Contact introuvable');
    return c;
  }
}
