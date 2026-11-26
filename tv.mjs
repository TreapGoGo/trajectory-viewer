#!/usr/bin/env node
// tv — read Tuple Agent trajectories from the local workbench server.
// Usage: node tv.mjs help
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATION_LABELS, SOURCE_LABELS, briefFromEvents, dayKey, digestBundle, formatDuration,
  formatTime, formatTokens, replyStatusInfo, resultHighlights, splitStructured, statusLabel,
} from "./ui/digest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.TV_BASE || "http://127.0.0.1:8765").replace(/\/$/, "");
let KEY = "";
try {
  KEY = readFileSync(join(HERE, "state", "cli.key"), "utf8").trim();
} catch {
  /* reported on first request */
}

const HELP = `tv — 本地 Agent 轨迹工作台命令行（服务器 ${BASE}）

  ls [--day today|yesterday|2026-11-25] [--since 2026-11-24] [--limit 30] [--all]
        列出运行：时间、Invocation ID、入口、状态、轮数、工具、主人消息、最终回复
  show <id> [--full] [--json]
        一次运行的全过程：每轮思考/输出/工具调用与结果、最终回复、失败、子运行
  ctx <id> [--round N] [--list] [--section KEY] [--conv] [--new] [--full]
        模型收到的上下文：--list 各段字数；--section role|rule|style|sop|recent|... 打印某段；
        --conv 打印对话消息（含工具调用与结果）；--new 只看相比上一轮新增的消息
  tools <id> [name] [--round N]
        本轮提供给模型的工具清单；给名字则打印完整描述与参数
  events <id> [--kind tool|model|delivery|...]
        原始事件时间线
  payload <id> <seq|payload_id>
        某个事件的原始内容（JSON）
  grep <正则> [--since 2026-11-24] [--until 2026-11-26] [--in user|final|think|tools|context|all]
        在运行里搜索（会拉取完整轨迹，首次较慢，之后有缓存）
  url <id>
        工作台网页链接

  <id> 可以是：Invocation ID（my_agent_…）、Run ID、Run ID 前缀（≥6 位）、last、last2、last3…
  环境变量 TV_BASE 可改服务器地址。`;

// ---------- args ----------
const argv = process.argv.slice(2);
const command = argv.shift() || "help";
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && !["full", "json", "all", "list", "conv", "new"].includes(name)) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  } else {
    positional.push(arg);
  }
}

