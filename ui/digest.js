// Turns a run bundle ({detail, events, payloads, children}) from /api/bundle/{id}
// into a readable "turn": who asked what, what the model saw, what it thought,
// said and called, what each tool returned, and what was finally delivered.
// Pure functions only — shared by the web workbench (app.js) and the CLI (tv.mjs).

export const MAIN_PURPOSE = "Agent 主循环（原生工具调用）";
export const TIME_ZONE = "Asia/Shanghai";
export const WITHHELD = /\[withheld:[^\]]*\]/;

export const SECTION_TITLES = {
  role: "Role · 身份",
  rule: "Rule · 规则",
  style: "Style · 表达风格",
  sop: "SOP · 工作流程",
  memory: "记忆",
  kyh: "KYH 记忆",
  topics: "Key Topics",
  recent: "Recent · 最近聊天",
  recentCalendar: "Recent · 日程",
  recentContacts: "Recent · 最近联系人",
  invocationContext: "调用上下文",
  pageContext: "本轮 Page",
  toolPolicy: "工具与确认说明（代码附加）",
};

export const OPERATION_LABELS = {
  foreground: "对话",
  "card.confirm": "点了确认卡",
  "card.cancel": "点了取消",
  owner_message_bridge: "代发消息桥接",
  initial_talk: "初次对话",
  try_agent: "试用 Agent",
};

export const SOURCE_LABELS = {
  my_agent_chat: "MyAgent 私聊",
  global_agent_voice: "语音入口",
  owner_message_bridge: "代发桥接",
};

const STATUS_LABELS = {
  succeeded: "成功",
  failed: "失败",
  running: "进行中",
  interrupted: "中断",
  needs_confirmation: "待确认",
  prepared: "已准备",
  pending: "待处理",
  cancelled: "已取消",
  canceled: "已取消",
  partial_failure: "部分失败",
};

export const statusLabel = (value) => STATUS_LABELS[value] || value || "—";

const CARD_STATUSES = {
  cron_task_draft_presented: "定时任务草稿卡",
  cron_task_change_presented: "定时任务修改卡",
  calendar_event_draft_presented: "日程草稿卡",
};

// How a run ended its reply ("reply request finish".status), in plain words.
// Returns null for an ordinary text reply.
export function replyStatusInfo(status) {
  if (!status || status === "reply" || status === "llm_final_text") return null;
  if (status === "schedule_read_reply") return { label: "客户端列表代答", tone: "warn", note: "手机上显示的是客户端拼出来的列表，不是模型原文" };
  if (status === "llm_round_failed") return { label: "模型失败", tone: "bad" };
  if (CARD_STATUSES[status]) return { label: CARD_STATUSES[status], tone: "accent", card: true };
  if (status.endsWith("_presented")) return { label: "出了卡片", tone: "accent", card: true };
  return { label: status, tone: "" };
}

// ---------- small helpers ----------

