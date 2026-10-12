import { readFileSync } from 'fs';

/**
 * Mot de passe Redis (`requirepass`) lu depuis un secret monté en fichier.
 *
 * Tous les clients Redis (ioredis, BullMQ) lisent déjà un éventuel mot de passe
 * dans `REDIS_URL` (`redis://:<pw>@redis:6379`). Plutôt que d'exposer le secret
 * en variable d'environnement (visible par `docker service inspect`) ou de
 * réécrire la `command` de chaque service, on injecte ici, AVANT tout import qui
 * se connecte, le contenu de `REDIS_PASSWORD_FILE` dans `REDIS_URL`.
 *
 * Doit rester le PREMIER import de `main.ts` (CommonJS : ordre des `require`).
 * Sans `REDIS_PASSWORD_FILE` : aucun effet (dev, compose, installs existantes).
 */
export function withRedisPassword(url: string, password: string): string {
  const u = new URL(url);
  u.password = encodeURIComponent(password);
  return u.toString().replace(/\/$/, '');
}

export function applyRedisPasswordFile(env: NodeJS.ProcessEnv = process.env): void {
  const file = env.REDIS_PASSWORD_FILE;
  if (!file) return;
  let password: string;
  try {
    password = readFileSync(file, 'utf8').trim();
  } catch (e) {
    // Fail-fast : un secret déclaré mais illisible = config cassée ; démarrer
    // sans mot de passe échouerait plus tard, de façon moins lisible (NOAUTH).
    throw new Error(`REDIS_PASSWORD_FILE unreadable (${file}): ${(e as Error).message}`);
  }
  if (!password) throw new Error(`REDIS_PASSWORD_FILE is empty (${file})`);
  env.REDIS_URL = withRedisPassword(env.REDIS_URL ?? 'redis://redis:6379', password);
}

applyRedisPasswordFile();
