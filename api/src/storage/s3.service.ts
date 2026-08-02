import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'node:fs';
import { TenantContext } from '../tenancy/tenant-context.service';
import { tenantDeleteKeys, tenantReadKey, tenantWriteKey } from './s3-key';

/// Noms de base des buckets (avant application du préfixe `S3_BUCKET_PREFIX`).
/// Les clés sont stables et référencées partout via `s3.buckets.<clé>`.
const BASE_BUCKETS = {
  charters: 'charter-blobs',
  templates: 'document-templates',
  attachments: 'vaks-pm-attachments',
  /// Branding (logo org, futurs assets de marque) — servi public via
  /// `GET /public/branding/...`, pas de pré-signature.
  branding: 'vaks-pm-branding',
  /// Archives froides du journal d'audit (JSONL gzip écrits par le cron de
  /// purge AVANT suppression, quand `audit.archive.enabled`). Clé :
  /// `<orgId>/<date-purge>.jsonl.gz`. Jamais purgé automatiquement.
  auditArchive: 'vaks-pm-audit-archive',
  /// Artefacts des exports asynchrones (rapports, portabilité RGPD…). Clé :
  /// `<orgId>/<jobId>.<ext>`. Servis par `GET /exports/:id/download`, **jamais**
  /// par URL pré-signée : `S3_ENDPOINT` est un nom DNS interne à l'overlay, une
  /// pré-signature pointerait `http://garage:3900` — injoignable d'un client.
  /// Rétention alignée sur le TTL du job (24 h) côté état ; l'objet lui-même
  /// n'est pas purgé automatiquement.
  exports: 'vaks-pm-exports',
} as const;

/**
 * Wrapper Nest sur un backend S3-compatible. Client AWS SDK v3 (aucune
 * dépendance au SDK propriétaire MinIO) — fonctionne avec **Garage** (prod
 * on-premise), **MinIO/Ceph RGW** ou **AWS S3 natif**. Config par env :
 *
 *   S3_ENDPOINT          URL ou host du backend. **Vide => AWS S3 natif**
 *                        (endpoint dérivé de la région par le SDK).
 *                        Ex Garage : "garage" ; ex AWS : laisser vide.
 *   S3_PORT              (default 3900) — ignoré si S3_ENDPOINT contient déjà
 *                        un schéma/port (URL complète) ou est vide (AWS).
 *   S3_USE_SSL           "true"/"false" (default false) — schéma quand
 *                        S3_ENDPOINT est un simple host. Ignoré si URL complète.
 *   S3_FORCE_PATH_STYLE  "true"/"false". Default : **true** si un endpoint
 *                        custom est fourni (Garage/MinIO l'exigent), **false**
 *                        en mode AWS natif (virtual-hosted-style).
 *   S3_ACCESS_KEY        clé d'accès (default "vakspm").
 *   S3_SECRET_KEY        clé secrète, sinon fichier /run/secrets/s3_secret_key.
 *   S3_REGION            (default "garage" ; AWS : "eu-west-1", …).
 *   S3_BUCKET_PREFIX     préfixe appliqué à TOUS les buckets — indispensable
 *                        sur AWS (espace de noms global) pour éviter les
 *                        collisions entre clients. Ex "acme-".
 *   S3_CREATE_BUCKETS    "true"/"false" (default true). Mettre "false" quand le
 *                        client pré-crée les buckets et ne donne pas le droit
 *                        `s3:CreateBucket` (déploiement least-privilege).
 */
