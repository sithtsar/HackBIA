"""One-shot probe: does gemma via Cerebras (a) answer, (b) tool-call, (c) return
strict JSON? Decides the agents.py path. Run: uv run python -m backend.app.probe_llm
"""
from __future__ import annotations

import json
import os

from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ["CEREBRAS_API_KEY"]
BASE_URL = os.environ["CEREBRAS_BASE_URL"]
MODEL_ID = os.environ["FOUNDRY_MODEL_ID"]


def probe_plain_and_json() -> None:
    from openai import OpenAI

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL)
    print("=== plain completion ===")
    r = client.chat.completions.create(
        model=MODEL_ID,
        messages=[{"role": "user", "content": "Reply with the single word: pong"}],
        max_tokens=16,
        temperature=0.2,
    )
    print("plain:", repr(r.choices[0].message.content))

    print("=== json completion (response_format) ===")
    try:
        r = client.chat.completions.create(
            model=MODEL_ID,
            messages=[{"role": "user", "content": 'Return JSON {"sum": 2+2}. Only JSON.'}],
            max_tokens=64,
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        content = r.choices[0].message.content
        print("json raw:", repr(content))
        print("json parsed:", json.loads(content))
    except Exception as e:  # noqa: BLE001
        print("json_object mode FAILED:", type(e).__name__, e)


def probe_tool_calling() -> None:
    print("=== tool calling (strands) ===")
    try:
        from strands import Agent, tool
        from strands.models.openai import OpenAIModel

        @tool
        def add(a: int, b: int) -> int:
            """Add two integers and return the sum."""
            return a + b

        model = OpenAIModel(
            client_args={"api_key": API_KEY, "base_url": BASE_URL},
            model_id=MODEL_ID,
            params={"max_tokens": 512, "temperature": 0.2},
        )
        agent = Agent(model=model, tools=[add])
        result = agent("What is 17 plus 25? Use the add tool.")
        print("tool result:", str(result)[:400])
    except Exception as e:  # noqa: BLE001
        print("tool calling FAILED:", type(e).__name__, e)


if __name__ == "__main__":
    probe_plain_and_json()
    probe_tool_calling()
