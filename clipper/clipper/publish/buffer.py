"""Buffer – Post als ENTWURF (saveToDraft) über die Buffer-GraphQL-API.

Buffer holt das Video über eine öffentliche URL ab. Dafür PUBLIC_BASE_URL setzen
(z. B. kostenloser Cloudflare-Quick-Tunnel, siehe README).
Falls Buffer sein Schema ändert: nur MUTATION unten anpassen.
"""
from __future__ import annotations

import httpx

from ..config import secret

MUTATION = """
mutation CreateDraft($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id } }
    ... on MutationError { message }
  }
}
"""


def configured() -> bool:
    return bool(secret("BUFFER_API_KEY") and secret("BUFFER_CHANNEL_IDS"))


def upload_draft(video: str, title: str, description: str, video_url: str = "") -> dict:
    if not video_url.startswith("https://"):
        raise RuntimeError("Buffer braucht eine öffentliche https-URL zum Video – PUBLIC_BASE_URL in .env setzen.")
    url = secret("BUFFER_API_URL") or "https://api.buffer.com"
    headers = {"Authorization": f"Bearer {secret('BUFFER_API_KEY')}", "Content-Type": "application/json"}
    text = f"{title}\n\n{description}".strip()
    ids = []
    for channel in [c.strip() for c in secret("BUFFER_CHANNEL_IDS").split(",") if c.strip()]:
        variables = {"input": {"channelId": channel, "text": text, "schedulingType": "automatic",
                               "mode": "addToQueue", "saveToDraft": True,  # fest: nur Entwurf
                               "assets": {"videos": [{"url": video_url}]}}}
        r = httpx.post(url, headers=headers, json={"query": MUTATION, "variables": variables}, timeout=120)
        r.raise_for_status()
        data = r.json()
        if data.get("errors"):
            raise RuntimeError(f"Buffer: {data['errors'][0].get('message')}")
        res = (data.get("data") or {}).get("createPost") or {}
        if res.get("message"):
            raise RuntimeError(f"Buffer: {res['message']}")
        ids.append((res.get("post") or {}).get("id"))
    return {"id": ",".join(i for i in ids if i), "url": "https://publish.buffer.com/drafts", "state": "draft"}
