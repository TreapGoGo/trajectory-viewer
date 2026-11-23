import { eventPages, failureType, filterEvents, runPath, searchPrompts } from "./trajectory-tools.js";

const byId = (id) => document.getElementById(id);
const state = {
  accountVersion: 0, listVersion: 0, detailVersion: 0,
  cursor: "", filters: "", listRequest: null,
  timeline: null, selected: null, runs: new Map(),
};
const friendly = {
  "run.accepted": "Execution accepted",
  "run.finished": "Execution finished",
  "span.started": "Step started",
  "span.finished": "Step finished",
  "span.failed": "Step failed",
  "model.requested": "Model request",
  "model.responded": "Model response",
  "model.failed": "Model request failed",
  "tool.requested": "Tool requested",
  "tool.started": "Tool started",
  "tool.result.raw": "Tool result",
  "tool.finished": "Tool finished",
  "card.event.accepted": "Card action accepted",
  "ui.event": "Interface event",
  "execution.observed": "Execution observation",
  "activity.related": "Related activity",
  "business.summary": "Outcome summary",
  "delivery.expected": "Delivery expected",
  "delivery.failed": "Delivery failed",
  "confirmation.requested": "Confirmation requested",
  "confirmation.finished": "Confirmation finished",
};
const eventsPerPage = 100;
const fullDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium", timeStyle: "medium",
});

