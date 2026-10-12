/**
 * Builder iCalendar (RFC 5545) minimal — juste ce qu'il faut pour un flux
 * VCALENDAR/VEVENT en lecture seule (échéances + allocations, slice C du
 * calendrier). Pas de dépendance externe : le format est simple à générer et
 * on ne veut auditer aucun package tiers pour un flux self-only.
 */

export interface IcsEvent {
  /** Stable dans le temps (ex. `task-<id>@vaks-pm`) — le client calendrier
   * s'en sert pour dédupliquer/mettre à jour l'entrée entre deux polls. */
  uid: string;
  summary: string;
  description?: string | null;
  /** Journée entière : DTSTART;VALUE=DATE, DTEND exclusif (RFC 5545 §3.6.1). */
  startDate: Date;
  /** Défaut = startDate + 1 jour (événement d'un seul jour). */
  endDateExclusive?: Date;
}

/** Échappe `\`, `,`, `;` et les retours ligne — RFC 5545 §3.3.11. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Folding de ligne à 75 octets (RFC 5545 §3.1) : au-delà, continuation sur la
 * ligne suivante préfixée d'un espace. On coupe en octets UTF-8, jamais au
 * milieu d'un caractère multi-octet (sinon flux corrompu chez le client).
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    // Ne pas couper au milieu d'un caractère multi-octet (continuation 10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(offset, end).toString('utf8'));
    offset = end;
    limit = 74; // la ligne de continuation démarre par un espace (1 octet)
  }
  return chunks.join('\r\n ');
}

/** `YYYYMMDD` (date locale, sans heure) pour `VALUE=DATE`. */
export function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** `YYYYMMDDTHHMMSSZ` pour DTSTAMP (horodatage de génération, toujours UTC). */
export function fmtDateTimeUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${day}T${h}${mi}${s}Z`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function buildVevent(ev: IcsEvent, now: Date): string {
  const dtend = ev.endDateExclusive ?? addDays(ev.startDate, 1);
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeText(ev.uid)}`,
    `DTSTAMP:${fmtDateTimeUtc(now)}`,
    `DTSTART;VALUE=DATE:${fmtDate(ev.startDate)}`,
    `DTEND;VALUE=DATE:${fmtDate(dtend)}`,
    `SUMMARY:${escapeText(ev.summary)}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  lines.push('END:VEVENT');
  return lines.map(foldLine).join('\r\n');
}

/** Assemble un VCALENDAR complet, prêt à envoyer tel quel (fin de ligne CRLF). */
export function buildVCalendar(events: IcsEvent[], now: Date = new Date()): string {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vaks-PM//Calendar Feed//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // Rafraîchissement suggéré aux clients qui le respectent (Outlook/Google
    // repollent de toute façon à leur propre cadence, mais l'indication est
    // standard sur ce type de flux).
    'X-PUBLISHED-TTL:PT1H',
  ];
  const body = events.map((ev) => buildVevent(ev, now));
  const footer = ['END:VCALENDAR'];
  return [...header, ...body, ...footer].join('\r\n') + '\r\n';
}