export function parseJSON(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

export function payloadMap(bundle) {
  const map = new Map();
  for (const [id, raw] of Object.entries(bundle?.payloads ?? {})) {
    const payload = raw && typeof raw === "object" ? raw : {};
    map.set(id, {
      value: payload.value,
      incomplete: Boolean(payload.incomplete),
      redacted: Array.isArray(payload.redacted_paths) ? payload.redacted_paths : [],
      error: payload.error || "",
    });
  }
  return map;
}

const isFailureState = (value) => value === "failed" || value === "partial_failure";

export function failureType(event) {
  const meta = event.metadata ?? {};
  switch (event.kind) {
    case "run.finished":
      return meta.execution_state === "failed" ? "run" : "";
    case "span.failed":
    case "model.failed":
    case "delivery.failed":
      return "step";
    case "model.responded":
      return Number.isInteger(meta.status) && meta.status >= 400 ? "step" : "";
    case "tool.finished":
      return isFailureState(meta.execution_state) || isFailureState(meta.business_state) ? "step" : "";
    case "business.receipt":
    case "business.summary":
    case "confirmation.finished":
      return isFailureState(meta.delivery_state) || isFailureState(meta.business_state) ? "step" : "";
    default:
      return "";
  }
}

export function formatTime(ms, withDate = false) {
  if (!Number.isFinite(ms)) return "—";
  const options = { timeZone: TIME_ZONE, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" };
  if (withDate) Object.assign(options, { year: "numeric", month: "2-digit", day: "2-digit" });
  return new Intl.DateTimeFormat("zh-CN", options).format(ms).replace(/\//g, "-");
}

export function dayKey(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value);
}

// Interesting fields of a tool result, in reading order.
const RESULT_KEYS = ["ok", "code", "reason_code", "message", "error", "phase", "status", "found",
  "presented", "card_presented", "confirmation_required", "missing_fields", "clarification",
  "available", "returned_count", "total_count", "relationship_state", "is_existing_contact", "request_id", "draft_id"];

export function resultHighlights(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  return RESULT_KEYS.filter((key) => key in result && result[key] !== "" && result[key] != null)
    .map((key) => [key, result[key]]);
}

// ---------- context sections ----------

// Archives from builds that do not record prompt_sections fall back to the
// section's own first line as its title.
function firstLine(text) {
  const line = String(text).trim().split("\n")[0].replace(/[：:]\s*$/, "").trim();
  return line.length > 24 ? line.slice(0, 24) + "…" : line;
}

// Splits "header text\n[json]" so structured parts can be rendered nicely.
export function splitStructured(text) {
  const match = /\n\s*([[{])/.exec(text);
  if (!match) return { header: text, data: undefined };
  const start = match.index + match[0].length - 1;
  const data = parseJSON(text.slice(start).trim());
  if (typeof data === "string") return { header: text, data: undefined };
  return { header: text.slice(0, match.index).trim(), data };
}

export function contextOf(request, sectionKeys = []) {
  if (!request || !Array.isArray(request.messages)) return null;
  const messages = request.messages;
  const systemCount = messages.filter((m) => m.role === "system" || m.role === "developer").length;
  const useKeys = sectionKeys.length === systemCount;
  let systemIndex = 0;
  const sections = [];
  const conversation = [];
  messages.forEach((message, index) => {
    const text = messageText(message.content);
    if (message.role === "system" || message.role === "developer") {
      const known = useKeys ? sectionKeys[systemIndex] : "";
      const key = known || `system${systemIndex + 1}`;
      systemIndex += 1;
      sections.push({ index, key, title: SECTION_TITLES[key] || (known ? key : firstLine(text) || key), text, chars: text.length });
    } else {
      conversation.push({
        index, role: message.role, text,
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id, name: call.function?.name, args: parseJSON(call.function?.arguments),
        })),
        toolCallId: message.tool_call_id || "",
        reasoning: message.reasoning_content || "",
      });
    }
  });
  const tools = (request.tools ?? []).map((tool) => ({
    name: tool.function?.name ?? tool.name ?? "",
    description: tool.function?.description ?? tool.description ?? "",
    parameters: tool.function?.parameters ?? tool.parameters ?? {},
  }));
  const params = {};
  for (const [key, value] of Object.entries(request)) {
    if (!["messages", "tools"].includes(key)) params[key] = value;
  }
  return {
    sections, conversation, tools, params,
    systemChars: sections.reduce((sum, section) => sum + section.chars, 0),
    messageCount: messages.length,
  };
}

// ---------- the main digest ----------

function newRound(index, at) {
  return {
    index, startAt: at, endAt: undefined, requestSeq: 0, requestPayloadId: "", messageCount: undefined,
    model: "", responseModel: "", finishReason: "", usage: null, latencyMs: undefined, ttfbMs: undefined,
    reasoning: "", content: "", toolCalls: [], failure: null, request: undefined,
  };
}

function newTool(id, name, round) {
  return {
    id, name, round, args: undefined, startAt: undefined, endAt: undefined, durationMs: undefined,
    status: "", businessState: "", result: undefined, rawResult: undefined, nested: [], seq: 0,
  };
}

export function digestBundle(bundle, options = {}) {
  const detail = bundle?.detail ?? {};
  const run = detail.run ?? {};
  const payloads = payloadMap(bundle);
  const events = [...(bundle?.events ?? [])].sort((a, b) => a.seq - b.seq);
  const value = (event) => (event?.payload_id ? payloads.get(event.payload_id)?.value : undefined);

  const turn = {
    id: run.id || bundle?.id || "", invocationId: run.invocation_id || "", parentId: run.parent_id || "",
    operation: run.operation || "", source: run.source || "", appVersion: run.app_version || "",
    agentUid: run.agent_uid || "",
    state: detail.execution_state || "", integrity: detail.integrity || "",
    terminalConflict: Boolean(detail.terminal_conflict),
    startedAt: run.started_at_ms ?? events[0]?.at_ms, endedAt: undefined, durationMs: undefined,
    entry: {}, userText: "", userTextSource: "",
    rounds: [], tools: [], finalText: "", finalStatus: "", lastModelText: "", replyReplaced: false,
    policy: null, loop: null, stages: [], delivery: [], business: [], failures: [], misc: [],
    usage: { prompt: 0, completion: 0, reasoning: 0, cacheHit: 0, cacheMiss: 0 },
    models: [], events, payloads, children: [], problems: bundle?.problems ?? [],
    redacted: [], withheldCount: 0,
  };

  // Span tree, so model calls made inside a tool can be attached to that tool.
  const spans = new Map();
  const toolBySpan = new Map();
  for (const event of events) {
    if (event.kind === "span.started" && event.span_id) {
      spans.set(event.span_id, { parent: event.metadata?.parent_span_id || "", operation: event.metadata?.operation || "" });
    }
    if (event.kind === "tool.requested" && event.span_id && event.metadata?.tool_call_id) {
      toolBySpan.set(event.span_id, event.metadata.tool_call_id);
    }
  }
  const owningTool = (spanId) => {
    let current = spans.get(spanId)?.parent;
    for (let guard = 0; current && guard < 20; guard++) {
      if (toolBySpan.has(current)) return toolBySpan.get(current);
      current = spans.get(current)?.parent;
    }
    return "";
  };

  const toolsById = new Map();
  const toolFor = (id, name, round) => {
    if (!toolsById.has(id)) {
      const tool = newTool(id, name, round);
      toolsById.set(id, tool);
      turn.tools.push(tool);
      const target = turn.rounds.find((r) => r.index === round) ?? turn.rounds.at(-1);
      target?.toolCalls.push(tool);
    }
    const tool = toolsById.get(id);
    if (name && !tool.name) tool.name = name;
    return tool;
  };
  const nestedByAttempt = new Map();
  let round = null;
  let openTool = null;
  const stageStarts = new Map();
  const ensureRound = (at, index) => {
    if (!round || (index && round.index !== index)) {
      round = newRound(index || turn.rounds.length + 1, at);
      turn.rounds.push(round);
    }
    return round;
  };

  for (const event of events) {
    const meta = event.metadata ?? {};
    const payload = event.payload_id ? payloads.get(event.payload_id) : undefined;
    if (payload?.redacted?.length) turn.redacted.push({ seq: event.seq, paths: payload.redacted });
    const v = payload?.value;
    turn.endedAt = Math.max(turn.endedAt ?? 0, event.at_ms ?? 0) || turn.endedAt;

    switch (event.kind) {
      case "run.accepted":
        turn.entry = {
          entryPoint: meta.entry_point || "", pageRoute: meta.source_page_route || "",
          pageTitle: meta.source_page_title || "", pageFeature: meta.source_page_feature || "",
          channelType: meta.source_channel_type, channelId: meta.source_channel_id || "",
          sessionId: meta.source_session_id || "", modelProfile: meta.model_profile_id || "",
        };
        break;
      case "execution.observed": {
        const stage = meta.stage || "";
        if (stage === "llm round request") {
          round = newRound(v?.round || turn.rounds.length + 1, event.at_ms);
          round.messageCount = v?.message_count;
          turn.rounds.push(round);
        } else if (stage === "llm round response" && v) {
          const r = ensureRound(event.at_ms, v.round);
          if (!r.content && v.assistant_text) r.content = v.assistant_text;
          if (Number.isFinite(v.elapsed_ms)) r.latencyMs ??= v.elapsed_ms;
          for (const call of v.tool_calls ?? []) {
            const tool = toolFor(call.id, call.name, r.index);
            tool.args ??= call.arguments;
          }
        } else if (stage === "llm round failed") {
          const r = ensureRound(event.at_ms, v?.round);
          r.failure = { ...(r.failure ?? {}), stage: "llm round failed", error: v?.error ?? "", elapsedMs: v?.elapsed_ms };
          r.endAt ??= event.at_ms;
        } else if (stage === "tool call start" && v) {
          const tool = toolFor(v.call_id, v.tool, v.round);
          tool.args ??= v.arguments;
        } else if (stage === "tool call result" && v) {
          const tool = toolFor(v.call_id, v.tool, v.round);
          tool.result = v.result;
          tool.durationMs ??= v.elapsed_ms;
          tool.status ||= v.tool_status || "";
        } else if (stage === "tool policy selected") {
          turn.policy = v ?? null;
        } else if (stage === "reply loop start") {
          turn.loop = v ?? null;
        } else if (stage === "reply loop finish") {
          if (typeof v?.final_text === "string") turn.finalText = v.final_text;
        } else if (stage === "reply request finish") {
          turn.finalStatus = v?.status || turn.finalStatus;
          if (v?.error) turn.misc.push({ seq: event.seq, at: event.at_ms, label: "回复请求结束", value: v });
        } else if (stage.startsWith("topic preload")) {
          if (!turn.userText && typeof v?.input === "string") {
            turn.userText = v.input;
            turn.userTextSource = "topic";
          }
          turn.misc.push({ seq: event.seq, at: event.at_ms, label: stage, value: v });
        } else if (stage === "chat stage start") {
          stageStarts.set(v?.stage, event.at_ms);
        } else if (stage === "chat stage finish" || stage === "chat stage failed") {
          const name = v?.stage || "";
          turn.stages.push({ name, startAt: stageStarts.get(name) ?? event.at_ms, endAt: event.at_ms, failed: stage.endsWith("failed"), error: v?.error });
        } else if (stage) {
          turn.misc.push({ seq: event.seq, at: event.at_ms, label: stage, value: v });
        }
        break;
      }
      case "model.requested": {
        const nestedIn = owningTool(event.span_id) || (meta.purpose && meta.purpose !== MAIN_PURPOSE && openTool ? openTool.id : "");
        if (nestedIn) {
          const call = {
            attemptId: meta.attempt_id || event.span_id, purpose: meta.purpose || "", model: meta.requested_model || "",
            startAt: event.at_ms, endAt: undefined, latencyMs: undefined, failure: null,
            requestPayloadId: event.payload_id || "", request: v, content: "", reasoning: "",
          };
          toolsById.get(nestedIn)?.nested.push(call);
          nestedByAttempt.set(call.attemptId, call);
          break;
        }
        const r = ensureRound(event.at_ms);
        if (r.requestSeq) {
          // A retry inside the same round: keep the latest request.
          r.retries = (r.retries ?? 0) + 1;
        }
        r.requestSeq = event.seq;
        r.requestPayloadId = event.payload_id || "";
        r.request = v;
        r.model = meta.requested_model || r.model;
        if (r.model && !turn.models.includes(r.model)) turn.models.push(r.model);
        if (!turn.userText && Array.isArray(v?.messages)) {
          const users = v.messages.filter((m) => m.role === "user");
          if (users.length) {
            turn.userText = messageText(users.at(-1).content);
            turn.userTextSource = "request";
          }
        }
        break;
      }
      case "model.responded":
      case "model.failed": {
        const nested = nestedByAttempt.get(meta.attempt_id);
        const message = v?.choices?.[0]?.message;
        if (nested) {
          nested.endAt = event.at_ms;
          nested.latencyMs = meta.elapsed_ms;
          if (event.kind === "model.failed") nested.failure = { code: meta.failure_code || "", type: meta.error_type || "" };
          nested.content = messageText(message?.content);
          nested.reasoning = message?.reasoning_content || "";
          break;
        }
        const r = ensureRound(event.at_ms);
        r.endAt = event.at_ms;
        r.latencyMs = meta.elapsed_ms ?? r.latencyMs;
        r.ttfbMs = meta.time_to_first_byte_ms;
        if (event.kind === "model.failed") {
          r.failure = { ...(r.failure ?? {}), code: meta.failure_code || "", type: meta.error_type || "", elapsedMs: meta.elapsed_ms };
          break;
        }
        if (Number.isInteger(meta.status) && meta.status >= 400) {
          r.failure = { ...(r.failure ?? {}), code: `HTTP ${meta.status}`, type: meta.upstream_status ? `upstream ${meta.upstream_status}` : "" };
        }
        r.responseModel = meta.response_model || v?.model || "";
        r.finishReason = v?.choices?.[0]?.finish_reason || (meta.finish_reasons ?? [])[0] || "";
        if (message) {
          r.reasoning = message.reasoning_content || r.reasoning;
          const content = messageText(message.content);
          if (content) r.content = content;
          for (const call of message.tool_calls ?? []) {
            const tool = toolFor(call.id, call.function?.name, r.index);
            tool.args ??= parseJSON(call.function?.arguments);
          }
        }
        const usage = v?.usage ?? meta.usage;
        if (usage) {
          r.usage = {
            prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0,
            reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
            cacheHit: usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheMiss: usage.prompt_cache_miss_tokens ?? 0,
          };
          for (const key of Object.keys(turn.usage)) turn.usage[key] += r.usage[key] ?? 0;
        }
        break;
      }
      case "tool.requested": {
        const tool = toolFor(meta.tool_call_id, meta.tool_name, round?.index);
        tool.seq ||= event.seq;
        if (v?.arguments !== undefined) tool.args = v.arguments;
        break;
      }
      case "tool.started": {
        const tool = toolFor(meta.tool_call_id, meta.tool_name, round?.index);
        tool.startAt = event.at_ms;
        openTool = tool;
        break;
      }
      case "tool.result.raw": {
        const tool = toolFor(meta.tool_call_id, meta.tool_name, round?.index);
        tool.rawResult = v;
        break;
      }
      case "tool.finished": {
        const tool = toolFor(meta.tool_call_id, meta.tool_name, round?.index);
        tool.endAt = event.at_ms;
        tool.status = meta.execution_state || tool.status;
        tool.businessState = meta.business_state || "";
        if (tool.result === undefined) tool.result = v;
        if (openTool === tool) openTool = null;
        break;
      }
      case "run.finished":
        turn.state ||= meta.execution_state || "";
        if (meta.execution_state === "failed") turn.runError = meta.error_type || "";
        break;
      default:
        if (event.kind.startsWith("delivery.")) {
          turn.delivery.push({ seq: event.seq, at: event.at_ms, kind: event.kind.slice(9), meta, value: v });
        } else if (/^(confirmation|business|card|ui)\./.test(event.kind)) {
          turn.business.push({ seq: event.seq, at: event.at_ms, kind: event.kind, meta, value: v });
        }
    }

    // Model, tool and round failures are reported from the reconstructed steps
    // below; only failures with no step of their own are taken from raw events.
    if (event.kind === "run.finished" && meta.execution_state === "failed") {
      turn.failures.push({ seq: event.seq, at: event.at_ms, kind: "run", title: "整次运行失败", detail: meta.error_type || "" });
    } else if (failureType(event) && !["model.failed", "model.responded", "tool.finished", "span.failed", "run.finished"].includes(event.kind)) {
      turn.failures.push({
        seq: event.seq, at: event.at_ms, kind: event.kind,
        title: failureTitle(event), detail: meta.failure_code || meta.error_type || meta.delivery_state || meta.business_state || "",
      });
    } else if (event.kind === "span.failed" && !["model", "model_operation", "tool", "chat"].includes(meta.operation)) {
      turn.failures.push({ seq: event.seq, at: event.at_ms, kind: event.kind, title: failureTitle(event), detail: meta.error_type || "" });
    }
  }

  for (const tool of turn.tools) {
    tool.durationMs ??= Number.isFinite(tool.startAt) && Number.isFinite(tool.endAt) ? tool.endAt - tool.startAt : undefined;
    const result = tool.result ?? tool.rawResult;
    tool.ok = result && typeof result === "object" ? result.ok : undefined;
    tool.errorCode = (result && typeof result === "object" && (result.code || result.reason_code)) || "";
    if (tool.status === "failed" || tool.ok === false) {
      const message = result && typeof result === "object" && typeof result.message === "string" ? result.message : "";
      turn.failures.push({ seq: tool.seq, at: tool.endAt, kind: "tool", toolId: tool.id,
        title: `工具 ${tool.name} ${tool.status === "failed" ? "执行失败" : "返回 ok=false"}`,
        detail: [tool.errorCode, message].filter(Boolean).join(" · ") });
    }
    for (const nested of tool.nested) {
      if (nested.failure) {
        turn.failures.push({ seq: tool.seq, at: nested.endAt, kind: "nested", title: `工具内模型调用「${nested.purpose}」失败`,
          detail: `${nested.failure.code || nested.failure.type} · ${formatDuration(nested.latencyMs)}` });
      }
    }
  }
  for (const r of turn.rounds) {
    if (r.failure) {
      turn.failures.push({ seq: r.requestSeq, at: r.endAt, kind: "round", title: `第 ${r.index} 轮模型调用失败`,
        detail: r.failure.code || r.failure.type || r.failure.stage || "" });
    }
  }
  turn.failures.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  turn.durationMs = Number.isFinite(turn.startedAt) && Number.isFinite(turn.endedAt) ? turn.endedAt - turn.startedAt : undefined;
  turn.lastModelText = [...turn.rounds].reverse().find((r) => r.content)?.content ?? "";
  const normalize = (text) => String(text ?? "").replace(/\s+/g, "");
  turn.replyReplaced = Boolean(turn.finalText && turn.lastModelText && normalize(turn.finalText) !== normalize(turn.lastModelText));
  turn.delivered = turn.delivery.some((d) => d.kind === "sent");
  // What the owner most likely saw: the recorded final text; without one, a
  // failed run shows an error instead of the model's last words.
  turn.replyStatus = replyStatusInfo(turn.finalStatus);
  const cardTool = [...turn.tools].reverse().find((tool) => {
    const result = tool.result ?? tool.rawResult;
    return (result && typeof result === "object" && (result.card_presented || result.draft_presented || result.card_id || result.draft_id)) ||
      (tool.args && typeof tool.args === "object" && tool.args.intro_text);
  });
  const cardIntro = cardTool ? (cardTool.args?.intro_text || (cardTool.result ?? cardTool.rawResult)?.intro_text || "") : "";
  turn.reply = turn.finalText
    ? { text: turn.finalText, kind: "final" }
    : turn.state === "failed"
      ? { text: turn.lastModelText, kind: "failed" }
      : turn.replyStatus?.card && cardTool
        ? { text: cardIntro || turn.lastModelText, kind: "card", tool: cardTool.name, card: turn.replyStatus.label }
        : { text: turn.lastModelText, kind: "model" };

  const sectionKeys = turn.loop?.prompt_sections ?? [];
  for (const r of turn.rounds) r.context = contextOf(r.request, sectionKeys);
  for (let i = 1; i < turn.rounds.length; i++) {
    const before = turn.rounds[i - 1].context;
    const after = turn.rounds[i].context;
    if (!before || !after) continue;
    after.changedSections = after.sections.filter((section) => {
      const same = before.sections.find((s) => s.key === section.key);
      return !same || same.text !== section.text;
    }).map((section) => section.key);
    after.newConversation = after.conversation.filter((m) => m.index >= before.messageCount);
  }

  const withheld = JSON.stringify(bundle?.payloads ?? {}).match(/\[withheld:[^\]]*\]/g);
  turn.withheldCount = withheld ? withheld.length : 0;

  if (options.children !== false) {
    turn.children = (bundle?.children ?? []).map((child) => digestBundle(child, options));
  }
  return turn;
}

