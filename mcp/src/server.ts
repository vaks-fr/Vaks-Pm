import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from './api-client.js';
import { registerTools } from './tools.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import type { Lang } from './i18n.js';

/**
 * Construit un `McpServer` **frais par requête** (mode stateless). Ses tools
 * sont liés à un `ApiClient` qui porte le jeton et le tenant de CETTE requête —
 * donc aucune fuite d'identité d'un utilisateur à l'autre. `allowWrite` (dérivé
 * du contexte `/me/mcp-context` : scopes d'écriture présents) pilote l'exposition
 * des tools d'écriture ; `allowFinance` (toggle org `mcp.allowFinance`, même
 * source) celle des tools finance.
 */
export function buildServer(
  api: ApiClient,
  allowWrite: boolean,
  lang: Lang = 'en',
  actorKind?: string,
  allowFinance = false,
  billingUnit?: string,
): McpServer {
  const server = new McpServer({
    name: 'vaks-pm',
    version: '0.1.0',
  });
  registerTools(server, api, allowWrite, actorKind, allowFinance, billingUnit);
  registerPrompts(server, api, allowWrite, lang);
  // Resources = données passives attachées au contexte par l'utilisateur. En
  // lecture seule par nature : aucun gating `allowWrite`.
  registerResources(server, api, lang);
  return server;
}
