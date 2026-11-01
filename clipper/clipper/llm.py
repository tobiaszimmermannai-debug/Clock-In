"""KI-Backends: Claude-CLI, Anthropic-API (Key nur aus Umgebung) oder lokal Ollama. Kein OpenAI."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

import httpx

from .config import CFG, secret


class LLMError(RuntimeError):
    pass


def complete(prompt: str) -> str:
    c = CFG["llm"]
    backend = c["backend"]
    timeout = float(c["timeout_seconds"])
    if backend == "claude_cli":
        return _claude_cli(prompt, c["claude_cli_model"], timeout)
    if backend == "anthropic_api":
        return _anthropic_api(prompt, c["anthropic_model"], timeout)
    if backend == "ollama":
        return _ollama(prompt, c["ollama_model"], c["ollama_url"], timeout)
    raise LLMError(f"Unbekanntes LLM-Backend: {backend}")


def _claude_cli(prompt: str, model: str, timeout: float) -> str:
    exe = shutil.which("claude")
    if not exe:
        raise LLMError("Claude-CLI nicht gefunden (npm install -g @anthropic-ai/claude-code).")
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)  # CLI soll dein Abo-Login nutzen, nicht den (kostenpflichtigen) API-Key
    cmd = [exe, "-p", "--output-format", "text"]
    if model:
        cmd += ["--model", model]
    r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode != 0:
        raise LLMError(f"Claude-CLI Fehler: {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout


def _anthropic_api(prompt: str, model: str, timeout: float) -> str:
    key = secret("ANTHROPIC_API_KEY")
    if not key:
        raise LLMError("ANTHROPIC_API_KEY fehlt in .env")
    r = httpx.post("https://api.anthropic.com/v1/messages", timeout=timeout,
                   headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                            "content-type": "application/json"},
                   json={"model": model, "max_tokens": 4096,
                         "messages": [{"role": "user", "content": prompt}]})
    if r.status_code >= 400:
        raise LLMError(f"Anthropic-API {r.status_code}: {r.text[:400]}")
    return "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")


def _ollama(prompt: str, model: str, url: str, timeout: float) -> str:
    try:
        r = httpx.post(url.rstrip("/") + "/api/chat", timeout=timeout, json={
            "model": model, "stream": False, "format": "json",
            "options": {"temperature": 0.3, "num_ctx": int(CFG["llm"].get("ollama_num_ctx", 8192))},
            "messages": [{"role": "user", "content": prompt}]})
    except httpx.ConnectError as e:
        raise LLMError(f"Ollama nicht erreichbar unter {url} (läuft 'ollama serve'?)") from e
    if r.status_code >= 400:
        raise LLMError(f"Ollama {r.status_code}: {r.text[:400]}")
    return r.json().get("message", {}).get("content", "")


def extract_json(text: str) -> dict:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1)
    dec = json.JSONDecoder()
    for m in re.finditer(r"\{", text):  # erstes vollständiges JSON-Objekt, Text danach ignorieren
        try:
            obj, _ = dec.raw_decode(text, m.start())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    raise LLMError(f"Keine JSON-Antwort erhalten: {text[:200]}")
