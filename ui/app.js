import {
  OPERATION_LABELS, SOURCE_LABELS, briefFromEvents, dayKey, digestBundle, failureType, formatDuration,
  formatTime, formatTokens, messageText, replyStatusInfo, resultHighlights, splitStructured, statusLabel,
} from "./digest.js";

// ---------------------------------------------------------------- basics
const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;
const state = {
  rows: [], byId: new Map(), briefs: new Map(), bundles: new Map(),
  cursor: "", hasMore: false, days: 3, rangeFrom: 0,
  selected: "", tab: "process", round: 1, turn: null,
  filter: "", showSystem: false, onlyFail: false,
  briefQueue: [], briefActive: 0, renderPending: false, liveTimer: 0, runningTimer: 0,
};

function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === "") continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function toast(text) {
  const element = $("toast");
  element.textContent = text;
  element.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("on"), 1600);
}

function copyButton(value, label = "复制") {
  const button = h("button", { class: "copy", type: "button", title: "复制", text: label });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
      button.classList.add("done");
      toast("已复制");
      setTimeout(() => button.classList.remove("done"), 1200);
    } catch {
      toast("复制失败");
    }
  });
  return button;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const response = await fetch("/api" + path, options);
  const text = await response.text();
  let value = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = null;
  }
  if (response.status === 401 && !["/session", "/login"].includes(path)) showSignIn();
  if (!response.ok) throw new HttpError(response.status, value?.error || `请求失败（${response.status}）`);
  return value;
}

// Text with [withheld:…] markers shown as badges.
function rich(text) {
  const value = String(text ?? "");
  const parts = value.split(/(\[withheld:[^\]]*\])/);
  if (parts.length === 1) return document.createTextNode(value);
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (/^\[withheld:/.test(part)) fragment.append(h("span", { class: "withheld", title: part, text: "已脱敏" }));
    else if (part) fragment.append(part);
  }
  return fragment;
}

function clampedText(text, className = "text") {
  const value = String(text ?? "");
  const body = h("div", { class: className }, rich(value));
  if (value.length < 420 && value.split("\n").length < 7) return body;
  body.classList.add("clamp");
  const toggle = h("button", { class: "expand", type: "button", text: `展开全部（${value.length} 字）` });
  toggle.addEventListener("click", () => {
    const open = body.classList.toggle("clamp");
    toggle.textContent = open ? `展开全部（${value.length} 字）` : "收起";
  });
  return h("div", {}, body, toggle);
}

// Lazily rendered, collapsible JSON tree.
function jsonView(value, open = 1) {
  const root = h("div", { class: "json" });
  root.append(jsonNode(null, value, 0, open));
  return root;
}
function jsonLeaf(value) {
  if (value === null) return h("span", { class: "j-null", text: "null" });
  switch (typeof value) {
    case "string": return h("span", { class: "j-str" }, '"', rich(value), '"');
    case "number": return h("span", { class: "j-num", text: String(value) });
    case "boolean": return h("span", { class: "j-bool", text: String(value) });
    default: return h("span", { class: "j-null", text: String(value) });
  }
}
function jsonNode(key, value, depth, open) {
  const keyLabel = key === null ? null : h("span", { class: "j-key", text: `${key}: ` });
  if (!value || typeof value !== "object") return h("div", { class: "row-line" }, keyLabel, jsonLeaf(value));
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  const meta = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  const preview = entries.slice(0, 4).map(([k, v]) => (Array.isArray(value) ? "" : `${k}: `) + (v && typeof v === "object" ? (Array.isArray(v) ? "[…]" : "{…}") : JSON.stringify(v)?.slice(0, 40))).join(", ");
  const details = h("details", {}, h("summary", {}, keyLabel, h("span", { class: "j-meta", text: `${meta} ${preview}${entries.length > 4 ? ", …" : ""}` })));
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    for (const [k, v] of entries) details.append(jsonNode(k, v, depth + 1, open));
  };
  details.addEventListener("toggle", () => details.open && fill());
  if (depth < open && entries.length <= 60) {
    details.open = true;
    fill();
  }
  return details;
}

function fold(label, build) {
  const details = h("details", { class: "fold" }, h("summary", { text: label }));
  let built = false;
  details.addEventListener("toggle", () => {
    if (details.open && !built) {
      built = true;
      details.append(build());
    }
  });
  return details;
}

function valueText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- routing
function readHash() {
  const match = /^#\/run\/([^?]+)(?:\?(.*))?$/.exec(location.hash);
  if (!match) return null;
  const params = new URLSearchParams(match[2] || "");
  return { id: decodeURIComponent(match[1]), tab: params.get("tab") || "process", round: Number(params.get("round") || 1) };
}
function writeHash(replace = false) {
  const params = new URLSearchParams();
  if (state.tab !== "process") params.set("tab", state.tab);
  if (state.tab === "context" && state.round > 1) params.set("round", String(state.round));
  const hash = `#/run/${encodeURIComponent(state.selected)}${params.size ? "?" + params : ""}`;
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
}
window.addEventListener("hashchange", () => {
  const route = readHash();
  if (!route) return;
  const changedRun = route.id !== state.selected;
  state.tab = route.tab;
  state.round = route.round;
  if (changedRun) void openRun(route.id, { fromHash: true });
  else renderTurn();
});

