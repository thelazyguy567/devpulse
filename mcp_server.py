"""MCP server that exposes live GitHub repository information."""

import base64
import os
import sys
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP


load_dotenv(Path(__file__).with_name(".env"))

mcp = FastMCP("DevPulse GitHub Intelligence Server")

GITHUB_API = "https://api.github.com"
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "DevPulse-MCP-Server",
    "X-GitHub-Api-Version": "2022-11-28",
}
if GITHUB_TOKEN:
    _HEADERS["Authorization"] = f"Bearer {GITHUB_TOKEN}"


def _get(path: str, params: dict[str, Any] | None = None) -> tuple[int, Any]:
    """Make one HTTP GET request to the real GitHub REST API."""
    try:
        response = httpx.get(
            f"{GITHUB_API}{path}",
            headers=_HEADERS,
            params=params,
            timeout=10,
            follow_redirects=True,
        )
        return response.status_code, response.json() if response.content else {}
    except httpx.RequestError as error:
        return -1, {"message": f"Network error: {error}"}


def _friendly_error(status: int, data: Any, context: str) -> str:
    message = data.get("message", "unknown error") if isinstance(data, dict) else str(data)
    if status == 403 and "rate limit" in message.lower():
        return (
            f"ERROR: GitHub API rate limit exceeded. {context} "
            "Unauthenticated requests are capped at 60/hour; set GITHUB_TOKEN "
            "to raise the limit to 5,000/hour."
        )
    if status == 404:
        return f"ERROR: {context} not found on GitHub (404)."
    if status == -1:
        return f"ERROR: could not reach GitHub. {message}"
    return f"ERROR: GitHub API returned status {status} for {context}: {message}"


def _validate_limit(limit: int) -> int:
    if not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100.")
    return limit


def _repo_path(owner: str, repo: str) -> str:
    return f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}"


def _error_json(status: int, data: Any, context: str) -> str:
    return json.dumps({"error": _friendly_error(status, data, context)})


def _days_since(timestamp: str | None) -> int | None:
    """Whole days between an ISO-8601 GitHub timestamp and now."""
    if not timestamp:
        return None
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, (datetime.now(timezone.utc) - moment).days)


def _get_stats(path: str) -> tuple[int, Any]:
    """GitHub answers 202 while it computes statistics; wait once and retry."""
    status, data = _get(path)
    if status == 202:
        time.sleep(2)
        status, data = _get(path)
    return status, data


def compute_health_score(
    commits_90d: int,
    days_since_push: int,
    community_pct: int,
    days_since_release: int | None,
) -> dict[str, Any]:
    """Explainable 0-100 score: activity 35, recency 25, docs 25, releases 15."""
    activity = min(max(commits_90d, 0) / 60, 1) * 35
    recency = 25 * (1 - min(max(days_since_push - 30, 0) / 335, 1))
    docs = max(0, min(community_pct, 100)) / 100 * 25
    release = 15 if days_since_release is not None and days_since_release <= 365 else 0
    parts = [
        ("Activity", activity, 35),
        ("Recency", recency, 25),
        ("Docs & community", docs, 25),
        ("Releases", release, 15),
    ]
    score = round(sum(part[1] for part in parts))
    grade = next(
        letter
        for letter, minimum in (("A", 85), ("B", 70), ("C", 55), ("D", 40), ("F", 0))
        if score >= minimum
    )
    return {
        "score": score,
        "grade": grade,
        "breakdown": [
            {"name": name, "score": round(value), "max": maximum}
            for name, value, maximum in parts
        ],
    }


@mcp.tool()
def search_repositories(query: str) -> str:
    """Search public GitHub repositories by keyword, topic, or language."""
    status, data = _get(
        "/search/repositories",
        params={"q": query, "sort": "stars", "per_page": 5},
    )
    if status != 200:
        return _friendly_error(status, data, f"search for '{query}'")
    items = data.get("items", [])
    if not items:
        return f"No repositories found for query: {query}"

    lines = [f"Top results for '{query}':"]
    for repository in items:
        description = repository.get("description") or "No description"
        lines.append(
            f"- {repository['full_name']} *{repository['stargazers_count']:,} -- "
            f"{description}"
        )
    return "\n".join(lines)


