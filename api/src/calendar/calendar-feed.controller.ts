import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { CalendarService } from './calendar.service';

/**
 * Flux ICS abonnable (Outlook/Google : « S'abonner via URL »). PUBLIC,
 * volontairement SANS `JwtAuthGuard` — un client calendrier fait un simple GET
 * périodique sans jamais porter de bearer. L'auth passe entièrement par le
 * token opaque dans l'URL (`CalendarService.renderIcs`), qui ne donne accès
 * qu'aux données du user propriétaire de ce token.
 *
 * `@SkipAudit` : lecture répétée et à haute fréquence côté client calendrier
 * (polling horaire type) — bruit pur en audit, et le token ne doit de toute
 * façon JAMAIS apparaître dans une entrée journalisée.
 */
@Controller('calendar')
@SkipAudit()
export class CalendarFeedController {
  constructor(private readonly calendar: CalendarService) {}

  @Get(':token')
  async feed(@Param('token') tokenParam: string, @Res() res: Response) {
    // Certains clients (Google Calendar notamment) exigent une URL en `.ics` ;
    // on l'accepte en suffixe et on le retire avant la résolution du token,
    // plutôt que de dépendre d'un pattern de route `:token.ics` fragile côté
    // path-to-regexp.
    const token = tokenParam.endsWith('.ics') ? tokenParam.slice(0, -4) : tokenParam;
    const ics = await this.calendar.renderIcs(token);
    if (ics === null) {
      res.status(404).send();
      return;
    }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // Privé par nature (données perso) ; cache court côté client seulement,
    // jamais un cache partagé (proxy/CDN).
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(ics);
  }
}
