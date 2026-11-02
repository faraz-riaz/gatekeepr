"""Provider-agnostic interface for structured (JSON) LLM generation.

To add a provider: implement `LLMProvider.generate_json`, then register it in `get_provider`.
API keys are read from the server environment only and never sent to the browser.
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel


class ProviderError(Exception):
    """Raised for configuration, authentication, quota or response errors."""


class LLMProvider(ABC):
    name: str = "base"
    model: str = ""

    @abstractmethod
    def generate_json(self, *, system: str, prompt: str, schema: type[BaseModel], max_output_tokens: int = 32768) -> dict[str, Any]:
        """Return a JSON object conforming (as far as the provider allows) to `schema`."""

    def describe(self) -> str:
        return f"{self.name}:{self.model}"


def _truthy(v: str | None) -> bool:
    return (v or "").strip().lower() in {"1", "true", "yes", "on"}


def gemini_configured() -> tuple[bool, str]:
    if _truthy(os.environ.get("GOOGLE_GENAI_USE_VERTEXAI")):
        if os.environ.get("GOOGLE_CLOUD_PROJECT"):
            return True, "Vertex AI (Application Default Credentials)"
        return False, "GOOGLE_GENAI_USE_VERTEXAI is true but GOOGLE_CLOUD_PROJECT is empty"
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return True, "Gemini Developer API key"
    return False, "No Gemini credentials (set GEMINI_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT)"


def get_provider(settings) -> tuple[LLMProvider | None, str]:
    """Instantiate the configured provider. Returns (provider, human-readable status)."""
    choice = settings.ai_provider
    if choice in {"none", "off", "disabled"}:
        return None, "AI analysis disabled (SCREENING_AI_PROVIDER=none)"
    gem_ok, gem_msg = gemini_configured()
    if choice in {"auto", "gemini", "vertex"} and gem_ok:
        from .gemini import GeminiProvider
        try:
            return GeminiProvider(settings.gemini_model), f"Gemini via {gem_msg}"
        except Exception as e:  # e.g. missing project / bad config
            return None, f"Gemini could not be initialised: {e}"
    if choice in {"auto", "openai"} and os.environ.get("OPENAI_API_KEY"):
        from .openai_provider import OpenAIProvider
        return OpenAIProvider(settings.openai_model), "OpenAI API key"
    if choice == "gemini":
        return None, gem_msg
    if choice == "openai":
        return None, "OPENAI_API_KEY is not set"
    return None, f"No AI provider configured. {gem_msg}; or set OPENAI_API_KEY."