// ---------------------------------------------------------------- account
function showSignIn() {
  $("booting").hidden = true;
  $("workspace").hidden = true;
  $("account").hidden = true;
  $("signin").hidden = false;
  stopLive();
}
$("signin").addEventListener("submit", async (event) => {
  event.preventDefault();
  // currentTarget is null once we await, so keep the form element itself.
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  $("signin-error").textContent = "";
  try {
    await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(form.get("email") || ""), password: String(form.get("password") || "") }),
    });
  } catch (error) {
    $("signin-error").textContent = error.message;
    return;
  }
  formElement.reset();
  try {
    await start();
  } catch (error) {
    $("signin-error").textContent = "已登录，但加载列表出错：" + error.message;
  }
});
$("signout").addEventListener("click", async () => {
  if (!confirm("退出后需要重新输入邮箱密码登录。确定退出？")) return;
  await api("/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  showSignIn();
});

async function start() {
  let account;
  try {
    account = await api("/session");
  } catch {
    showSignIn();
    return;
  }
  $("booting").hidden = true;
  $("signin").hidden = true;
  $("account").hidden = false;
  $("workspace").hidden = false;
  $("account-name").textContent = account?.name || "";
  // The original viewer is only bundled with the Go server, not on Vercel.
  fetch("/classic/", { method: "HEAD" }).then((response) => { $("classic-link").hidden = !response.ok; }).catch(() => {});
  await loadList();
  startLive();
  const route = readHash();
  if (route) {
    state.tab = route.tab;
    state.round = route.round;
    await openRun(route.id, { fromHash: true });
  }
}

// ---------------------------------------------------------------- run list
function rangeStart(days) {
  const today = dayKey(Date.now());
  return Date.parse(`${today}T00:00:00+08:00`) - (days - 1) * DAY;
}

async function fetchPage(cursor = "", limit = 100) {
  const query = new URLSearchParams({ limit: String(limit), from_at_ms: String(state.rangeFrom) });
  if (cursor) query.set("cursor", cursor);
  return api("/trajectories?" + query);
}

async function loadList() {
  state.rangeFrom = rangeStart(state.days);
  state.rows = [];
  state.byId.clear();
  state.cursor = "";
  setListStatus("加载中…");
  try {
    const page = await fetchPage();
    addRows(page.items ?? []);
    state.cursor = page.next_cursor || "";
    state.hasMore = Boolean(page.has_more);
    renderList();
  } catch (error) {
    setListStatus("加载失败：" + error.message);
  }
}

async function loadMore() {
  if (!state.hasMore) return;
  try {
    const page = await fetchPage(state.cursor);
    addRows(page.items ?? []);
    state.cursor = page.next_cursor || "";
    state.hasMore = Boolean(page.has_more);
    renderList();
  } catch (error) {
    toast("加载失败：" + error.message);
  }
}

function addRows(items) {
  for (const row of items) {
    const existing = state.byId.get(row.run.id);
    if (existing) {
      if (existing.execution_state !== row.execution_state || existing.integrity !== row.integrity) {
        state.briefs.delete(row.run.id);
        state.bundles.delete(row.run.id);
      }
      Object.assign(existing, row);
      continue;
    }
    state.byId.set(row.run.id, row);
    state.rows.push(row);
  }
  state.rows.sort((a, b) => b.run.started_at_ms - a.run.started_at_ms);
}

function setListStatus(text) {
  $("list-status").textContent = text;
}

const isSystem = (row) => row.run.operation !== "foreground" && !row.run.parent_id;

function rowMatches(row) {
  const brief = state.briefs.get(row.run.id);
  if (state.onlyFail) {
    const failed = row.execution_state === "failed" || (brief && brief !== "loading" && brief.failures > 0);
    if (!failed) return false;
  }
  if (!state.filter) return true;
  const haystack = [row.run.id, row.run.invocation_id, OPERATION_LABELS[row.run.operation],
    brief && brief !== "loading" ? [brief.userText, brief.finalText, brief.tools.join(" ")] : ""].flat().join(" ").toLowerCase();
  return haystack.includes(state.filter);
}

function orderedRows() {
  const visible = state.rows.filter((row) => state.showSystem || !isSystem(row));
  const children = new Map();
  const top = [];
  for (const row of visible) {
    const parent = row.run.parent_id;
    if (parent && state.byId.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(row);
    } else {
      top.push(row);
    }
  }
  const result = [];
  for (const row of top) {
    const kids = (children.get(row.run.id) ?? []).sort((a, b) => a.run.started_at_ms - b.run.started_at_ms);
    const keep = rowMatches(row) || kids.some(rowMatches);
    if (!keep) continue;
    result.push({ row, child: Boolean(row.run.parent_id) });
    for (const kid of kids) result.push({ row: kid, child: true });
  }
  return result;
}

function renderList() {
  const container = $("runs");
  const scroll = container.scrollTop;
  container.replaceChildren();
  const items = orderedRows();
  let currentDay = "";
  for (const { row, child } of items) {
    const day = dayKey(row.run.started_at_ms);
    if (day !== currentDay && !child) {
      currentDay = day;
      container.append(h("div", { class: "day", text: dayLabel(day) }));
    }
    container.append(renderRow(row, child));
    queueBrief(row);
  }
  if (state.hasMore) container.append(h("button", { class: "btn more", type: "button", onclick: loadMore, text: "加载更早的运行" }));
  const total = state.rows.length;
  const shown = items.length;
  setListStatus(`${shown} 条${shown !== total ? `（共 ${total} 条，部分被筛选或是系统运行）` : ""} · 最近更新 ${formatTime(Date.now())}`);
  container.scrollTop = scroll;
}

function dayLabel(day) {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.parse(`${today}T00:00:00+08:00`) - 1);
  return day === today ? `今天 · ${day}` : day === yesterday ? `昨天 · ${day}` : day;
}

function renderRow(row, child) {
  const brief = state.briefs.get(row.run.id);
  const ready = brief && brief !== "loading";
  const badges = [];
  if (row.run.source && row.run.source !== "my_agent_chat") badges.push(h("span", { class: "badge accent", text: SOURCE_LABELS[row.run.source] || row.run.source }));
  if (row.execution_state === "failed") badges.push(h("span", { class: "badge bad", text: "失败" }));
  else if (row.execution_state === "running") badges.push(h("span", { class: "badge accent", text: "进行中" }));
  else if (row.execution_state && row.execution_state !== "succeeded") badges.push(h("span", { class: "badge warn", text: statusLabel(row.execution_state) }));
  if (row.integrity === "incomplete") badges.push(h("span", { class: "badge warn", text: "存档不全" }));
  if (ready && brief.failures && row.execution_state !== "failed") badges.push(h("span", { class: "badge bad", text: `✗${brief.failures}` }));
  const replyInfo = ready ? replyStatusInfo(brief.finalStatus) : null;
  if (replyInfo && brief.finalStatus !== "llm_round_failed") {
    badges.push(h("span", { class: `badge ${replyInfo.tone}`, text: replyInfo.label, title: brief.finalStatus }));
  }
  const operation = row.run.operation;
  const facts = ready
    ? operation === "foreground"
      ? `${brief.rounds}轮 · ${brief.tools.length}工具 · ${formatDuration(brief.durationMs)}`
      : formatDuration(brief.durationMs)
    : "";
  let text;
  if (operation === "foreground") {
    text = ready
      ? h("div", { class: "row-text" + (brief.userText ? "" : " muted"), text: brief.userText || "（没有找到主人消息）" })
      : h("div", { class: "skeleton" });
  } else {
    text = h("div", { class: "row-text muted", text: OPERATION_LABELS[operation] || operation || "系统运行" });
  }
  const reply = ready && (brief.finalText) ? h("div", { class: "row-reply", text: brief.finalText.replace(/\s+/g, " ") }) : null;
  const button = h("button", {
    class: `row${child ? " child" : ""}${row.run.id === state.selected ? " active" : ""}`,
    type: "button", dataset: { id: row.run.id },
    onclick: () => selectRun(row.run.id),
  },
  h("div", { class: "row-top" },
    h("span", { class: "row-time", text: formatTime(row.run.started_at_ms) }),
    h("span", { class: "badges" }, badges),
    h("span", { class: "row-facts", text: facts })),
  text, reply);
  return button;
}

function queueBrief(row) {
  if (state.briefs.has(row.run.id)) return;
  state.briefs.set(row.run.id, "loading");
  state.briefQueue.push(row);
  pumpBriefs();
}

