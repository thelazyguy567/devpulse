const state = {
  history: [],
  chatThreads: [],
  activeThreadId: null,
  repository: null,
  insights: null,
  insightsLoading: false,
  insightsError: null,
  activeTab: "overview",
  busy: false,
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatCount(value) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function relativeDate(value) {
  if (!value) return "date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date unavailable";
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(payload.detail)
      ? payload.detail.map((item) => item.msg).join(", ")
      : payload.detail || payload.message;
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  return payload;
}

async function loadHealth() {
  try {
    const data = await apiRequest("/api/health");
    byId("github-status").textContent = data.github_token_configured
      ? "Token configured · live on demand"
      : "Public API · 60 requests / hour";
    if (data.backend) {
      byId("model-name").textContent = `${data.backend === "ollama" ? "Ollama" : "Groq"} · ${data.model}`;
      byId("model-status").textContent = data.backend === "ollama" ? "Local model · private by default" : "Cloud model · API key configured";
      byId("config-label").textContent = "Configuration loaded";
    } else {
      byId("model-name").textContent = "Model needs setup";
      byId("model-status").textContent = data.message;
      byId("config-label").textContent = "Setup required for chat";
    }
  } catch (error) {
    byId("model-name").textContent = "API not reachable";
    byId("model-status").textContent = "Start the FastAPI server to connect";
    byId("config-label").textContent = "Connection unavailable";
  }
}

function renderSearchResults(data) {
  const target = byId("search-results");
  if (!data.items?.length) {
    target.innerHTML = '<div class="notice">No public repositories matched that search. Try a broader name, topic, or language.</div>';
    return;
  }
  target.innerHTML = data.items.map((repo) => `
    <button class="search-result" type="button" data-repo="${escapeHtml(repo.full_name)}" aria-label="Open ${escapeHtml(repo.full_name)}">
      ${repo.avatar_url
        ? `<img src="${escapeHtml(repo.avatar_url)}" alt="" loading="lazy">`
        : `<span class="result-avatar-fallback" aria-hidden="true">${escapeHtml(repo.owner?.slice(0, 1)?.toUpperCase() || "?")}</span>`}
      <span class="search-result-main">
        <span class="search-result-top"><span class="search-result-name">${escapeHtml(repo.full_name)}</span><span class="result-stars">★ ${formatCount(repo.stars)}</span></span>
        <span class="search-result-description">${escapeHtml(repo.description || "No description provided.")}</span>
        <span class="result-language"><span class="language-dot"></span>${escapeHtml(repo.language || "Language not specified")} · ${formatCount(repo.open_issues)} open issues</span>
      </span>
    </button>`).join("");
}

function setSearchBusy(busy) {
  const button = byId("search-button");
  button.disabled = busy;
  button.innerHTML = busy ? '<span class="spinner"></span> Searching…' : "Search GitHub <span>↗</span>";
}

async function searchRepositories(query) {
  byId("search-results").innerHTML = '<div class="loading-card"><span class="spinner"></span><span>Looking up live repositories…</span></div>';
  setSearchBusy(true);
  try {
    const data = await apiRequest("/api/search", {
      method: "POST",
      body: JSON.stringify({ query }),
    });
    renderSearchResults(data);
    byId("github-status").textContent = "Connected · live GitHub data";
  } catch (error) {
    byId("search-results").innerHTML = `<div class="notice notice-error">${escapeHtml(error.message)}</div>`;
  } finally {
    setSearchBusy(false);
  }
}

function renderOverview(repo) {
  const topics = repo.topics?.length
    ? repo.topics.map((topic) => `<span class="topic-chip">${escapeHtml(topic)}</span>`).join("")
    : '<span class="topic-chip">No topics published</span>';
  return `
    <div class="tab-heading"><strong>Repository profile</strong><span>About this project</span></div>
    <div class="topic-list">${topics}</div>
    <p class="repo-description-long">${escapeHtml(repo.description || "This repository has not added a public description yet.")}</p>
    <div class="repo-meta-grid">
      <div class="repo-meta">Primary language<strong>${escapeHtml(repo.language || "Not specified")}</strong></div>
      <div class="repo-meta">License<strong>${escapeHtml(repo.license || "No license listed")}</strong></div>
      <div class="repo-meta">Default branch<strong>${escapeHtml(repo.default_branch)}</strong></div>
      <div class="repo-meta">Created<strong>${formatDate(repo.created_at)}</strong></div>
      <div class="repo-meta">Last pushed<strong>${relativeDate(repo.pushed_at)}</strong></div>
      <div class="repo-meta">Last updated<strong>${formatDate(repo.updated_at)}</strong></div>
    </div>`;
}

function renderIssues(issues) {
  if (!issues?.length) {
    return '<div class="tab-heading"><strong>Open issues</strong><span>No open issues were returned</span></div><p class="repo-description-long">This repository has no open issues in the current result, or GitHub did not return issue data.</p>';
  }
  return `<div class="tab-heading"><strong>Recently opened issues</strong><span>Showing ${issues.length} live issue${issues.length === 1 ? "" : "s"}</span></div>
    <div class="issue-list">${issues.map((issue) => `
      <div class="issue-row">
        <span class="issue-status" aria-label="Open issue">○</span>
        <div class="issue-main">
          <a href="${escapeHtml(issue.html_url)}" target="_blank" rel="noreferrer">#${escapeHtml(issue.number)} · ${escapeHtml(issue.title)} ↗</a>
          <div class="issue-subline"><span>by ${escapeHtml(issue.user)}</span><span>·</span><span>${relativeDate(issue.created_at)}</span><span>·</span><span>${formatCount(issue.comments)} comments</span>
            ${issue.labels?.slice(0, 3).map((label) => `<span class="issue-label">${escapeHtml(label)}</span>`).join("") || ""}
          </div>
        </div>
      </div>`).join("")}</div>`;
}

function renderContributors(contributors) {
  if (!contributors?.length) {
    return '<div class="tab-heading"><strong>Community contributors</strong><span>No contributor data returned</span></div><p class="repo-description-long">Contributor details are not available for this repository.</p>';
  }
  return `<div class="tab-heading"><strong>Community contributors</strong><span>Top contributors by commit count</span></div>
    <div class="contributor-list">${contributors.map((person) => `
      <div class="contributor-row">
        <img src="${escapeHtml(person.avatar_url)}" alt="" loading="lazy">
        <div><a href="${escapeHtml(person.html_url)}" target="_blank" rel="noreferrer">${escapeHtml(person.login)} ↗</a><span>GitHub contributor</span></div>
        <span class="contributor-count">${formatCount(person.contributions)} commits</span>
      </div>`).join("")}</div>`;
}

function renderRelease(release) {
  if (!release) {
    return '<div class="tab-heading"><strong>Latest release</strong><span>No published release returned</span></div><p class="repo-description-long">GitHub did not return a latest published release. Some repositories use tags or continuous delivery instead of GitHub Releases.</p>';
  }
  return `<div class="tab-heading"><strong>Latest published release</strong><span>Live release metadata</span></div>
    <div class="release-card">
      <div class="release-top"><span class="release-tag">${escapeHtml(release.tag_name)}</span><span class="release-name">${escapeHtml(release.name || "Release")}</span><span class="release-date">${formatDate(release.published_at)}</span></div>
      <p class="release-body">${escapeHtml(release.body || "No release notes were published.")}</p>
      <a class="release-link" href="${escapeHtml(release.html_url)}" target="_blank" rel="noreferrer">Open release on GitHub ↗</a>
    </div>`;
}



/* ---------- Safe Markdown (escape first, then format) ---------- */
function inlineMarkdown(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function normalizeAnswer(text) {
  const labels = "Summary|Key findings|In plain English|What this means|Caveats";
  const pattern = new RegExp(`^\\s*(?:#{1,4}\\s*)?\\**\\s*(${labels})\\s*\\**\\s*(?::\\s*\\**\\s*(.*)|$)`, "i");
  const out = [];
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const match = line.match(pattern);
    if (match && !/^[-*•]\s/.test(line.trim())) {
      const label = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
      out.push("", `## ${label}`);
      if ((match[2] || "").trim()) out.push(match[2].trim());
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const out = [];
  const startsBlock = (line) => /^(```|#{1,4}\s|\s*[-*•]\s+|\s*\d+[.)]\s+|\|)/.test(line);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (/^```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i += 1;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      out.push(`<h4>${inlineMarkdown(escapeHtml(heading[1]))}</h4>`);
      i += 1;
      continue;
    }
    if (line.startsWith("|") && /^\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(escapeHtml(cell.trim())));
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].startsWith("|")) body.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items = [];
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(escapeHtml(lines[i].replace(pattern, "")))}</li>`);
        i += 1;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !(paragraph.length && startsBlock(lines[i]))) {
      paragraph.push(inlineMarkdown(escapeHtml(lines[i])));
      i += 1;
    }
    out.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return out.join("");
}

/* ---------- Mermaid diagrams (lazy-loaded; text fallback if offline) ---------- */
const DIAGRAMS = {
  system: {
    title: "System",
    caption: "Everything you do in the browser goes through one API. The API talks to GitHub only through the MCP tool server, and asks you before the AI runs a tool.",
    code: `flowchart LR
  U["You<br/>(browser)"] --> W["Web pages<br/>HTML, CSS, JS"]
  W --> API["FastAPI<br/>validates and caches"]
  API --> BR["MCP bridge"]
  BR --> MCP["MCP server<br/>15 read-only tools"]
  MCP --> GH[("GitHub API")]
  API --> LLM["Language model<br/>Ollama or Groq"]
  API -. asks your approval .-> U
  classDef you fill:#fff7e0,stroke:#c9a64b,color:#18231f
  classDef core fill:#edf5ec,stroke:#2e624d,color:#18231f
  class U you
  class API,BR,MCP core`,
  },
  request: {
    title: "One chat question",
    caption: "The model decides whether it needs live data. If it does, nothing runs until you click Approve, and the answer is written only from what the tools returned.",
    code: `flowchart TD
  A["1. You ask in chat"] --> B["2. API sends your question and the tool list to the model"]
  B --> C{"3. Does the model need live GitHub data?"}
  C -- No --> F["6. Answer is shown"]
  C -- Yes --> D{"4. You review the tool call"}
  D -- Approve --> E["5. MCP server calls GitHub and returns the result to the model"]
  D -- Decline --> G["Model is told the tool did not run"]
  E --> F
  G --> F
  classDef you fill:#fff7e0,stroke:#c9a64b,color:#18231f
  class D you`,
  },
  agents: {
    title: "Multi-agent team",
    caption: "In the command-line assistant, a supervisor reads your question, picks up to four specialists, they work in parallel with their own limited tools, and a synthesizer merges the results.",
    code: `flowchart LR
  Q["Your question"] --> S["Supervisor<br/>picks 1 to 4 agents"]
  S --> R["Repo Analyst"]
  S --> H["Health Analyst"]
  S --> X["Security Auditor"]
  S --> P["PR Reviewer"]
  S --> D["DevOps Monitor"]
  S --> I["Issue Triage"]
  S --> N["Release Notes"]
  R & H & X & P & D & I & N --> M["Synthesizer<br/>merges the answers"]
  M --> A["One combined answer"]
  classDef core fill:#edf5ec,stroke:#2e624d,color:#18231f
  class S,M core`,
  },
  health: {
    title: "Health score",
    caption: "Four measurable ingredients add up to a score out of 100. Every number on the Health tab can be traced back to one of them.",
    code: `flowchart LR
  A["Commits in the last 90 days<br/>up to 35 points"] --> S(("Health<br/>score<br/>0 to 100"))
  B["Days since the last push<br/>up to 25 points"] --> S
  C["README, license, contributing<br/>up to 25 points"] --> S
  D["A release in the last year<br/>15 points"] --> S
  S --> G["Grade<br/>A 85+ B 70+ C 55+ D 40+ F"]
  classDef core fill:#edf5ec,stroke:#2e624d,color:#18231f
  class S,G core`,
  },
};

let mermaidPromise = null;
let diagramCounter = 0;
const diagramCache = new Map();

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("https://cdn.jsdelivr.net/npm/mermaid@11.4.0/dist/mermaid.esm.min.mjs").then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          fontFamily: "DM Sans, sans-serif",
          fontSize: "14px",
          primaryColor: "#edf5ec",
          primaryBorderColor: "#2e624d",
          primaryTextColor: "#18231f",
          lineColor: "#64816d",
          secondaryColor: "#f5f6f2",
          tertiaryColor: "#ffffff",
        },
        flowchart: { curve: "basis", htmlLabels: true, padding: 12 },
      });
      return mermaid;
    });
    mermaidPromise.catch(() => { mermaidPromise = null; });
  }
  return mermaidPromise;
}

async function drawDiagram(container, code, cacheKey, fallbackHtml = "") {
  if (!container) return;
  if (cacheKey && diagramCache.has(cacheKey)) {
    container.innerHTML = diagramCache.get(cacheKey);
    return;
  }
  container.innerHTML = '<div class="diagram-loading"><span class="spinner"></span> Drawing diagram…</div>';
  const id = `mmd-${++diagramCounter}`;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(id, code);
    container.innerHTML = svg;
    if (cacheKey) diagramCache.set(cacheKey, svg);
  } catch (error) {
    document.getElementById(`d${id}`)?.remove();
    container.innerHTML = fallbackHtml || '<div class="notice">The diagram could not be drawn (it needs internet access to load the diagram library).</div>';
  }
}

function hydrateDiagrams() {
  document.querySelectorAll("[data-diagram]").forEach((element) => {
    const diagram = DIAGRAMS[element.dataset.diagram];
    if (diagram && !element.dataset.drawn) {
      element.dataset.drawn = "1";
      drawDiagram(element, diagram.code, element.dataset.diagram);
    }
  });
}

function initDiagramPanel() {
  const tabs = byId("diagram-tabs");
  const view = byId("diagram-view");
  const caption = byId("diagram-caption");
  const show = (key) => {
    const diagram = DIAGRAMS[key];
    tabs.querySelectorAll("button").forEach((button) => {
      const active = button.dataset.diagramTab === key;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    caption.textContent = diagram.caption;
    drawDiagram(view, diagram.code, key);
  };
  tabs.innerHTML = Object.entries(DIAGRAMS).map(([key, item]) =>
    `<button type="button" role="tab" data-diagram-tab="${key}">${escapeHtml(item.title)}</button>`).join("");
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-diagram-tab]");
    if (button) show(button.dataset.diagramTab);
  });
  show("system");
}

/* ---------- "How this answer was produced" ---------- */
function buildFlowStrip(trace) {
  const total = trace.reduce((sum, step) => sum + (step.ms || 0), 0);
  const steps = trace.length
    ? [
        "You asked",
        `Model chose: ${trace.map((step) => step.title || step.tool).join(", ")}`,
        "You approved",
        `Read live GitHub data (${(total / 1000).toFixed(1)}s)`,
        "Answer written from that data",
      ]
    : ["You asked", "Answered from the model’s general knowledge (no live data)", "Tip: name a repository like facebook/react to use live tools"];
  const strip = document.createElement("div");
  strip.className = "flow-strip";
  strip.setAttribute("aria-label", "How this answer was produced");
  strip.innerHTML = steps.map((step) => `<span>${escapeHtml(step)}</span>`).join('<i aria-hidden="true">→</i>');
  return strip;
}

function buildExplainCard(trace) {
  const details = document.createElement("details");
  details.className = "explain-card";
  const total = trace.reduce((sum, step) => sum + (step.ms || 0), 0);
  const steps = trace.length
    ? trace.map((step, index) => {
        const args = Object.entries(step.arguments || {}).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(" · ");
        return `<li><div class="explain-step-head"><span class="explain-num">${index + 1}</span><strong>${escapeHtml(step.title || step.tool)}</strong><code>${escapeHtml(step.tool)}</code><span class="explain-ms">${(step.ms / 1000).toFixed(1)}s</span></div>
          ${step.what ? `<p>${escapeHtml(step.what)}</p>` : ""}
          <small>${args ? `Inputs: ${args} · ` : ""}Source: ${escapeHtml(step.source || "GitHub API")}</small></li>`;
      }).join("")
    : "";
  details.innerHTML = `
    <summary>Step-by-step details <span>${trace.length ? `${trace.length} tool step${trace.length === 1 ? "" : "s"} · ${(total / 1000).toFixed(1)}s` : "no tools used"}</span></summary>
    <div class="explain-body">
      <ol class="explain-steps">${steps}</ol>
      <p class="explain-foot">Tools only read public GitHub data. Each one ran only after you approved it, and the answer above is written from their results.</p>
    </div>`;
  return details;
}

let chartJsPromise = null;

function loadChartJs() {
  if (!chartJsPromise) {
    chartJsPromise = new Promise((resolve, reject) => {
      if (window.Chart) return resolve(window.Chart);
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
      script.onload = () => resolve(window.Chart);
      script.onerror = () => {
        chartJsPromise = null;
        reject(new Error("Chart library unavailable"));
      };
      document.head.append(script);
    });
  }
  return chartJsPromise;
}

const CHART_COLORS = ["#2e624d", "#64816d", "#86c99f", "#c9e8d6", "#d7be77", "#9e9aca", "#b8c9bd"];
const CHART_BASE = { responsive: true, maintainAspectRatio: false, animation: { duration: 500 } };

function chartSpec(visual) {
  const data = visual.data;
  if (visual.tool === "get_repo_health" && data.breakdown?.length) {
    const rows = data.breakdown.map((item) => `
      <div class="score-row"><span>${escapeHtml(item.name)}</span>
        <div class="compare-bar-track"><div class="compare-bar" style="width:${item.max ? Math.max(item.score / item.max * 100, 2) : 2}%"></div></div>
        <small>${item.score}/${item.max}</small></div>`).join("");
    return {
      title: "Health score",
      html: `<div class="mini-health"><div class="mini-gauge"><canvas></canvas><div class="mini-gauge-text"><strong>${data.score}</strong><small>GRADE ${escapeHtml(data.grade)}</small></div></div><div class="mini-rows">${rows}</div></div>`,
      draw(Chart, card) {
        new Chart($("canvas", card), {
          type: "doughnut",
          data: { datasets: [{ data: [data.score, Math.max(100 - data.score, 0)], backgroundColor: [CHART_COLORS[0], "rgba(120,140,125,.16)"], borderWidth: 0 }] },
          options: { ...CHART_BASE, rotation: -90, circumference: 180, cutout: "74%", events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } } },
        });
      },
    };
  }
  if (visual.tool === "get_language_breakdown" && data.languages?.length) {
    const legend = data.languages.map((item, index) => `<span><i style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></i>${escapeHtml(item.name)} ${item.percent}%</span>`).join("");
    return {
      title: "Languages",
      html: `<div class="mini-lang"><div class="mini-donut"><canvas></canvas></div><div class="lang-legend stacked">${legend}</div></div>`,
      draw(Chart, card) {
        new Chart($("canvas", card), {
          type: "doughnut",
          data: { labels: data.languages.map((item) => item.name), datasets: [{ data: data.languages.map((item) => item.percent), backgroundColor: CHART_COLORS, borderWidth: 2, borderColor: "rgba(255,255,255,.9)" }] },
          options: { ...CHART_BASE, cutout: "62%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed}%` } } } },
        });
      },
    };
  }
  if (visual.tool === "get_commit_activity" && data.weekly?.length) {
    return {
      title: "Commits per week",
      html: `<div class="mini-bars"><canvas></canvas></div><div class="spark-caption"><span>52 weeks ago</span><span>${formatCount(data.total)} commits</span><span>now</span></div>`,
      draw(Chart, card) {
        new Chart($("canvas", card), {
          type: "bar",
          data: { labels: data.weekly.map((_, index) => `${data.weekly.length - index} weeks ago`), datasets: [{ data: data.weekly, backgroundColor: "#86c99f", hoverBackgroundColor: "#2e624d", borderRadius: 2, barPercentage: 0.9, categoryPercentage: 1 }] },
          options: { ...CHART_BASE, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.y} commits` } } } },
        });
      },
    };
  }
  if (visual.tool === "get_ci_status" && data.pass_rate != null) {
    const runs = data.runs || [];
    const passed = runs.filter((run) => run.conclusion === "success").length;
    const failed = runs.filter((run) => run.conclusion === "failure").length;
    const other = Math.max(runs.length - passed - failed, 0);
    return {
      title: "CI pass rate",
      html: `<div class="mini-lang"><div class="mini-donut small"><canvas></canvas><div class="mini-gauge-text center"><strong>${data.pass_rate}%</strong></div></div><div class="lang-legend stacked"><span><i style="background:#77c892"></i>${passed} passed</span><span><i style="background:#d98b7a"></i>${failed} failed</span>${other ? `<span><i style="background:#d9ded8"></i>${other} other</span>` : ""}</div></div>`,
      draw(Chart, card) {
        new Chart($("canvas", card), {
          type: "doughnut",
          data: { labels: ["Passed", "Failed", "Other"], datasets: [{ data: [passed, failed, other], backgroundColor: ["#77c892", "#d98b7a", "#d9ded8"], borderWidth: 0 }] },
          options: { ...CHART_BASE, cutout: "68%", plugins: { legend: { display: false } } },
        });
      },
    };
  }
  return null;
}

function buildVisualCard(visual) {
  const card = document.createElement("div");
  card.className = "chat-visual";
  const fallback = () => {
    const render = VISUAL_RENDERERS[visual.tool];
    card.innerHTML = `<div class="chat-visual-title">${escapeHtml(visual.repo)}</div>${render ? render(visual.data) : ""}`;
  };
  let spec = null;
  try {
    spec = chartSpec(visual);
  } catch (error) {
    spec = null;
  }
  if (!spec) {
    fallback();
    return card;
  }
  card.innerHTML = `<div class="chat-visual-title">${escapeHtml(visual.repo)} · ${escapeHtml(spec.title)}</div>${spec.html}`;
  loadChartJs().then((Chart) => spec.draw(Chart, card)).catch(fallback);
  return card;
}

function renderAnswerExtras(container, meta) {
  if (!meta) return;
  const cards = (meta.visuals || []).filter((visual) => VISUAL_RENDERERS[visual.tool]).map(buildVisualCard);
  if (cards.length) {
    const grid = document.createElement("div");
    grid.className = "chat-visuals";
    grid.append(...cards);
    container.append(grid);
  }
  if ((meta.trace || []).length) container.append(buildExplainCard(meta.trace));
}

async function loadCapabilities() {
  const list = byId("caps-list");
  if (!list) return;
  try {
    const data = await apiRequest("/api/capabilities");
    byId("caps-count").textContent = `${data.tool_count} MCP tools`;
    const item = (prompt, title, code, what) => `
      <button type="button" class="caps-item" data-prompt="${escapeHtml(prompt)}">
        <span class="caps-item-top"><strong>${escapeHtml(title)}</strong>${code ? `<code>${escapeHtml(code)}</code>` : ""}</span>
        ${what ? `<span class="caps-item-what">${escapeHtml(what)}</span>` : ""}
        <span class="caps-item-prompt">“${escapeHtml(prompt)}”</span>
      </button>`;
    list.innerHTML = data.groups.map((group) => `
      <div class="caps-group"><div class="caps-group-name">${escapeHtml(group.name)}</div>
        ${group.items.map((entry) => item(entry.prompt, entry.title, entry.tool, entry.what)).join("")}</div>`).join("")
      + `<div class="caps-group"><div class="caps-group-name">Combos</div>${data.combos.map((combo) => item(combo.prompt, combo.label, "", "")).join("")}</div>`;
  } catch (error) {
    list.innerHTML = `<div class="notice notice-error">${escapeHtml(error.message)}</div>`;
  }
}

function wireCapsToggle() {
  const layout = document.querySelector(".chat-layout");
  byId("caps-toggle")?.addEventListener("click", () => layout.classList.toggle("caps-open"));
  byId("caps-close")?.addEventListener("click", () => layout.classList.remove("caps-open"));
}

function showThinking(label) {
  hideThinking();
  const messages = byId("chat-messages");
  const row = document.createElement("div");
  row.className = "chat-thinking";
  row.innerHTML = `<span class="spinner"></span><span>${escapeHtml(label)}</span>`;
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
}

function hideThinking() {
  document.querySelector(".chat-thinking")?.remove();
}

function insightHelp(text) {
  return `<p class="insight-help">${text}</p>`;
}

function healthSummary(health) {
  if (!health.breakdown?.length) return "";
  const ratio = (item) => (item.max ? item.score / item.max : 0);
  const ranked = [...health.breakdown].sort((a, b) => ratio(b) - ratio(a));
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const verdict = health.score >= 85 ? "very healthy" : health.score >= 70 ? "healthy" : health.score >= 55 ? "in fair shape" : health.score >= 40 ? "in need of attention" : "at risk of being abandoned";
  return `<p class="insight-summary"><strong>In plain words:</strong> ${escapeHtml(health.full_name)} looks <strong>${verdict}</strong> (${health.score}/100, grade ${escapeHtml(health.grade)}). Strongest area: ${escapeHtml(best.name)} (${best.score}/${best.max}). Weakest area: ${escapeHtml(worst.name)} (${worst.score}/${worst.max}).</p>`;
}

function updateRateStatus(rate) {
  if (!rate || rate.remaining == null) return;
  byId("github-status").textContent = `Live · ${Number(rate.remaining).toLocaleString()} / ${Number(rate.limit).toLocaleString()} requests left`;
}

function renderGauge(score, grade) {
  const arc = Math.PI * 54;
  const path = "M16 70 A54 54 0 0 1 124 70";
  return `<svg class="gauge" viewBox="0 0 140 84" role="img" aria-label="Health score ${score} out of 100, grade ${escapeHtml(grade)}">
    <path d="${path}" class="gauge-track"/>
    <path d="${path}" class="gauge-fill" style="stroke-dasharray:${(arc * score / 100).toFixed(1)} ${arc.toFixed(1)}"/>
    <text x="70" y="64" class="gauge-score">${score}</text>
    <text x="70" y="80" class="gauge-grade">GRADE ${escapeHtml(grade)}</text></svg>`;
}

function insightUnavailable(title) {
  return `<div class="insight-block"><div class="tab-heading"><strong>${title}</strong><span>Not available</span></div></div>`;
}

function renderHealthBlock(health) {
  if (!health) return insightUnavailable("Health score");
  const fileLabels = { readme: "README", license: "License", contributing: "Contributing", code_of_conduct: "Code of conduct" };
  const rows = health.breakdown.map((item) => `
    <div class="score-row"><span>${escapeHtml(item.name)}</span>
      <div class="compare-bar-track"><div class="compare-bar" style="width:${item.max ? Math.max(item.score / item.max * 100, 2) : 2}%"></div></div>
      <small>${item.score}/${item.max}</small></div>`).join("");
  const files = Object.entries(health.files || {}).map(([key, present]) =>
    `<span class="topic-chip ${present ? "" : "missing"}">${present ? "✓" : "✗"} ${fileLabels[key] || escapeHtml(key)}</span>`).join("");
  return `<div class="insight-block">
    <div class="tab-heading"><strong>Health score</strong><span>${health.commits_90d}${health.commits_capped ? "+" : ""} commits in 90 days · last push ${health.days_since_push ?? "?"} days ago</span></div>
    ${healthSummary(health)}
    <div class="insight-grid"><div>${renderGauge(health.score, health.grade)}</div><div>${rows}<div class="file-checks">${files}</div></div></div></div>`;
}

function renderLanguageBlock(data) {
  if (!data?.languages?.length) return insightUnavailable("Languages");
  return `<div class="insight-block"><div class="tab-heading"><strong>Languages</strong><span>Share of code by size</span></div>${insightHelp("Which programming languages the project is written in, measured by amount of code. A single dominant language usually means a focused project.")}
    <div class="lang-bar">${data.languages.map((item, index) => `<i style="width:${item.percent}%;background:var(--lang-${index})" title="${escapeHtml(item.name)} ${item.percent}%"></i>`).join("")}</div>
    <div class="lang-legend">${data.languages.map((item, index) => `<span><i style="background:var(--lang-${index})"></i>${escapeHtml(item.name)} ${item.percent}%</span>`).join("")}</div></div>`;
}

function renderActivityBlock(data) {
  if (!data) return insightUnavailable("Commit activity");
  if (data.status === "computing") {
    return `<div class="insight-block"><div class="tab-heading"><strong>Commit activity</strong><span>GitHub is still computing</span></div><p class="repo-description-long">${escapeHtml(data.message)}</p></div>`;
  }
  const maximum = Math.max(...data.weekly, 1);
  return `<div class="insight-block"><div class="tab-heading"><strong>Commit activity · last 52 weeks</strong><span>${formatCount(data.total)} commits</span></div>${insightHelp("Each bar is one week of commits, oldest on the left. Steady bars mean steady development; bars fading to nothing on the right can mean the project is slowing down.")}
    <div class="spark">${data.weekly.map((count, index) => `<i style="height:${Math.max(count / maximum * 100, 3)}%" title="${count} commits, ${data.weekly.length - index} weeks ago"></i>`).join("")}</div>
    <div class="spark-caption"><span>52 weeks ago</span><span>busiest week: ${data.busiest_week_commits} commits</span><span>now</span></div></div>`;
}

function renderCiBlock(data) {
  if (!data) return insightUnavailable("CI status");
  if (data.pass_rate == null) {
    return `<div class="insight-block"><div class="tab-heading"><strong>CI status</strong><span>No completed workflow runs</span></div><p class="repo-description-long">This repository has no finished GitHub Actions runs in the recent results.</p></div>`;
  }
  const dots = [...data.runs].reverse().map((run) => {
    const kind = run.conclusion === "success" ? "ok" : run.conclusion === "failure" ? "bad" : "";
    return `<span class="${kind}" title="${escapeHtml(run.name || "workflow")}: ${escapeHtml(run.conclusion || "unknown")}"></span>`;
  }).join("");
  return `<div class="insight-block"><div class="tab-heading"><strong>CI status</strong><span>${data.pass_rate}% of recent finished runs passed</span></div>${insightHelp("CI means automated builds and tests that run on every change. Each dot is one recent run (green passed, red failed). A low pass rate can point to flaky or broken builds.")}
    <div class="compare-bar-track"><div class="compare-bar" style="width:${Math.max(data.pass_rate, 2)}%"></div></div>
    <div class="ci-dots" aria-label="Latest workflow runs, oldest first">${dots}</div></div>`;
}

function renderPullRequestBlock(data) {
  if (!data) return insightUnavailable("Open pull requests");
  if (!data.pull_requests.length) {
    return `<div class="insight-block"><div class="tab-heading"><strong>Open pull requests</strong><span>None open</span></div></div>`;
  }
  return `<div class="insight-block"><div class="tab-heading"><strong>Open pull requests</strong><span>Showing ${data.pull_requests.length}</span></div>${insightHelp("Pull requests are proposed changes waiting for review. Many old ones can mean maintainers are slow to review.")}
    <div class="issue-list">${data.pull_requests.map((pull) => `
      <div class="issue-row"><span class="issue-status" aria-hidden="true">⑂</span>
        <div class="issue-main"><a href="${escapeHtml(pull.html_url)}" target="_blank" rel="noreferrer">#${escapeHtml(pull.number)} · ${escapeHtml(pull.title)} ↗</a>
          <div class="issue-subline"><span>by ${escapeHtml(pull.user)}</span><span>·</span><span>${pull.age_days ?? "?"} days old</span>
            ${pull.draft ? '<span class="issue-label">draft</span>' : ""}
            ${pull.labels.slice(0, 3).map((label) => `<span class="issue-label">${escapeHtml(label)}</span>`).join("")}</div></div></div>`).join("")}</div></div>`;
}

function renderAdvisoryBlock(data) {
  if (!data) return insightUnavailable("Security advisories");
  if (!data.advisories.length) {
    return `<div class="insight-block"><div class="tab-heading"><strong>Security advisories</strong><span>None published</span></div><p class="repo-description-long">${escapeHtml(data.note)}</p></div>`;
  }
  return `<div class="insight-block"><div class="tab-heading"><strong>Security advisories</strong><span>${data.advisories.length} published</span></div>${insightHelp("Known vulnerabilities the maintainers have disclosed. Check whether you use an affected version.")}
    <div class="issue-list">${data.advisories.map((item) => `
      <div class="issue-row"><span class="issue-status" aria-hidden="true">!</span>
        <div class="issue-main"><span>${escapeHtml(item.summary || item.ghsa_id)}</span>
          <div class="issue-subline"><span class="issue-label severity severity-${escapeHtml(item.severity || "unknown")}">${escapeHtml(item.severity || "unknown")}</span>
            <span>${escapeHtml(item.cve_id || item.ghsa_id || "")}</span><span>·</span><span>${relativeDate(item.published_at)}</span></div></div></div>`).join("")}</div></div>`;
}

function renderHealth() {
  if (state.insightsError) {
    return `<div class="notice notice-error">${escapeHtml(state.insightsError)}</div>`;
  }
  const data = state.insights;
  if (!data) {
    return '<div class="loading-card"><span class="spinner"></span><span>Collecting health, activity, CI, and security signals through MCP…</span></div>';
  }
  return `${renderHealthBlock(data.get_repo_health)}
    ${renderLanguageBlock(data.get_language_breakdown)}
    ${renderActivityBlock(data.get_commit_activity)}
    ${renderCiBlock(data.get_ci_status)}
    ${renderPullRequestBlock(data.list_pull_requests)}
    ${renderAdvisoryBlock(data.get_security_advisories)}
    ${data.warnings?.length ? `<div class="notice notice-error repo-warning">${data.warnings.map(escapeHtml).join("<br>")}</div>` : ""}
    <div class="insight-block"><div class="tab-heading"><strong>How the score is calculated</strong><span>Four ingredients, 100 points</span></div>
      <div class="mermaid-view" data-diagram="health"></div>
      <p class="diagram-caption">${escapeHtml(DIAGRAMS.health.caption)}</p></div>
    <p class="compare-health-note">${data.cached ? "Served from the 5-minute cache" : "Fetched live"} · tools: get_repo_health, get_language_breakdown, get_commit_activity, get_ci_status, list_pull_requests, get_security_advisories</p>`;
}

async function loadInsights() {
  const fullName = state.repository?.repository?.full_name;
  if (!fullName || state.insightsLoading) return;
  const [owner, name] = fullName.split("/");
  state.insightsLoading = true;
  state.insightsError = null;
  renderRepositoryTab();
  const sameRepository = () => state.repository?.repository?.full_name === fullName;
  try {
    const data = await apiRequest(`/api/repository/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/insights`);
    if (sameRepository()) {
      state.insights = data;
      updateRateStatus(data.get_rate_limit);
    }
  } catch (error) {
    if (sameRepository()) state.insightsError = error.message;
  } finally {
    state.insightsLoading = false;
    if (sameRepository()) renderRepositoryTab();
  }
}

function renderRepositoryTab() {
  if (!state.repository) return;
  const repo = state.repository.repository;
  const tabs = {
    overview: ["Overview", renderOverview(repo)],
    issues: [`Issues · ${formatCount(repo.open_issues)}`, renderIssues(state.repository.issues)],
    contributors: ["Contributors", renderContributors(state.repository.contributors)],
    releases: ["Releases", renderRelease(state.repository.release)],
    health: ["Health", renderHealth()],
  };
  byId("repo-content").innerHTML = `
    <article class="repo-card">
      <div class="repo-banner">
        <img class="repo-avatar" src="${escapeHtml(repo.avatar_url)}" alt="" loading="lazy">
        <div class="repo-title-block"><div class="repo-eyebrow">LIVE REPOSITORY PROFILE</div><h3 class="repo-name">${escapeHtml(repo.full_name)}</h3><div class="repo-description">${escapeHtml(repo.description || "No public description")}</div></div>
        <div class="repo-links">
          <a class="repo-github-link" href="${escapeHtml(repo.html_url)}" target="_blank" rel="noreferrer">View on GitHub ↗</a>
          <a class="repo-diagram-link" href="https://gitdiagram.com/${repo.full_name.split("/").map(encodeURIComponent).join("/")}" target="_blank" rel="noreferrer">Explore architecture diagram ↗</a>
        </div>
      </div>
      <div class="repo-stats">
        <div class="repo-stat"><span class="stat-icon">★</span><span><span class="stat-label">Stars</span><strong class="stat-value">${formatCount(repo.stars)}</strong></span></div>
        <div class="repo-stat"><span class="stat-icon">⑂</span><span><span class="stat-label">Forks</span><strong class="stat-value">${formatCount(repo.forks)}</strong></span></div>
        <div class="repo-stat"><span class="stat-icon">◷</span><span><span class="stat-label">Open issues</span><strong class="stat-value">${formatCount(repo.open_issues)}</strong></span></div>
        <div class="repo-stat"><span class="stat-icon">◎</span><span><span class="stat-label">Watching</span><strong class="stat-value">${formatCount(repo.watchers)}</strong></span></div>
      </div>
      <div class="repo-tabs" role="tablist" aria-label="Repository information">
        ${Object.entries(tabs).map(([key, [label]]) => `<button class="repo-tab ${state.activeTab === key ? "active" : ""}" type="button" role="tab" aria-selected="${state.activeTab === key}" data-tab="${key}">${label}</button>`).join("")}
      </div>
      <div class="repo-tab-content" role="tabpanel">${tabs[state.activeTab][1]}</div>
      <div class="repo-source"><span class="source-check">●</span> LIVE SOURCE · GitHub REST API <span>→</span> MCP SERVER <span class="repo-source-time">· fetched ${formatDate(state.repository.fetched_at)}</span><button class="export-button" type="button" data-export-repository>Download JSON ↧</button></div>
    </article>
    ${state.repository.warnings?.length ? `<div class="notice notice-error repo-warning">${state.repository.warnings.map(escapeHtml).join("<br>")}</div>` : ""}`;
  hydrateDiagrams();
}

async function loadRepository(fullName) {
  const parts = fullName.trim().split("/");
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))) {
    showToast("Enter a repository as owner/name, such as facebook/react.");
    return;
  }
  byId("repo-empty").hidden = true;
  byId("repo-error").hidden = true;
  byId("repo-content").hidden = true;
  byId("repo-loading").hidden = false;
  state.repository = null;
  state.insights = null;
  state.insightsError = null;
  state.insightsLoading = false;
  state.activeTab = "overview";
  try {
    const data = await apiRequest(`/api/repository/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`);
    state.repository = data;
    byId("repo-loading").hidden = true;
    byId("repo-content").hidden = false;
    renderRepositoryTab();
    byId("github-status").textContent = "Connected · live GitHub data";
  } catch (error) {
    byId("repo-loading").hidden = true;
    byId("repo-error").textContent = error.message;
    byId("repo-error").hidden = false;
  }
}

function renderArchitecture(layers) {
  const map = byId("architecture-map");
  map.innerHTML = layers.map((layer, index) => `
    ${index ? '<span class="architecture-connector" aria-hidden="true">→</span>' : ""}
    <button class="architecture-node ${index === 0 ? "selected" : ""}" type="button" data-layer="${escapeHtml(layer.id)}" aria-pressed="${index === 0}">
      <span class="architecture-node-top"><span class="architecture-node-number">0${index + 1}</span><span class="architecture-node-title">${escapeHtml(layer.title)}</span></span>
      <span class="architecture-node-tech">${escapeHtml(layer.technology)}</span>
    </button>`).join("");
  const first = layers[0];
  map.insertAdjacentHTML("afterend", `
    <div class="architecture-explainer" id="architecture-explainer">
      <div><strong>${escapeHtml(first.title)}</strong><span>${escapeHtml(first.detail)}</span></div>
      <span class="architecture-hint">SELECT A LAYER TO EXPLORE</span>
    </div>`);
}

function downloadRepositoryReport() {
  if (!state.repository) return;
  const encoded = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      source: "GitHub REST API through the DevPulse MCP server",
      ...state.repository,
    },
    null,
    2,
  );
  const file = new Blob([encoded], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.repository.repository.full_name.replace("/", "-")}-devpulse-report.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Repository report downloaded as JSON.");
}

function renderComparison(repositories) {
  const first = repositories[0].repository;
  const second = repositories[1].repository;
  const metrics = [
    ["Stars", "stars"],
    ["Forks", "forks"],
    ["Open issues", "open_issues"],
    ["Watchers", "watchers"],
  ];
  const maximumFor = (key) => Math.max(first[key] || 0, second[key] || 0, 1);
  const renderMetric = ([label, key]) => {
    const firstValue = first[key] || 0;
    const secondValue = second[key] || 0;
    const maximum = maximumFor(key);
    return `
      <div class="compare-metric">
        <span class="compare-metric-label">${label}</span>
        <span class="compare-metric-side">
          <span class="compare-metric-value ${firstValue >= secondValue ? "winner" : ""}">${formatCount(firstValue)}</span>
          <span class="compare-bar-track"><span class="compare-bar" style="width:${Math.max(firstValue / maximum * 100, 2)}%"></span></span>
        </span>
        <span class="compare-vs-mark">·</span>
        <span class="compare-metric-side">
          <span class="compare-metric-value ${secondValue > firstValue ? "winner" : ""}">${formatCount(secondValue)}</span>
          <span class="compare-bar-track"><span class="compare-bar second" style="width:${Math.max(secondValue / maximum * 100, 2)}%"></span></span>
        </span>
      </div>`;
  };
  byId("compare-results").innerHTML = `
    <article class="compare-card">
      <div class="compare-two-header">
        <span class="compare-header-label">LIVE METRIC</span>
        <div class="compare-repo-heading"><img src="${escapeHtml(first.avatar_url)}" alt="" loading="lazy"><div><strong>${escapeHtml(first.full_name)}</strong><span>${escapeHtml(first.language || "Language n/a")}</span></div></div>
        <span class="compare-header-versus">VS</span>
        <div class="compare-repo-heading"><img src="${escapeHtml(second.avatar_url)}" alt="" loading="lazy"><div><strong>${escapeHtml(second.full_name)}</strong><span>${escapeHtml(second.language || "Language n/a")}</span></div></div>
      </div>
      ${metrics.map(renderMetric).join("")}
      <div class="compare-metric">
        <span class="compare-metric-label">Updated</span>
        <span class="compare-meta-value">${formatDate(first.updated_at)}</span><span class="compare-vs-mark">·</span><span class="compare-meta-value">${formatDate(second.updated_at)}</span>
      </div>
      <div class="compare-metric">
        <span class="compare-metric-label">Last push</span>
        <span class="compare-meta-value">${relativeDate(first.pushed_at)}</span><span class="compare-vs-mark">·</span><span class="compare-meta-value">${relativeDate(second.pushed_at)}</span>
      </div>
      <div class="compare-metric">
        <span class="compare-metric-label">License</span>
        <span class="compare-meta-value">${escapeHtml(first.license || "Not listed")}</span><span class="compare-vs-mark">·</span><span class="compare-meta-value">${escapeHtml(second.license || "Not listed")}</span>
      </div>
      <div class="compare-legend"><span><i class="compare-dot"></i>${escapeHtml(first.full_name)}</span><span><i class="compare-dot second"></i>${escapeHtml(second.full_name)}</span><span>Bar scale is relative within each metric · live via MCP</span></div>
    </article>`;
}

async function addHealthRows(repositories) {
  const card = $(".compare-card", byId("compare-results"));
  if (!card) return;
  try {
    const results = await Promise.all(repositories.map((item) => {
      const [owner, name] = item.repository.full_name.split("/");
      return apiRequest(`/api/repository/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/insights`);
    }));
    if (!card.isConnected) return;
    const side = (value, other, second) => `
      <span class="compare-metric-side">
        <span class="compare-metric-value ${value != null && (second ? value > (other ?? -1) : value >= (other ?? -1)) ? "winner" : ""}">${value == null ? "n/a" : value}</span>
        <span class="compare-bar-track"><span class="compare-bar ${second ? "second" : ""}" style="width:${Math.max(value ?? 0, 2)}%"></span></span>
      </span>`;
    const row = (label, a, b) => `
      <div class="compare-metric"><span class="compare-metric-label">${label}</span>
        ${side(a, b, false)}<span class="compare-vs-mark">·</span>${side(b, a, true)}</div>`;
    const scores = results.map((item) => item.get_repo_health?.score ?? null);
    const ci = results.map((item) => item.get_ci_status?.pass_rate ?? null);
    $(".compare-legend", card)?.insertAdjacentHTML("beforebegin",
      row("Health score", scores[0], scores[1]) + row("CI pass %", ci[0], ci[1]));
  } catch (error) {
    // Health rows are an enhancement; the core comparison stays visible.
  }
}

async function compareRepositories(first, second) {
  byId("compare-error").hidden = true;
  byId("compare-results").innerHTML = '<div class="loading-card"><span class="spinner"></span><span>Fetching both repositories in parallel through MCP…</span></div>';
  const button = byId("compare-button");
  button.disabled = true;
  button.textContent = "Comparing…";
  try {
    const result = await apiRequest("/api/compare", {
      method: "POST",
      body: JSON.stringify({ first, second }),
    });
    renderComparison(result.repositories);
    addHealthRows(result.repositories);
  } catch (error) {
    byId("compare-results").innerHTML = "";
    byId("compare-error").textContent = error.message;
    byId("compare-error").hidden = false;
  } finally {
    button.disabled = false;
    button.innerHTML = "Compare <span>↗</span>";
  }
}

async function loadAgentRoster() {
  try {
    const card = await apiRequest("/api/agent-card");
    byId("agent-roster").innerHTML = `
      <div class="tab-heading"><strong>Agent skills published on the A2A card</strong><span>v${escapeHtml(card.version)}</span></div>
      <div class="topic-list">${card.skills.map((skill) =>
        `<span class="topic-chip" title="${escapeHtml(skill.description)}">${escapeHtml(skill.id)}</span>`).join("")}</div>`;
  } catch (error) {
    byId("agent-roster").innerHTML = "";
  }
}

async function loadArchitecture() {
  try {
    const data = await apiRequest("/api/architecture");
    renderArchitecture(data.layers);
  } catch (error) {
    byId("architecture-map").innerHTML = `<div class="notice notice-error">${escapeHtml(error.message)}</div>`;
  }
}

function appendChatBubble(text, role = "assistant", isError = false, meta = null, openExplain = false) {
  const messages = byId("chat-messages");
  $(".chat-welcome", messages)?.remove();
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}${isError ? " error" : ""}`;
  if (role === "assistant" && !isError) {
    bubble.classList.add("md");
    bubble.innerHTML = renderMarkdown(normalizeAnswer(text));
  } else {
    bubble.textContent = text;
  }
  if (role === "assistant" && !isError && meta) messages.append(buildFlowStrip(meta.trace || []));
  messages.append(bubble);
  if (role === "assistant" && !isError) {
    renderAnswerExtras(messages, meta);
    const repositories = new Set();
    for (const step of meta?.trace || []) {
      const { owner, repo } = step.arguments || {};
      if (owner && repo) repositories.add(`${owner}/${repo}`);
    }
    for (const match of text.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]{1,39})\/([A-Za-z0-9_.-]{1,100})/gi)) {
      repositories.add(`${match[1]}/${match[2].replace(/[?#].*$/, "")}`);
    }
    for (const fullName of [...repositories].slice(0, 3)) {
      if (/^(?:api|docs|owner|repository|repo|your|the|this|that|example|github|orgs|topics|features)$/i.test(fullName.split("/")[0])) continue;
      const [owner, repository] = fullName.split("/");
      const card = document.createElement("a");
      card.className = "chat-diagram-card";
      card.href = `https://gitdiagram.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      card.target = "_blank";
      card.rel = "noreferrer";
      card.innerHTML = `<span class="diagram-card-icon" aria-hidden="true">⌘</span><span><strong>${escapeHtml(fullName)} · architecture map</strong><small>Open interactive repository diagram on GitDiagram</small></span><span aria-hidden="true">↗</span>`;
      messages.append(card);
    }
  }
  if (!meta) messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function scrollToAnswer(bubble) {
  const messages = byId("chat-messages");
  const anchor = bubble.previousElementSibling?.classList.contains("flow-strip") ? bubble.previousElementSibling : bubble;
  const offset = anchor.getBoundingClientRect().top - messages.getBoundingClientRect().top + messages.scrollTop - 12;
  messages.scrollTop = Math.max(offset, 0);
}

function syncHistory() {
  state.history = (currentThread()?.messages || [])
    .filter((message) => ["user", "assistant"].includes(message.role))
    .slice(-20)
    .map(({ role, content }) => ({ role, content }));
}

const CHAT_STORAGE_KEY = "devpulse.chat.v1";

function currentThread() {
  return state.chatThreads.find((thread) => thread.id === state.activeThreadId);
}

function saveChatThreads() {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
      activeThreadId: state.activeThreadId,
      threads: state.chatThreads,
    }));
  } catch (error) {
    showToast(`Could not save chat history in this browser: ${error.message}`);
  }
}

function renderThreadList() {
  const list = byId("chat-threads");
  if (!list) return;
  list.replaceChildren();
  for (const thread of [...state.chatThreads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const item = document.createElement("button");
    item.className = `chat-thread ${thread.id === state.activeThreadId ? "active" : ""}`;
    item.type = "button";
    item.dataset.chatThread = thread.id;
    item.textContent = thread.title;
    list.append(item);
  }
}

function renderConversation() {
  const messages = byId("chat-messages");
  const thread = currentThread();
  messages.replaceChildren();
  state.history = (thread?.messages || [])
    .filter((message) => ["user", "assistant"].includes(message.role))
    .slice(-20)
    .map(({ role, content }) => ({ role, content }));
  if (!thread?.messages.length) {
    messages.innerHTML = `<div class="chat-welcome"><span class="chat-welcome-star">✳</span><strong>Hi, I'm DevPulse.</strong><p>Name a GitHub repository as <code>owner/name</code> and I will pick the right tools, ask your approval, read live data, and explain it in plain English with small charts.</p><div class="prompt-label">TRY ONE</div><div class="suggestion-list prompt-grid"><button type="button" data-prompt="How healthy is facebook/react and is its CI passing?"><small>Health</small>How healthy is facebook/react and is its CI passing?</button><button type="button" data-prompt="Is vuejs/core production ready?"><small>Production check</small>Is vuejs/core production ready?</button><button type="button" data-prompt="Which languages is microsoft/vscode written in?"><small>Languages</small>Which languages is microsoft/vscode written in?</button><button type="button" data-prompt="Compare facebook/react and vuejs/core"><small>Compare</small>Compare facebook/react and vuejs/core</button></div><p class="welcome-hint">See every tool and a prompt for each in the <strong>What I can do</strong> panel.</p></div>`;
  } else {
    let lastBubble = null;
    thread.messages.forEach((message) => {
      try {
        lastBubble = appendChatBubble(message.content, message.role, false, message.meta);
      } catch (error) {
        lastBubble = appendChatBubble(message.content, message.role);
      }
    });
    const lastMessage = thread.messages[thread.messages.length - 1];
    if (lastMessage.role === "assistant" && lastBubble) scrollToAnswer(lastBubble);
    else messages.scrollTop = messages.scrollHeight;
  }
  renderThreadList();
}

function addChatMessage(role, content, meta = null) {
  const thread = currentThread();
  if (!thread) return;
  thread.messages.push({ role, content, createdAt: Date.now(), ...(meta ? { meta } : {}) });
  thread.updatedAt = Date.now();
  if (role === "user" && thread.title === "New conversation") {
    thread.title = content.slice(0, 48) + (content.length > 48 ? "…" : "");
  }
  saveChatThreads();
  syncHistory();
  const messages = byId("chat-messages");
  messages.querySelectorAll(".explain-card[open]").forEach((card) => { card.open = false; });
  let bubble;
  try {
    bubble = appendChatBubble(content, role, false, meta);
  } catch (error) {
    bubble = appendChatBubble(content, role);
  }
  if (role === "assistant") scrollToAnswer(bubble);
  else messages.scrollTop = messages.scrollHeight;
  renderThreadList();
}

function startNewConversation() {
  const id = crypto.randomUUID();
  state.chatThreads.push({ id, title: "New conversation", updatedAt: Date.now(), messages: [] });
  state.activeThreadId = id;
  saveChatThreads();
  renderConversation();
  byId("chat-input")?.focus();
}

function initializeChatPage() {
  try {
    const saved = localStorage.getItem(CHAT_STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      if (Array.isArray(data.threads)) {
        state.chatThreads = data.threads.filter((thread) =>
          typeof thread.id === "string"
          && typeof thread.title === "string"
          && Array.isArray(thread.messages)
          && thread.messages.every((message) =>
            ["user", "assistant"].includes(message.role) && typeof message.content === "string"));
      }
      state.activeThreadId = state.chatThreads.some((thread) => thread.id === data.activeThreadId)
        ? data.activeThreadId
        : state.chatThreads[0]?.id || null;
    }
  } catch (error) {
    showToast(`Could not load saved chat history: ${error.message}`);
  }
  if (!currentThread()) startNewConversation();
  else renderConversation();

  byId("new-chat").addEventListener("click", startNewConversation);
  byId("clear-chat").addEventListener("click", () => {
    state.chatThreads = [];
    state.activeThreadId = null;
    startNewConversation();
    showToast("Chat history cleared from this browser.");
  });
}

function renderApproval(data) {
  hideThinking();
  const card = document.createElement("div");
  card.className = "approval-card";
  const calls = data.calls.map((call) => {
    const args = Object.entries(call.arguments || {}).map(([key, value]) =>
      `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    return `<div class="approval-call">
      <h4>${escapeHtml(call.title || call.name)} <code>${escapeHtml(call.name)}</code></h4>
      <p>${escapeHtml(call.what || call.description || "")}</p>
      ${args ? `<dl class="approval-args-list">${args}</dl>` : ""}
      <small>Data source: ${escapeHtml(call.source || "GitHub API")}</small>
    </div>`;
  }).join("");
  card.innerHTML = `
    <div class="approval-kicker">YOUR APPROVAL NEEDED · NOTHING HAS RUN YET</div>
    <p class="approval-intro">${data.source === "router" ? "DevPulse matched your question to these tools." : "The assistant wants to read live data from GitHub."} They are read-only and change nothing.</p>
    ${calls}
    <div class="approval-actions"><button class="approve-button" type="button" data-approval="yes">Approve and run</button><button class="reject-button" type="button" data-approval="no">Decline</button></div>`;
  card.dataset.approvalId = data.approval_id;
  byId("chat-messages").append(card);
  byId("chat-messages").scrollTop = byId("chat-messages").scrollHeight;
  setChatBusy(false, true);
}

function setChatBusy(busy, waitingForApproval = false) {
  state.busy = busy;
  byId("chat-send").disabled = busy || waitingForApproval;
  byId("chat-input").disabled = busy || waitingForApproval;
  byId("new-chat").disabled = busy || waitingForApproval;
  byId("clear-chat").disabled = busy || waitingForApproval;
  document.querySelectorAll("[data-chat-thread]").forEach((button) => {
    button.disabled = busy || waitingForApproval;
  });
  if (!waitingForApproval) byId("chat-send").textContent = busy ? "…" : "↑";
}

async function handleChatResponse(data) {
  hideThinking();
  if (data.status === "approval_required") {
    renderApproval(data);
    return;
  }
  if (Array.isArray(data.history)) state.history = data.history;
  addChatMessage("assistant", data.answer || "The model returned an empty response.", {
    trace: data.trace || [],
    visuals: data.visuals || [],
  });
  setChatBusy(false);
}

async function sendChatMessage(message) {
  if (state.busy || !message.trim()) return;
  if (!currentThread()) startNewConversation();
  const history = state.history;
  setChatBusy(true);
  addChatMessage("user", message);
  showThinking("Thinking about which live data is needed…");
  byId("chat-input").value = "";
  try {
    const data = await apiRequest("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, history }),
    });
    await handleChatResponse(data);
  } catch (error) {
    hideThinking();
    appendChatBubble(error.message, "assistant", true);
    setChatBusy(false);
  }
}

async function resolveApproval(button) {
  if (state.busy) return;
  const card = button.closest(".approval-card");
  if (!card) return;
  const approvalId = card.dataset.approvalId;
  const approve = button.dataset.approval === "yes";
  const actions = $(".approval-actions", card);
  actions.innerHTML = '<span class="spinner" aria-label="Resolving approval"></span>';
  setChatBusy(true, true);
  showThinking(approve ? "Reading live data from GitHub through MCP…" : "Writing an answer without the tool…");
  try {
    const data = await apiRequest("/api/chat/approval", {
      method: "POST",
      body: JSON.stringify({ approval_id: approvalId, approved: approve }),
    });
    card.remove();
    if (!approve) showToast("Tool declined. The assistant has been told it was not run.");
    else showToast("Approved. MCP is now fetching live GitHub data.");
    await handleChatResponse(data);
  } catch (error) {
    card.remove();
    hideThinking();
    appendChatBubble(error.message, "assistant", true);
    setChatBusy(false);
  }
}

function wireEvents() {
  byId("search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = byId("search-input").value.trim();
    if (query.length >= 2) searchRepositories(query);
  });
  byId("compare-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    compareRepositories(byId("compare-first").value, byId("compare-second").value);
  });

  document.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-repo]");
    if (target) {
      const name = target.dataset.repo;
      loadRepository(name);
      byId("repo-content")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const tab = event.target.closest?.("[data-tab]");
    if (tab) {
      state.activeTab = tab.dataset.tab;
      renderRepositoryTab();
      if (state.activeTab === "health" && !state.insights && !state.insightsLoading) loadInsights();
    }
    if (event.target.closest?.("[data-export-repository]")) downloadRepositoryReport();
    const layer = event.target.closest?.("[data-layer]");
    if (layer) {
      const allLayers = [...document.querySelectorAll("[data-layer]")];
      for (const item of allLayers) {
        const selected = item === layer;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      }
      apiRequest("/api/architecture").then((data) => {
        const selectedLayer = data.layers.find((item) => item.id === layer.dataset.layer);
        if (selectedLayer) {
          byId("architecture-explainer").innerHTML = `
            <div><strong>${escapeHtml(selectedLayer.title)}</strong><span>${escapeHtml(selectedLayer.detail)}</span></div>
            <span class="architecture-hint">${escapeHtml(selectedLayer.technology.toUpperCase())}</span>`;
        }
      }).catch((error) => showToast(error.message));
    }
    const approval = event.target.closest?.("[data-approval]");
    if (approval) resolveApproval(approval);
    const promptButton = event.target.closest?.("[data-prompt]");
    if (promptButton) {
      document.querySelector(".chat-layout")?.classList.remove("caps-open");
      sendChatMessage(promptButton.dataset.prompt);
    }
    const thread = event.target.closest?.("[data-chat-thread]");
    if (thread && !state.busy) {
      state.activeThreadId = thread.dataset.chatThread;
      saveChatThreads();
      renderConversation();
    }
  });

  byId("chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChatMessage(byId("chat-input").value);
  });
  byId("chat-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      byId("chat-form").requestSubmit();
    }
  });
}

const VISUAL_RENDERERS = {
  get_repo_health: renderHealthBlock,
  get_language_breakdown: renderLanguageBlock,
  get_commit_activity: renderActivityBlock,
  get_ci_status: renderCiBlock,
};

wireEvents();
loadHealth();
if (byId("diagram-view")) initDiagramPanel();
if (byId("architecture-map")) loadArchitecture();
if (byId("agent-roster")) loadAgentRoster();
if (byId("chat-form")) initializeChatPage();
if (byId("caps-list")) {
  loadCapabilities();
  wireCapsToggle();
}