@Injectable()
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger(S3Service.name);
  private client!: S3Client;
  /// Renseigné dans onModuleInit (préfixe appliqué). Même forme que BASE_BUCKETS.
  readonly buckets: Record<keyof typeof BASE_BUCKETS, string> = { ...BASE_BUCKETS };

  /// Isolation par tenant : chaque clé d'objet est préfixée par le slug du
  /// tenant courant (`<slug>/<clé>`), résolu via `TenantContext`. Orthogonal à
  /// `S3_BUCKET_PREFIX` (nom de bucket). `S3_TENANT_PREFIX=true` active ;
  /// `S3_TENANT_PREFIX_STRICT=true` retire le fallback de lecture legacy (après
  /// migration). Défaut off = comportement historique (déploiement neutre).
  private tenantPrefix = false;
  private tenantStrict = false;

  constructor(private readonly tenant: TenantContext) {}

  /**
   * Sonde de santé pour le bundle de diagnostic : `HeadBucket` sur le bucket
   * principal (attachments). Ne crée rien, ne lève pas — renvoie l'état.
   */
  async ping(): Promise<{ ok: boolean; bucket: string; error?: string }> {
    const bucket = this.buckets.attachments;
    try {
      if (!this.client) return { ok: false, bucket, error: 'client not initialized' };
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { ok: true, bucket };
    } catch (e) {
      return { ok: false, bucket, error: (e as Error).message };
    }
  }

  async onModuleInit() {
    const rawEndpoint = (process.env.S3_ENDPOINT || '').trim();
    const port = parseInt(process.env.S3_PORT || '3900', 10);
    const useSSL = (process.env.S3_USE_SSL || 'false') === 'true';
    const accessKeyId = process.env.S3_ACCESS_KEY || 'vakspm';
    let secretAccessKey = process.env.S3_SECRET_KEY || '';
    if (!secretAccessKey) {
      try {
        secretAccessKey = fs.readFileSync('/run/secrets/s3_secret_key', 'utf8').trim();
      } catch {
        // pas de secret => stockage désactivé, les appels échoueront proprement
      }
    }
    const region = process.env.S3_REGION || 'garage';

    // Endpoint : vide => AWS S3 natif (le SDK le dérive de la région).
    // Sinon, accepter une URL complète (http(s)://…) ou un simple host.
    let endpoint: string | undefined;
    if (rawEndpoint) {
      endpoint = /^https?:\/\//i.test(rawEndpoint)
        ? rawEndpoint
        : `${useSSL ? 'https' : 'http'}://${rawEndpoint}:${port}`;
    }

    // path-style requis par Garage/MinIO (endpoint custom) ; virtual-hosted
    // pour AWS natif. Surchargeable explicitement.
    const forcePathStyle =
      process.env.S3_FORCE_PATH_STYLE != null
        ? process.env.S3_FORCE_PATH_STYLE === 'true'
        : Boolean(endpoint);

    // Préfixe de bucket (espace de noms global AWS). Appliqué au NOM des buckets.
    const prefix = process.env.S3_BUCKET_PREFIX || '';
    for (const k of Object.keys(BASE_BUCKETS) as (keyof typeof BASE_BUCKETS)[]) {
      this.buckets[k] = `${prefix}${BASE_BUCKETS[k]}`;
    }

    // Isolation par tenant (préfixe de CLÉ, pas de bucket).
    this.tenantPrefix = (process.env.S3_TENANT_PREFIX || 'false') === 'true';
    this.tenantStrict = (process.env.S3_TENANT_PREFIX_STRICT || 'false') === 'true';
    if (this.tenantPrefix) {
      this.logger.log(
        `S3 tenant key isolation ON (strict=${this.tenantStrict ? 'yes, no legacy fallback' : 'no, legacy read-fallback'})`,
      );
    }

    this.client = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle,
    });
    this.logger.log(
      `S3 backend: ${endpoint || `aws:${region}`} (forcePathStyle=${forcePathStyle}, prefix="${prefix}")`,
    );

    // Auto-création désactivable : sur AWS least-privilege les buckets sont
    // pré-créés et `s3:CreateBucket` n'est pas accordé.
    if ((process.env.S3_CREATE_BUCKETS || 'true') !== 'true') {
      this.logger.log('S3 bucket auto-creation disabled (S3_CREATE_BUCKETS=false)');
      return;
    }

    for (const b of Object.values(this.buckets)) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: b }));
      } catch (e) {
        if (isNotFound(e)) {
          try {
            await this.client.send(new CreateBucketCommand({ Bucket: b }));
            this.logger.log(`Created S3 bucket "${b}"`);
          } catch (e2) {
            this.logger.error(`Could not create bucket "${b}": ${(e2 as Error).message}`);
          }
        } else {
          this.logger.error(`Could not check bucket "${b}": ${(e as Error).message}`);
        }
      }
    }
  }

  // ============================================================
  // Isolation par tenant — résolution de clé
  // ============================================================

  /** HeadObject silencieux (existence). */
  private async headExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /** Clé d'écriture préfixée (throw si isolation on sans contexte tenant). */
  private writeKey(key: string): string {
    return tenantWriteKey(this.tenantPrefix, this.tenant.currentSlug(), key);
  }

  /** Clé de lecture effective (scoped si existe, sinon legacy en fallback). */
  private readKey(bucket: string, key: string): Promise<string> {
    return tenantReadKey(
      this.tenantPrefix,
      this.tenantStrict,
      this.tenant.currentSlug(),
      key,
      (scoped) => this.headExists(bucket, scoped),
    );
  }

  async putObject(bucket: string, key: string, buffer: Buffer, mimeType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: this.writeKey(key),
        Body: buffer,
        ContentType: mimeType,
        ContentLength: buffer.length,
      }),
    );
  }

  async getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
    const k = await this.readKey(bucket, key);
    const out = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: k }));
    if (!out.Body) throw new Error(`empty body for ${bucket}/${k}`);
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    // Supprime la clé préfixée ET la clé legacy (best-effort) pour éviter qu'un
    // objet « supprimé » réapparaisse via le fallback de lecture.
    const keys = tenantDeleteKeys(this.tenantPrefix, this.tenantStrict, this.tenant.currentSlug(), key);
    for (const k of keys) {
      await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })).catch(() => {});
    }
  }

  async objectExists(bucket: string, key: string): Promise<boolean> {
    return this.headExists(bucket, await this.readKey(bucket, key));
  }

  async statObject(bucket: string, key: string): Promise<{ size: number; etag: string } | null> {
    try {
      const k = await this.readKey(bucket, key);
      const out = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: k }));
      return { size: out.ContentLength ?? 0, etag: (out.ETag ?? '').replace(/^"|"$/g, '') };
    } catch {
      return null;
    }
  }

  /** URL pré-signée PUT pour upload direct (TTL en secondes). */
  presignPut(bucket: string, key: string, expirySec = 300): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: bucket, Key: this.writeKey(key) }), {
      expiresIn: expirySec,
    });
  }

  /** URL pré-signée GET pour download direct (TTL en secondes). */
  async presignGet(bucket: string, key: string, expirySec = 120): Promise<string> {
    const k = await this.readKey(bucket, key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: k }), {
      expiresIn: expirySec,
    });
  }
}

function isNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'NotFound' || err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404;
}