// ---------- http ----------
async function api(path) {
  if (!KEY) throw new Error(`找不到 ${join(HERE, "state", "cli.key")}：工作台服务器还没用 -state 启动过`);
  const response = await fetch(BASE + "/api" + path, { headers: { "X-Viewer-Key": KEY } });
  const text = await response.text();
  if (response.status === 401) {
    throw new Error(`工作台未登录或登录已失效：请在浏览器打开 ${BASE}/ 登录一次（之后会自动保持）`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

// ---------- time ----------
const DAY = 86_400_000;
function shanghaiMidnight(dateString) {
  return Date.parse(`${dateString}T00:00:00+08:00`);
}
function resolveDay(value) {
  const today = dayKey(Date.now());
  if (!value || value === "today") return today;
  if (value === "yesterday") return dayKey(shanghaiMidnight(today) - 1);
  return value;
}

async function listRuns({ from, to, limit = 100, maxPages = 10 } = {}) {
  const rows = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (from) query.set("from_at_ms", String(from));
    if (to) query.set("to_at_ms", String(to));
    if (cursor) query.set("cursor", cursor);
    const result = await api("/trajectories?" + query);
    rows.push(...(result.items ?? []));
    if (!result.has_more || !result.next_cursor || rows.length >= limit) break;
    cursor = result.next_cursor;
  }
  return rows.slice(0, limit);
}

async function resolveRun(id) {
  if (!id) throw new Error("缺少 <id>");
  const last = /^last(\d*)$/.exec(id);
  if (last) {
    const nth = Number(last[1] || 1);
    const rows = (await listRuns({ from: Date.now() - 14 * DAY, limit: 100 })).filter((row) => row.run.operation === "foreground");
    if (!rows[nth - 1]) throw new Error(`最近 14 天没有第 ${nth} 条前台运行`);
    return rows[nth - 1].run.id;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  if (/^[a-z_]+_\d+$/i.test(id)) {
    const result = await api("/trajectories?" + new URLSearchParams({ invocation_id: id, limit: "10" }));
    const row = (result.items ?? []).find((item) => !item.run.parent_id) ?? result.items?.[0];
    if (!row) throw new Error(`找不到 Invocation ID ${id}`);
    return row.run.id;
  }
  if (/^[0-9a-f-]{6,}$/i.test(id)) {
    const rows = await listRuns({ from: Date.now() - 30 * DAY, limit: 600, maxPages: 6 });
    const hits = rows.filter((row) => row.run.id.startsWith(id.toLowerCase()));
    if (hits.length === 1) return hits[0].run.id;
    if (hits.length > 1) throw new Error(`前缀 ${id} 对应多条运行：${hits.map((h) => h.run.id).join(", ")}`);
    throw new Error(`最近 30 天找不到以 ${id} 开头的运行`);
  }
  throw new Error(`看不懂的 id：${id}`);
}

const bundleCache = new Map();
async function loadTurn(id, children = true) {
  const runId = await resolveRun(id);
  if (!bundleCache.has(runId)) bundleCache.set(runId, await api(`/bundle/${encodeURIComponent(runId)}`));
  return digestBundle(bundleCache.get(runId), { children });
}

// ---------- text helpers ----------
const FULL = Boolean(flags.full);
function cut(text, max = 600) {
  const value = String(text ?? "");
  if (FULL || value.length <= max) return value;
  return value.slice(0, max) + ` …（共 ${value.length} 字，--full 看全部）`;
}
function oneLine(text, max = 80) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max) + "…" : value;
}
function compactJSON(value, max = 400) {
  if (value === undefined) return "";
  return cut(typeof value === "string" ? value : JSON.stringify(value), max);
}
function indent(text, prefix = "    ") {
  return String(text).split("\n").map((line) => prefix + line).join("\n");
}
const entryLabel = (turn) => {
  const op = OPERATION_LABELS[turn.operation] || turn.operation;
  const source = SOURCE_LABELS[turn.source] || turn.source;
  return [source, op].filter(Boolean).join(" · ");
};

// ---------- commands ----------
async function cmdLs() {
  let from;
  let to;
  if (flags.since) {
    from = shanghaiMidnight(resolveDay(flags.since));
    to = flags.until ? shanghaiMidnight(resolveDay(flags.until)) + DAY : undefined;
  } else {
    const day = resolveDay(flags.day === true ? "today" : flags.day);
    if (flags.day) {
      from = shanghaiMidnight(day);
      to = from + DAY;
    } else {
      from = shanghaiMidnight(day) - DAY; // today + yesterday
    }
  }
  const limit = Number(flags.limit || 40);
  let rows = await listRuns({ from, to, limit });
  if (!flags.all) rows = rows.filter((row) => row.run.operation === "foreground" || row.run.parent_id);
  // Child runs (card confirmations) go right under their parent, oldest first.
  const ids = new Set(rows.map((row) => row.run.id));
  const kids = new Map();
  for (const row of rows) {
    const parent = row.run.parent_id;
    if (parent && ids.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), row]);
  }
  rows = rows.filter((row) => !(row.run.parent_id && ids.has(row.run.parent_id)))
    .flatMap((row) => [row, ...(kids.get(row.run.id) ?? []).sort((a, b) => a.run.started_at_ms - b.run.started_at_ms)]);
  const briefs = await pool(rows, 6, async (row) => {
    const events = (await api(`/trajectories/${row.run.id}/events?limit=500`)).events ?? [];
    let brief = briefFromEvents(row, events);
    const ids = [...brief.smallPayloadIds];
    if (brief.needsRequestForText && brief.firstRequestPayloadId) ids.push(brief.firstRequestPayloadId);
    const small = {};
    await Promise.all(ids.map(async (pid) => {
      try {
        small[pid] = (await api(`/trajectories/${row.run.id}/payloads/${encodeURIComponent(pid)}`)).payload;
      } catch {
        /* missing payload: leave blank */
      }
    }));
    brief = briefFromEvents(row, events, small);
    if (!brief.userText && brief.firstRequestPayloadId && small[brief.firstRequestPayloadId]) {
      const messages = small[brief.firstRequestPayloadId].value?.messages ?? [];
      const user = messages.filter((m) => m.role === "user").at(-1);
      brief.userText = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
    }
    return brief;
  });
  if (flags.json) {
    console.log(JSON.stringify(rows.map((row, i) => ({ run: row.run, state: row.execution_state, integrity: row.integrity, ...briefs[i] })), null, 2));
    return;
  }
  let currentDay = "";
  rows.forEach((row, i) => {
    const brief = briefs[i];
    const day = dayKey(row.run.started_at_ms);
    if (day !== currentDay) {
      currentDay = day;
      console.log(`\n== ${day}（北京时间）`);
    }
    const child = row.run.parent_id ? "  ↳ " : "";
    const state = row.execution_state === "succeeded" ? "" : ` [${statusLabel(row.execution_state)}]`;
    const integrity = row.integrity === "incomplete" ? " [存档不全]" : "";
    const label = OPERATION_LABELS[row.run.operation] || row.run.operation;
    const source = row.run.source && row.run.source !== "my_agent_chat" ? `（${SOURCE_LABELS[row.run.source] || row.run.source}）` : "";
    const facts = row.run.operation === "foreground"
      ? `${brief.rounds}轮 ${brief.tools.length}工具 ${formatDuration(brief.durationMs)}${brief.failures ? ` ✗${brief.failures}` : ""}`
      : formatDuration(brief.durationMs);
    console.log(`${child}${formatTime(row.run.started_at_ms)}  ${row.run.invocation_id || row.run.id.slice(0, 8)}  ${label}${source}${state}${integrity}  ${facts}`);
    if (brief.userText) console.log(`${child}    主人：${oneLine(brief.userText, 70)}`);
    const info = replyStatusInfo(brief.finalStatus);
    if (brief.finalText) console.log(`${child}    回复：${oneLine(brief.finalText, 70)}${info ? `（${info.label}）` : ""}`);
    else if (info) console.log(`${child}    回复：${info.label}`);
    if (brief.tools.length) console.log(`${child}    工具：${[...new Set(brief.tools)].join(", ")}`);
  });
  console.log(`\n共 ${rows.length} 条。看详情：node tv.mjs show <Invocation ID>`);
}

