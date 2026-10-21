"""Measure routing accuracy of the planner against eval/golden.json.

Usage (from the project folder, virtual environment active):
    python -m eval.run                 # keyword rules only (no model needed)
    python -m eval.run --with-model    # also ask the configured LLM supervisor

Only the routing decision is evaluated; no GitHub requests are made.
"""

import json
import sys
from pathlib import Path

import langgraph_agent as agents

GOLDEN = Path(__file__).with_name("golden.json")


def model_plan(query: str) -> list[str]:
    state = {"query": query, "plan": []}
    return agents.supervisor(state)["plan"]  # type: ignore[arg-type]


def single_label_router(query: str) -> list[str]:
    """The previous design: exactly one agent per query (first keyword match)."""
    return agents.plan_from_keywords(query)[:1]


def score(rows: list[dict], planner) -> tuple[int, float]:
    exact, overlap = 0, 0.0
    for row in rows:
        plan, expected = set(planner(row["q"])), set(row["expect"])
        exact += plan == expected
        overlap += len(plan & expected) / len(plan | expected)
    return exact, overlap / len(rows)


def main() -> None:
    rows = json.loads(GOLDEN.read_text(encoding="utf-8"))
    planners = {
        "single-label (old)": single_label_router,
        "keyword plan": agents.plan_from_keywords,
    }
    if "--with-model" in sys.argv:
        planners["LLM supervisor"] = model_plan

    print(f"{'planner':<20}{'exact match':>13}{'avg overlap':>13}")
    for name, planner in planners.items():
        exact, overlap = score(rows, planner)
        print(f"{name:<20}{f'{exact}/{len(rows)}':>13}{overlap:>13.0%}")
    multi = sum(len(row["expect"]) > 1 for row in rows)
    print(f"\n{multi}/{len(rows)} prompts need more than one agent.")


if __name__ == "__main__":
    main()
