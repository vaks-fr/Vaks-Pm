import { Injectable } from '@nestjs/common';
import { AgentDirectoryProvider, AgentProviderDescriptor } from './agent-directory.types';
import { EntraAgentProvider } from './providers/entra-agent.provider';

/**
 * Registry des plateformes d'agents supportées. Ajouter Bedrock AgentCore /
 * Vertex AI = une classe provider de plus, enregistrée ici — rien d'autre ne
 * change (même pattern que TicketProviderRegistry).
 */
@Injectable()
export class AgentProviderRegistry {
  private readonly providers = new Map<string, AgentDirectoryProvider>();

  constructor(entra: EntraAgentProvider) {
    for (const p of [entra]) this.providers.set(p.provider, p);
  }

  get(provider: string): AgentDirectoryProvider | undefined {
    return this.providers.get(provider);
  }

  list(): AgentProviderDescriptor[] {
    return [...this.providers.values()].map((p) => p.describe());
  }
}
