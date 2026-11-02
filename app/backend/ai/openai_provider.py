"""OpenAI provider (Chat Completions, JSON mode). Selected when SCREENING_AI_PROVIDER=openai,
or automatically when only OPENAI_API_KEY is configured."""
from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx
from pydantic import BaseModel

from .base import LLMProvider, ProviderError


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, model: str):
        self.model = model
        self.base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.key = os.environ.get("OPENAI_API_KEY", "")

    def generate_json(self, *, system: str, prompt: str, schema: type[BaseModel], max_output_tokens: int = 32768) -> dict[str, Any]:
        schema_text = json.dumps(schema.model_json_schema(), ensure_ascii=False)
        body = {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "max_tokens": min(max_output_tokens, 32768),
            "messages": [
                {"role": "system", "content": system + "\n\nRespond with one JSON object matching this JSON Schema:\n" + schema_text},
                {"role": "user", "content": prompt},
            ],
        }
        for attempt in range(5):
            try:
                r = httpx.post(f"{self.base_url}/chat/completions", json=body, timeout=600,
                               headers={"Authorization": f"Bearer {self.key}"})
            except httpx.HTTPError as e:
                if attempt < 2:
                    time.sleep(3)
                    continue
                raise ProviderError(f"OpenAI request failed: {e}") from e
            if r.status_code in (429, 500, 502, 503, 504) and attempt < 4:
                time.sleep(min(60, 4 * 2 ** attempt))
                continue
            if r.status_code != 200:
                raise ProviderError(f"OpenAI API error {r.status_code}: {r.text[:400]}")
            data = r.json()
            try:
                out = json.loads(data["choices"][0]["message"]["content"])
            except Exception as e:
                raise ProviderError(f"OpenAI returned invalid JSON: {e}") from e
            usage = data.get("usage") or {}
            out["_usage"] = {"prompt_tokens": usage.get("prompt_tokens"), "output_tokens": usage.get("completion_tokens")}
            return out
        raise ProviderError("OpenAI request failed after retries")
