"""Google Gemini provider (Gemini Developer API or Vertex AI) using the google-genai SDK."""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from pydantic import BaseModel

from .base import LLMProvider, ProviderError, _truthy

log = logging.getLogger(__name__)

RETRYABLE = {429, 500, 502, 503, 504}


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(self, model: str):
        from google import genai

        self.model = model
        if _truthy(os.environ.get("GOOGLE_GENAI_USE_VERTEXAI")):
            self.client = genai.Client(
                vertexai=True,
                project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
                location=os.environ.get("GOOGLE_CLOUD_LOCATION") or "global",
            )
        else:
            self.client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))

    def generate_json(self, *, system: str, prompt: str, schema: type[BaseModel], max_output_tokens: int = 32768) -> dict[str, Any]:
        from google.genai import errors, types

        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_schema=schema,
            temperature=0.0,
            max_output_tokens=max_output_tokens,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        last: Exception | None = None
        for attempt in range(5):
            try:
                resp = self.client.models.generate_content(model=self.model, contents=prompt, config=config)
            except errors.APIError as e:
                last = e
                code = getattr(e, "code", None)
                if code in RETRYABLE and attempt < 4:
                    delay = min(60, 4 * 2 ** attempt)
                    log.warning("Gemini %s (attempt %d); retrying in %ds", code, attempt + 1, delay)
                    time.sleep(delay)
                    continue
                raise ProviderError(_friendly(e)) from e
            except Exception as e:  # network errors, auth library errors
                last = e
                if attempt < 2:
                    time.sleep(3)
                    continue
                raise ProviderError(f"Gemini request failed: {e}") from e
            text = resp.text
            if not text:
                reason = None
                try:
                    reason = resp.candidates[0].finish_reason
                except Exception:
                    pass
                raise ProviderError(f"Gemini returned no content (finish reason: {reason})")
            try:
                data = json.loads(text)
            except json.JSONDecodeError as e:
                finish = getattr(resp.candidates[0], "finish_reason", None) if resp.candidates else None
                raise ProviderError(f"Gemini returned invalid JSON (finish reason: {finish}): {e}") from e
            usage = getattr(resp, "usage_metadata", None)
            if usage is not None:
                data["_usage"] = {
                    "prompt_tokens": getattr(usage, "prompt_token_count", None),
                    "output_tokens": getattr(usage, "candidates_token_count", None),
                    "thinking_tokens": getattr(usage, "thoughts_token_count", None),
                }
            return data
        raise ProviderError(f"Gemini request failed: {last}")


def _friendly(e: Exception) -> str:
    msg = str(e)
    code = getattr(e, "code", None)
    if code == 403 and "quota project" in msg:
        return ("Vertex AI rejected the request: Application Default Credentials have no quota project. "
                "Run `gcloud auth application-default set-quota-project <PROJECT_ID>` or use a GEMINI_API_KEY.")
    if code == 403:
        return ("Vertex AI permission denied (aiplatform.endpoints.predict). The account used by "
                "Application Default Credentials needs the 'Vertex AI User' role on GOOGLE_CLOUD_PROJECT, "
                "the Vertex AI API must be enabled, and the model must be available in GOOGLE_CLOUD_LOCATION. "
                f"Details: {msg[:300]}")
    if code == 404:
        return f"Model not found or not available in this location. Set GEMINI_MODEL to an available model. Details: {msg[:300]}"
    if code == 401:
        return f"Authentication failed. Check GEMINI_API_KEY or run `gcloud auth application-default login`. Details: {msg[:200]}"
    return f"Gemini API error {code}: {msg[:400]}"