function printTurn(turn, depth = 0) {
  const pad = depth ? "    ".repeat(depth) : "";
  const say = (line = "") => console.log(line ? pad + line : "");
  say(`运行 ${turn.id}${turn.invocationId ? `  ${turn.invocationId}` : ""}${turn.parentId ? `  (父运行 ${turn.parentId.slice(0, 8)})` : ""}`);
  say(`时间 ${formatTime(turn.startedAt, true)}（北京） · ${entryLabel(turn)}${turn.entry.pageRoute ? ` ${turn.entry.pageRoute}` : ""} · ${statusLabel(turn.state)} · 存档${turn.integrity === "complete" ? "完整" : turn.integrity === "incomplete" ? "不全" : turn.integrity || "?"} · 用时 ${formatDuration(turn.durationMs)} · App ${turn.appVersion}`);
  if (turn.rounds.length) {
    const u = turn.usage;
    say(`模型 ${turn.models.join(", ") || "?"} · ${turn.rounds.length} 轮 · ${turn.tools.length} 次工具 · tokens 输入 ${formatTokens(u.prompt)}（缓存命中 ${formatTokens(u.cacheHit)}）/ 输出 ${formatTokens(u.completion)}（思考 ${formatTokens(u.reasoning)}）`);
  }
  if (turn.policy) {
    const excluded = (turn.policy.excluded_tool_names ?? []).map((name) => `${name}(${turn.policy.excluded_tool_reasons?.[name] ?? ""})`).join(", ");
    say(`工具策略 ${turn.policy.tool_policy || ""} · 可用 ${turn.policy.allowed_tool_count ?? "?"}${excluded ? ` · 排除 ${excluded}` : ""}`);
  }
  if (turn.userText) say(`主人：${cut(turn.userText, 400)}`);
  for (const r of turn.rounds) {
    say();
    const usage = r.usage ? ` · 输入 ${formatTokens(r.usage.prompt)} / 输出 ${formatTokens(r.usage.completion)}${r.usage.reasoning ? `（思考 ${formatTokens(r.usage.reasoning)}）` : ""}` : "";
    say(`第 ${r.index} 轮 · ${r.model || "?"}${r.responseModel && r.responseModel !== r.model ? `→${r.responseModel}` : ""} · ${formatDuration(r.latencyMs)}${usage}${r.finishReason ? ` · ${r.finishReason}` : ""}${r.retries ? ` · 重试${r.retries}次` : ""}`);
    if (r.failure) say(`  ✗ 模型失败：${[r.failure.code, r.failure.type, r.failure.stage, r.failure.error].filter(Boolean).join(" · ")}`);
    if (r.reasoning) say(`  思考：${indent(cut(r.reasoning, 900), pad + "        ").trimStart()}`);
    if (r.content) say(`  输出：${indent(cut(r.content, 900), pad + "        ").trimStart()}`);
    for (const tool of r.toolCalls) {
      say(`  调用 ${tool.name} ${compactJSON(tool.args, 500)}`);
      const highlights = resultHighlights(tool.result ?? tool.rawResult).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
      say(`    → ${statusLabel(tool.status)}${tool.businessState ? `/${statusLabel(tool.businessState)}` : ""} ${formatDuration(tool.durationMs)}${highlights ? ` · ${oneLine(highlights, 300)}` : ""}`);
      for (const nested of tool.nested) {
        say(`    ↳ 工具内模型调用「${nested.purpose}」${nested.model} · ${formatDuration(nested.latencyMs)}${nested.failure ? ` · ✗ ${nested.failure.code || nested.failure.type}` : ""}`);
      }
      if (FULL) say(indent(JSON.stringify(tool.result ?? tool.rawResult, null, 2), pad + "      "));
      else say(`      结果：${compactJSON(tool.result ?? tool.rawResult, 300)}`);
    }
  }
  if (turn.reply.text || turn.finalStatus) {
    say();
    const label = { final: "最终发出", model: "模型最后输出", failed: "运行失败，没有记录到发出的回复；模型最后输出" }[turn.reply.kind];
    if (turn.reply.text) say(`${label}：${indent(cut(turn.reply.text, 1200), pad + "          ").trimStart()}`);
    if (turn.replyReplaced) say(`  ⚠ 发出的文本不是模型原文（回复状态 ${turn.finalStatus || "?"}）；模型原文见最后一轮「输出」`);
    else if (turn.finalStatus && turn.finalStatus !== "reply") say(`  回复状态 ${turn.finalStatus}`);
  }
  const sent = turn.delivery.filter((d) => d.kind === "sent");
  if (turn.delivery.length) say(`送达：${turn.delivery.map((d) => `${d.kind} ${formatTime(d.at)}`).join(" → ")}${sent[0]?.meta?.message_id ? ` · message_id ${sent[0].meta.message_id}` : ""}`);
  if (turn.business.length) {
    for (const b of turn.business) {
      say(`${b.kind} ${formatTime(b.at)} ${oneLine(JSON.stringify(b.meta), 200)}${b.value ? ` ${compactJSON(b.value, 300)}` : ""}`);
    }
  }
  if (turn.failures.length) {
    say("失败：");
    for (const f of turn.failures) say(`  ✗ ${formatTime(f.at)} ${f.title}${f.detail ? ` · ${f.detail}` : ""}`);
  }
  if (turn.withheldCount) say(`注意：有 ${turn.withheldCount} 处内容被脱敏（[withheld:…]），看不到原文`);
  if (turn.problems.length) say(`拉取问题：${turn.problems.join("; ")}`);
  for (const child of turn.children) {
    say();
    say(`── 子运行（${OPERATION_LABELS[child.operation] || child.operation}）`);
    printTurn(child, depth + 1);
  }
}