function pumpBriefs() {
  while (state.briefActive < 4 && state.briefQueue.length) {
    const row = state.briefQueue.shift();
    state.briefActive++;
    loadBrief(row).catch(() => {
      state.briefs.set(row.run.id, { userText: "", finalText: "", tools: [], rounds: 0, failures: 0, error: true });
    }).finally(() => {
      state.briefActive--;
      scheduleListRender();
      pumpBriefs();
    });
  }
}

async function loadBrief(row) {
  const id = row.run.id;
  const events = (await api(`/trajectories/${encodeURIComponent(id)}/events?limit=500`)).events ?? [];
  let brief = briefFromEvents(row, events);
  const ids = [...brief.smallPayloadIds];
  if (brief.needsRequestForText && brief.firstRequestPayloadId) ids.push(brief.firstRequestPayloadId);
  const small = {};
  await Promise.all(ids.map(async (pid) => {
    try {
      small[pid] = (await api(`/trajectories/${encodeURIComponent(id)}/payloads/${encodeURIComponent(pid)}`)).payload;
    } catch {
      /* leave out */
    }
  }));
  brief = briefFromEvents(row, events, small);
  if (!brief.userText && small[brief.firstRequestPayloadId]) {
    const messages = small[brief.firstRequestPayloadId].value?.messages ?? [];
    brief.userText = messageText(messages.filter((m) => m.role === "user").at(-1)?.content);
  }
  state.briefs.set(id, brief);
}

function scheduleListRender() {
  if (state.renderPending) return;
  state.renderPending = true;
  requestAnimationFrame(() => {
    state.renderPending = false;
    renderList();
  });
}

// filters
$("search").addEventListener("input", (event) => {
  state.filter = event.currentTarget.value.trim().toLowerCase();
  renderList();
});
$("ranges").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  for (const other of $("ranges").querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
  state.days = Number(chip.dataset.days);
  void loadList();
});
$("show-system").addEventListener("change", (event) => {
  state.showSystem = event.currentTarget.checked;
  renderList();
});
$("only-fail").addEventListener("change", (event) => {
  state.onlyFail = event.currentTarget.checked;
  renderList();
});
$("refresh").addEventListener("click", async () => {
  await pollNew(true);
  if (state.selected) await openRun(state.selected, { fresh: true });
  toast("已刷新");
});

// live updates
function startLive() {
  stopLive();
  state.liveTimer = setInterval(() => {
    if ($("live").checked && document.visibilityState === "visible") void pollNew();
  }, 15_000);
}
function stopLive() {
  clearInterval(state.liveTimer);
}
$("live").addEventListener("change", (event) => $("live-dot").classList.toggle("on", event.currentTarget.checked));

async function pollNew(force = false) {
  try {
    const page = await fetchPage("", 40);
    const before = state.rows.length;
    addRows(page.items ?? []);
    if (force || state.rows.length !== before || (page.items ?? []).some((row) => !state.briefs.has(row.run.id))) renderList();
    if (state.rows.length > before && !force) toast(`有 ${state.rows.length - before} 条新运行`);
  } catch {
    /* keep quiet while polling */
  }
}

// ---------------------------------------------------------------- detail
function selectRun(id) {
  if (id === state.selected) return;
  state.tab = "process";
  state.round = 1;
  location.hash = `#/run/${encodeURIComponent(id)}`; // hashchange opens it
}

// One request when the server offers /api/bundle; otherwise (or when the run is
// too large for one response) assemble the same bundle from the archive API.
async function loadBundle(id, fresh = false) {
  try {
    return await api(`/bundle/${encodeURIComponent(id)}${fresh ? "?fresh=1" : ""}`);
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
  }
  return assembleBundle(id, 1);
}

async function assembleBundle(id, depth) {
  const base = `/trajectories/${encodeURIComponent(id)}`;
  const detail = await api(base);
  const events = [];
  for (let after = 0, page = 0; page < 50; page++) {
    const result = await api(`${base}/events?limit=500${after ? `&after_seq=${after}` : ""}`);
    events.push(...(result.events ?? []));
    if (!result.has_more || !(result.next_seq > after)) break;
    after = result.next_seq;
  }
  const payloads = {};
  const ids = events.map((event) => event.payload_id).filter(Boolean);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < ids.length) {
      const pid = ids[next++];
      try {
        payloads[pid] = (await api(`${base}/payloads/${encodeURIComponent(pid)}`)).payload;
      } catch (error) {
        payloads[pid] = { error: error.message };
      }
    }
  }));
  const children = depth > 0
    ? await Promise.all((detail.children ?? []).map((child) => assembleBundle(child, depth - 1).catch(() => null)))
    : [];
  return { id, detail, events, payloads, children: children.filter(Boolean), problems: [], fetched_ms: Date.now() };
}

async function openRun(id, { fromHash = false, fresh = false } = {}) {
  state.selected = id;
  for (const row of $("runs").querySelectorAll(".row")) row.classList.toggle("active", row.dataset.id === id);
  $("empty").hidden = true;
  const container = $("turn");
  container.hidden = false;
  if (!state.bundles.has(id) || fresh) {
    container.replaceChildren(h("div", { class: "turn" }, h("div", { class: "card" }, "正在读取完整轨迹…（第一次打开一条运行需要几秒，之后会缓存）")));
  }
  try {
    let bundle = state.bundles.get(id);
    if (!bundle || fresh) {
      bundle = await loadBundle(id, fresh);
      state.bundles.set(id, bundle);
    }
    if (state.selected !== id) return;
    state.turn = digestBundle(bundle);
    if (!fromHash) writeHash(true);
    renderTurn();
    clearTimeout(state.runningTimer);
    if (state.turn.state === "running") {
      state.runningTimer = setTimeout(() => state.selected === id && openRun(id, { fresh: true, fromHash: true }), 4000);
    }
  } catch (error) {
    if (state.selected === id) container.replaceChildren(h("div", { class: "turn" }, h("div", { class: "card note bad", text: "读取失败：" + error.message })));
  }
}

function renderTurn() {
  const turn = state.turn;
  if (!turn) return;
  const container = $("turn");
  const scroll = $("detail").scrollTop;
  const tabs = [
    ["process", "过程", ""],
    ["context", "上下文", turn.rounds.length ? `${turn.rounds.length} 轮` : ""],
    ["tools", "工具", turn.rounds[0]?.context ? String(turn.rounds[0].context.tools.length) : ""],
    ["events", "原始事件", String(turn.events.length)],
  ];
  const tabBar = h("nav", { class: "tabs" }, tabs.map(([key, label, count]) => h("button", {
    class: "tab" + (state.tab === key ? " on" : ""), type: "button",
    onclick: () => { state.tab = key; writeHash(true); renderTurn(); $("detail").scrollTop = 0; },
  }, label, count ? h("span", { class: "count", text: count }) : null)));
  const panel = { process: renderProcess, context: renderContext, tools: renderTools, events: renderEvents }[state.tab] ?? renderProcess;
  container.replaceChildren(h("div", { class: "turn" }, renderHead(turn), tabBar, panel(turn)));
  $("detail").scrollTop = scroll;
}

