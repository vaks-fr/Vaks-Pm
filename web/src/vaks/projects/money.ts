/* ============================================================
   Vaks — helpers de formatage monétaire (devise org)
   ============================================================ */

/** Formate un montant dans la devise org (Intl). null → tiret. */
export function fmtMoney(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Comme fmtMoney mais sans centimes (euros entiers). null → tiret.
 *  Usage : valeurs KPI (déjà arrondies) où les ",00" sont du bruit et coûtent
 *  de la largeur. */
export function fmtMoneyWhole(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

/** Notation compacte k/M pour montants (ex. « 480 k € », « 1,5 M € »), sans
 *  décimale superflue (« 480 k € » et non « 480,0 k € »). Utilisé quand la
 *  carte est trop étroite pour le montant exact. null → tiret. */
export function fmtMoneyCompact(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—';
  try {
    const nf = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    const parts = nf.formatToParts(amount);
    // Retire une fraction « 0 » (et son séparateur décimal) → « 480 k € ».
    const fi = parts.findIndex((p) => p.type === 'fraction');
    if (fi >= 0 && parts[fi].value === '0') {
      const cut = fi > 0 && parts[fi - 1].type === 'decimal' ? fi - 1 : fi;
      parts.splice(cut, fi - cut + 1);
    }
    return parts.map((p) => p.value).join('');
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

/** Parse un input texte → nombre ≥ 0 arrondi 2 décimales, ou null si vide. */
export function parseMoney(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
