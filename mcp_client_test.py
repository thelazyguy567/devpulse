"""Exercise the MCP handshake, discovery, and a live GitHub tool call."""

import asyncio
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


SERVER_PATH = os.path.join(os.path.dirname(__file__), "mcp_server.py")


async def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")

    server_params = StdioServerParameters(
        command=sys.executable,
        args=[SERVER_PATH],
        env=os.environ.copy(),
    )

    print("Launching mcp_server.py as a subprocess and connecting...")
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print("[1] initialize() complete -- MCP handshake done.\n")

            tools_result = await session.list_tools()
            print(f"[2] list_tools() discovered {len(tools_result.tools)} tools:")
            for tool in tools_result.tools:
                print(f"    - {tool.name}: {tool.description}")

            resources_result = await session.list_resources()
            resource_uris = [str(resource.uri) for resource in resources_result.resources]
            print(
                "    Resources: "
                f"{resource_uris or '(template-based, not listed directly)'}"
            )

            prompts_result = await session.list_prompts()
            print(f"    Prompts: {[prompt.name for prompt in prompts_result.prompts]}\n")

            print(
                "[3] call_tool('search_repositories', ...) -- "
                "a REAL call to api.github.com:"
            )
            result = await session.call_tool(
                "search_repositories",
                arguments={"query": "agentic ai framework"},
            )
            for item in result.content:
                if hasattr(item, "text"):
                    print(item.text)


if __name__ == "__main__":
    asyncio.run(main())
