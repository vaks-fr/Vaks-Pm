import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  REPORT_WIDGET_KEYS,
  type ReportWidgetKey,
  type ReportWidgetPreferenceDto,
} from '@vaks-pm/shared';
import { UpdateReportWidgetsDto } from './dto/report-widgets.dto';

const KNOWN_KEYS = new Set<string>(REPORT_WIDGET_KEYS);
const isWidgetKey = (k: string): k is ReportWidgetKey => KNOWN_KEYS.has(k);

/** Complète un ordre partiel avec les clés du registre absentes (widgets
 *  livrés après le dernier enregistrement de l'utilisateur) et retire les
 *  clés qui n'existent plus. */
function mergeWithRegistry(order: string[]): ReportWidgetKey[] {
  const known = order.filter(isWidgetKey);
  const seen = new Set(known);
  for (const key of REPORT_WIDGET_KEYS) {
    if (!seen.has(key)) known.push(key);
  }
  return known;
}

@Injectable()
export class ReportWidgetsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Préférence effective — calculée à la lecture si aucune ligne n'existe
   *  encore (pas d'écriture tant que l'utilisateur n'a rien personnalisé). */
  async getEffective(orgId: string, userId: string, projectId: string): Promise<ReportWidgetPreferenceDto> {
    const row = await this.prisma.reportWidgetPreference.findUnique({
      where: { organizationId_userId_projectId: { organizationId: orgId, userId, projectId } },
    });
    if (!row) {
      return { widgetOrder: [...REPORT_WIDGET_KEYS], hiddenKeys: [] };
    }
    const widgetOrder = mergeWithRegistry(row.widgetOrder);
    const orderSet = new Set<string>(widgetOrder);
    const hiddenKeys = row.hiddenKeys.filter((k) => isWidgetKey(k) && orderSet.has(k)) as ReportWidgetKey[];
    return { widgetOrder, hiddenKeys };
  }

  /** Upsert de la préférence de l'utilisateur courant sur ce projet. Filtre
   *  silencieusement les clés inconnues (skew de déploiement front/back) au
   *  lieu de rejeter — même tolérance que le reste des settings self-service. */
  async update(
    orgId: string,
    userId: string,
    projectId: string,
    dto: UpdateReportWidgetsDto,
  ): Promise<ReportWidgetPreferenceDto> {
    const widgetOrder = mergeWithRegistry(dto.widgetOrder ?? []);
    const orderSet = new Set<string>(widgetOrder);
    const hiddenKeys = (dto.hiddenKeys ?? []).filter((k) => isWidgetKey(k) && orderSet.has(k));

    await this.prisma.reportWidgetPreference.upsert({
      where: { organizationId_userId_projectId: { organizationId: orgId, userId, projectId } },
      create: { organizationId: orgId, userId, projectId, widgetOrder, hiddenKeys },
      update: { widgetOrder, hiddenKeys },
    });
    return this.getEffective(orgId, userId, projectId);
  }
}
