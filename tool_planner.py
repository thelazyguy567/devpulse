"""Deterministic question -> MCP tool-call planner.

Small local models often answer from memory instead of calling tools. This router
reads the user's question, finds the GitHub repositories it mentions, and proposes
the right read-only tool calls itself. The calls still go through the human
approval gate; the language model then writes the answer from the tool results.
"""

import re
from typing import Any

MAX_CALLS = 6
MAX_REPOS = 3

_REPO = re.compile(r"(?<![\w./@-])([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})(?![\w/-])")
_URL = re.compile(r"github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100})", re.I)
_NOT_REPOS = {
    "ci/cd", "i/o", "and/or", "w/o", "n/a", "tcp/ip", "client/server", "yes/no",
    "read/write", "front/back", "he/she", "input/output", "pass/fail", "true/false",
    "on/off", "either/or", "pros/cons", "build/test", "docs/code",
}
_FOLLOW_UP = re.compile(r"\b(it|its|that|this|same|the repo|the project|the repository|them|their)\b", re.I)

_RATE = re.compile(r"rate.?limit|quota|\b(requests?|calls?)\b.*\b(left|remaining)\b", re.I)
_SEARCH = re.compile(r"\b(find|search|popular|top|best|recommend|alternatives?|similar|trending|frameworks?|libraries|library)\b", re.I)
_PRODUCTION = re.compile(r"production|ready to use|safe to (use|adopt)|adopt|due diligence|should (we|i) use|trust", re.I)
_COMPARE = re.compile(r"compare|versus|\bvs\.?\b|better than|difference between", re.I)

# (intent, pattern) in display order; each maps to tools in _tools_for
_INTENTS: list[tuple[str, re.Pattern[str]]] = [
    ("health", re.compile(r"health|maintain|\bactiv(e|ely|ity)\b|abandon|alive|dead|score|momentum|reliable|commit", re.I)),
    ("ci", re.compile(r"\bci\b|\bcd\b|pipeline|workflows?|github actions|\bactions\b|\bbuilds?\b|tests? (are )?(pass|fail)|passing|failing|green", re.I)),
    ("security", re.compile(r"secur|vulnerab|\bcves?\b|advisor|exploit", re.I)),
    ("languages", re.compile(r"language|written in|tech stack|\bstack\b|built with|programming", re.I)),
    ("prs", re.compile(r"pull requests?|\bprs?\b|merge requests?|in review", re.I)),
    ("release", re.compile(r"release|version|changelog|latest", re.I)),
    ("issues", re.compile(r"\bissues?\b|\bbugs?\b|good first|help wanted", re.I)),
    ("people", re.compile(r"contributor|maintainers?|\bpeople\b|\bteam\b|authors?|who (built|wrote|maintains|made)", re.I)),
    ("readme", re.compile(r"readme|documentation|\bdocs\b|getting started|how to (use|install)|\binstall", re.I)),
    ("dashboard", re.compile(r"dashboard|full report|everything about|complete overview", re.I)),
    ("overview", re.compile(r"tell me|overview|describe|details|\bstars\b|\bforks\b|licen[cs]e|summari[sz]e (the )?repo", re.I)),
]


def find_repos(text: str) -> list[str]:
    """Return unique owner/name pairs mentioned in the text, in order."""
    found: list[str] = []

    def add(owner: str, name: str) -> None:
        name = name.rstrip(".")
        full = f"{owner}/{name}"
        if (
            not name
            or full.lower() in _NOT_REPOS
            or not re.search(r"[A-Za-z]", owner)
            or not re.search(r"[A-Za-z]", name)
            or full.lower() in {item.lower() for item in found}
        ):
            return
        found.append(full)

    for owner, name in _URL.findall(text):
        add(owner, re.sub(r"[?#].*$", "", name))
    for owner, name in _REPO.findall(text):
        add(owner, name)
    return found


def _tools_for(intent: str, owner: str, repo: str) -> list[dict[str, Any]]:
    base = {"owner": owner, "repo": repo}
    table: dict[str, list[tuple[str, dict[str, Any]]]] = {
        "health": [("get_repo_health", base), ("get_commit_activity", base)],
        "ci": [("get_ci_status", base)],
        "security": [("get_security_advisories", base)],
        "languages": [("get_language_breakdown", base)],
        "prs": [("list_pull_requests", base)],
        "release": [("get_latest_release", base)],
        "issues": [("list_open_issues", base)],
        "people": [("list_contributors", base)],
        "readme": [("get_file_content", {**base, "path": "README.md"})],
        "dashboard": [("get_repository_dashboard", base)],
        "overview": [("get_repo_details", base)],
    }
    return [{"name": name, "arguments": dict(arguments)} for name, arguments in table[intent]]


def detect_intents(message: str) -> list[str]:
    intents: list[str] = []
    if _PRODUCTION.search(message):
        intents += ["health", "ci", "security"]
    if _COMPARE.search(message):
        intents += ["health", "ci"]
    intents += [name for name, pattern in _INTENTS if pattern.search(message)]
    seen: set[str] = set()
    return [item for item in intents if not (item in seen or seen.add(item))]


def plan_tool_calls(
    message: str,
    previous_user_messages: list[str],
    available: set[str],
) -> list[dict[str, Any]]:
    """Propose tool calls for a question, or [] to let the language model decide."""
    if _RATE.search(message) and "get_rate_limit" in available:
        return [{"name": "get_rate_limit", "arguments": {}}]

    repos = find_repos(message)
    intents = detect_intents(message)

    if not repos:
        previous = [repo for text in previous_user_messages for repo in find_repos(text)]
        if previous and intents and _FOLLOW_UP.search(message):
            repos = [previous[-1]]
        elif _SEARCH.search(message) and "search_repositories" in available:
            query = re.sub(r"\s+", " ", message).strip(" ?!.")[:150]
            return [{"name": "search_repositories", "arguments": {"query": query}}]
        else:
            return []

    if not intents:
        intents = ["overview", "health"]

    calls: list[dict[str, Any]] = []
    for full_name in repos[:MAX_REPOS]:
        owner, repo = full_name.split("/", 1)
        for intent in intents:
            for call in _tools_for(intent, owner, repo):
                if call["name"] in available and call not in calls:
                    calls.append(call)
    return calls[:MAX_CALLS]
