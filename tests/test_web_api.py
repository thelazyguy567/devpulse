"""Focused tests for the DevPulse web API and approval boundary."""

import asyncio
import json
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import api


class FakeToolCall:
    id = "call_test_001"
    function = SimpleNamespace(
        name="get_repo_details",
        arguments='{"owner":"facebook","repo":"react"}',
    )

    def model_dump(self) -> dict:
        return {
            "id": self.id,
            "type": "function",
            "function": {
                "name": self.function.name,
                "arguments": self.function.arguments,
            },
        }


class FakeCompletions:
    def __init__(self) -> None:
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        if self.calls == 1:
            message = SimpleNamespace(
                content=None,
                tool_calls=[FakeToolCall()],
            )
            finish_reason = "tool_calls"
        else:
            message = SimpleNamespace(
                content="That action was declined and no GitHub request was made.",
                tool_calls=None,
            )
            finish_reason = "stop"
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason=finish_reason,
                    message=message,
                )
            ]
        )


class WebApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(api.app)

    def test_home_and_static_assets_are_served(self) -> None:
        page = self.client.get("/")
        stylesheet = self.client.get("/assets/styles.css")
        self.assertEqual(page.status_code, 200)
        self.assertIn("DevPulse", page.text)
        self.assertEqual(stylesheet.status_code, 200)
        self.assertIn(".sidebar", stylesheet.text)

    def test_workspace_pages_are_served_as_separate_routes(self) -> None:
        pages = {
            "/repositories": "search-form",
            "/compare": "compare-form",
            "/architecture": "architecture-map",
            "/chat": "chat-threads",
        }
        for path, page_element in pages.items():
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn(page_element, response.text)

    def test_architecture_explains_the_five_layers(self) -> None:
        response = self.client.get("/api/architecture")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["layers"]), 5)
        self.assertEqual(response.json()["layers"][2]["id"], "mcp")

    def test_agent_card_is_published_for_external_discovery(self) -> None:
        response = self.client.get("/api/agent-card")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "DevPulse")
        self.assertEqual(
            {skill["id"] for skill in response.json()["skills"]},
            {
                "repo_info",
                "issue_triage",
                "release_notes",
                "health_score",
                "security_audit",
                "pr_review",
                "ci_cd_monitor",
            },
        )

    def test_insights_merge_tools_and_use_the_cache(self) -> None:
        api._cache.clear()

        async def fake_tool(_session, name, _arguments):
            if name == "get_ci_status":
                return json.dumps({"error": "ERROR: Actions not available"})
            return json.dumps({"tool": name})

        @asynccontextmanager
        async def fake_session():
            yield object()

        with (
            patch.object(api, "mcp_session", side_effect=fake_session),
            patch.object(api, "call_mcp_tool", new=AsyncMock(side_effect=fake_tool)) as call_tool,
        ):
            first = asyncio.run(api.repository_insights("org", "repo"))
            calls_after_first = call_tool.await_count
            second = asyncio.run(api.repository_insights("ORG", "repo"))

        self.assertEqual(first["get_repo_health"], {"tool": "get_repo_health"})
        self.assertIsNone(first["get_ci_status"])
        self.assertIn("ERROR: Actions not available", first["warnings"])
        self.assertEqual(calls_after_first, len(api.INSIGHT_TOOLS))
        self.assertTrue(second["cached"])
        self.assertEqual(call_tool.await_count, calls_after_first)

    def test_capabilities_list_tools_with_sample_prompts(self) -> None:
        data = self.client.get("/api/capabilities").json()
        self.assertEqual(data["tool_count"], len(api.TOOL_INFO))
        items = [item for group in data["groups"] for item in group["items"]]
        self.assertIn("get_repo_health", {item["tool"] for item in items})
        self.assertTrue(all(item["prompt"] and item["what"] for item in items))

    def test_router_proposes_tools_without_asking_the_model(self) -> None:
        def tool(name):
            return {
                "type": "function",
                "function": {"name": name, "description": name, "parameters": {"type": "object", "properties": {}}},
            }

        with (
            patch.object(
                api,
                "_discover_tools",
                new=AsyncMock(return_value=[tool("get_repo_health"), tool("get_commit_activity")]),
            ),
            patch.object(api, "get_client_and_model", side_effect=AssertionError("model must not be called")),
        ):
            response = asyncio.run(
                api.chat(api.ChatRequest(message="How healthy is facebook/react?"))
            )
        self.assertEqual(response["status"], "approval_required")
        self.assertEqual(response["source"], "router")
        self.assertEqual(
            [call["name"] for call in response["calls"]],
            ["get_repo_health", "get_commit_activity"],
        )
        self.assertEqual(response["calls"][0]["arguments"], {"owner": "facebook", "repo": "react"})

    def test_insights_validate_repository_parts(self) -> None:
        with self.assertRaises(HTTPException) as error:
            asyncio.run(api.repository_insights("../x", "repo"))
        self.assertEqual(error.exception.status_code, 422)

    def test_repository_parts_are_validated_before_network_access(self) -> None:
        with patch.object(api, "_call_dashboard_tool", new=AsyncMock()) as call_tool:
            with self.assertRaises(HTTPException) as error:
                asyncio.run(api.repository_dashboard("../private", "repo"))
        self.assertEqual(error.exception.status_code, 422)
        call_tool.assert_not_awaited()

    def test_search_uses_the_structured_mcp_tool(self) -> None:
        expected = {"total_count": 1, "items": [{"full_name": "org/repo"}]}
        with patch.object(
            api,
            "_call_dashboard_tool",
            new=AsyncMock(return_value=json.dumps(expected)),
        ) as call_tool:
            response = asyncio.run(api.search(api.SearchRequest(query="python agents")))
        self.assertEqual(response, expected)
        call_tool.assert_awaited_once_with(
            "search_repositories_data",
            {"query": "python agents"},
        )

    def test_comparison_fetches_both_repositories_concurrently(self) -> None:
        first = {"repository": {"full_name": "org/first"}}
        second = {"repository": {"full_name": "org/second"}}
        with patch.object(
            api,
            "_call_dashboard_tool",
            new=AsyncMock(side_effect=[json.dumps(first), json.dumps(second)]),
        ) as call_tool:
            result = asyncio.run(
                api.compare_repositories(
                    api.CompareRequest(first="org/first", second="org/second")
                )
            )
        self.assertEqual(result["repositories"], [first, second])
        self.assertEqual(call_tool.await_count, 2)

    def test_comparison_rejects_the_same_repository(self) -> None:
        with patch.object(api, "_call_dashboard_tool", new=AsyncMock()) as call_tool:
            with self.assertRaises(HTTPException) as error:
                asyncio.run(
                    api.compare_repositories(
                        api.CompareRequest(first="org/repo", second="ORG/REPO")
                    )
                )
        self.assertEqual(error.exception.status_code, 422)
        call_tool.assert_not_awaited()

    def test_chat_returns_approval_instead_of_running_a_tool(self) -> None:
        fake_client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))
        tool = {
            "type": "function",
            "function": {
                "name": "get_repo_details",
                "description": "Get repository details",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        with (
            patch.object(api, "_discover_tools", new=AsyncMock(return_value=[tool])),
            patch.object(
                api,
                "get_client_and_model",
                return_value=(fake_client, "test-model", "test"),
            ),
        ):
            response = asyncio.run(
                api.chat(
                    api.ChatRequest(
                        message="Tell me about facebook/react",
                        history=[],
                    )
                )
            )

        self.assertEqual(response["status"], "approval_required")
        self.assertEqual(response["calls"][0]["name"], "get_repo_details")
        self.assertNotIn("tool_calls_made", response)

    def test_declined_approval_is_one_time_and_never_calls_mcp(self) -> None:
        fake_client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))
        tool = {
            "type": "function",
            "function": {
                "name": "get_repo_details",
                "description": "Get repository details",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        with (
            patch.object(api, "_discover_tools", new=AsyncMock(return_value=[tool])),
            patch.object(
                api,
                "get_client_and_model",
                return_value=(fake_client, "test-model", "test"),
            ),
            patch.object(api, "mcp_session") as mcp_session,
        ):
            pending = asyncio.run(
                api.chat(api.ChatRequest(message="Get repository facts", history=[]))
            )
            result = asyncio.run(
                api.resolve_chat_approval(
                    api.ApprovalRequest(
                        approval_id=pending["approval_id"],
                        approved=False,
                    )
                )
            )
            self.assertEqual(result["status"], "complete")
            self.assertIn("declined", result["answer"])
            mcp_session.assert_not_called()

            with self.assertRaises(HTTPException) as error:
                asyncio.run(
                    api.resolve_chat_approval(
                        api.ApprovalRequest(
                            approval_id=pending["approval_id"],
                            approved=True,
                        )
                    )
                )
        self.assertEqual(error.exception.status_code, 410)

    def test_chartable_tool_results_are_returned_as_visuals_with_explanations(self) -> None:
        class HealthToolCall(FakeToolCall):
            id = "call_health_001"
            function = SimpleNamespace(
                name="get_repo_health",
                arguments='{"owner":"facebook","repo":"react"}',
            )

        class HealthCompletions(FakeCompletions):
            def create(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    message = SimpleNamespace(content=None, tool_calls=[HealthToolCall()])
                    finish_reason = "tool_calls"
                else:
                    message = SimpleNamespace(content="**Summary** healthy", tool_calls=None)
                    finish_reason = "stop"
                return SimpleNamespace(
                    choices=[SimpleNamespace(finish_reason=finish_reason, message=message)]
                )

        fake_client = SimpleNamespace(chat=SimpleNamespace(completions=HealthCompletions()))
        tool = {
            "type": "function",
            "function": {
                "name": "get_repo_health",
                "description": "Score health",
                "parameters": {"type": "object", "properties": {}},
            },
        }

        @asynccontextmanager
        async def fake_session():
            yield object()

        health = {"score": 90, "grade": "A", "breakdown": []}
        with (
            patch.object(api, "_discover_tools", new=AsyncMock(return_value=[tool])),
            patch.object(
                api, "get_client_and_model", return_value=(fake_client, "test-model", "test")
            ),
            patch.object(api, "mcp_session", side_effect=fake_session),
            patch.object(api, "call_mcp_tool", new=AsyncMock(return_value=json.dumps(health))),
        ):
            pending = asyncio.run(api.chat(api.ChatRequest(message="How healthy is react?")))
            result = asyncio.run(
                api.resolve_chat_approval(
                    api.ApprovalRequest(approval_id=pending["approval_id"], approved=True)
                )
            )

        self.assertEqual(pending["calls"][0]["title"], "Health score")
        self.assertIn("0-100", pending["calls"][0]["what"])
        self.assertEqual(result["visuals"][0]["tool"], "get_repo_health")
        self.assertEqual(result["visuals"][0]["repo"], "facebook/react")
        self.assertEqual(result["visuals"][0]["data"]["score"], 90)
        self.assertEqual(result["trace"][0]["arguments"]["repo"], "react")
        self.assertTrue(result["trace"][0]["source"])

    def test_approved_tool_runs_once_and_returns_a_grounded_answer(self) -> None:
        completions = FakeCompletions()
        completions.calls = 1  # the router chose the tool, so the model only writes the answer
        fake_client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        tool = {
            "type": "function",
            "function": {
                "name": "get_repo_details",
                "description": "Get repository details",
                "parameters": {"type": "object", "properties": {}},
            },
        }

        @asynccontextmanager
        async def fake_session():
            yield object()

        with (
            patch.object(api, "_discover_tools", new=AsyncMock(return_value=[tool])),
            patch.object(
                api,
                "get_client_and_model",
                return_value=(fake_client, "test-model", "test"),
            ),
            patch.object(api, "mcp_session", side_effect=fake_session),
            patch.object(
                api,
                "call_mcp_tool",
                new=AsyncMock(return_value="facebook/react: live repository facts"),
            ) as call_tool,
        ):
            pending = asyncio.run(
                api.chat(api.ChatRequest(message="Tell me about facebook/react"))
            )
            result = asyncio.run(
                api.resolve_chat_approval(
                    api.ApprovalRequest(
                        approval_id=pending["approval_id"],
                        approved=True,
                    )
                )
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual([step["tool"] for step in result["trace"]], ["get_repo_details"])
        call_tool.assert_awaited_once_with(
            unittest.mock.ANY,
            "get_repo_details",
            {"owner": "facebook", "repo": "react"},
        )


if __name__ == "__main__":
    unittest.main()