async function cmdShow() {
  const turn = await loadTurn(positional[0]);
  if (flags.json) {
    const strip = (t) => ({
      ...t, events: undefined, payloads: undefined,
      rounds: t.rounds.map((r) => ({ ...r, request: undefined, context: r.context ? { sections: r.context.sections.map((s) => ({ key: s.key, chars: s.chars })), tools: r.context.tools.length } : null })),
      children: t.children.map(strip),
    });
    console.log(JSON.stringify(strip(turn), null, 2));
    return;
  }
  printTurn(turn);
  console.log(`\n网页：${BASE}/#/run/${turn.id}`);
}

function pickRound(turn) {
  const index = Number(flags.round || 1);
  const round = turn.rounds.find((r) => r.index === index);
  if (!round) throw new Error(`没有第 ${index} 轮（共 ${turn.rounds.length} 轮）`);
  if (!round.context) throw new Error(`第 ${index} 轮没有存档请求体`);
  return round;
}

async function cmdCtx() {
  const turn = await loadTurn(positional[0], false);
  const round = pickRound(turn);
  const context = round.context;
  if (flags.section) {
    const section = context.sections.find((s) => s.key === flags.section || s.title.includes(flags.section));
    if (!section) throw new Error(`没有段落 ${flags.section}。可选：${context.sections.map((s) => s.key).join(", ")}`);
    console.log(`# ${section.title}（${section.chars} 字）\n`);
    console.log(FULL ? section.text : cut(section.text, 6000));
    return;
  }
  if (flags.conv || flags.new) {
    const list = flags.new ? context.newConversation ?? context.conversation : context.conversation;
    for (const message of list) {
      const who = { user: "主人", assistant: "Agent", tool: "工具结果" }[message.role] || message.role;
      console.log(`[#${message.index} ${who}${message.toolCallId ? ` ${message.toolCallId}` : ""}]`);
      if (message.reasoning) console.log(indent("思考：" + cut(message.reasoning, 800)));
      if (message.text) console.log(indent(cut(message.text, 1500)));
      for (const call of message.toolCalls) console.log(indent(`调用 ${call.name} ${compactJSON(call.args, 600)}`));
    }
    return;
  }
  console.log(`第 ${round.index} 轮请求 · 模型 ${context.params.model ?? "?"} · ${context.messageCount} 条消息 · 系统提示 ${context.systemChars} 字 · ${context.tools.length} 个工具`);
  console.log(`参数 ${JSON.stringify(context.params)}`);
  if (context.changedSections?.length) console.log(`相比上一轮变化的段落：${context.changedSections.join(", ")}`);
  console.log("");
  for (const section of context.sections) {
    const { header, data } = splitStructured(section.text);
    const extra = data !== undefined ? `（含结构化数据：${Array.isArray(data) ? `${data.length} 条` : "对象"}）` : "";
    console.log(`  ${section.key.padEnd(18)} ${String(section.chars).padStart(6)} 字  ${section.title}${extra}  ${oneLine(header, 50)}`);
  }
  console.log(`\n对话消息 ${context.conversation.length} 条（--conv 查看；--new 只看本轮新增）`);
  console.log(`打印某段：node tv.mjs ctx ${positional[0]} --round ${round.index} --section <key>`);
}

