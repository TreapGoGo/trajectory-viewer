// node --test digest.test.mjs — offline checks of the trajectory digest.
import assert from "node:assert/strict";
import test from "node:test";
import { digestBundle, replyStatusInfo } from "./ui/digest.js";

const MAIN = "Agent 主循环（原生工具调用）";
let seq = 0;
const at = (s) => 1_000_000 + s * 1000;
const ev = (kind, t, metadata = {}, extra = {}) => ({ seq: ++seq, kind, at_ms: at(t), metadata, ...extra });

function bundle() {
  seq = 0;
  const events = [
    ev("run.accepted", 0, { entry_point: "my_agent_chat", source_page_route: "/contacts/my-agent-chat" }),
    ev("span.started", 0, { operation: "chat" }, { span_id: "chat" }),
    ev("execution.observed", 0, { stage: "reply loop start" }, { payload_id: "p-loop" }),
    ev("execution.observed", 0, { stage: "llm round request" }, { payload_id: "p-r1" }),
    ev("span.started", 0, { operation: "model_operation", parent_span_id: "chat" }, { span_id: "mo1" }),
    ev("model.requested", 0, { purpose: MAIN, requested_model: "m1", attempt_id: "a1" }, { span_id: "a1", payload_id: "p-req1" }),
    ev("model.responded", 5, { elapsed_ms: 5000, attempt_id: "a1" }, { span_id: "a1", payload_id: "p-res1" }),
    ev("span.started", 5, { operation: "tool", parent_span_id: "chat" }, { span_id: "tool1" }),
    ev("tool.requested", 5, { tool_call_id: "c1", tool_name: "upsert_memory_entry" }, { span_id: "tool1", payload_id: "p-args" }),
    ev("tool.started", 5, { tool_call_id: "c1", tool_name: "upsert_memory_entry" }, { span_id: "tool1" }),
    ev("span.started", 5, { operation: "model_operation", parent_span_id: "tool1" }, { span_id: "mo2" }),
    ev("model.requested", 5, { purpose: "Remark 语义合并", requested_model: "m1", attempt_id: "a2" }, { span_id: "a2", payload_id: "p-merge" }),
    ev("model.failed", 50, { attempt_id: "a2", elapsed_ms: 45000, failure_code: "client_receive_timeout" }, { span_id: "a2" }),
    ev("tool.finished", 50, { tool_call_id: "c1", tool_name: "upsert_memory_entry", execution_state: "failed" }, { span_id: "tool1", payload_id: "p-result" }),
    ev("execution.observed", 50, { stage: "llm round request" }, { payload_id: "p-r2" }),
    ev("model.requested", 50, { purpose: MAIN, requested_model: "m1", attempt_id: "a3" }, { span_id: "a3", payload_id: "p-req2" }),
    ev("model.failed", 52, { attempt_id: "a3", elapsed_ms: 2000, failure_code: "client_deadline_exceeded" }, { span_id: "a3" }),
    ev("run.finished", 52, { execution_state: "failed", error_type: "AgentModelRequestFailure" }),
  ];
  const request = (extra = []) => ({
    model: "m1",
    messages: [
      { role: "system", content: "你是 Agent" },
      { role: "system", content: "规则正文" },
      { role: "user", content: "帮我把张三的备注改成张老师" },
      ...extra,
    ],
    tools: [{ type: "function", function: { name: "upsert_memory_entry", description: "写记忆", parameters: {} } }],
  });
  return {
    id: "run-1",
    detail: { execution_state: "failed", integrity: "complete", run: { id: "run-1", operation: "foreground", started_at_ms: at(0) } },
    events,
    payloads: {
      "p-loop": { value: { prompt_sections: ["role", "rule"] } },
      "p-r1": { value: { round: 1, message_count: 3 } },
      "p-r2": { value: { round: 2, message_count: 5 } },
      "p-req1": { value: request() },
      "p-res1": { value: { choices: [{ finish_reason: "tool_calls", message: { content: "我来改备注。", reasoning_content: "先写入",
        tool_calls: [{ id: "c1", function: { name: "upsert_memory_entry", arguments: "{\"value\":\"张老师\"}" } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } } },
      "p-args": { value: { arguments: { value: "张老师" } } },
      "p-merge": { value: { messages: [] } },
      "p-result": { value: { ok: false, code: "tool_execution_failed", message: "等待模型回复超时。", error: "[withheld:error_text]" } },
      "p-req2": { value: request([{ role: "assistant", tool_calls: [{ id: "c1", function: { name: "upsert_memory_entry", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "{}" }]) },
    },
    children: [],
  };
}

test("rounds, tools and nested model calls are reconstructed", () => {
  const turn = digestBundle(bundle());
  assert.equal(turn.userText, "帮我把张三的备注改成张老师");
  assert.equal(turn.rounds.length, 2);
  assert.equal(turn.rounds[0].reasoning, "先写入");
  assert.equal(turn.rounds[0].toolCalls.length, 1);
  const tool = turn.rounds[0].toolCalls[0];
  assert.equal(tool.name, "upsert_memory_entry");
  assert.deepEqual(tool.args, { value: "张老师" });
  assert.equal(tool.status, "failed");
  assert.equal(tool.nested.length, 1, "the merge call belongs to the tool, not to a round");
  assert.equal(tool.nested[0].failure.code, "client_receive_timeout");
  assert.equal(turn.rounds[1].failure.code, "client_deadline_exceeded");
});

test("failures are listed once per step and a failed run does not claim it replied", () => {
  const turn = digestBundle(bundle());
  const titles = turn.failures.map((f) => f.title);
  assert.equal(titles.filter((t) => t.includes("Remark 语义合并")).length, 1);
  assert.equal(titles.filter((t) => t.includes("upsert_memory_entry")).length, 1);
  assert.equal(titles.filter((t) => t.includes("第 2 轮")).length, 1);
  assert.equal(titles.filter((t) => t.includes("整次运行失败")).length, 1);
  assert.equal(turn.reply.kind, "failed");
  assert.equal(turn.withheldCount, 1);
});

test("context sections use the recorded prompt section names and round 2 shows only new messages", () => {
  const turn = digestBundle(bundle());
  assert.deepEqual(turn.rounds[0].context.sections.map((s) => s.key), ["role", "rule"]);
  assert.equal(turn.rounds[1].context.changedSections.length, 0);
  assert.deepEqual(turn.rounds[1].context.newConversation.map((m) => m.role), ["assistant", "tool"]);
});

test("reply status labels", () => {
  assert.equal(replyStatusInfo("reply"), null);
  assert.equal(replyStatusInfo("llm_final_text"), null);
  assert.equal(replyStatusInfo("schedule_read_reply").tone, "warn");
  assert.equal(replyStatusInfo("cron_task_draft_presented").card, true);
});
