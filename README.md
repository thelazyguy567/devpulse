# DevPulse

DevPulse is a full-stack GitHub intelligence capstone that combines a
responsive web dashboard, a FastAPI backend, a live GitHub REST API, an MCP
server, an approval-gated ReAct agent, a LangGraph multi-agent workflow, and a
discoverable A2A-style agent card. GitHub insights come from live API responses;
the application does not present mocked repository data.

## What you can do

- Search public GitHub repositories by name, language, or topic.
- Explore live repository statistics, issues, contributors, releases, and project
  metadata in one dashboard.
- Open an interactive repository architecture diagram through GitDiagram.
- Compare two repositories side by side using the same live metrics.
- Download a repository snapshot as a portable JSON report.
- Ask the assistant questions in plain language and review every proposed MCP
  tool call before it runs. Chat conversations are saved in the current browser.
- Explore an interactive architecture map and a visual request-flow walkthrough.
- Discover the DevPulse agent card at `/api/agent-card` and explore the generated
  API reference at `/docs`.
- Open the **Health** tab on any repository for a 0-100 health score gauge with
  a score breakdown, language mix, 52-week commit chart, CI pass rate, open pull
  requests, and published security advisories.
- See a **Health score** and **CI pass %** row on the Compare page.
- Chat in a centered, easy-to-read column. Answers are formatted (summary, key
  findings, in plain English, what it means, caveats), include small live charts
  when health, language, activity, or CI data was fetched, and show a one-line
  flow at the top in words (You asked → Model chose … → You approved → Read live
  data → Answer). A collapsed **Step-by-step details** card lists each tool, its
  inputs, data source, and duration. Earlier messages stay on screen like a
  normal chat, and past conversations are listed in the history sidebar.
- Use the **What I can do** panel beside the chat: every MCP tool, what it does,
  and a sample prompt you can click to test it (plus multi-tool combos such as
  "Is vuejs/core production ready?"). On narrow screens open it with the
  **Tools & prompts** button.
- Get live tools reliably: a built-in router reads your question, finds
  `owner/name` repositories (and remembers the last one for follow-ups such as
  "What about its pull requests?"), and proposes the matching tools for your
  approval. Small local models no longer skip the tools.
- Read approval prompts in plain English: each tool explains what it does and
  which GitHub endpoint it reads before you click Approve.
- Open the **Architecture** page and switch between four diagrams (System, One
  chat question, Multi-agent team, Health score) with a short explanation under
  each.
- Ask the multi-agent CLI a broad question such as "Is facebook/react production
  ready?" and watch a supervisor pick specialist agents that run in parallel.

The frontend is served by the Python backend from the same application origin;
there is no separate JavaScript build step or Node.js requirement.

## Requirements

