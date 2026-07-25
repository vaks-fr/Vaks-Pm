import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Bloque les routes d'émission de token (login, refresh, logout, MFA login,
 * forced-enroll) sur une **cellule data-only** (`SERVICE_ROLE=data-plane`).
 *
 * Modèle « control plane mutualisé » : l'authentification est portée par le
 * service `control-plane` (front door partagé). Une cellule de données ne fait
 * QUE servir les données en faisant confiance au JWT émis par le control-plane.
 *
 * - `SERVICE_ROLE` non-défini (legacy) ou `control-plane` → login autorisé.
 * - `SERVICE_ROLE=data-plane` → 404 (la route n'existe pas pour ce rôle).
 *
 * On renvoie 404 (et pas 403) pour ne pas révéler qu'un endpoint d'auth existe
 * ici : sur une cellule data-only, l'auth se fait ailleurs.
 */
@Injectable()
export class LoginEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (this.config.get('serviceRole') === 'data-plane') {
      throw new NotFoundException();
    }
    return true;
  }
}
