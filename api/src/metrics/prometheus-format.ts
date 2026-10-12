/**
 * Petit helper d'exposition **OpenMetrics / Prometheus text format**
 * (`text/plain; version=0.0.4`), volontairement sans dépendance externe
 * (pas de `prom-client` — un scrape read-only par org n'a pas besoin d'un
 * registre process-global, cf. `metrics.service.ts`).
 *
 * Spec minimale respectée : une ligne `# HELP <name> <text>`, une ligne
 * `# TYPE <name> <gauge|counter>`, puis une ou plusieurs lignes
 * `<name>{label="value",...} <number>`. Cf.
 * https://github.com/OpenObservability/OpenMetrics/blob/main/specification/OpenMetrics.md
 */

export type MetricValue = number | null;

export interface MetricSample {
  /** Valeurs de labels (déjà échappées par ce module — ne PAS pré-échapper). */
  labels?: Record<string, string | number>;
  value: MetricValue;
}

/** Échappe une valeur de label selon la spec text-format (`\`, `"`, `\n`). */
function escapeLabelValue(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels?: Record<string, string | number>): string {
  if (!labels) return '';
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',') + '}';
}

/** Formatte une valeur numérique (Prometheus attend `NaN` en toutes lettres, jamais `null`). */
function renderValue(v: MetricValue): string {
  if (v == null || Number.isNaN(v)) return 'NaN';
  return String(v);
}

/**
 * Construit un accumulateur texte : `metric(...)` ajoute un bloc HELP/TYPE/
 * échantillons pour un nom donné. `toString()` rend le corps final.
 */
export class OpenMetricsBuilder {
  private lines: string[] = [];

  /** Ajoute une métrique `gauge` (valeur qui peut monter/descendre — sièges, comptes). */
  gauge(name: string, help: string, samples: MetricSample | MetricSample[]): this {
    return this.metric(name, 'gauge', help, samples);
  }

  /** Ajoute une métrique `counter` (monotone — non utilisée pour l'instant, réservé). */
  counter(name: string, help: string, samples: MetricSample | MetricSample[]): this {
    return this.metric(name, 'counter', help, samples);
  }

  private metric(
    name: string,
    type: 'gauge' | 'counter',
    help: string,
    samples: MetricSample | MetricSample[],
  ): this {
    const list = Array.isArray(samples) ? samples : [samples];
    this.lines.push(`# HELP ${name} ${help.replace(/\n/g, ' ')}`);
    this.lines.push(`# TYPE ${name} ${type}`);
    for (const s of list) {
      this.lines.push(`${name}${renderLabels(s.labels)} ${renderValue(s.value)}`);
    }
    return this;
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}
