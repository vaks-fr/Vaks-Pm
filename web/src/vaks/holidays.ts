/* ============================================================
   Vaks — client-side holiday lookup with memoization.
   La source de vérité reste l'API (`/holidays`), qui s'appuie
   sur la lib `date-holidays`. Ici on cache (country, year) côté
   navigateur pour éviter de re-fetcher à chaque ouverture d'une
   tâche.
   ============================================================ */
import { api } from '../api/client';

export interface HolidayHit {
  /** Pays ISO 3166-1 alpha-2 dans lequel ce jour est férié. */
  country: string;
  /** Nom du férié (ex. "Fête du Travail"). */
  name: string;
}

/** ISO yyyy-mm-dd → libellé. */
type YearMap = Map<string, string>;

const cache = new Map<string, Promise<YearMap>>();
let defaultCountryPromise: Promise<string> | null = null;

function isoYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Pays par défaut de l'organisation (caché en mémoire). */
export function getOrgDefaultCountry(): Promise<string> {
  if (!defaultCountryPromise) {
    defaultCountryPromise = api
      .getOrgDefaultHolidayCountry()
      .then((r) => r.country)
      .catch(() => 'FR');
  }
  return defaultCountryPromise;
}

/** Renvoie une map yyyy-mm-dd → libellé pour (country, year). */
export function fetchCountryYear(country: string, year: number): Promise<YearMap> {
  const key = `${country.toUpperCase()}-${year}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const p = api
    .lookupHolidays({ country, from, to })
    .then((r) => {
      const m: YearMap = new Map();
      for (const h of r.holidays) m.set(h.date, h.name);
      return m;
    })
    .catch(() => new Map() as YearMap);
  cache.set(key, p);
  return p;
}

/**
 * Charge en parallèle les fériés pour toutes les paires (country, year)
 * couvrant les dates demandées. Renvoie une map `country → YearMap` pour
 * l'année (ou les années) couverte(s), avec toutes les années fusionnées.
 */
export async function loadHolidaysFor(
  countries: Iterable<string>,
  dates: Iterable<Date>,
): Promise<Map<string, Map<string, string>>> {
  const years = new Set<number>();
  for (const d of dates) years.add(d.getFullYear());
  if (years.size === 0) years.add(new Date().getFullYear());
  const cs = new Set<string>();
  for (const c of countries) {
    const up = (c || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(up)) cs.add(up);
  }
  const out = new Map<string, Map<string, string>>();
  await Promise.all(
    [...cs].map(async (c) => {
      const merged = new Map<string, string>();
      const maps = await Promise.all([...years].map((y) => fetchCountryYear(c, y)));
      for (const m of maps) for (const [k, v] of m) merged.set(k, v);
      out.set(c, merged);
    }),
  );
  return out;
}

/**
 * Pour un jeu de pays + une date, renvoie tous les pays où ce jour est férié,
 * avec le nom du jour. Si aucun pays ne marque ce jour, renvoie un tableau vide.
 */
export function holidayHitsFor(
  date: Date,
  countryHolidays: Map<string, Map<string, string>>,
): HolidayHit[] {
  const iso = isoYMD(date);
  const hits: HolidayHit[] = [];
  for (const [country, m] of countryHolidays) {
    const name = m.get(iso);
    if (name) hits.push({ country, name });
  }
  return hits;
}