async function cmdTools() {
  const turn = await loadTurn(positional[0], false);
  const round = pickRound(turn);
  const called = new Set(turn.tools.map((t) => t.name));
  const name = positional[1];
  if (name) {
    const tool = round.context.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`本轮没有提供工具 ${name}`);
    console.log(`# ${tool.name}${called.has(name) ? "（本次被调用）" : ""}\n\n${tool.description}\n`);
    console.log(JSON.stringify(tool.parameters, null, 2));
    return;
  }
  console.log(`第 ${round.index} 轮提供了 ${round.context.tools.length} 个工具（★ = 本次调用过）`);
  for (const tool of round.context.tools) {
    console.log(`${called.has(tool.name) ? "★" : " "} ${tool.name.padEnd(46)} ${oneLine(tool.description, 70)}`);
  }
}

async function cmdEvents() {
  const turn = await loadTurn(positional[0], false);
  const start = turn.startedAt;
  for (const event of turn.events) {
    if (flags.kind && !event.kind.startsWith(flags.kind)) continue;
    const meta = { ...(event.metadata ?? {}) };
    delete meta.run_id;
    console.log(`${String(event.seq).padStart(3)} +${String(Math.round((event.at_ms - start))).padStart(6)}ms ${event.kind.padEnd(22)} ${oneLine(JSON.stringify(meta), 150)}${event.payload_id ? "  [有内容]" : ""}`);
  }
}

