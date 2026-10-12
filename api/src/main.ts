import './redis-env';
import { NestFactory, Reflector, DiscoveryService } from '@nestjs/core';
import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded, type Request, type Response, type NextFunction } from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';
import { OPENAPI_DESCRIPTION, redocHtml, redocInitJs } from './openapi';
import { PUBLIC_API_KEY, PublicApiMeta } from './rbac/require-permissions.decorator';
import { ExceptionI18nFilter } from './common/i18n/exception-i18n.filter';
import { RingBufferLogger } from './common/ring-buffer-logger';

async function bootstrap() {
  // bodyParser désactivé pour le remplacer par UN parser JSON qui accepte aussi
  // le `application/scim+json` de SCIM (RFC 7644). Sans ça, soit les bodies SCIM
  // ne sont pas parsés (parser ajouté en plus), soit ajouter un parser shadowe
  // le parser par défaut et casse TOUT le JSON. Un seul parser pour les deux types.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // Logger applicatif qui garde en mémoire les dernières erreurs/warns (anneau)
  // pour le bundle de diagnostic, tout en écrivant sur stdout comme avant.
  app.useLogger(new RingBufferLogger());
  // Capture le body BRUT sur `req.rawBody` (référence, pas de copie) : les
  // webhooks CI entrants (vérification des livrables, phase C) vérifient une
  // signature HMAC sur les octets exacts reçus — re-sérialiser le JSON parsé ne
  // matcherait pas (espaces, ordre des clés). Pattern Stripe/GitHub.
  app.use(
    json({
      type: ['application/json', 'application/scim+json'],
      verify: (req, _res, buf) => {
        if (buf?.length) (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true }));
  const config = app.get(ConfigService);

  // SÉCURITÉ — Refuse de démarrer en production avec un secret JWT manquant ou
  // égal au défaut de dev. Sans cette garde, un boot sans `JWT_ACCESS_SECRET`
  // signerait tous les tokens avec la chaîne publique `dev-access-secret` →
  // forge d'un token admin = prise de contrôle de l'org. Calque la garde
  // existante de `CryptoService` sur `MFA_ENCRYPTION_KEY`.
  if ((config.get<string>('nodeEnv') ?? 'development') === 'production') {
    const jwt = config.get<{ accessSecret: string; refreshSecret: string }>('jwt');
    const weak = (s: string | undefined, dev: string) => !s || s === dev || s.length < 16;
    if (weak(jwt?.accessSecret, 'dev-access-secret') || weak(jwt?.refreshSecret, 'dev-refresh-secret')) {
      throw new Error(
        'JWT_ACCESS_SECRET / JWT_REFRESH_SECRET are missing, too short, or equal to the dev default in production. Startup refused.',
      );
    }
  }

  // Durcissement HTTP : headers de sécurité posés au niveau applicatif (défense
  // en profondeur, indépendamment de ce que Traefik ajoute). Pas de dépendance
  // helmet pour ne pas alourdir le build on-premise.
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Même valeur que le middleware Traefik `security-headers` (infra/traefik-dynamic.yml)
    // — une seule politique, l'applicatif ne sert que de défense en profondeur.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  });

  // Derrière Traefik (X-Forwarded-For), faire confiance au premier proxy pour
  // que req.ip / req.protocol soient corrects → rate-limit et capture d'IP
  // dans les sessions reposent dessus. `1` = un seul proxy de confiance.
  // `TRUST_PROXY_HOPS=2` pour le MCP en DMZ (box DMZ → Traefik interne → api,
  // avec l'IP de la box en `forwardedHeaders.trustedIPs`) : sinon req.ip = IP
  // de la box pour tous les internautes → un seul seau de throttling.
  // Sûr aussi en co-localisé : Traefik écrase tout X-Forwarded-For non fiable.
  const trustHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '', 10);
  app.set('trust proxy', Number.isInteger(trustHops) && trustHops >= 1 && trustHops <= 5 ? trustHops : 1);

  // Branche l'adapter Redis pour socket.io : indispensable pour que les
  // events se propagent entre les replicas Swarm de l'API.
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  // Flush final du journal d'audit (et cleanup des modules) sur SIGTERM —
  // les rolling updates Swarm passent par là, sans ça on perdrait jusqu'à
  // 2 s d'entrées d'audit bufferisées à chaque déploiement.
  app.enableShutdownHooks();

  // La découverte OAuth (RFC 8414) DOIT être servie à la racine du host
  // (`/.well-known/oauth-authorization-server`) — les clients MCP la dérivent
  // de l'issuer (origine). On l'exclut donc du préfixe `api/v1`.
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '.well-known/oauth-authorization-server', method: RequestMethod.GET }],
  });
  app.enableCors({ origin: config.get('corsOrigin'), credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  // Localize HttpException messages (CSV/UI errors) per Accept-Language.
  app.useGlobalFilters(new ExceptionI18nFilter());

  // OpenAPI : spec publique + doc Redoc (design 3 colonnes, servie offline).
  const swagger = new DocumentBuilder()
    .setTitle('Vaks-PM API')
    .setDescription(OPENAPI_DESCRIPTION)
    .setVersion('0.1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  const document = SwaggerModule.createDocument(app, swagger, {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
  });
  // Doc PUBLIQUE = UNIQUEMENT les routes marquées @PublicApi. Tout le reste
  // (interne, admin, auth, écritures sensibles…) est exclu par défaut →
  // fail-safe : impossible d'exposer une route privée par oubli.
  {
    const reflector = app.get(Reflector);
    const discovery = app.get(DiscoveryService);
    const publicOps = new Set<string>();
    for (const w of discovery.getControllers()) {
      const metatype = w.metatype as (new (...a: unknown[]) => object) | undefined;
      if (!metatype) continue;
      const classMeta = reflector.get<PublicApiMeta>(PUBLIC_API_KEY, metatype);
      const proto = metatype.prototype as Record<string, unknown>;
      for (const methodName of Object.getOwnPropertyNames(proto)) {
        if (methodName === 'constructor') continue;
        const handler = proto[methodName];
        if (typeof handler !== 'function') continue;
        const methodMeta = reflector.get<PublicApiMeta>(PUBLIC_API_KEY, handler);
        if (methodMeta || classMeta) publicOps.add(`${metatype.name}_${methodName}`);
      }
    }
    const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
    for (const path of Object.keys(document.paths)) {
      // Denylist défensif : aucune route /admin/ ou /internal/ dans la doc
      // publique, même si un contrôleur public héberge une route admin (ex.
      // import CSV de skills) — fail-safe en plus de l'allowlist @PublicApi.
      if (path.includes('/admin/') || path.includes('/internal/') || path.includes('/scim/') || path.includes('/ops/') || path.includes('/webhooks/ci/')) {
        delete document.paths[path];
        continue;
      }
      const item = document.paths[path] as Record<string, { operationId?: string }>;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (op && (!op.operationId || !publicOps.has(op.operationId))) delete item[method];
      }
      if (!HTTP_METHODS.some((m) => item[m])) delete document.paths[path];
    }
  }

  const expressApp = app.getHttpAdapter().getInstance();
  // Spec brute (téléchargeable / consommable par des outils).
  expressApp.get('/api/v1/openapi.json', (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json(document),
  );
  // Bundle Redoc vendorisé (api/static/) — un seul fichier, pas la dépendance
  // npm complète. Servi localement (pas de CDN — déploiement on-premise offline).
  const redocBundle = join(__dirname, '..', 'static', 'redoc.standalone.js');
  expressApp.get('/api/v1/redoc.standalone.js', (_req: unknown, res: { sendFile: (p: string) => void }) =>
    res.sendFile(redocBundle),
  );
  // Script d'init Redoc servi en externe (CSP prod = script-src 'self' → pas d'inline).
  const initJs = redocInitJs({ specUrl: '/api/v1/openapi.json' });
  expressApp.get(
    '/api/v1/redoc-init.js',
    (_req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) =>
      res.type('application/javascript').send(initJs),
  );
  // Page de doc (Redoc) — accessible sans auth, comme une référence d'API publique.
  const html = redocHtml({
    initUrl: '/api/v1/redoc-init.js',
    bundleUrl: '/api/v1/redoc.standalone.js',
  });
  expressApp.get('/api/docs', (_req: unknown, res: { type: (t: string) => { send: (b: string) => void } }) =>
    res.type('html').send(html),
  );

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port} (docs: /api/docs)`);
}
bootstrap();