function failureTitle(event) {
  const meta = event.metadata ?? {};
  switch (event.kind) {
    case "run.finished": return "整次运行失败";
    case "model.failed": return `模型调用失败（${meta.purpose || "主循环"}）`;
    case "tool.finished": return `工具 ${meta.tool_name || ""} 失败`;
    case "delivery.failed": return "消息送达失败";
    case "span.failed": return `步骤失败（${meta.operation || meta.purpose || ""}）`;
    default: return event.kind;
  }
}

// One-line facts for lists: cheap to compute from events plus a few small payloads.
export function briefFromEvents(row, events, smallPayloads = {}) {
  const meta = (kind) => events.filter((e) => e.kind === kind).map((e) => e.metadata ?? {});
  const stage = (name) => events.find((e) => e.kind === "execution.observed" && e.metadata?.stage === name);
  const value = (event) => (event ? smallPayloads[event.payload_id]?.value : undefined);
  const mainRequests = events.filter((e) => e.kind === "model.requested" && (e.metadata?.purpose ?? MAIN_PURPOSE) === MAIN_PURPOSE);
  const roundStarts = events.filter((e) => e.kind === "execution.observed" && e.metadata?.stage === "llm round request").length;
  const topic = events.find((e) => e.kind === "execution.observed" && String(e.metadata?.stage).startsWith("topic preload"));
  const first = events[0]?.at_ms;
  const last = events.reduce((max, e) => Math.max(max, e.at_ms ?? 0), 0);
  return {
    userText: value(topic)?.input ?? "",
    finalText: value(stage("reply loop finish"))?.final_text ?? "",
    finalStatus: value(stage("reply request finish"))?.status ?? "",
    rounds: roundStarts || mainRequests.length,
    tools: meta("tool.requested").map((m) => m.tool_name).filter(Boolean),
    models: [...new Set(meta("model.requested").map((m) => m.requested_model).filter(Boolean))],
    failures: events.filter((e) => failureType(e)).length,
    durationMs: Number.isFinite(first) && last ? last - first : undefined,
    entry: events.find((e) => e.kind === "run.accepted")?.metadata ?? {},
    needsRequestForText: !topic,
    firstRequestPayloadId: mainRequests[0]?.payload_id ?? "",
    smallPayloadIds: [topic, stage("reply loop finish"), stage("reply request finish")].filter(Boolean).map((e) => e.payload_id),
  };
}
