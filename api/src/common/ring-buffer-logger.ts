import { ConsoleLogger } from '@nestjs/common';

export interface RingEntry {
  level: 'error' | 'warn';
  time: string;
  context?: string;
  message: string;
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Logger applicatif qui conserve en mémoire les N derniers messages
 * `error`/`warn` (anneau circulaire) EN PLUS de les écrire sur stdout comme
 * d'habitude (il étend `ConsoleLogger`). Sert au **bundle de diagnostic**
 * (« dernières erreurs ») : l'app ne logge que sur stdout, sans fichiers, donc
 * un bouton in-app n'a aucun fichier à zipper — cet anneau lui en tient lieu.
 *
 * Process-local : chaque réplica API a son propre anneau (pas de partage
 * Redis). Acceptable pour du diagnostic best-effort — le bundle indique de
 * compléter avec `docker service logs vaks-pm_api`.
 */
export class RingBufferLogger extends ConsoleLogger {
  private static readonly MAX = 200;
  private static ring: RingEntry[] = [];

  private static push(level: 'error' | 'warn', message: unknown, context?: string) {
    const text = safeStringify(message);
    RingBufferLogger.ring.push({
      level,
      time: new Date().toISOString(),
      context: context || undefined,
      message: text.length > 2000 ? text.slice(0, 2000) + '…' : text,
    });
    const overflow = RingBufferLogger.ring.length - RingBufferLogger.MAX;
    if (overflow > 0) RingBufferLogger.ring.splice(0, overflow);
  }

  /** Copie immuable des dernières entrées (la plus récente en dernier). */
  static snapshot(): RingEntry[] {
    return [...RingBufferLogger.ring];
  }

  // Nest passe le contexte en dernier argument string (error: [stack, context]).
  private static lastString(rest: unknown[]): string | undefined {
    const last = rest[rest.length - 1];
    return typeof last === 'string' ? last : undefined;
  }

  error(message: unknown, ...rest: unknown[]) {
    RingBufferLogger.push('error', message, RingBufferLogger.lastString(rest) ?? this.context);
    (super.error as (...a: unknown[]) => void)(message, ...rest);
  }

  warn(message: unknown, ...rest: unknown[]) {
    RingBufferLogger.push('warn', message, RingBufferLogger.lastString(rest) ?? this.context);
    (super.warn as (...a: unknown[]) => void)(message, ...rest);
  }
}
