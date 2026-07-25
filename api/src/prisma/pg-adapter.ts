import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'fs';
import type { ConnectionOptions } from 'tls';

/**
 * Construit la config TLS de la connexion node-postgres selon l'environnement
 * (DORA — chiffrement en transit app↔Postgres). Trois niveaux :
 *
 *   PG_TLS != 1                  → pas de TLS (clair).
 *   PG_TLS=1, sans PG_TLS_CA     → **chiffré sans vérification** (`rejectUnauthorized:false`).
 *                                  Cert auto-signé interne par défaut. node-postgres
 *                                  ne lit pas « no-verify » depuis l'URL, d'où le code.
 *   PG_TLS=1 + PG_TLS_CA=<pem>   → **vérification anti-MITM** contre la CA fournie
 *                                  (CA interne du client / corporate PKI) :
 *                                    PG_TLS_MODE=verify-full (défaut) → chaîne **et** hostname
 *                                    PG_TLS_MODE=verify-ca            → chaîne seule (hostname ignoré,
 *                                      utile quand le SAN du cert ne matche pas l'hôte de connexion,
 *                                      ex. accès via HAProxy par nom de service/IP).
 *
 * PG_TLS_CA est un **chemin de fichier** PEM (cert CA monté en secret/volume).
 */
export function buildPgSsl(): { ssl?: boolean | ConnectionOptions } {
  if (process.env.PG_TLS !== '1') return {};
  const caPath = process.env.PG_TLS_CA;
  if (!caPath) {
    // Chiffré, sans vérification (self-signed, défaut historique).
    return { ssl: { rejectUnauthorized: false } };
  }
  // Vérification stricte contre la CA fournie.
  const ssl: ConnectionOptions = {
    rejectUnauthorized: true,
    ca: readFileSync(caPath, 'utf8'),
  };
  if ((process.env.PG_TLS_MODE ?? 'verify-full') === 'verify-ca') {
    // verify-ca : on valide la chaîne mais pas l'identité (hostname) du serveur.
    ssl.checkServerIdentity = () => undefined;
  }
  return { ssl };
}

/** Fabrique l'adapter Postgres (node-postgres) pour Prisma 7, TLS selon l'env. */
export function makePgAdapter(connectionString: string | undefined): PrismaPg {
  return new PrismaPg({ connectionString, ...buildPgSsl() });
}
