"""Offline tests for the new MCP tools (GitHub is mocked)."""

import base64
import json
import unittest
from unittest.mock import patch

import mcp_server


class HealthScoreTests(unittest.TestCase):
    def test_abandoned_project_is_graded_f(self) -> None:
        result = mcp_server.compute_health_score(0, 900, 0, None)
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["grade"], "F")

    def test_thriving_project_scores_100(self) -> None:
        result = mcp_server.compute_health_score(120, 1, 100, 10)
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["grade"], "A")
        self.assertEqual(sum(item["max"] for item in result["breakdown"]), 100)

    def test_recency_decays_between_30_and_365_days(self) -> None:
        recent = mcp_server.compute_health_score(0, 30, 0, None)["score"]
        older = mcp_server.compute_health_score(0, 200, 0, None)["score"]
        self.assertGreater(recent, older)


class ToolTests(unittest.TestCase):
    def test_ci_status_computes_pass_rate(self) -> None:
        runs = [{"name": "ci", "conclusion": "success", "created_at": "t"}] * 8 + [
            {"name": "ci", "conclusion": "failure", "created_at": "t"}
        ] * 2
        with patch.object(mcp_server, "_get", return_value=(200, {"workflow_runs": runs})):
            result = json.loads(mcp_server.get_ci_status("o", "r"))
        self.assertEqual(result["pass_rate"], 80)

    def test_ci_status_reports_not_found(self) -> None:
        with patch.object(mcp_server, "_get", return_value=(404, {"message": "Not Found"})):
            result = json.loads(mcp_server.get_ci_status("o", "r"))
        self.assertIn("404", result["error"])

    def test_commit_activity_reports_computing_after_two_202s(self) -> None:
        with (
            patch.object(mcp_server, "_get", return_value=(202, {})),
            patch.object(mcp_server.time, "sleep"),
        ):
            result = json.loads(mcp_server.get_commit_activity("o", "r"))
        self.assertEqual(result["status"], "computing")

    def test_commit_activity_totals_weeks(self) -> None:
        with patch.object(mcp_server, "_get", return_value=(200, {"all": [1, 5, 2]})):
            result = json.loads(mcp_server.get_commit_activity("o", "r"))
        self.assertEqual(result["total"], 8)
        self.assertEqual(result["busiest_week_commits"], 5)

    def test_file_content_rejects_unsafe_paths(self) -> None:
        for path in ("../secret", "/etc/passwd", "a\\b", "", "x/../y"):
            with self.subTest(path=path), patch.object(mcp_server, "_get") as get:
                result = json.loads(mcp_server.get_file_content("o", "r", path))
                self.assertIn("error", result)
                get.assert_not_called()

    def test_file_content_wraps_text_as_untrusted(self) -> None:
        payload = {
            "type": "file",
            "size": 5,
            "content": base64.b64encode(b"hello").decode(),
        }
        with patch.object(mcp_server, "_get", return_value=(200, payload)):
            result = json.loads(mcp_server.get_file_content("o", "r", "README.md"))
        self.assertTrue(result["content"].startswith("<untrusted_repo_content>"))
        self.assertIn("hello", result["content"])

    def test_file_content_rejects_directories(self) -> None:
        with patch.object(mcp_server, "_get", return_value=(200, [{"name": "a"}])):
            result = json.loads(mcp_server.get_file_content("o", "r", "src"))
        self.assertIn("error", result)

    def test_empty_advisories_include_a_caution_note(self) -> None:
        with patch.object(mcp_server, "_get", return_value=(200, [])):
            result = json.loads(mcp_server.get_security_advisories("o", "r"))
        self.assertEqual(result["advisories"], [])
        self.assertIn("not a guarantee", result["note"])

    def test_language_breakdown_groups_the_tail_as_other(self) -> None:
        languages = {f"L{i}": 100 - i for i in range(8)}
        with patch.object(mcp_server, "_get", return_value=(200, languages)):
            result = json.loads(mcp_server.get_language_breakdown("o", "r"))
        self.assertEqual(len(result["languages"]), 7)
        self.assertEqual(result["languages"][-1]["name"], "Other")

    def test_pull_requests_are_summarized(self) -> None:
        pull = {
            "number": 7,
            "title": "Fix bug",
            "user": {"login": "dev"},
            "draft": True,
            "created_at": "2020-01-01T00:00:00Z",
            "labels": [{"name": "bug"}],
            "html_url": "https://github.com/o/r/pull/7",
        }
        with patch.object(mcp_server, "_get", return_value=(200, [pull])):
            result = json.loads(mcp_server.list_pull_requests("o", "r"))
        self.assertTrue(result["pull_requests"][0]["draft"])
        self.assertEqual(result["pull_requests"][0]["labels"], ["bug"])

    def test_repo_health_combines_signals(self) -> None:
        def fake_get(path, params=None):
            if path.endswith("/community/profile"):
                return 200, {
                    "health_percentage": 100,
                    "files": {
                        "readme": {"url": "x"},
                        "license": {"url": "x"},
                        "contributing": None,
                    },
                }
            if path.endswith("/commits"):
                return 200, [{}] * 100
            if path.endswith("/releases"):
                return 200, [{"published_at": "2999-01-01T00:00:00Z"}]
            return 200, {"full_name": "o/r", "pushed_at": "2999-01-01T00:00:00Z"}

        with patch.object(mcp_server, "_get", side_effect=fake_get):
            result = json.loads(mcp_server.get_repo_health("o", "r"))
        self.assertEqual(result["grade"], "A")
        self.assertTrue(result["commits_capped"])
        self.assertTrue(result["files"]["readme"])
        self.assertFalse(result["files"]["contributing"])


if __name__ == "__main__":
    unittest.main()
