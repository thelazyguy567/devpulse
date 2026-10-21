"""Offline tests for supervisor routing (no model or GitHub calls)."""

import unittest

import langgraph_agent as agents


class PlanFromKeywordsTests(unittest.TestCase):
    def test_security_question(self) -> None:
        self.assertEqual(agents.plan_from_keywords("Is facebook/react secure?"), ["security"])

    def test_multi_domain_question(self) -> None:
        plan = agents.plan_from_keywords("Is it maintained and does CI pass?")
        self.assertIn("health", plan)
        self.assertIn("devops", plan)

    def test_broad_question_uses_three_agents(self) -> None:
        self.assertEqual(
            agents.plan_from_keywords("Is facebook/react production ready?"),
            ["health", "security", "devops"],
        )

    def test_unknown_question_defaults_to_repo_analyst(self) -> None:
        self.assertEqual(agents.plan_from_keywords("tell me about vuejs/core"), ["repo_info"])

    def test_plan_is_capped(self) -> None:
        plan = agents.plan_from_keywords("security pull request ci health release issues")
        self.assertLessEqual(len(plan), agents.MAX_AGENTS_PER_QUERY)


class ParsePlanTests(unittest.TestCase):
    def test_valid_json_array(self) -> None:
        self.assertEqual(agents.parse_plan('["health", "security"]'), ["health", "security"])

    def test_unknown_and_duplicate_names_are_dropped(self) -> None:
        self.assertEqual(agents.parse_plan('["health", "hacker", "health"]'), ["health"])

    def test_array_inside_prose(self) -> None:
        self.assertEqual(agents.parse_plan('Sure: ["devops"] done'), ["devops"])

    def test_garbage_returns_empty(self) -> None:
        self.assertEqual(agents.parse_plan("no idea"), [])
        self.assertEqual(agents.parse_plan("[not json]"), [])


class RosterTests(unittest.TestCase):
    def test_every_specialist_has_a_label_and_scoped_tools(self) -> None:
        for name, (persona, tools) in agents.SPECIALISTS.items():
            self.assertIn(name, agents.AGENT_LABELS)
            self.assertTrue(persona)
            self.assertTrue(tools)


if __name__ == "__main__":
    unittest.main()
