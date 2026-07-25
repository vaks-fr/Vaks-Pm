/* ============================================================
   Vaks — Formatage dates/nombres centralisé
   ----------------------------------------------------------------
   Toutes les vues qui affichent une date/un nombre doivent passer
   par ces utilitaires : ils consomment la locale BCP47 de l'org
   (admin → Organization → Default locale) au lieu de la coder en
   dur. La locale est exposée par `useAuth().orgSettings.locale`.

   Utilisation :
     const f = useFormat();
     f.day(date)              → "15 août" / "Aug 15" / "8/15"
     f.dayMonth(date)         → idem (alias court)
     f.dayMonthYear(date)     → "15 août 2026" / …
     f.monthYear(date)        → "août 2026" / "August 2026"
     f.dateShort(date)        → format court complet "15/08/2026"
     f.dateTime(date)         → date + heure courte
     f.range(start, end)      → "15 août → 20 août 2026"
   ============================================================ */
import { useAuth } from '../auth/AuthContext';

/** Convertit une entrée hétérogène (Date | ISO string | timestamp) → Date. */
function toDate(input: Date | string | number): Date {
  if (input instanceof Date) return input;
  if (typeof input === 'number') return new Date(input);
  // ISO court "YYYY-MM-DD" : on force UTC pour éviter le drift TZ.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return new Date(input + 'T00:00:00Z');
  return new Date(input);
}

export interface Formatter {
  /** Locale BCP47 résolue (utile pour `<input lang=…>`, Intl, etc.). */
  locale: string;
  day(d: Date | string | number): string;
  dayMonth(d: Date | string | number): string;
  dayMonthYear(d: Date | string | number): string;
  monthShort(d: Date | string | number): string;
  monthYear(d: Date | string | number): string;
  dateShort(d: Date | string | number): string;
  dateTime(d: Date | string | number): string;
  range(start: Date | string | number, end: Date | string | number): string;
}

export function makeFormatter(locale: string): Formatter {
  // `month: 'short'` donne "août" en fr-FR, "Aug" en en-GB/en-US, etc.
  const fmtDayMonth = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' });
  const fmtDayMonthYear = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const fmtMonthYear = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  const fmtMonthShort = new Intl.DateTimeFormat(locale, { month: 'short' });
  const fmtShort = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const fmtDateTime = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return {
    locale,
    day: (d) => fmtDayMonth.format(toDate(d)),
    dayMonth: (d) => fmtDayMonth.format(toDate(d)),
    dayMonthYear: (d) => fmtDayMonthYear.format(toDate(d)),
    monthShort: (d) => fmtMonthShort.format(toDate(d)),
    monthYear: (d) => {
      const s = fmtMonthYear.format(toDate(d));
      // Capitalise la première lettre — utile en fr-FR ("août" → "Août") quand
      // la chaîne est affichée comme titre.
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    dateShort: (d) => fmtShort.format(toDate(d)),
    dateTime: (d) => fmtDateTime.format(toDate(d)),
    range: (start, end) => {
      const s = toDate(start);
      const e = toDate(end);
      // Si même année, on omet l'année sur le début pour alléger.
      if (s.getFullYear() === e.getFullYear()) {
        return `${fmtDayMonth.format(s)} → ${fmtDayMonthYear.format(e)}`;
      }
      return `${fmtDayMonthYear.format(s)} → ${fmtDayMonthYear.format(e)}`;
    },
  };
}

/** Hook React : retourne le Formatter configuré sur la locale org courante. */
export function useFormat(): Formatter {
  const { orgSettings } = useAuth();
  return makeFormatter(orgSettings.locale);
}