function renderHead(turn) {
  const isForeground = turn.operation === "foreground";
  const askText = isForeground
    ? turn.userText || "（没有找到主人消息）"
    : `${OPERATION_LABELS[turn.operation] || turn.operation || "系统运行"}${turn.parentId ? "（属于另一条对话）" : ""}`;
  const meta = [
    h("span", {}, h("b", { text: formatTime(turn.startedAt, true) })),
    h("span", { text: [SOURCE_LABELS[turn.source] || turn.source, OPERATION_LABELS[turn.operation] || turn.operation].filter(Boolean).join(" · ") }),
    turn.entry.pageRoute ? h("span", { class: "mono", text: turn.entry.pageRoute }) : null,
    h("span", { class: `badge ${turn.state === "succeeded" ? "good" : turn.state === "failed" ? "bad" : "accent"}`, text: statusLabel(turn.state) }),
    turn.integrity === "incomplete" ? h("span", { class: "badge warn", text: "存档不全", title: "有些事件或内容没上传完整" }) : null,
    h("span", {}, "用时 ", h("b", { text: formatDuration(turn.durationMs) })),
    turn.models.length ? h("span", {}, "模型 ", h("b", { text: turn.models.join("、") })) : null,
    turn.rounds.length ? h("span", { text: `${turn.rounds.length} 轮 · ${turn.tools.length} 次工具` }) : null,
    turn.usage.prompt ? h("span", { title: "所有轮次合计" }, `输入 ${formatTokens(turn.usage.prompt)} tokens（缓存命中 ${formatTokens(turn.usage.cacheHit)}）· 输出 ${formatTokens(turn.usage.completion)}（思考 ${formatTokens(turn.usage.reasoning)}）`) : null,
    turn.appVersion ? h("span", { text: `App ${turn.appVersion}` }) : null,
  ];
  const ids = [
    turn.invocationId ? h("span", {}, "Invocation ", h("code", { text: turn.invocationId }), copyButton(turn.invocationId)) : null,
    h("span", {}, "Run ", h("code", { text: turn.id }), copyButton(turn.id)),
    turn.parentId ? h("span", {}, "父运行 ", h("button", { class: "copy", type: "button", text: turn.parentId.slice(0, 8) + " →", onclick: () => selectRun(turn.parentId) })) : null,
    h("span", {}, copyButton(() => location.href, "复制本页链接")),
  ];
  return h("div", { class: "ask" },
    h("div", { class: "ask-who", text: isForeground ? "主人发来" : "运行类型" }),
    h("div", { class: "ask-text" + (isForeground && turn.userText ? "" : " muted") }, rich(askText)),
    h("div", { class: "meta" }, meta),
    h("div", { class: "ids" }, ids));
}

// ---------------------------------------------------------------- process tab
function renderProcess(turn) {
  const parts = [];
  parts.push(renderReply(turn));
  if (turn.failures.length) parts.push(renderFailures(turn));
  if (turn.rounds.length || turn.tools.length) parts.push(renderTimeline(turn));
  for (const round of turn.rounds) parts.push(renderRound(turn, round));
  const cards = turn.business.filter((b) => b.kind.startsWith("ui.") || b.kind.startsWith("card."));
  const confirmations = turn.business.filter((b) => !cards.includes(b));
  if (cards.length) parts.push(renderBusiness("界面与卡片", cards, turn));
  if (confirmations.length) parts.push(renderBusiness("确认与业务回执", confirmations, turn));
  if (turn.children.length) parts.push(renderChildren(turn));
  if (turn.problems.length) parts.push(h("div", { class: "card note warn", text: "拉取时的问题：" + turn.problems.join("；") }));
  if (!turn.rounds.length && !turn.business.length && !turn.delivery.length) {
    parts.push(h("div", { class: "card", text: "这条运行没有模型调用。可以到「原始事件」看它记录了什么。" }));
  }
  return h("div", {}, parts);
}

function renderReply(turn) {
  const reply = turn.reply;
  const delivery = turn.delivery.map((d) => `${d.kind} ${formatTime(d.at)}`).join(" → ");
  const title = {
    final: "最终发给主人的回复",
    model: "模型最后的输出",
    failed: "运行失败，没有记录到发出的回复",
    card: `这次回复是一张卡片：${reply.card ?? ""}（由 ${reply.tool ?? "工具"} 生成）`,
  }[reply.kind];
  const card = h("div", { class: "card" },
    h("div", { class: "card-title" }, h("span", { text: title }), h("span", { class: "grow" }),
      turn.delivered ? h("span", { class: "badge good", text: "已送达" }) : null,
      reply.text ? copyButton(reply.text) : null));
  if (reply.kind === "card" && reply.text) card.append(h("div", { class: "sub-label", text: "卡片上方的说明文字：" }));
  if (reply.text) card.append(h("div", { class: "reply-text text" }, rich(reply.text)));
  else card.append(h("div", { class: "text", text: turn.rounds.length ? "（没有文字输出，可能静默结束）" : "（这条运行不是对话，没有回复）" }));
  if (reply.kind === "failed" && reply.text) {
    card.append(h("div", { class: "note bad", text: "上面是模型失败前最后说的话，不一定发到了手机上；手机上通常只看到报错提示。" }));
  }
  if (turn.replyReplaced) {
    card.append(h("div", { class: "note warn" },
      `${turn.replyStatus?.note ?? "手机上显示的是客户端生成的文本"}（回复状态 ${turn.finalStatus || "未知"}）。模型原文：`,
      h("div", { class: "text" }, rich(turn.lastModelText))));
  } else if (turn.replyStatus && !turn.replyStatus.card && turn.finalStatus !== "llm_round_failed") {
    card.append(h("div", { class: "note info", text: `回复状态：${turn.replyStatus.label}（${turn.finalStatus}）` }));
  }
  if (delivery) card.append(h("div", { class: "meta", text: "送达过程：" + delivery }));
  return card;
}

function renderFailures(turn) {
  return h("div", { class: "card failures" },
    h("div", { class: "card-title" }, h("span", { class: "badge bad", text: `${turn.failures.length} 个失败` }),
      turn.withheldCount ? h("span", { text: `另有 ${turn.withheldCount} 处错误原文被脱敏` }) : null),
    h("ul", {}, turn.failures.map((f) => h("li", {},
      h("span", { class: "mono", text: formatTime(f.at) + " " }), h("b", { text: f.title }), f.detail ? " · " : "", rich(f.detail)))));
}

