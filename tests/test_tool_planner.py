"""Offline tests for the question -> tool-call planner."""

import unittest

from tool_planner import find_repos, plan_tool_calls

ALL_TOOLS = {
    "search_repositories", "get_repo_details", "list_open_issues", "list_contributors",
    "get_latest_release", "get_repository_dashboard", "get_repo_health",
    "get_language_breakdown", "get_commit_activity", "list_pull_requests",
    "get_ci_status", "get_security_advisories", "get_file_content", "get_rate_limit",
}


def names(message, previous=()):
    return [call["name"] for call in plan_tool_calls(message, list(previous), ALL_TOOLS)]


class FindReposTests(unittest.TestCase):
    def test_finds_owner_name_pairs(self) -> None:
        self.assertEqual(find_repos("compare facebook/react and vuejs/core."), ["facebook/react", "vuejs/core"])

    def test_ignores_non_repositories(self) -> None:
        self.assertEqual(find_repos("CI/CD with 24/7 input/output and 90/100"), [])

    def test_strips_trailing_punctuation_and_urls(self) -> None:
        self.assertEqual(find_repos("see https://github.com/psf/requests?tab=x"), ["psf/requests"])
        self.assertEqual(find_repos("is pallets/flask."), ["pallets/flask"])


class PlannerTests(unittest.TestCase):
    def test_every_capability_prompt_triggers_its_tool(self) -> None:
        expected = {
            "Find popular Python web frameworks": "search_repositories",
            "Tell me about tiangolo/fastapi": "get_repo_details",
            "Give me a full dashboard of pallets/flask": "get_repository_dashboard",
            "Show open issues for psf/requests": "list_open_issues",
            "Who are the top contributors to torvalds/linux?": "list_contributors",
            "What open pull requests does pallets/flask have?": "list_pull_requests",
            "How healthy is facebook/react?": "get_repo_health",
            "How active has vuejs/core been this year?": "get_commit_activity",
            "Is the CI passing for numpy/numpy?": "get_ci_status",
            "Does django/django have security advisories?": "get_security_advisories",
            "Which languages is microsoft/vscode written in?": "get_language_breakdown",
            "Summarize the README of tiangolo/fastapi": "get_file_content",
            "What is the latest release of django/django?": "get_latest_release",
            "How many GitHub requests do I have left?": "get_rate_limit",
        }
        for prompt, tool in expected.items():
            with self.subTest(prompt=prompt):
                self.assertIn(tool, names(prompt))

    def test_production_question_uses_three_areas(self) -> None:
        planned = names("Is vuejs/core production ready?")
        for tool in ("get_repo_health", "get_ci_status", "get_security_advisories"):
            self.assertIn(tool, planned)

    def test_compare_covers_both_repositories_within_the_cap(self) -> None:
        calls = plan_tool_calls("Compare facebook/react and vuejs/core", [], ALL_TOOLS)
        repos = {call["arguments"].get("repo") for call in calls}
        self.assertEqual(repos, {"react", "core"})
        self.assertLessEqual(len(calls), 6)

    def test_follow_up_reuses_the_previous_repository(self) -> None:
        calls = plan_tool_calls(
            "What about its open pull requests?", ["How healthy is facebook/react?"], ALL_TOOLS
        )
        self.assertEqual(calls[0]["name"], "list_pull_requests")
        self.assertEqual(calls[0]["arguments"], {"owner": "facebook", "repo": "react"})

    def test_repo_without_intent_gets_overview_and_health(self) -> None:
        self.assertEqual(names("facebook/react"), ["get_repo_details", "get_repo_health", "get_commit_activity"])

    def test_no_repo_and_no_search_intent_defers_to_the_model(self) -> None:
        self.assertEqual(plan_tool_calls("hello there", [], ALL_TOOLS), [])

    def test_only_available_tools_are_planned(self) -> None:
        calls = plan_tool_calls("How healthy is facebook/react?", [], {"get_repo_details"})
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
