"""Shared MCP client helpers for discovering and invoking server tools."""

import os
import sys
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


SERVER_PATH = os.path.join(os.path.dirname(__file__), "mcp_server.py")


@asynccontextmanager
async def mcp_session() -> AsyncIterator[ClientSession]:
    """Launch the MCP server subprocess and yield an initialized session."""
    server_params = StdioServerParameters(
        command=sys.executable,
        args=[SERVER_PATH],
        env=os.environ.copy(),
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def discover_openai_tools(session: ClientSession) -> list[dict[str, Any]]:
    """Convert the MCP server's live tool definitions to function-calling schemas."""
    tools_result = await session.list_tools()
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.inputSchema
                or {"type": "object", "properties": {}},
            },
        }
        for tool in tools_result.tools
    ]


async def call_mcp_tool(
    session: ClientSession,
    name: str,
    arguments: dict[str, Any],
) -> str:
    """Invoke a real MCP tool and return its text content."""
    result = await session.call_tool(name, arguments=arguments)
    texts = [item.text for item in result.content if hasattr(item, "text")]
    return "\n".join(texts) if texts else "(empty result)"
