"""Backend-agnostic connection to Ollama or Groq chat-completion APIs."""

import os
import sys
from typing import Any

from dotenv import load_dotenv
from groq import Groq, GroqError
from openai import APIError, OpenAI, OpenAIError


load_dotenv(override=True)


def get_client_and_model() -> tuple[Any, str, str]:
    """Return a chat client, model name, and backend name."""
    configured_backend = os.environ.get("LLM_BACKEND")
    backend = (configured_backend or ("groq" if os.environ.get("GROQ_API_KEY") else "ollama")).lower()

    if backend == "groq":
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise ValueError("LLM_BACKEND=groq requires GROQ_API_KEY in your .env file.")
        client = Groq(api_key=api_key)
        return client, os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant"), "groq"

    if backend == "ollama":
        client = OpenAI(
            base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
            api_key="ollama",
        )
        return client, os.environ.get("OLLAMA_MODEL", "qwen2.5:3b"), "ollama"

    raise ValueError("LLM_BACKEND must be either 'ollama' or 'groq'.")


def check_connection(client: Any, model: str, backend: str) -> bool:
    """Check the selected LLM backend and print actionable connection guidance."""
    try:
        client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "Say OK in one word"}],
            max_tokens=5,
        )
        print(f"Connected to {backend} ({model}).")
        return True
    except (OpenAIError, GroqError) as error:
        if backend == "ollama":
            print("\nCould not reach Ollama at the configured base URL.", file=sys.stderr)
            print("  1) Is it running?  ->  ollama serve", file=sys.stderr)
            print(f"  2) Is the model pulled?  ->  ollama pull {model}", file=sys.stderr)
        else:
            print("\nCould not reach Groq.", file=sys.stderr)
            print("  Check that GROQ_API_KEY is set correctly.", file=sys.stderr)
        print(f"  Underlying error: {error}\n", file=sys.stderr)
        return False