function renderTimeline(turn) {
  const t0 = turn.startedAt;
  const items = [];
  for (const round of turn.rounds) {
    const start = round.startAt ?? round.endAt;
    items.push({ lane: "模型", start, end: round.endAt ?? start, fail: Boolean(round.failure), label: `第 ${round.index} 轮 · ${formatDuration(round.latencyMs)}`, target: `r-${round.index}` });
  }
  for (const tool of turn.tools) {
    if (!Number.isFinite(tool.startAt)) continue;
    items.push({ lane: "工具", start: tool.startAt, end: tool.endAt ?? tool.startAt, fail: tool.status === "failed" || tool.ok === false, label: `${tool.name} · ${formatDuration(tool.durationMs)}`, target: `t-${tool.id}`, kind: "tool" });
    for (const nested of tool.nested) {
      items.push({ lane: "工具内模型", start: nested.startAt, end: nested.endAt ?? nested.startAt, fail: Boolean(nested.failure), label: `${nested.purpose} · ${formatDuration(nested.latencyMs)}`, target: `t-${tool.id}`, kind: "nested" });
    }
  }
  for (const d of turn.delivery) items.push({ lane: "送达", start: d.at, end: d.at, point: true, label: `${d.kind} ${formatTime(d.at)}` });
  const end = Math.max(turn.endedAt ?? 0, ...items.map((item) => item.end ?? 0));
  const span = Math.max(1, end - t0);
  const lanes = ["模型", "工具", "工具内模型", "送达"].filter((lane) => items.some((item) => item.lane === lane));
  const rows = lanes.map((lane) => {
    const track = h("div", { class: "lane-track" });
    for (const item of items.filter((i) => i.lane === lane)) {
      const bar = h("button", {
        class: `bar${item.kind ? " " + item.kind : ""}${item.fail ? " fail" : ""}${item.point ? " point" : ""}`,
        type: "button", title: item.label,
        onclick: () => item.target && document.getElementById(item.target)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      });
      bar.style.left = `${((item.start - t0) / span) * 100}%`;
      if (!item.point) bar.style.width = `${Math.max(0.4, ((item.end - item.start) / span) * 100)}%`;
      track.append(bar);
    }
    return h("div", { class: "lane" }, h("div", { class: "lane-name", text: lane }), track);
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => h("span", { text: formatDuration(span * f) }));
  return h("div", { class: "card" },
    h("div", { class: "card-title" }, h("span", { text: "轨迹（点色块跳到对应步骤）" }), h("span", { class: "grow" }), h("span", { text: `从开始到结束 ${formatDuration(span)}` })),
    h("div", { class: "timeline" }, rows, h("div", { class: "axis" }, h("span"), h("div", { class: "axis-track" }, ticks))));
}

function renderRound(turn, round) {
  const usage = round.usage;
  const facts = [
    round.model + (round.responseModel && round.responseModel !== round.model ? ` → ${round.responseModel}` : ""),
    formatDuration(round.latencyMs),
    usage ? `输入 ${formatTokens(usage.prompt)}${usage.cacheHit ? `（缓存 ${formatTokens(usage.cacheHit)}）` : ""} · 输出 ${formatTokens(usage.completion)}${usage.reasoning ? `（思考 ${formatTokens(usage.reasoning)}）` : ""}` : "",
    round.finishReason ? `结束：${round.finishReason}` : "",
    round.retries ? `重试 ${round.retries} 次` : "",
  ].filter(Boolean).join(" · ");
  const card = h("div", { class: "card" },
    h("div", { class: "round-head" },
      h("h3", { text: `第 ${round.index} 轮` }), h("span", { class: "facts", text: facts }), h("span", { class: "grow" }),
      round.context ? h("button", { class: "btn tiny", type: "button", text: "看这一轮收到的上下文", onclick: () => { state.tab = "context"; state.round = round.index; writeHash(true); renderTurn(); $("detail").scrollTop = 0; } }) : null));
  if (round.failure) {
    card.append(h("div", { class: "note bad" }, "模型调用失败：", rich([round.failure.code, round.failure.type, round.failure.stage, round.failure.error].filter(Boolean).join(" · "))));
  }
  if (round.reasoning) {
    card.append(h("div", { class: "block think" }, h("div", { class: "block-label", text: `思考 · ${round.reasoning.length} 字` }), clampedText(round.reasoning)));
  }
  if (round.content) {
    card.append(h("div", { class: "block say" }, h("div", { class: "block-label" }, `输出 · ${round.content.length} 字`, copyButton(round.content)), clampedText(round.content)));
  }
  if (!round.reasoning && !round.content && !round.toolCalls.length && !round.failure) {
    card.append(h("div", { class: "note info", text: "这一轮没有思考、输出或工具调用记录。" }));
  }
  for (const tool of round.toolCalls) card.append(renderTool(tool));
  return h("div", { class: "round" + (round.failure ? " fail" : ""), id: `r-${round.index}` }, h("span", { class: "round-dot" }), card);
}

function toolBadge(tool) {
  if (tool.status === "failed") return h("span", { class: "badge bad", text: "执行失败" });
  if (tool.ok === false) return h("span", { class: "badge bad", text: "ok=false" });
  if (["needs_confirmation", "prepared", "pending"].includes(tool.status) || tool.businessState === "pending") {
    return h("span", { class: "badge accent", text: [statusLabel(tool.status), tool.businessState && tool.businessState !== tool.status ? statusLabel(tool.businessState) : ""].filter(Boolean).join(" / ") });
  }
  if (tool.status === "succeeded") return h("span", { class: "badge good", text: "成功" });
  return h("span", { class: "badge", text: statusLabel(tool.status) || "未知" });
}

function renderTool(tool) {
  const failed = tool.status === "failed" || tool.ok === false;
  const result = tool.result ?? tool.rawResult;
  const args = tool.args && typeof tool.args === "object" && !Array.isArray(tool.args) ? Object.entries(tool.args) : null;
  const argsView = args
    ? h("div", { class: "kv" }, args.map(([key, value]) => [
      h("div", { class: "k", text: key }),
      h("div", { class: "v" + (typeof value === "string" ? "" : " code") }, rich(valueText(value))),
    ]))
    : h("div", { class: "kv" }, h("div", { class: "k", text: "参数" }), h("div", { class: "v code" }, rich(valueText(tool.args ?? "（无）"))));
  const highlights = resultHighlights(result).map(([key, value]) => h("span", {
    class: "hl" + ((key === "ok" && value === false) || (key === "code" && failed) || key === "error" ? " bad" : ""),
  }, h("span", { class: "k", text: key }), rich(valueText(value))));
  const body = h("div", { class: "tool-body" },
    h("div", { class: "sub-label", text: "参数" }), argsView,
    h("div", { class: "sub-label", text: "结果" }),
    highlights.length ? h("div", { class: "highlights" }, highlights) : h("div", { class: "text", text: result === undefined ? "（没有记录结果）" : "（结果里没有常见字段，展开看完整内容）" }),
    tool.nested.map((nested) => h("div", { class: "nested" },
      h("b", { text: `工具内部又调了一次模型：「${nested.purpose}」` }),
      ` ${nested.model} · ${formatDuration(nested.latencyMs)}`,
      nested.failure ? h("span", { class: "badge bad", text: ` 失败 ${nested.failure.code || nested.failure.type}` }) : null,
      nested.content ? clampedText(nested.content) : null,
      nested.request ? fold("这次内部调用的请求", () => jsonView(nested.request, 2)) : null)),
    result !== undefined ? fold("完整结果", () => jsonView(result, 1)) : null,
    tool.rawResult !== undefined && tool.result !== undefined && JSON.stringify(tool.rawResult) !== JSON.stringify(tool.result)
      ? fold("工具原始返回（模型看到的版本见上）", () => jsonView(tool.rawResult, 1)) : null);
  return h("div", { class: "tool-call" + (failed ? " fail" : ""), id: `t-${tool.id}` },
    h("div", { class: "tool-head" },
      h("span", { class: "tool-name", text: tool.name || "（未知工具）" }), toolBadge(tool),
      h("span", { class: "facts", text: formatDuration(tool.durationMs) }), h("span", { class: "grow" }),
      tool.errorCode ? h("span", { class: "badge " + (failed ? "bad" : ""), text: tool.errorCode }) : null),
    body);
}

function renderBusiness(title, items, turn) {
  return h("div", { class: "card" },
    h("div", { class: "card-title", text: title }),
    items.map((item) => {
      const meta = item.meta ?? {};
      const summary = [meta.event_type, meta.action, meta.purpose, meta.phase, meta.tool_name, meta.outcome, meta.business_state, meta.delivery_state]
        .filter(Boolean).join(" · ");
      return h("div", { class: "block say" },
        h("div", { class: "block-label" }, h("span", { class: "mono", text: `${formatTime(item.at)} +${formatDuration(item.at - turn.startedAt)}` }), h("b", { text: item.kind }), summary),
        item.value !== undefined ? fold("内容", () => jsonView(item.value, 1)) : null);
    }));
}

function renderChildren(turn) {
  return h("div", { class: "card" },
    h("div", { class: "card-title", text: "之后发生的操作（子运行）" }),
    turn.children.map((child) => {
      const receipts = child.business.filter((b) => b.kind.startsWith("business") || b.kind.startsWith("confirmation"));
      return h("div", { class: "block say" },
        h("div", { class: "block-label" },
          h("b", { text: OPERATION_LABELS[child.operation] || child.operation }),
          h("span", { class: "mono", text: formatTime(child.startedAt) }),
          h("span", { class: `badge ${child.state === "succeeded" ? "good" : child.state === "failed" ? "bad" : ""}`, text: statusLabel(child.state) }),
          h("span", { text: `用时 ${formatDuration(child.durationMs)}` }),
          h("button", { class: "btn tiny", type: "button", text: "打开", onclick: () => selectRun(child.id) })),
        receipts.map((b) => h("div", { class: "text" },
          h("span", { class: "mono", text: b.kind + " " }),
          [b.meta?.action, b.meta?.purpose, b.meta?.outcome, b.meta?.business_state].filter(Boolean).join(" · "),
          b.value !== undefined ? fold("回执内容", () => jsonView(b.value, 1)) : null)),
        child.delivery.length ? h("div", { class: "meta", text: "送达：" + child.delivery.map((d) => `${d.kind} ${formatTime(d.at)}`).join(" → ") }) : null,
        child.failures.length ? h("div", { class: "note bad", text: child.failures.map((f) => f.title + (f.detail ? " · " + f.detail : "")).join("；") }) : null);
    }));
}

// ---------------------------------------------------------------- context tab
const SECTION_COLORS = {
  role: "#5b8def", rule: "#7c6cf2", style: "#c06cf2", sop: "#e0718f",
  recent: "#f0a35b", recentCalendar: "#e6c35a", recentContacts: "#b9c95a",
  invocationContext: "#5bc0a8", pageContext: "#59b6d9", toolPolicy: "#8f99a8",
  kyh: "#d9915b", topics: "#a7835b", memory: "#c9a26b",
};
const colorFor = (key, index) => SECTION_COLORS[key] || ["#6b8fb8", "#8fb86b", "#b86b8f", "#b8a36b"][index % 4];

function renderContext(turn) {
  const withContext = turn.rounds.filter((r) => r.context);
  if (!withContext.length) return h("div", { class: "card", text: "这条运行没有存档模型请求体，看不到上下文。" });
  if (!withContext.some((r) => r.index === state.round)) state.round = withContext[0].index;
  const round = withContext.find((r) => r.index === state.round);
  const context = round.context;
  const pills = h("div", { class: "round-pills" }, h("span", { class: "sub-label", text: "第几轮的请求：" }),
    withContext.map((r) => h("button", {
      class: "chip" + (r.index === state.round ? " on" : ""), type: "button",
      text: `第 ${r.index} 轮 · ${r.context.messageCount} 条消息`,
      onclick: () => { state.round = r.index; writeHash(true); renderTurn(); },
    })));

  const toolsChars = JSON.stringify(context.tools).length;
  const convChars = context.conversation.reduce((sum, m) => sum + m.text.length + JSON.stringify(m.toolCalls).length, 0);
  const pieces = [
    ...context.sections.map((s, i) => ({ key: s.key, title: s.title, chars: s.chars, color: colorFor(s.key, i), target: `sec-${s.key}` })),
    { key: "conversation", title: "对话消息", chars: convChars, color: "#3fa7a0", target: "sec-conversation" },
    { key: "tools", title: `工具定义（${context.tools.length} 个）`, chars: toolsChars, color: "#c7ccd5", target: "" },
  ];
  const total = pieces.reduce((sum, p) => sum + p.chars, 0) || 1;
  const bar = h("div", { class: "compose" }, pieces.map((p) => {
    const span = h("span", { title: `${p.title} · ${p.chars.toLocaleString()} 字符 · ${((p.chars / total) * 100).toFixed(1)}%`,
      onclick: () => p.target && openSection(p.target) });
    span.style.width = `${(p.chars / total) * 100}%`;
    span.style.background = p.color;
    return span;
  }));
  const legend = h("div", { class: "legend" }, pieces.map((p) => {
    const swatch = h("i");
    swatch.style.background = p.color;
    return h("span", {}, swatch, `${p.title} ${((p.chars / total) * 100).toFixed(0)}%`);
  }));

  const summary = h("div", { class: "card" },
    h("div", { class: "card-title" }, h("span", { text: `第 ${round.index} 轮发给模型的完整请求` }), h("span", { class: "grow" }),
      copyButton(() => JSON.stringify(round.request, null, 2), "复制完整请求 JSON")),
    h("div", { class: "meta" },
      h("span", {}, "模型 ", h("b", { text: String(context.params.model ?? round.model ?? "?") })),
      Object.entries(context.params).filter(([k]) => k !== "model").map(([k, v]) => h("span", { text: `${k}=${valueText(v)}` })),
      h("span", { text: `${context.messageCount} 条消息` }),
      h("span", { text: `系统提示 ${context.systemChars.toLocaleString()} 字` }),
      round.usage ? h("span", { text: `实际输入 ${formatTokens(round.usage.prompt)} tokens（缓存命中 ${formatTokens(round.usage.cacheHit)}）` }) : null),
    bar, legend,
    h("div", { class: "sub-label", text: "色块按字符数比例，点击跳到对应段落。工具定义也算在请求里。" }));

  const parts = [pills, summary];
  if (round.index > 1) {
    const changed = context.changedSections ?? [];
    parts.push(h("div", { class: "card" },
      h("div", { class: "card-title", text: `相比第 ${round.index - 1} 轮` }),
      h("div", { class: changed.length ? "note warn" : "note info", text: changed.length ? `这些系统段落变了：${changed.join("、")}` : "系统提示完全相同；只是追加了下面这些消息。" }),
      (context.newConversation ?? []).map(renderMessage)));
  }
  context.sections.forEach((section, index) => parts.push(renderSection(section, colorFor(section.key, index), context.changedSections ?? [])));
  parts.push(h("details", { class: "section", id: "sec-conversation", open: round.index === 1 },
    h("summary", {}, h("span", { class: "swatch" }), h("span", { class: "title", text: "对话消息（system 之后的部分）" }), h("span", { class: "size", text: `${context.conversation.length} 条` })),
    h("div", { class: "section-body" }, context.conversation.map(renderMessage))));
  return h("div", {}, parts);
}

function openSection(id) {
  const element = document.getElementById(id);
  if (!element) return;
  element.open = true;
  element.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderMessage(message) {
  const who = { user: "主人（本轮用户消息）", assistant: "Agent", tool: "工具结果" }[message.role] || message.role;
  return h("div", { class: `msg ${message.role}` },
    h("div", { class: "msg-head" }, h("b", { text: who }), h("span", { text: `#${message.index}` }), message.toolCallId ? h("span", { class: "mono", text: message.toolCallId }) : null),
    message.reasoning ? h("div", { class: "block think" }, h("div", { class: "block-label", text: "思考" }), clampedText(message.reasoning)) : null,
    message.text ? (message.role === "tool" ? structuredOrText(message.text) : clampedText(message.text)) : null,
    message.toolCalls.map((call) => h("div", { class: "kv" }, h("div", { class: "k", text: "调用" }), h("div", { class: "v code" }, `${call.name} ${valueText(call.args)}`))));
}

function structuredOrText(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") return jsonView(value, 1);
  } catch {
    /* plain text */
  }
  return clampedText(text);
}

function renderSection(section, color, changed) {
  const swatch = h("span", { class: "swatch" });
  swatch.style.background = color;
  const details = h("details", { class: "section", id: `sec-${section.key}` },
    h("summary", {}, swatch, h("span", { class: "title", text: section.title }), h("span", { class: "key", text: section.key }),
      changed.includes(section.key) ? h("span", { class: "changed", text: "本轮有变化" }) : null,
      h("span", { class: "size", text: `${section.chars.toLocaleString()} 字` })));
  let built = false;
  details.addEventListener("toggle", () => {
    if (!details.open || built) return;
    built = true;
    details.append(h("div", { class: "section-body" }, sectionBody(section)));
  });
  return details;
}

function sectionBody(section) {
  const { header, data } = splitStructured(section.text);
  const raw = () => h("div", { class: "text" }, rich(section.text));
  const tools = h("div", { class: "section-tools" }, copyButton(section.text, "复制本段原文"));
  if (data === undefined) return [tools, raw()];
  let pretty = null;
  if (section.key === "recent" && Array.isArray(data)) pretty = transcript(data);
  else if (section.key === "recentCalendar" && data && Array.isArray(data.events)) pretty = calendarTable(data);
  else if (section.key === "recentContacts" && Array.isArray(data)) pretty = contactsTable(data);
  else pretty = jsonView(data, 1);
  return [tools, h("div", { class: "text sub-label" }, rich(header)), pretty, fold("看原文", raw)];
}

function transcript(items) {
  return h("div", { class: "transcript" }, items.map((item) => {
    const owner = item.author === "owner";
    const who = owner ? "主人" : item.author === "my_agent" ? "Agent" : item.author;
    const page = item.page?.route ? ` · ${item.page.route}` : "";
    const flags = [item.content_truncated ? "正文截断" : "", item.delivery_status && item.delivery_status !== "success" ? item.delivery_status : ""].filter(Boolean).join(" · ");
    return h("div", { class: "bubble" + (owner ? " owner" : "") },
      h("span", { class: "who", text: `${who} · ${formatTime(item.timestamp_ms, true)}${page}${flags ? " · " + flags : ""}` }),
      rich(typeof item.content === "string" ? item.content : valueText(item.content)),
      item.cards || item.attachments ? fold("附带卡片", () => jsonView(item.cards ?? item.attachments, 1)) : null);
  }));
}

function calendarTable(data) {
  return h("div", {},
    h("div", { class: "sub-label", text: `${data.start_date} ~ ${data.end_date} · ${data.time_zone ?? ""} · ${data.events.length} 个日程${data.truncated ? "（截断）" : ""}` }),
    h("table", { class: "mini-table" },
      h("tr", {}, ["日期", "时间", "标题", "类型", "状态", "参与者"].map((t) => h("th", { text: t }))),
      data.events.map((event) => h("tr", {},
        h("td", { text: event.date ?? "" }),
        h("td", { text: event.all_day ? "全天" : `${formatTime(Date.parse(event.start_at))}–${formatTime(Date.parse(event.end_at))}` }),
        h("td", { text: event.title ?? "" }),
        h("td", { text: [event.type, event.meeting_mode].filter(Boolean).join(" · ") }),
        h("td", { text: [event.status, event.viewer_status].filter(Boolean).join(" / ") }),
        h("td", { text: (event.attendees ?? []).map((a) => `${a.display_name}(${a.response_status ?? a.role})`).join("、") })))));
}

function contactsTable(items) {
  return h("table", { class: "mini-table" },
    h("tr", {}, ["联系人", "最近聊天", "UID"].map((t) => h("th", { text: t }))),
    items.map((item) => h("tr", {},
      h("td", { text: item.display_name ?? "" }),
      h("td", { text: formatTime(item.last_message_at_ms, true) }),
      h("td", { class: "mono", text: item.contact_uid ?? "" }))));
}

// ---------------------------------------------------------------- tools tab
function renderTools(turn) {
  const context = (turn.rounds.find((r) => r.index === state.round) ?? turn.rounds[0])?.context;
  const parts = [];
  if (turn.policy) {
    const p = turn.policy;
    parts.push(h("div", { class: "card" },
      h("div", { class: "card-title", text: "工具策略（ToolPolicy 决定这次给模型哪些工具）" }),
      h("div", { class: "meta" },
        h("span", {}, "策略 ", h("b", { class: "mono", text: p.tool_policy ?? "" })),
        h("span", { text: `可用 ${p.allowed_tool_count ?? "?"} / 共 ${p.total_tool_count ?? "?"}` }),
        h("span", { text: `主人本人：${p.requester_is_owner ? "是" : "否"}` }),
        h("span", { text: `可写联系人备注：${p.contact_notes_write_allowed ? "是" : "否"}` }),
        p.protect_owner_calendar_privacy ? h("span", { class: "badge warn", text: "保护主人日程隐私" }) : null),
      (p.excluded_tool_names ?? []).length ? h("div", { class: "note info", text: "被排除的工具：" + p.excluded_tool_names.map((n) => `${n}（${p.excluded_tool_reasons?.[n] ?? "?"}）`).join("、") }) : null,
      turn.loop?.tool_domains ? h("div", { class: "sub-label", text: "工具领域：" + turn.loop.tool_domains.join("、") }) : null));
  }
  if (!context) {
    parts.push(h("div", { class: "card", text: "没有存档请求体，看不到工具定义。" }));
    return h("div", {}, parts);
  }
  const counts = new Map();
  for (const tool of turn.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  const list = h("div", {});
  const filter = h("input", { class: "search", type: "search", placeholder: "筛选工具名或描述" });
  const draw = () => {
    const query = filter.value.trim().toLowerCase();
    const tools = [...context.tools]
      .filter((tool) => !query || tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query))
      .sort((a, b) => (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0));
    list.replaceChildren(...tools.map((tool) => renderToolDef(tool, counts.get(tool.name) ?? 0)));
  };
  filter.addEventListener("input", draw);
  draw();
  parts.push(h("div", { class: "card" },
    h("div", { class: "card-title", text: `第 ${context === turn.rounds[0]?.context ? 1 : state.round} 轮提供给模型的 ${context.tools.length} 个工具（被调用过的排在前面）` }),
    filter, h("div", { class: "sub-label", text: " " }), list));
  return h("div", {}, parts);
}

function renderToolDef(tool, called) {
  const details = h("details", { class: "tool-row" + (called ? " called" : "") },
    h("summary", {}, h("span", { class: "name", text: tool.name }),
      called ? h("span", { class: "badge accent", text: `本次调用 ${called} 次` }) : null,
      h("span", { class: "desc", text: tool.description.replace(/\s+/g, " ") })));
  let built = false;
  details.addEventListener("toggle", () => {
    if (!details.open || built) return;
    built = true;
    const props = tool.parameters?.properties ?? {};
    const required = new Set(tool.parameters?.required ?? []);
    details.append(h("div", { class: "body" },
      h("div", { class: "text" }, rich(tool.description)),
      Object.keys(props).length ? h("table", { class: "mini-table" },
        h("tr", {}, ["参数", "类型", "必填", "说明"].map((t) => h("th", { text: t }))),
        Object.entries(props).map(([name, schema]) => h("tr", {},
          h("td", { class: "mono", text: name }),
          h("td", { text: [schema.type, schema.enum ? `枚举：${schema.enum.join(" / ")}` : ""].filter(Boolean).join(" · ") }),
          h("td", { text: required.has(name) ? "必填" : "" }),
          h("td", {}, rich(schema.description ?? ""))))) : h("div", { class: "sub-label", text: "没有参数" }),
      fold("参数 JSON Schema", () => jsonView(tool.parameters, 2))));
  });
  return details;
}

// ---------------------------------------------------------------- events tab
function eventCategory(event) {
  const prefix = event.kind.split(".")[0];
  if (["model", "tool", "delivery"].includes(prefix)) return prefix;
  if (["ui", "card", "confirmation", "business"].includes(prefix)) return "card";
  if (prefix === "span") return event.metadata?.operation === "tool" ? "tool" : event.metadata?.operation?.startsWith("model") ? "model" : "other";
  return "other";
}

function renderEvents(turn) {
  const filters = [["", "全部"], ["model", "模型"], ["tool", "工具"], ["delivery", "送达"], ["card", "卡片/确认"], ["fail", "失败"], ["other", "其他"]];
  let current = renderEvents.filter ?? "";
  const table = h("table", { class: "events" });
  const draw = () => {
    table.replaceChildren();
    for (const event of turn.events) {
      const fail = Boolean(failureType(event));
      if (current === "fail" ? !fail : current && eventCategory(event) !== current) continue;
      const meta = { ...(event.metadata ?? {}) };
      delete meta.run_id;
      const row = h("tr", { class: "ev" + (fail ? " fail" : "") },
        h("td", { class: "seq", text: String(event.seq) }),
        h("td", { class: "off", text: `+${formatDuration(event.at_ms - turn.startedAt)}` }),
        h("td", { class: "kind", text: event.kind }),
        h("td", { class: "sum", text: JSON.stringify(meta).slice(0, 220) + (event.payload_id ? "  📄" : "") }));
      let open = null;
      row.addEventListener("click", () => {
        if (open) {
          open.remove();
          open = null;
          return;
        }
        const payload = event.payload_id ? turn.payloads.get(event.payload_id) : undefined;
        const cell = h("td", { colspan: "4" },
          h("div", { class: "sub-label", text: `metadata` }), jsonView(event.metadata ?? {}, 1),
          payload ? [
            h("div", { class: "sub-label", text: `内容 ${event.payload_id}${payload.incomplete ? " · 不完整" : ""}${payload.redacted.length ? " · 脱敏路径 " + payload.redacted.join(", ") : ""}${payload.error ? " · " + payload.error : ""}` }),
            jsonView(payload.value, 1),
          ] : event.payload_id ? h("div", { class: "sub-label", text: "内容没有拉取到" }) : null);
        open = h("tr", {}, cell);
        row.after(open);
      });
      table.append(row);
    }
  };
  const chips = h("div", { class: "chips" }, filters.map(([key, label]) => h("button", {
    class: "chip" + (key === current ? " on" : ""), type: "button", text: label,
    onclick: (event) => {
      current = key;
      renderEvents.filter = key;
      for (const chip of chips.querySelectorAll(".chip")) chip.classList.toggle("on", chip === event.currentTarget);
      draw();
    },
  })));
  draw();
  return h("div", {}, h("div", { class: "card" }, h("div", { class: "card-title", text: "所有事件按顺序排列，点一行看 metadata 和存档内容" }), chips), table);
}

// ---------------------------------------------------------------- keyboard
document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea") || event.metaKey || event.ctrlKey || event.altKey) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    $("search").focus();
  } else if (event.key === "j" || event.key === "k") {
    const rows = [...$("runs").querySelectorAll(".row")];
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.dataset.id === state.selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))] ?? rows[0];
    next.scrollIntoView({ block: "nearest" });
    selectRun(next.dataset.id);
  } else if (["1", "2", "3", "4"].includes(event.key) && state.turn) {
    state.tab = ["process", "context", "tools", "events"][Number(event.key) - 1];
    writeHash(true);
    renderTurn();
  }
});

if (["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) $("brand-note").textContent = "本地 · 北京时间";
void start();
