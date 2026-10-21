"""Single ReAct agent with conversational memory and human-approved tools."""

import asyncio
import json
from typing import Any

from mcp_bridge import call_mcp_tool, discover_openai_tools, mcp_session
from model_client import check_connection, get_client_and_model


SYSTEM_PROMPT = (
    "You are DevPulse, an assistant that answers questions about GitHub "
    "repositories using real, live tools. Always use a tool to look up facts "
    "instead of guessing. Remember repository names mentioned earlier in the "
    "conversation so the user doesn't have to repeat them."
)


class DevPulseAgent:
    def __init__(self) -> None:
        self.client, self.model, self.backend = get_client_and_model()
        self.history: list[dict[str, Any]] = []

    async def ask(self, user_input: str, max_loops: int = 4) -> str:
        if max_loops < 1:
            raise ValueError("max_loops must be at least 1.")
        self.history.append({"role": "user", "content": user_input})

        async with mcp_session() as session:
            tools = await discover_openai_tools(session)
            for _ in range(max_loops):
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        *self.history,
                    ],
                    tools=tools,
                    tool_choice="auto",
                )
                message = response.choices[0].message
                if response.choices[0].finish_reason != "tool_calls" or not message.tool_calls:
                    answer = message.content or ""
                    self.history.append({"role": "assistant", "content": answer})
                    return answer

                self.history.append(
                    {
                        "role": "assistant",
                        "content": message.content,
                        "tool_calls": [
                            tool_call.model_dump() for tool_call in message.tool_calls
                        ],
                    }
                )

                for tool_call in message.tool_calls:
                    arguments = json.loads(tool_call.function.arguments)
                    print("\n" + "=" * 60)
                    print(" HUMAN-IN-THE-LOOP APPROVAL ")
                    print("=" * 60)
                    print(f"Tool Selected : {tool_call.function.name}")
                    print(f"Arguments     : {arguments}")
                    print("=" * 60)

                    approval = input("Approve tool execution? (y/n): ").strip().lower()
                    if approval != "y":
                        print("\nTool execution rejected by human.\n")
                        result_text = "Tool execution denied by human reviewer."
                    else:
                        print("\nHuman approved. Executing MCP tool...\n")
                        result_text = await call_mcp_tool(
                            session,
                            tool_call.function.name,
                            arguments,
                        )
                        print("=" * 60)
                        print(" TOOL RESULT ")
                        print("=" * 60)
                        print(result_text)
                        print("=" * 60)

                    self.history.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": result_text,
                        }
                    )

        return "I wasn't able to resolve this within the allotted reasoning steps."


async def main() -> None:
    agent = DevPulseAgent()
    if not check_connection(agent.client, agent.model, agent.backend):
        return

    print("\n" + "=" * 70)
    print(" DevPulse Agent with Human-in-the-Loop ")
    print("=" * 70)
    print(f"Model: {agent.model} ({agent.backend})")
    print("Type 'quit' to exit.")
    print("=" * 70)

    while True:
        user_input = input("\nYou: ").strip()
        if user_input.lower() == "quit":
            break
        if not user_input:
            continue
        answer = await agent.ask(user_input)
        print("\n" + "=" * 70)
        print(" DevPulse Response ")
        print("=" * 70)
        print(answer)
        print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