@mcp.tool()
def search_repositories_data(query: str) -> str:
    """Search GitHub repositories and return structured JSON for the DevPulse dashboard."""
    status, data = _get(
        "/search/repositories",
        params={"q": query, "sort": "stars", "per_page": 8},
    )
    if status != 200:
        return json.dumps(
            {"error": _friendly_error(status, data, f"search for '{query}'")}
        )
    repositories = [
        {
            "full_name": repository["full_name"],
            "name": repository["name"],
            "owner": repository["owner"]["login"],
            "description": repository.get("description"),
            "stars": repository["stargazers_count"],
            "forks": repository["forks_count"],
            "language": repository.get("language"),
            "open_issues": repository["open_issues_count"],
            "html_url": repository["html_url"],
            "avatar_url": repository["owner"].get("avatar_url"),
            "updated_at": repository.get("updated_at"),
        }
        for repository in data.get("items", [])
    ]
    return json.dumps({"total_count": data.get("total_count", 0), "items": repositories})


@mcp.tool()
def get_repo_details(owner: str, repo: str) -> str:
    """Get live details for a GitHub repository: stars, forks, license, and description."""
    status, data = _get(f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}")
    if status != 200:
        return _friendly_error(status, data, f"{owner}/{repo}")
    license_name = (data.get("license") or {}).get("name", "No license")
    return (
        f"{data['full_name']}: {data.get('description') or 'No description'}\n"
        f"{data['stargazers_count']:,} stars | {data['forks_count']:,} forks | "
        f"Language: {data.get('language') or 'N/A'} | License: {license_name}\n"
        f"Open issues: {data['open_issues_count']} | "
        f"Default branch: {data['default_branch']}"
    )


@mcp.tool()
def list_open_issues(owner: str, repo: str, limit: int = 5) -> str:
    """List currently open issues for a GitHub repository."""
    limit = _validate_limit(limit)
    status, data = _get(
        f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/issues",
        params={"state": "open", "per_page": limit},
    )
    if status != 200:
        return _friendly_error(status, data, f"{owner}/{repo} issues")
    if not data:
        return f"{owner}/{repo} currently has no open issues."

    lines = [f"Open issues for {owner}/{repo} (showing {len(data)}):"]
    for issue in data:
        labels = ", ".join(label["name"] for label in issue.get("labels", []))
        lines.append(
            f"- #{issue['number']}: {issue['title']} "
            f"[{labels or 'no labels'}]"
        )
    return "\n".join(lines)


@mcp.tool()
def list_contributors(owner: str, repo: str, limit: int = 5) -> str:
    """List the top contributors to a GitHub repository by commit count."""
    limit = _validate_limit(limit)
    status, data = _get(
        f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/contributors",
        params={"per_page": limit},
    )
    if status != 200:
        return _friendly_error(status, data, f"{owner}/{repo} contributors")
    if not data:
        return f"No contributor data available for {owner}/{repo}."

    lines = [f"Top contributors to {owner}/{repo}:"]
    lines.extend(
        f"- {contributor['login']}: {contributor['contributions']} commits"
        for contributor in data
    )
    return "\n".join(lines)


@mcp.tool()
def get_latest_release(owner: str, repo: str) -> str:
    """Get the latest published release for a GitHub repository."""
    status, data = _get(
        f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/releases/latest"
    )
    if status != 200:
        return _friendly_error(status, data, f"{owner}/{repo} latest release")
    return (
        f"Latest release of {owner}/{repo}: {data['tag_name']} "
        f"({data.get('name') or ''})\n"
        f"Published: {data.get('published_at') or 'Unknown'}\n"
        f"Notes: {(data.get('body') or 'No release notes.')[:300]}"
    )


