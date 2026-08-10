"""
Vaks-PM — adaptateur LiteLLM de référence (passerelle externe).

Si vous exploitez déjà une passerelle LiteLLM, vous n'avez PAS besoin de la
passerelle Vaks : ce callback déclare l'usage EXACT de chaque appel à votre API
Vaks (`POST /agent-runs`), exactement comme la passerelle Vaks le ferait. LiteLLM
gère nativement 100+ providers (dont Bedrock, Vertex, Azure) — vous couvrez donc
la « longue traîne » sans code Vaks supplémentaire.

Le contrat est identique à celui de la passerelle : Bearer = PAT de l'agent,
en-tête `X-Vaks-Gateway-Secret` (prouve la provenance MESURÉE → `source='gateway'`),
`runKey` = id de réponse (idempotent). Attribution par tâche via `metadata`.

Installation (litellm proxy `config.yaml`) :

    litellm_settings:
      callbacks: litellm_callback.vaks_logger   # ce module doit être importable

Variables d'environnement :
    VAKS_API_URL           https://acme.vaks-pm.com   (obligatoire)
    VAKS_API_PREFIX        /api/v1                     (défaut)
    VAKS_GATEWAY_SECRET    secret partagé (= setting org agents.gateway.sharedSecret)
    VAKS_AGENT_TOKEN       PAT d'agent par défaut (repli si absent des metadata)

Attribution par requête — passez dans `metadata` de l'appel LiteLLM :
    metadata = {
      "vaks_agent_token": "vaks_pat_...",   # sinon VAKS_AGENT_TOKEN
      "vaks_task_id": "<uuid tâche>",        # optionnel
      "vaks_deliverable_id": "<uuid>",       # optionnel
    }
"""

import os

import httpx
from litellm.integrations.custom_logger import CustomLogger


def _cfg():
    base = (os.environ.get("VAKS_API_URL") or "").rstrip("/")
    prefix = os.environ.get("VAKS_API_PREFIX") or "/api/v1"
    return base, prefix


def _extract(kwargs, response_obj):
    """Retourne (payload, headers) ou (None, None) si non reportable."""
    base, prefix = _cfg()
    if not base:
        return None, None

    usage = getattr(response_obj, "usage", None) or (
        response_obj.get("usage") if isinstance(response_obj, dict) else None
    )
    if not usage:
        return None, None
    tokens_in = int(getattr(usage, "prompt_tokens", None) or usage.get("prompt_tokens", 0) or 0)
    tokens_out = int(
        getattr(usage, "completion_tokens", None) or usage.get("completion_tokens", 0) or 0
    )
    if tokens_in + tokens_out == 0:
        return None, None

    model = getattr(response_obj, "model", None) or (
        response_obj.get("model") if isinstance(response_obj, dict) else None
    )
    run_key = getattr(response_obj, "id", None) or (
        response_obj.get("id") if isinstance(response_obj, dict) else None
    )

    meta = (kwargs.get("litellm_params", {}) or {}).get("metadata", {}) or {}
    agent_token = meta.get("vaks_agent_token") or os.environ.get("VAKS_AGENT_TOKEN")
    if not agent_token:
        return None, None  # aucun PAT d'agent résolu → pas d'attribution possible.

    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {agent_token}",
    }
    secret = os.environ.get("VAKS_GATEWAY_SECRET")
    if secret:
        headers["x-vaks-gateway-secret"] = secret

    payload = {
        "model": model,
        "tokensIn": tokens_in,
        "tokensOut": tokens_out,
        "runKey": run_key,
        "taskId": meta.get("vaks_task_id"),
        "deliverableId": meta.get("vaks_deliverable_id"),
        "note": "via LiteLLM gateway",
    }
    url = f"{base}{prefix}/agent-runs"
    return (url, payload, headers)


class VaksLogger(CustomLogger):
    """Callback LiteLLM : déclare l'usage mesuré à Vaks-PM (fire-and-forget)."""

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            extracted = _extract(kwargs, response_obj)
            if not extracted:
                return
            url, payload, headers = extracted
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.post(url, json=payload, headers=headers)
                if r.status_code >= 300:
                    print(f"[vaks] agent-run report failed: HTTP {r.status_code}")
        except Exception as e:  # ne jamais casser l'appel LLM
            print(f"[vaks] agent-run report error: {e}")

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        # Variante synchrone (proxy non-async) — best effort.
        try:
            extracted = _extract(kwargs, response_obj)
            if not extracted:
                return
            url, payload, headers = extracted
            with httpx.Client(timeout=8.0) as client:
                r = client.post(url, json=payload, headers=headers)
                if r.status_code >= 300:
                    print(f"[vaks] agent-run report failed: HTTP {r.status_code}")
        except Exception as e:
            print(f"[vaks] agent-run report error: {e}")


vaks_logger = VaksLogger()