async function cmdPayload() {
  const turn = await loadTurn(positional[0], false);
  const which = positional[1];
  if (!which) throw new Error("用法：payload <id> <seq|payload_id>");
  const payloadId = /^\d+$/.test(which) ? turn.events.find((e) => e.seq === Number(which))?.payload_id : which;
  const payload = turn.payloads.get(payloadId);
  if (!payload) throw new Error(`事件 ${which} 没有存档内容`);
  console.log(JSON.stringify(payload, null, 2));
}

async function cmdGrep() {
  const pattern = positional[0];
  if (!pattern) throw new Error("用法：grep <正则>");
  const regex = new RegExp(pattern, "i");
  const where = String(flags.in || "all");
  const from = shanghaiMidnight(resolveDay(flags.since || "yesterday"));
  const to = flags.until ? shanghaiMidnight(resolveDay(flags.until)) + DAY : undefined;
  const rows = (await listRuns({ from, to, limit: Number(flags.limit || 60) })).filter((row) => flags.all || row.run.operation === "foreground");
  let hits = 0;
  await pool(rows, 3, async (row) => {
    const bundle = await api(`/bundle/${row.run.id}?depth=0`);
    const turn = digestBundle(bundle, { children: false });
    const found = [];
    const check = (label, text) => {
      const value = typeof text === "string" ? text : JSON.stringify(text ?? "");
      const match = regex.exec(value);
      if (match) found.push(`${label}: …${oneLine(value.slice(Math.max(0, match.index - 40), match.index + 80), 140)}…`);
    };
    if (["all", "user"].includes(where)) check("主人", turn.userText);
    if (["all", "final"].includes(where)) check("最终回复", turn.finalText || turn.lastModelText);
    for (const r of turn.rounds) {
      if (["all", "think"].includes(where)) check(`第${r.index}轮思考`, r.reasoning);
      if (["all", "final", "think"].includes(where)) check(`第${r.index}轮输出`, r.content);
      if (["all", "tools"].includes(where)) {
        for (const tool of r.toolCalls) {
          check(`${tool.name} 参数`, tool.args);
          check(`${tool.name} 结果`, tool.result ?? tool.rawResult);
        }
      }
    }
    if (["all", "context"].includes(where)) {
      for (const section of turn.rounds[0]?.context?.sections ?? []) check(`上下文 ${section.key}`, section.text);
    }
    if (found.length) {
      hits++;
      console.log(`\n${formatTime(turn.startedAt, true)}  ${turn.invocationId || turn.id}  主人：${oneLine(turn.userText, 40)}`);
      for (const line of found.slice(0, 6)) console.log(`  ${line}`);
      if (found.length > 6) console.log(`  …另有 ${found.length - 6} 处`);
    }
  });
  console.log(`\n${rows.length} 条运行里有 ${hits} 条命中。`);
}

async function cmdUrl() {
  const runId = await resolveRun(positional[0]);
  console.log(`${BASE}/#/run/${runId}`);
}

const COMMANDS = { ls: cmdLs, show: cmdShow, ctx: cmdCtx, tools: cmdTools, events: cmdEvents, payload: cmdPayload, grep: cmdGrep, url: cmdUrl };
if (command === "help" || command === "--help" || !COMMANDS[command]) {
  console.log(HELP);
  process.exit(command === "help" || command === "--help" ? 0 : 1);
}
try {
  await COMMANDS[command]();
} catch (error) {
  console.error("tv: " + error.message);
  process.exit(1);
}
