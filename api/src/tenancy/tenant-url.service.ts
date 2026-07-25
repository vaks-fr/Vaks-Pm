import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantContext } from './tenant-context.service';

/**
 * Origine publique de l'app, résolue PAR TENANT.
 *
 * En mode `pooled`, un `APP_URL` global n'a pas de sens : chaque tenant vit
 * sur son propre host (`<slug>.<baseDomain>` ou domaine custom mappé). Ce
 * service dérive l'origine depuis le contexte tenant courant
 * (AsyncLocalStorage — posé par le middleware HTTP comme par les crons qui
 * itèrent les tenants via `TenantContext.run`), et ne retombe sur `appUrl`
 * (env `APP_URL`) qu'en mode `dedicated` ou hors contexte tenant.
 *
 * À utiliser pour TOUT lien sortant construit hors d'une requête HTTP
 * (emails, payloads webhook). Dans une requête HTTP, le Host de la requête
 * reste la source préférée (cf. `sso.service.ts` → `origin()`).
 */
@Injectable()
export class TenantUrlService {
  constructor(
    private readonly config: ConfigService,
    private readonly tenant: TenantContext,
  ) {}

  /** Origine publique (`https://…`, sans slash final) du tenant courant. */
  publicBaseUrl(): string {
    const slug = this.tenant.currentSlug();
    const dep = this.config.get<{
      mode: 'dedicated' | 'pooled';
      baseDomain: string;
      customDomains: Record<string, string>;
    }>('deployment');
    if (slug && dep?.mode === 'pooled') {
      // Un domaine custom mappé sur ce slug prime : c'est le host que les
      // utilisateurs de ce tenant visitent réellement (TLS ACME dédié).
      const custom = Object.keys(dep.customDomains ?? {}).find(
        (host) => dep.customDomains[host] === slug,
      );
      if (custom) return `https://${custom}`;
      if (dep.baseDomain) return `https://${slug}.${dep.baseDomain}`;
    }
    return (this.config.get<string>('appUrl') ?? 'http://localhost').replace(/\/+$/, '');
  }

  /** Deep-link vers une tâche (liens CTA des emails, champ `url` des webhooks). */
  taskUrl(taskId: string): string {
    return `${this.publicBaseUrl()}/tasks/${taskId}`;
  }

  /** Deep-link vers un projet. */
  projectUrl(projectId: string): string {
    return `${this.publicBaseUrl()}/projects/${projectId}`;
  }

  /** Deep-link vers une vue de l'app (`?view=timesheet`, …). */
  viewUrl(view: string): string {
    return `${this.publicBaseUrl()}/?view=${view}`;
  }
}
