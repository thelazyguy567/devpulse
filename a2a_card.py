"""Publish DevPulse's capabilities as a framework-independent agent card."""

from pydantic import BaseModel


class Skill(BaseModel):
    id: str
    description: str
    tags: list[str]


class AgentCard(BaseModel):
    name: str
    description: str
    version: str
    endpoint: str
    skills: list[Skill]


DEVPULSE_CARD = AgentCard(
    name="DevPulse",
    description="Agentic GitHub intelligence assistant backed by a real MCP server.",
    version="1.1.0",
    endpoint="http://localhost:9001/devpulse",
    skills=[
        Skill(
            id="repo_info",
            description="Look up live stats, search, and contributors for a GitHub repository",
            tags=["github", "repository", "stars", "contributors", "search"],
        ),
        Skill(
            id="issue_triage",
            description="List and triage open issues for a GitHub repository",
            tags=["github", "issues", "triage", "bugs"],
        ),
        Skill(
            id="release_notes",
            description="Get the latest release/version info for a GitHub repository",
            tags=["github", "release", "version", "changelog"],
        ),
        Skill(
            id="health_score",
            description="Score a repository's health (activity, recency, docs, releases) from 0-100",
            tags=["github", "health", "maintenance", "activity"],
        ),
        Skill(
            id="security_audit",
            description="List published security advisories and inspect dependency manifests",
            tags=["github", "security", "cve", "advisories"],
        ),
        Skill(
            id="pr_review",
            description="Summarize open pull requests, their age, and draft state",
            tags=["github", "pull-requests", "review"],
        ),
        Skill(
            id="ci_cd_monitor",
            description="Report GitHub Actions pass rate and recent workflow results",
            tags=["github", "ci", "actions", "devops"],
        ),
    ],
)


class AgentRegistry:
    def __init__(self) -> None:
        self.agents: list[AgentCard] = []

    def register(self, card: AgentCard) -> None:
        self.agents.append(card)

    def discover(self, tag: str) -> list[str]:
        return [
            agent.name
            for agent in self.agents
            if any(tag in skill.tags for skill in agent.skills)
        ]


def demo() -> None:
    registry = AgentRegistry()
    registry.register(DEVPULSE_CARD)

    print("Registered agents:")
    for agent in registry.agents:
        print(f"  - {agent.name}: {[skill.id for skill in agent.skills]}")
    print("\nAn external agent searching for who can triage GitHub issues:")
    print(f"  discover('triage') -> {registry.discover('triage')}")
    print("\nAn external agent searching for release/version info:")
    print(f"  discover('release') -> {registry.discover('release')}")
    print("\nFull card as published (this is all an external agent ever sees):")
    print(DEVPULSE_CARD.model_dump_json(indent=2))


if __name__ == "__main__":
    demo()