function time(value) {
  return Number.isFinite(value) ? fullDate.format(value) : "—";
}
function label(value) {
  const result = String(value ?? "").replace(/[_.-]+/g, " ");
  return result ? result[0].toUpperCase() + result.slice(1) : "Unknown";
}
function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function button(value, callback) {
  const element = node("button", value, "quiet");
  element.type = "button";
  element.addEventListener("click", callback);
  return element;
}
function message(id, text, error = false) {
  const target = byId(id);
  target.textContent = text;
  target.classList.toggle("error", error);
}
function tags(row) {
  const wrap = node("div", undefined, "tags");
  const execution = row.execution_state;
  wrap.append(node("span", label(execution), "tag " +
    (execution === "succeeded" ? "good" : execution === "failed" ? "bad" : "")));
  const integrity = row.integrity;
  wrap.append(node("span", integrity === "incomplete" ? "Archive incomplete" :
    integrity === "complete" ? "Archive complete" : "Integrity unknown",
    "tag " + (integrity === "incomplete" ? "warn" : "")));
  if (row.terminal_conflict) wrap.append(node("span", "Conflicting finish events", "tag warn"));
  return wrap;
}
function codeBlock(value) {
  return node("pre", typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function api(path, data, signal) {
  const generation = state.accountVersion;
  const url = new URL("./api" + path, import.meta.url);
  const response = await fetch(url, data === undefined ? { signal } : {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (generation === state.accountVersion && response.status === 401 &&
        !["/login", "/session"].includes(path)) showSignIn(true);
    const error = new Error(value?.error || "The request failed.");
    error.status = response.status;
    throw error;
  }
  return value;
}
function resetDetail() {
  state.detailVersion++;
  state.timeline?.request.abort();
  state.timeline = null;
  state.selected = null;
  byId("detail").hidden = true;
  for (const id of ["summary", "related", "failures", "events"]) byId(id).replaceChildren();
  for (const id of ["previous-events", "more-events", "retry-events", "failures"]) byId(id).hidden = true;
  byId("event-type").value = "";
  byId("event-tool").replaceChildren(new Option("All tools", ""));
  message("timeline-status", "");
  message("detail-status", "Select a trajectory to view its events.");
}
function showSignIn(expired = false) {
  state.accountVersion++;
  state.listVersion++;
  state.listRequest?.abort();
  state.listRequest = null;
  byId("stop-search").hidden = true;
  byId("filters").reset();
  message("list-status", "");
  state.runs.clear();
  byId("runs").replaceChildren();
  resetDetail();
  byId("account-name").textContent = "";
  byId("workspace").hidden = true;
  byId("account").hidden = true;
  byId("signin").hidden = false;
  byId("login-error").hidden = !expired;
  message("login-error", expired ? "Your sign-in expired. Sign in again." : "", true);
}
function showAccount(account) {
  state.accountVersion++;
  byId("account-name").textContent = account.name || "Tuple account";
  byId("signin").hidden = true;
  byId("workspace").hidden = false;
  byId("account").hidden = false;
  byId("filters").reset();
  void loadRuns();
}

async function loadRuns(append = false) {
  const version = ++state.listVersion;
  state.listRequest?.abort();
  const request = new AbortController();
  state.listRequest = request;
  const read = (path) => api(path, undefined, request.signal);
  const more = byId("more-runs"), stop = byId("stop-search");
  more.disabled = true;
  stop.hidden = true;
  if (!append) {
    state.cursor = "";
    state.runs.clear();
    byId("runs").replaceChildren();
    more.hidden = true;
    resetDetail();
  }
  message("list-status", "Loading trajectories…");
  try {
    if (!append) {
      const form = new FormData(byId("filters"));
      state.filters = archiveFilters(form);
      const prompt = form.get("prompt").trim();
      if (prompt) {
        stop.hidden = false;
        await loadPromptResults(read, version, prompt, form.get("role"));
        return;
      }
    }
    const search = new URLSearchParams(state.filters);
    if (append && state.cursor) search.set("cursor", state.cursor);
    const result = await read("/trajectories?" + search);
    if (version !== state.listVersion) return;
    for (const row of result.items) appendRun(row);
    state.cursor = result.has_more ? result.next_cursor : "";
    more.hidden = !state.cursor;
    message("list-status", state.runs.size ? "" : "No cloud trajectories match these filters.");
    if (!append && state.runs.size) void openRun(state.runs.keys().next().value);
  } catch (error) {
    if (version === state.listVersion) message("list-status", error.message, true);
  } finally {
    if (version === state.listVersion) {
      more.disabled = false;
      stop.hidden = true;
      state.listRequest = null;
    }
  }
}

function archiveFilters(form) {
  const status = form.get("status"), invocation = form.get("invocation_id").trim();
  const from = form.get("from"), through = form.get("through");
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (invocation) query.set("invocation_id", invocation);
  if (from && through && from > through) throw new Error("The start date must be on or before the end date.");
  if (from) query.set("from_at_ms", new Date(from + "T00:00:00").getTime());
  if (through) {
    const end = new Date(through + "T00:00:00");
    end.setDate(end.getDate() + 1);
    query.set("to_at_ms", end.getTime() - 1);
  }
  return query.toString();
}

async function loadPromptResults(read, version, prompt, role) {
  let scanned = 0, limited = 0;
  const counts = () => {
    const matches = state.runs.size;
    const coverage = limited ? " Prompt coverage was limited in " + limited +
      (limited === 1 ? " trajectory." : " trajectories.") : "";
    return matches + (matches === 1 ? " match" : " matches") + " across " + scanned +
      (scanned === 1 ? " trajectory checked." : " trajectories checked.") + coverage;
  };
  message("list-status", "Searching archived prompts…");
  try {
    for await (const batch of searchPrompts(read, state.filters, prompt, role)) {
      if (version !== state.listVersion) return;
      for (const result of batch) {
        scanned++;
        if (result.limited) limited++;
        if (result.hit) appendRun(result.row, result.hit);
      }
      message("list-status", "Searching… " + counts());
    }
    if (version === state.listVersion) message("list-status", counts());
  } catch (error) {
    if (version !== state.listVersion) return;
    if (error.name === "AbortError") {
      message("list-status", "Search stopped. " + counts());
    } else {
      message("list-status", "Search incomplete. " + counts() + " " + error.message, true);
    }
  }
}

function appendRun(row, hit) {
  const run = row.run;
  if (state.runs.has(run.id)) return;
  const item = node("li"), control = node("button", undefined, "run");
  control.type = "button";
  control.setAttribute("aria-current", String(state.selected === run.id));
  control.append(node("span", label(run.operation), "run-title"),
    node("span", time(run.started_at_ms), "run-time"), tags(row));
  if (hit) {
    const snippet = node("span", undefined, "prompt-snippet");
    snippet.append(hit.before, node("mark", hit.text), hit.after);
    control.append(node("span", label(hit.role) + " prompt · #" + hit.seq, "meta"), snippet);
  }
  control.addEventListener("click", () => void openRun(run.id, hit?.seq));
  item.append(control);
  byId("runs").append(item);
  state.runs.set(run.id, control);
}

function renderSummary(detail) {
  const run = detail.run;
  const facts = node("dl", undefined, "facts");
  const pairs = [
    ["Started", time(run.started_at_ms)],
    ["Entry point", run.source ? label(run.source) : "—"],
    ["Invocation ID", run.invocation_id || "—"],
    ["Trajectory ID", run.id],
    ["Agent ID", run.agent_uid || "—"],
    ["Declared events", run.declared_last_seq],
  ];
  for (const [name, value] of pairs) {
    const fact = node("div");
    fact.append(node("dt", name), node("dd", value));
    facts.append(fact);
  }
  byId("summary").replaceChildren(node("h2", label(run.operation)), tags(detail), facts);
  if (run.parent_id) byId("related").append(button("Parent trajectory", () => void openRun(run.parent_id)));
}
function renderChildren(detail, version) {
  const related = byId("related");
  byId("more-children")?.remove();
  for (const child of detail.children || []) {
    related.append(button("Child · " + child.slice(0, 8), () => void openRun(child)));
  }
  if (detail.has_more_children && detail.next_child_cursor) {
    const control = button("More child trajectories", async () => {
      control.disabled = true;
      try {
        const query = new URLSearchParams({
          children_after: detail.next_child_cursor,
          snapshot_seq: String(detail.snapshot_seq),
        });
        const result = await api(runPath(state.selected) + "?" + query);
        if (version === state.detailVersion) renderChildren(result, version);
      } catch (error) {
        if (version === state.detailVersion) {
          message("detail-status", error.message, true);
          control.disabled = false;
        }
      }
    });
    control.id = "more-children";
    related.append(control);
  }
}

async function openRun(id, targetSeq) {
  resetDetail();
  const version = state.detailVersion;
  state.selected = id;
  const request = new AbortController();
  const timeline = {
    request, runID: id, events: [], rows: new Map(), tools: new Set(),
    next: 0, page: 0, loading: false, targetSeq, failedRun: false, specificFailure: false,
  };
  state.timeline = timeline;
  for (const [runId, control] of state.runs) {
    control.setAttribute("aria-current", String(runId === id));
  }
  message("detail-status", "Loading trajectory…");
  try {
    const detail = await api(runPath(id), undefined, request.signal);
    if (version !== state.detailVersion) return;
    renderSummary(detail);
    renderChildren(detail, version);
    timeline.failedRun = detail.execution_state === "failed";
    byId("detail").hidden = false;
    message("detail-status", "");
    await loadTimeline();
  } catch (error) {
    if (version === state.detailVersion) message("detail-status", error.message, true);
  }
}
function eventTitle(event) {
  const meta = event.metadata ?? {};
  const stage = meta.tool_name || (event.kind.startsWith("span.") ? meta.operation : meta.purpose);
  return (friendly[event.kind] || label(event.kind)) + (typeof stage === "string" && stage ? " · " + stage : "");
}

function eventRow(event, timeline) {
  const kind = failureType(event);
  const row = node("li", undefined, kind ? "event event-failed" : "event");
  const details = node("details"), summary = node("summary");
  summary.append(node("span", event.seq, "event-number"),
    node("strong", eventTitle(event)),
    node("span", time(event.at_ms), "event-time"));
  if (kind) summary.append(node("span", kind === "run" ? "Run failed" : "Failure", "tag bad"));
  const content = node("div", undefined, "event-body");
  const meta = node("p", event.kind + (event.span_id ? " · " + event.span_id : ""), "meta");
  content.append(meta);
  if (event.metadata && Object.keys(event.metadata).length) content.append(codeBlock(event.metadata));
  if (event.incomplete) content.append(node("p", "Some event content was unavailable or omitted."));
  if (event.payload_id) {
    const control = button("Load archived content", async () => {
      control.disabled = true;
      try {
        const result = await api(runPath(timeline.runID) + "/payloads/" + encodeURIComponent(event.payload_id),
          undefined, timeline.request.signal);
        if (timeline !== state.timeline) return;
        content.querySelector(".error")?.remove();
        control.replaceWith(codeBlock(result.payload?.value));
      } catch (error) {
        if (timeline !== state.timeline) return;
        control.textContent = "Retry archived content";
        const notice = node("p", error.message, "error");
        content.querySelector(".error")?.remove();
        content.append(notice);
      } finally {
        control.disabled = false;
      }
    });
    content.append(control);
  }
  details.append(summary, content);
  row.append(details);
  return row;
}
function collectTimelineEvents(timeline, events) {
  const previousToolCount = timeline.tools.size;
  const failures = byId("failures");
  for (const event of events) {
    const tool = event.metadata?.tool_name;
    if (typeof tool === "string" && tool) timeline.tools.add(tool);
    const kind = failureType(event);
    if (!kind) continue;
    if (kind === "step") timeline.specificFailure = true;
    if (kind === "run") timeline.failedRun = true;
    if (failures.hidden) {
      failures.append(node("h2", "Failure events"), node("ul"));
      failures.hidden = false;
    }
    const item = node("li");
    const title = kind === "run" ? "Run failed" : eventTitle(event);
    item.append(button("#" + event.seq + " · " + title + " · " + time(event.at_ms), () => jumpToEvent(event.seq)));
    failures.querySelector("ul").append(item);
  }
  if (timeline.tools.size !== previousToolCount) {
    const control = byId("event-tool");
    const selected = control.value;
    control.replaceChildren(new Option("All tools", ""),
      ...Array.from(timeline.tools).sort().map((tool) => new Option(tool, tool)));
    control.value = selected;
  }
  timeline.events.push(...events);
}

function renderTimeline() {
  const timeline = state.timeline;
  const filtered = filterEvents(timeline.events, byId("event-type").value, byId("event-tool").value);
  const start = timeline.page * eventsPerPage;
  const shown = filtered.slice(start, start + eventsPerPage);
  const rows = shown.map((event) => {
    if (!timeline.rows.has(event.seq)) timeline.rows.set(event.seq, eventRow(event, timeline));
    return timeline.rows.get(event.seq);
  });
  const list = byId("events");
  if (list.children.length !== rows.length || rows.some((row, index) => row !== list.children[index])) {
    list.replaceChildren(...rows);
  }
  byId("previous-events").hidden = timeline.page === 0;
  byId("more-events").hidden = start + shown.length >= filtered.length;
  const count = shown.length
    ? (start + 1) + "–" + (start + shown.length) + " of " + filtered.length + " matching events."
    : "No archived events match these filters.";
  const status = timeline.loading ? "Loading events… " : timeline.next !== null ? "Timeline partially loaded. " : "";
  const error = timeline.loadError ? " " + timeline.loadError : "";
  const missing = timeline.missingTarget ? " The matching event is no longer available." : "";
  message("timeline-status", status + count + error + missing, Boolean(error));
}

function jumpToEvent(seq) {
  const timeline = state.timeline;
  const index = timeline.events.findIndex((event) => event.seq === seq);
  if (index < 0) return false;
  byId("event-type").value = "";
  byId("event-tool").value = "";
  timeline.page = Math.floor(index / eventsPerPage);
  timeline.targetSeq = undefined;
  renderTimeline();
  const row = timeline.rows.get(seq);
  row.querySelector("details").open = true;
  row.querySelector("summary").focus({ preventScroll: true });
  row.scrollIntoView({ block: "center" });
  return true;
}

async function loadTimeline() {
  const timeline = state.timeline;
  if (!timeline || timeline.loading || timeline.next === null) return;
  timeline.loading = true;
  timeline.loadError = "";
  byId("retry-events").hidden = true;
  renderTimeline();
  try {
    const read = (path) => api(path, undefined, timeline.request.signal);
    for await (const page of eventPages(read, timeline.runID, timeline.next)) {
      if (timeline !== state.timeline) return;
      timeline.next = page.has_more ? page.next_seq : null;
      collectTimelineEvents(timeline, page.events);
      if (timeline.targetSeq === undefined || !jumpToEvent(timeline.targetSeq)) renderTimeline();
    }
    timeline.missingTarget = timeline.targetSeq !== undefined;
    if (timeline.failedRun && !timeline.specificFailure) {
      const failures = byId("failures");
      failures.hidden = false;
      failures.append(node("p", "The run failed. No specific failed step was recorded in the archive."));
    }
  } catch (error) {
    if (timeline !== state.timeline) return;
    timeline.loadError = error.message;
    byId("retry-events").hidden = false;
  } finally {
    if (timeline === state.timeline) {
      timeline.loading = false;
      renderTimeline();
    }
  }
}

byId("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget, submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  byId("login-error").hidden = true;
  try {
    const result = await api("/login", {
      email: form.elements.namedItem("email").value,
      password: form.elements.namedItem("password").value,
    });
    form.reset();
    showAccount(result);
  } catch (error) {
    byId("login-error").hidden = false;
    message("login-error", error.message, true);
  } finally {
    submit.disabled = false;
  }
});
byId("logout").addEventListener("click", async () => {
  const control = byId("logout");
  control.disabled = true;
  try {
    await api("/logout", {});
    showSignIn();
  } catch (error) {
    message("list-status", error.message, true);
  } finally {
    control.disabled = false;
  }
});
byId("filters").addEventListener("submit", (event) => { event.preventDefault(); void loadRuns(); });
byId("refresh").addEventListener("click", () => void loadRuns());
byId("more-runs").addEventListener("click", () => void loadRuns(true));
byId("stop-search").addEventListener("click", () => state.listRequest?.abort());
byId("retry-events").addEventListener("click", () => void loadTimeline());
for (const id of ["event-type", "event-tool"]) {
  byId(id).addEventListener("change", () => {
    state.timeline.page = 0;
    renderTimeline();
  });
}
for (const [id, delta] of [["previous-events", -1], ["more-events", 1]]) {
  byId(id).addEventListener("click", () => {
    state.timeline.page += delta;
    renderTimeline();
  });
}
api("/session").then(showAccount).catch(() => {});