@mcp.tool()
def get_repository_dashboard(owner: str, repo: str) -> str:
    """Return structured repository, issue, contributor, and release data for the web dashboard."""
    repository_path = f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}"
    status, repository = _get(repository_path)
    if status != 200:
        return json.dumps(
            {"error": _friendly_error(status, repository, f"{owner}/{repo}")}
        )

    issues_status, issues_data = _get(
        f"{repository_path}/issues",
        params={"state": "open", "per_page": 8},
    )
    contributors_status, contributors_data = _get(
        f"{repository_path}/contributors",
        params={"per_page": 6},
    )
    release_status, release_data = _get(f"{repository_path}/releases/latest")

    def response_error(
        response_status: int, response_data: Any, context: str
    ) -> str | None:
        if response_status == 200:
            return None
        return _friendly_error(response_status, response_data, context)

    dashboard = {
        "repository": {
            "full_name": repository["full_name"],
            "description": repository.get("description"),
            "html_url": repository["html_url"],
            "avatar_url": repository["owner"].get("avatar_url"),
            "stars": repository["stargazers_count"],
            "forks": repository["forks_count"],
            "watchers": repository["subscribers_count"],
            "open_issues": repository["open_issues_count"],
            "language": repository.get("language"),
            "license": (repository.get("license") or {}).get("name"),
            "default_branch": repository["default_branch"],
            "created_at": repository["created_at"],
            "updated_at": repository["updated_at"],
            "pushed_at": repository["pushed_at"],
            "topics": repository.get("topics", []),
        },
        "issues": (
            [
                {
                    "number": issue["number"],
                    "title": issue["title"],
                    "html_url": issue["html_url"],
                    "created_at": issue["created_at"],
                    "comments": issue["comments"],
                    "labels": [label["name"] for label in issue.get("labels", [])],
                    "user": issue["user"]["login"],
                }
                for issue in issues_data
                if "pull_request" not in issue
            ]
            if issues_status == 200
            else []
        ),
        "contributors": (
            [
                {
                    "login": contributor["login"],
                    "avatar_url": contributor["avatar_url"],
                    "html_url": contributor["html_url"],
                    "contributions": contributor["contributions"],
                }
                for contributor in contributors_data
            ]
            if contributors_status == 200
            else []
        ),
        "release": (
            {
                "tag_name": release_data["tag_name"],
                "name": release_data.get("name"),
                "html_url": release_data["html_url"],
                "published_at": release_data.get("published_at"),
                "body": (release_data.get("body") or "")[:3000],
            }
            if release_status == 200
            else None
        ),
        "warnings": [
            message
            for message in (
                response_error(issues_status, issues_data, f"{owner}/{repo} issues"),
                response_error(
                    contributors_status,
                    contributors_data,
                    f"{owner}/{repo} contributors",
                ),
                response_error(release_status, release_data, f"{owner}/{repo} release"),
            )
            if message
        ],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    return json.dumps(dashboard)


@mcp.tool()
def get_repo_health(owner: str, repo: str) -> str:
    """Score a repository's health from 0-100 (activity, recency, docs, releases) with a breakdown."""
    path = _repo_path(owner, repo)
    status, repository = _get(path)
    if status != 200:
        return _error_json(status, repository, f"{owner}/{repo}")

    since = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%SZ")
    commit_status, commits = _get(
        f"{path}/commits", params={"since": since, "per_page": 100}
    )
    community_status, community = _get(f"{path}/community/profile")
    release_status, releases = _get(f"{path}/releases", params={"per_page": 1})

    commits_90d = len(commits) if commit_status == 200 and isinstance(commits, list) else 0
    community_pct = (
        int(community.get("health_percentage") or 0) if community_status == 200 else 0
    )
    release_days = (
        _days_since(releases[0].get("published_at"))
        if release_status == 200 and isinstance(releases, list) and releases
        else None
    )
    push_days = _days_since(repository.get("pushed_at"))
    result = compute_health_score(
        commits_90d,
        push_days if push_days is not None else 9999,
        community_pct,
        release_days,
    )
    files = (community.get("files") or {}) if community_status == 200 else {}
    result.update(
        {
            "full_name": repository["full_name"],
            "commits_90d": commits_90d,
            "commits_capped": commits_90d >= 100,
            "days_since_push": push_days,
            "community_percentage": community_pct,
            "files": {
                key: bool(files.get(key))
                for key in ("readme", "license", "contributing", "code_of_conduct")
            },
        }
    )
    return json.dumps(result)


@mcp.tool()
def get_language_breakdown(owner: str, repo: str) -> str:
    """Return the percentage of each programming language used in a repository."""
    status, data = _get(f"{_repo_path(owner, repo)}/languages")
    if status != 200:
        return _error_json(status, data, f"{owner}/{repo} languages")
    total = sum(data.values()) or 1
    ranked = sorted(data.items(), key=lambda item: item[1], reverse=True)
    languages = [
        {"name": name, "bytes": size, "percent": round(size / total * 100, 1)}
        for name, size in ranked[:6]
    ]
    other = sum(size for _, size in ranked[6:])
    if other:
        languages.append(
            {"name": "Other", "bytes": other, "percent": round(other / total * 100, 1)}
        )
    return json.dumps({"languages": languages})


@mcp.tool()
def get_commit_activity(owner: str, repo: str) -> str:
    """Return weekly commit counts for the last 52 weeks."""
    status, data = _get_stats(f"{_repo_path(owner, repo)}/stats/participation")
    if status == 202 or (status == 200 and not data):
        return json.dumps(
            {
                "status": "computing",
                "message": "GitHub is still preparing these statistics. Try again in a minute.",
            }
        )
    if status != 200:
        return _error_json(status, data, f"{owner}/{repo} commit activity")
    weekly = [int(count) for count in data.get("all", [])]
    busiest = max(range(len(weekly)), key=weekly.__getitem__) if weekly else None
    return json.dumps(
        {
            "weekly": weekly,
            "total": sum(weekly),
            "busiest_week_index": busiest,
            "busiest_week_commits": weekly[busiest] if busiest is not None else 0,
        }
    )


@mcp.tool()
def list_pull_requests(owner: str, repo: str, limit: int = 5) -> str:
    """List currently open pull requests with author, age, labels, and draft state."""
    limit = _validate_limit(limit)
    status, data = _get(
        f"{_repo_path(owner, repo)}/pulls",
        params={"state": "open", "per_page": limit},
    )
    if status != 200:
        return _error_json(status, data, f"{owner}/{repo} pull requests")
    return json.dumps(
        {
            "pull_requests": [
                {
                    "number": pull["number"],
                    "title": pull["title"],
                    "user": (pull.get("user") or {}).get("login", "unknown"),
                    "draft": bool(pull.get("draft")),
                    "age_days": _days_since(pull.get("created_at")),
                    "labels": [label["name"] for label in pull.get("labels", [])],
                    "html_url": pull["html_url"],
                }
                for pull in data
            ]
        }
    )


@mcp.tool()
def get_ci_status(owner: str, repo: str) -> str:
    """Summarize recent GitHub Actions runs: pass rate and the latest results."""
    status, data = _get(
        f"{_repo_path(owner, repo)}/actions/runs", params={"per_page": 20}
    )
    if status != 200:
        return _error_json(status, data, f"{owner}/{repo} CI runs")
    runs = data.get("workflow_runs", [])
    finished = [run for run in runs if run.get("conclusion") in {"success", "failure"}]
    passed = sum(1 for run in finished if run["conclusion"] == "success")
    return json.dumps(
        {
            "pass_rate": round(passed / len(finished) * 100) if finished else None,
            "runs": [
                {
                    "name": run.get("name"),
                    "conclusion": run.get("conclusion") or run.get("status"),
                    "created_at": run.get("created_at"),
                }
                for run in runs[:10]
            ],
        }
    )


@mcp.tool()
def get_security_advisories(owner: str, repo: str) -> str:
    """List published GitHub security advisories (CVE/GHSA) for a repository."""
    status, data = _get(
        f"{_repo_path(owner, repo)}/security-advisories",
        params={"state": "published", "per_page": 10},
    )
    if status != 200:
        return _error_json(status, data, f"{owner}/{repo} security advisories")
    return json.dumps(
        {
            "advisories": [
                {
                    "ghsa_id": advisory.get("ghsa_id"),
                    "cve_id": advisory.get("cve_id"),
                    "severity": advisory.get("severity"),
                    "summary": advisory.get("summary"),
                    "published_at": advisory.get("published_at"),
                }
                for advisory in data
            ],
            "note": (
                "Only advisories the maintainers published are listed. "
                "An empty list is not a guarantee that the project is secure."
            ),
        }
    )


@mcp.tool()
def get_file_content(owner: str, repo: str, path: str) -> str:
    """Read a text file (README, package.json, Dockerfile, ...) from a repository, capped at 8000 characters."""
    if (
        not path
        or path.startswith("/")
        or "\\" in path
        or any(part == ".." for part in path.split("/"))
    ):
        return json.dumps({"error": "ERROR: path must be a relative file path inside the repository."})
    status, data = _get(f"{_repo_path(owner, repo)}/contents/{quote(path, safe='/')}")
    if status != 200:
        return _error_json(status, data, f"{owner}/{repo}/{path}")
    if not isinstance(data, dict) or data.get("type") != "file":
        return json.dumps({"error": "ERROR: that path is a directory, not a file."})
    try:
        text = base64.b64decode(data.get("content", "")).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return json.dumps({"error": "ERROR: that file is binary or not UTF-8 text."})
    truncated = len(text) > 8000
    return json.dumps(
        {
            "path": path,
            "size": data.get("size"),
            "truncated": truncated,
            "content": (
                "<untrusted_repo_content>\n"
                f"{text[:8000]}\n"
                "</untrusted_repo_content>"
            ),
        }
    )


@mcp.tool()
def get_rate_limit() -> str:
    """Report the remaining GitHub API quota for the configured credentials."""
    status, data = _get("/rate_limit")
    if status != 200:
        return _error_json(status, data, "rate limit")
    core = data.get("resources", {}).get("core", {})
    reset = core.get("reset")
    return json.dumps(
        {
            "remaining": core.get("remaining"),
            "limit": core.get("limit"),
            "reset_at": (
                datetime.fromtimestamp(reset, timezone.utc).isoformat() if reset else None
            ),
            "authenticated": bool(GITHUB_TOKEN),
        }
    )


@mcp.resource("github://repo/{owner}/{repo}/summary")
def repo_summary_resource(owner: str, repo: str) -> str:
    """Provide a read-only snapshot of a repository's key statistics."""
    status, data = _get(f"/repos/{quote(owner, safe='')}/{quote(repo, safe='')}")
    if status != 200:
        return _friendly_error(status, data, f"{owner}/{repo}")
    return (
        f"REPO SUMMARY: {data['full_name']}\n"
        f"Stars: {data['stargazers_count']} | Forks: {data['forks_count']} | "
        f"Open Issues: {data['open_issues_count']}\n"
        f"Created: {data['created_at']} | Last push: {data['pushed_at']}"
    )


@mcp.prompt()
def issue_triage_prompt() -> str:
    """Provide a reusable structured workflow for triaging a GitHub issue."""
    return (
        "Review this GitHub issue and:\n"
        "1. Classify it as exactly one of: Bug / Feature Request / Question / Documentation\n"
        "2. Assign a priority: Critical / High / Medium / Low, based on impact described\n"
        "3. Suggest which existing label(s) it should carry\n"
        "4. Write a one-sentence summary suitable for a triage dashboard\n"
        "Be concise -- output should fit in 4 short lines."
    )


if __name__ == "__main__":
    print("Starting DevPulse MCP Server...", file=sys.stderr)
    print(
        "15 tools: search, structured search, repository details and dashboard, "
        "open issues, contributors, latest release, health score, languages, "
        "commit activity, pull requests, CI status, security advisories, "
        "file content, rate limit",
        file=sys.stderr,
    )
    print("1 resource: github://repo/{owner}/{repo}/summary", file=sys.stderr)
    print("1 prompt: issue_triage_prompt", file=sys.stderr)
    if not GITHUB_TOKEN:
        print(
            "NOTE: no GITHUB_TOKEN set -- limited to 60 unauthenticated requests/hour.",
            file=sys.stderr,
        )
    print("Waiting for MCP client connections (Ctrl+C to stop)...", file=sys.stderr)
    mcp.run()
