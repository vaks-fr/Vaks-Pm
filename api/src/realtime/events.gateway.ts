import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { EventName } from '@vaks-pm/shared';
import { JwtPayload } from '../auth/auth.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { MutationContextService } from './mutation-context.service';

interface SocketUser {
  userId: string;
  orgId: string;
  email: string;
  isAdmin: boolean;
  /** Slug tenant (claim signé du JWT, mode pooled). */
  tenant?: string;
}

/**
 * Gateway temps réel : les clients rejoignent une "room" par projet et
 * reçoivent les événements (déplacement Kanban, commentaires, time entries…).
 *
 * Auth : à la connexion, on lit le JWT depuis `handshake.auth.token` (envoyé
 * par socket.io-client) ou un header `Authorization: Bearer …`. Connexion
 * refusée si le token est absent / invalide / expiré.
 *
 * NOTE: en prod multi-instances, brancher l'adapter Redis (voir main.ts).
 */
@WebSocketGateway({ cors: true, namespace: '/ws' })
export class EventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mutationCtx: MutationContextService,
    private readonly access: ProjectAccessService,
    private readonly tenancy: TenancyService,
    private readonly tenantConn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) throw new Error('missing token');
      const secret = this.config.get('jwt').accessSecret;
      const payload = this.jwt.verify<JwtPayload>(token, { secret });
      const user: SocketUser = {
        userId: payload.sub,
        orgId: payload.orgId,
        email: payload.email,
        isAdmin: payload.isAdmin,
        tenant: payload.tenant,
      };
      client.data.user = user;
      // Room "org:<id>" : tout event broadcast à l'org si besoin.
      client.join(`org:${user.orgId}`);
      // Room "user:<id>" : notifications personnelles (assignation, mention,
      // changement de statut) reçues quel que soit le projet affiché — la
      // cloche in-app ne dépend plus de la room du projet courant.
      client.join(`user:${user.userId}`);
    } catch (err) {
      this.logger.warn(`WS rejet: ${(err as Error).message}`);
      client.emit('error', { message: 'unauthorized' });
      client.disconnect(true);
    }
  }

  /**
   * Même frontière que la `ProjectAccessGuard` côté REST : on ne rejoint la
   * room d'un projet (et donc son flux temps réel) que si on peut y accéder
   * (admin, `project:view_all`, membre direct ou via équipe). Sans ce check,
   * n'importe quel user authentifié recevait les events de tous les projets.
   */
  @SubscribeMessage('project:join')
  async joinProject(@MessageBody() projectId: string, @ConnectedSocket() client: Socket) {
    const user = client.data.user as SocketUser | undefined;
    if (!user) throw new WsException('unauthorized');
    if (typeof projectId !== 'string' || !projectId) throw new WsException('forbidden');
    const ok = await this.canAccessProject(user, projectId).catch((err) => {
      this.logger.warn(`WS project:join check failed: ${(err as Error).message}`);
      return false;
    });
    if (!ok) throw new WsException('forbidden');
    client.join(`project:${projectId}`);
    return { joined: projectId };
  }

  @SubscribeMessage('project:leave')
  leaveProject(@MessageBody() projectId: string, @ConnectedSocket() client: Socket) {
    client.leave(`project:${projectId}`);
    return { left: projectId };
  }

  // Appelé par les services pour diffuser un événement à un projet.
  // Accepte aussi un nom d'event arbitraire (string) pour les modules qui
  // n'ont pas encore enregistré leur event dans @vaks-pm/shared/EVENTS.
  emitToProject(projectId: string, event: EventName | string, payload: unknown) {
    const { clientMutationId, actorUserId } = this.mutationCtx.get();
    const wrapped =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), clientMutationId, actorUserId }
        : { data: payload, clientMutationId, actorUserId };
    this.server.to(`project:${projectId}`).emit(event, wrapped);
  }

  /**
   * Diffuse un événement à toute l'organisation (room `org:<id>`, rejointe à
   * la connexion). Réservé aux events « méta » dont le payload ne fuit rien :
   * la liste projets (`project.created/updated/deleted`) n'envoie que l'id —
   * le client refetch `GET /projects`, qui applique la visibilité par user.
   */
  emitToOrg(orgId: string, event: EventName | string, payload: unknown) {
    const { clientMutationId, actorUserId } = this.mutationCtx.get();
    const wrapped =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), clientMutationId, actorUserId }
        : { data: payload, clientMutationId, actorUserId };
    this.server.to(`org:${orgId}`).emit(event, wrapped);
  }

  /**
   * Notification personnelle : diffusée à la room `user:<id>` (rejointe à la
   * connexion). Utilisée par `NotificationsService` pour alimenter la cloche
   * in-app en parallèle des emails. Pas de wrap `clientMutationId` : ce n'est
   * pas une mutation à dédupliquer, et le serveur exclut déjà l'acteur de ses
   * propres notifications. Cross-instance via l'adapter Redis (main.ts).
   */
  emitToUser(userId: string, event: EventName | string, payload: unknown) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  // ---- helpers ----

  /**
   * `ProjectAccessService` passe par le `PrismaService` proxy, routé via le
   * contexte tenant (AsyncLocalStorage) — posé par un middleware **HTTP** que
   * les frames WS ne traversent pas. En mode pooled, on reconstruit donc le
   * contexte depuis le claim `tenant` du JWT (signé, non forgeable) avant
   * d'interroger la base ; en dedicated, appel direct (base globale).
   */
  private async canAccessProject(user: SocketUser, projectId: string): Promise<boolean> {
    const check = () =>
      this.access.canAccessProject(user.orgId, user.userId, user.isAdmin, projectId);
    if (this.tenancy.mode !== 'pooled') return check();
    if (!user.tenant) return false; // token sans tenant sur une cellule pooled
    const client = this.tenantConn.getClient({ id: user.tenant, slug: user.tenant });
    return this.tenantCtx.run({ client, slug: user.tenant }, check);
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;
    const header = client.handshake.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7);
    }
    return null;
  }
}