- Python 3.10 or newer
- Internet access for live GitHub requests
- Either [Ollama](https://ollama.com/) running locally, or a Groq API key
- A GitHub token is optional. It increases the GitHub API rate limit from
  60 to 5,000 requests per hour.
- The MCP SDK is constrained to version 1.x because this capstone uses its
  `FastMCP` API; SDK version 2 renamed and changed that API.

## Install on Windows

Open PowerShell in this project folder:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

If PowerShell prevents virtual-environment activation, allow scripts for this
PowerShell session and activate again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

Edit `.env` to configure the model and optional keys. Do not commit `.env` or
share its secrets.

### Option A: local Ollama (default; no LLM API key)

Install Ollama, then run these commands in a separate PowerShell window:

```powershell
ollama serve
ollama pull qwen2.5:3b
```

Leave the Ollama server running. The default `.env` selects this backend. To
use a different locally available model, update `OLLAMA_MODEL`.

### Option B: Groq cloud model

Create a Groq API key, then edit `.env`:

```dotenv
LLM_BACKEND=groq
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.1-8b-instant
```

### Optional: GitHub token

Create a personal access token in your GitHub settings and set `GITHUB_TOKEN`
in `.env`. Public repository lookups work without one, but GitHub limits
unauthenticated requests to 60 per hour.

## Run the web application

From the project folder, start the application in the activated virtual
environment:

```powershell
python -m uvicorn api:app --reload --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser. The
workspace has separate Overview, Repository explorer, Compare, Architecture,
and AI assistant pages. Interactive repository search and comparison require
an internet connection; the AI chat also requires Ollama or a configured Groq
account. Ollama must be running in a separate terminal for the default chat
setup.

Useful local URLs:

- Overview: `http://127.0.0.1:8000/`
- Repository explorer: `http://127.0.0.1:8000/repositories`
- Compare repositories: `http://127.0.0.1:8000/compare`
- Architecture: `http://127.0.0.1:8000/architecture`
- AI assistant: `http://127.0.0.1:8000/chat`
- Interactive REST API reference: `http://127.0.0.1:8000/docs`
- API health/configuration: `http://127.0.0.1:8000/api/health`
- Architecture model: `http://127.0.0.1:8000/api/architecture`
- Public agent capability card: `http://127.0.0.1:8000/api/agent-card`

The development server binds to `127.0.0.1` by default in these instructions.
Do not expose this demo server to a public network: chat approvals are stored in
process memory, are intentionally short-lived and single-use, and are not a
production authentication system. Run one worker when using the local approval
flow; starting additional workers would give each process its own pending
approvals.

## Run the CLI and protocol demonstrations

Run commands from the project folder with the virtual environment activated.

Start with the protocol-level check. This launches the MCP server as a child
process, discovers its tools/resources/prompts, then makes a real GitHub search:

```powershell
python mcp_client_test.py
```

Run a direct tool call without an LLM:

```powershell
python -c "from mcp_server import get_repo_details; print(get_repo_details('facebook', 'react'))"
```

Run the single conversational ReAct agent. Each proposed MCP tool call requires
your explicit `y` approval before it reaches GitHub:

```powershell
python agent_core.py
```

Run the LangGraph multi-agent workflow. A supervisor chooses 1-4 of seven
specialists (repo analyst, issue triage, release notes, health analyst, security
auditor, PR reviewer, DevOps/CI monitor), they run in parallel, and a synthesizer
merges their answers:

```powershell
python langgraph_agent.py
```

Try these prompts:

- `Is facebook/react production ready?` (health + security + devops agents)
- `Does vuejs/core have security advisories and open pull requests?`
- `What is the latest release of django/django?` (single agent)

Measure how well the planner routes questions (no GitHub calls). The first
command needs no model; the second also tests the LLM supervisor:

```powershell
python -m eval.run
python -m eval.run --with-model
```

Print the A2A agent card and try tag-based discovery without starting an LLM:

```powershell
python a2a_card.py
```

The MCP server is normally started automatically by each MCP client; run it
directly only when configuring a separate MCP host:

```powershell
python mcp_server.py
```

Run the focused backend checks:

```powershell
python -m unittest discover -s tests -v
```

## Try the new features (step by step)

1. Add a `GITHUB_TOKEN` to `.env` (strongly recommended: the Health tab makes
   about nine GitHub requests per repository, which is only a handful of
   repositories per hour without a token).
2. Check the tools: `python mcp_client_test.py` should list **15 tools**.
3. Start the server (see "Run the web application"), open **Repository
   explorer**, load `facebook/react`, and click the **Health** tab. The sidebar
   then shows your remaining GitHub quota. Opening the same repository again
   within 5 minutes is served from the API cache and makes no GitHub calls.
4. Open **Compare** with `facebook/react` vs `vuejs/core` and look for the
   Health score and CI pass % rows under the usual metrics.
5. Open **AI assistant** and ask `How healthy is facebook/react and is its CI
   passing?`. Read the plain-English approval card, click **Approve and run**,
   and read the one-line flow above the answer, the small gauge/CI charts below
   it, and the collapsed **Step-by-step details**. Ask a follow-up in the same
   chat: the earlier question and answer stay above it.
6. Open **Architecture**, switch between the four diagram tabs, and see the
   agent skills published on the A2A card. On any repository's Health tab, the
   bottom section explains how the score is calculated with a diagram.
7. Run `python langgraph_agent.py` and ask `Is facebook/react production ready?`.
8. Run the tests and the routing evaluation:

```powershell
python -m unittest discover -s tests -v
python -m eval.run
```

Notes on behavior:

- **"No live data" answers:** If your message names no repository (`owner/name`)
  and is not a search or quota question, the router stays out of the way and the
  model answers from general knowledge; the flow line above the answer says so.
  Include a repository such as `facebook/react` to trigger live tools.
- Small charts use Chart.js loaded from cdnjs (transparent, no borders). If the
  library cannot load, the page falls back to built-in CSS charts.
- Flow diagrams are drawn in the browser with the Mermaid library loaded from the
  jsDelivr CDN, so the first diagram needs internet access. If it cannot load,
  the page shows a simple step-by-step fallback instead of a blank box.
- Chat answers are rendered from Markdown after HTML is escaped, so model output
  cannot inject scripts or markup. Small local models may format less neatly
  than larger ones; the system prompt asks for Summary, Key findings, What this
  means, and Caveats.
- Chart data and the step explanations are saved with each chat message in the
  browser, so they are still there when you reopen a conversation.
- A fresh commit-activity chart can show "GitHub is still computing"; GitHub
  builds these statistics on first request. Reload the tab after a minute.
- An empty security-advisory list only means no advisories were *published* by
  the maintainers. It is not a guarantee that the project is secure.
- Text read from repository files is wrapped in `<untrusted_repo_content>` tags
  and the assistant is told never to follow instructions found inside it.
- If a repository has no GitHub Actions or no community profile, that section
  shows "Not available" and the rest of the page still renders.

## Project files

| File | Purpose |
| --- | --- |
| `api.py` | FastAPI application, structured REST endpoints, web serving, and expiring human approvals for chat tool calls. |
| `web/` | Responsive dashboard, live repository explorer/comparison, assistant, and visual architecture guide. |
| `mcp_server.py` | Fifteen live GitHub tools (search, details, issues, contributors, release, dashboard, health score, languages, commit activity, pull requests, CI status, security advisories, file content, rate limit), one resource, and one prompt. |
| `mcp_client_test.py` | Verifies MCP initialization, discovery, and a real tool call. |
| `model_client.py` | Selects the Ollama or Groq chat-completion client using `.env`. |
| `mcp_bridge.py` | Launches the MCP subprocess and adapts discovered tools for LLM function calling. |
| `agent_core.py` | Single ReAct agent with conversational history and human approval for every tool call. |
| `langgraph_agent.py` | LangGraph supervisor, seven specialists (each restricted to its own MCP tools), and a synthesizer. |
| `tool_planner.py` | Maps a question to read-only MCP tool calls (repository detection, intents, follow-ups) so tools run even with small models. Calls still need your approval. |
| `a2a_card.py` | Pydantic agent card (seven skills) and a small registry for skill-tag discovery; the card is also published by the web API. |
| `eval/` | Ten golden prompts and `python -m eval.run`, which scores routing accuracy against the old single-label router. |
| `tests/` | Focused tests for web serving, input validation, the new MCP tools, agent routing, caching, and the chat approval boundary. |

## Troubleshooting

- **Could not reach Ollama:** Keep `ollama serve` running and verify
  `ollama pull qwen2.5:3b` completed. Check `OLLAMA_BASE_URL` if Ollama listens
  at a non-default address.
- **Could not reach Groq:** Set `LLM_BACKEND=groq` and add a valid
  `GROQ_API_KEY` in `.env`.
- **GitHub rate limit exceeded:** Add a `GITHUB_TOKEN` to `.env` or wait for the
  unauthenticated quota to reset.
- **MCP JSON-RPC parse errors:** MCP uses stdout for protocol messages; server
  status output is sent to stderr.
- **MCP child process cannot see a token:** The stdio client passes a copy of
  the parent environment to the server subprocess.
- **Health tab shows warnings or "Not available":** Usually GitHub rate limiting
  (add `GITHUB_TOKEN`) or a repository without Actions/advisories. The warning
  text names the tool that failed.
- **`python -m eval.run` cannot import a module:** Run it from the project folder
  with the virtual environment active so `langgraph_agent` can be imported.
- **Multi-agent CLI picks the wrong agents:** Small local models sometimes
  return invalid plans; the supervisor then falls back to keyword routing and
  prints `[supervisor] plan: [...]` so you can see the decision.
- **No release found:** Some repositories do not publish GitHub releases; the
  API returns a not-found response for those repositories.
