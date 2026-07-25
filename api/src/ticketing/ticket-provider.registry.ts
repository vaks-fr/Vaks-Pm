import { Injectable } from '@nestjs/common';
import { ProviderDescriptor, TicketProvider } from './ticket-provider.types';
import { ServiceNowProvider } from './providers/servicenow.provider';

/**
 * Registry des fournisseurs de ticketing. Keyée par `source`. Ajouter un
 * fournisseur = injecter sa classe ici (et l'ajouter aux providers du module).
 * L'UI admin lit `list()` pour proposer les types disponibles et rendre leurs
 * champs de config dynamiquement.
 */
@Injectable()
export class TicketProviderRegistry {
  private readonly map = new Map<string, TicketProvider>();

  constructor(serviceNow: ServiceNowProvider) {
    this.register(serviceNow);
  }

  private register(p: TicketProvider): void {
    this.map.set(p.source, p);
  }

  /** Fournisseur pour ce `source`, ou null si inconnu. */
  get(source: string): TicketProvider | null {
    return this.map.get(source) ?? null;
  }

  has(source: string): boolean {
    return this.map.has(source);
  }

  /** Catalogue des types disponibles (pour l'UI admin). */
  list(): ProviderDescriptor[] {
    return [...this.map.values()].map((p) => p.describe());
  }
}
