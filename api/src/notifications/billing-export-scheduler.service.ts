import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { NotificationsService } from './notifications.service';
import { FinanceService } from '../finance/finance.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { getEmailQueue } from './email-queue';
import { toCsv } from '../common/csv.util';
import { buildXlsx, type XlsxSheet } from '../common/xlsx.util';
import { reportT } from '../common/i18n/report-i18n';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Cron natif (setInterval, 1h) — envoie l'export facturation planifié
 * aux destinataires configurés via Admin > Organization > Finance.
 *
 * Période automatique :
 *   - weekly  → semaine calendaire précédente (lun–dim UTC)
 *   - monthly → mois calendaire précédent (1er au dernier jour)
 *
 * Lock Redis par org+date pour éviter les doublons en Swarm.
 */
@Injectable()
export class BillingExportSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BillingExportSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly notifications: NotificationsService,
    private readonly finance: FinanceService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), HOUR_MS);
    setTimeout(() => void this.tick(), 90_000); // 90s après le boot
    this.log.log('Billing export scheduler armé (interval 1h).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposé pour le bouton "Send now" (admin). */
  async sendNow(orgId: string): Promise<{ sent: number; skipped: boolean }> {
    return this.processOrg(orgId, true);
  }

  private async tick(): Promise<void> {
    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.processAllOrgs());
        } catch (err) {
          this.log.warn(`billing-export tick tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    } else {
      await this.processAllOrgs();
    }
  }

  private async tenantSlugs(): Promise<string[]> {
    const base = process.env.DATABASE_URL;
    if (!base) return [];
    let dbName: string;
    try {
      dbName = new URL(base).pathname.replace(/^\//, '') || 'myapp';
    } catch {
      return [];
    }
    const rows = await this.prisma.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE '${dbName}\\_%' AND datallowconn = true`,
    );
    return rows.map((r) => r.datname.replace(/^[^_]+_/, ''));
  }

  private async processAllOrgs(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      try {
        await this.processOrg(org.id, false);
      } catch (err) {
        this.log.warn(`billing-export org=${org.id} failed: ${(err as Error).message}`);
      }
    }
  }

  private async processOrg(
    orgId: string,
    forceSend: boolean,
  ): Promise<{ sent: number; skipped: boolean }> {
    const schedule = await this.settings.getBillingExportSchedule(orgId);
    if (!schedule.enabled || schedule.recipients.length === 0) {
      return { sent: 0, skipped: true };
    }

    if (!forceSend) {
      const nowUtc = new Date();
      const hour = nowUtc.getUTCHours();
      if (hour !== schedule.hour) return { sent: 0, skipped: true };

      const dayOfWeek = nowUtc.getUTCDay() === 0 ? 7 : nowUtc.getUTCDay(); // 1=Lun…7=Dim
      const dayOfMonth = nowUtc.getUTCDate();
      if (schedule.frequency === 'weekly' && dayOfWeek !== schedule.weekDay) return { sent: 0, skipped: true };
      if (schedule.frequency === 'monthly' && dayOfMonth !== schedule.monthDay) return { sent: 0, skipped: true };

      // Lock Redis — 1 envoi par org par jour
      const queue = getEmailQueue();
      const client = await queue.client;
      const lockKey = `vaks:billing-export:${orgId}:${new Date().toISOString().slice(0, 10)}`;
      const ok = await (client as unknown as {
        set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
      }).set(lockKey, '1', 'EX', 90_000, 'NX');
      if (ok !== 'OK') return { sent: 0, skipped: true };
    }

    const { from, to, label } = this.computePeriod(schedule.frequency);

    const data = await this.finance.billingExport(
      orgId,
      { userId: '', isAdmin: true },
      { from, to },
    );

    const t = reportT('en');
    const headers = billingHeaders(t, data.currency);
    const rows = data.rows.map((r) => billingRow(t, r));
    const filename = `billing-${from}_${to}.${schedule.format}`;
    let contentBase64: string;
    let contentType: string;

    if (schedule.format === 'xlsx') {
      const sheets: XlsxSheet[] = [
        { name: t('sheet.billingDetail'), headers, rows },
        {
          name: t('sheet.summary'),
          headers: [t('be.client'), t('project'), t('name'), t('user'), t('tb.billableHours'), t('be.amount', { cur: data.currency })],
          rows: data.summary.map((s) => [s.clientName, s.projectKey, s.projectName, s.userName, s.billableHours, s.amount]),
        },
      ];
      const buf = await buildXlsx(sheets, { title: t('title.billingExport') });
      contentBase64 = buf.toString('base64');
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else {
      contentBase64 = Buffer.from(toCsv(headers, rows)).toString('base64');
      contentType = 'text/csv';
    }

    const attachment = { filename, contentType, contentBase64 };
    let sent = 0;
    for (const email of schedule.recipients) {
      try {
        await this.notifications.sendBillingExportEmail(
          orgId,
          email,
          { period: label, rowCount: data.rows.length, filename },
          attachment,
        );
        sent++;
      } catch (err) {
        this.log.warn(`billing-export send to ${email} failed: ${(err as Error).message}`);
      }
    }
    this.log.log(`billing-export org=${orgId} period=${label} rows=${data.rows.length} sent=${sent}/${schedule.recipients.length}`);
    return { sent, skipped: false };
  }

  /** Calcule la période à exporter selon la fréquence. */
  private computePeriod(frequency: 'weekly' | 'monthly'): { from: string; to: string; label: string } {
    const now = new Date();
    if (frequency === 'weekly') {
      // Semaine calendaire précédente lun–dim UTC
      const dayOfWeek = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
      const toDate = new Date(now);
      toDate.setUTCDate(now.getUTCDate() - dayOfWeek); // dim dernier
      const fromDate = new Date(toDate);
      fromDate.setUTCDate(toDate.getUTCDate() - 6);     // lun dernier
      const from = fromDate.toISOString().slice(0, 10);
      const to = toDate.toISOString().slice(0, 10);
      return { from, to, label: `${from} → ${to}` };
    } else {
      // Mois calendaire précédent
      const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86_400_000);
      const firstOfPrevMonth = new Date(Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1));
      const from = firstOfPrevMonth.toISOString().slice(0, 10);
      const to = lastOfPrevMonth.toISOString().slice(0, 10);
      return { from, to, label: `${from} → ${to}` };
    }
  }
}

function billingHeaders(t: ReturnType<typeof reportT>, cur: string): string[] {
  return [
    t('date'), t('user'), t('email'), t('project'), t('name'), t('be.client'),
    t('be.kind'), t('task'), t('be.ticketSource'), t('be.ticketKey'), t('be.ticketUrl'),
    t('hours'), t('overtime'), t('billable'), t('be.rate'), t('be.amount', { cur }), t('description'),
  ];
}

function billingRow(t: ReturnType<typeof reportT>, r: {
  date: string; userName: string; userEmail: string; projectKey: string; projectName: string;
  clientName: string; kind: 'STANDARD' | 'EXTERNAL'; taskTitle: string;
  externalSource: string; externalKey: string; externalUrl: string;
  hours: number; overtimeHours: number; billable: boolean; billRate: number | null; amount: number; note: string;
}): unknown[] {
  return [
    r.date, r.userName, r.userEmail, r.projectKey, r.projectName, r.clientName,
    r.kind === 'EXTERNAL' ? t('kind.external') : t('kind.standard'),
    r.taskTitle, r.externalSource, r.externalKey, r.externalUrl,
    r.hours, r.overtimeHours, r.billable ? t('yes') : t('no'),
    r.billRate ?? '', r.amount, r.note,
  ];
}
