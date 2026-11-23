import test from "node:test";
import assert from "node:assert/strict";
import { eventPages, failureType, filterEvents, searchPrompts } from "./web/trajectory-tools.js";

test("finds a literal prompt on later trajectory and event pages", async () => {
  const requests = [];
  const runRow = (id) => ({ run: { id }, integrity: "complete" });
  const model = (seq, payload_id) => ({ seq, kind: "model.requested", payload_id });
  const read = async (path) => {
    requests.push(path);
    const url = new URL(path, "http://fixture.test");
    if (url.pathname === "/trajectories") {
      assert.equal(url.searchParams.get("from_at_ms"), "1000");
      assert.equal(url.searchParams.get("status"), "failed");
      assert.equal(url.searchParams.has("prompt"), false);
      return url.searchParams.has("cursor")
        ? { items: [runRow("hit")], has_more: false }
        : { items: [runRow("limited"), runRow("different-role")], has_more: true, next_cursor: "second" };
    }
    if (url.pathname === "/trajectories/limited/events") return { events: [model(2, "")] };
    if (url.pathname === "/trajectories/different-role/events") return { events: [model(2, "only-system")] };
    if (url.pathname.endsWith("/payloads/only-system")) {
      return { payload: { value: { messages: [{ role: "system", content: "Fix [Draft] now" }] } } };
    }
    if (url.pathname === "/trajectories/hit/events") {
      return url.searchParams.get("after_seq") === "0"
        ? { events: [{ seq: 100, kind: "run.accepted" }], has_more: true, next_seq: 100 }
        : { events: [model(101, "messages")] };
    }
    if (url.pathname.endsWith("/payloads/messages")) {
      return { payload: { value: { messages: [{
        role: "user", content: [{ type: "input_text", text: "请 FIX [draft] now，谢谢" }],
      }] }, redacted_paths: ["$.messages[2].content"] } };
    }
    assert.fail(path);
  };
  const results = [];
  for await (const batch of searchPrompts(read, "from_at_ms=1000&status=failed", "fix [draft] now", "user")) {
    results.push(...batch);
  }
  assert.deepEqual(results.map(({ row, limited, hit }) => [row.run.id, limited, hit?.seq]), [
    ["limited", true, undefined], ["different-role", false, undefined], ["hit", true, 101],
  ]);
  assert.deepEqual(results[2].hit, { role: "user", before: "请 ", text: "FIX [draft] now", after: "，谢谢", seq: 101 });
  assert.ok(requests.includes("/trajectories/hit/events?after_seq=100"));
});

test("missing payloads are reported and upstream failures interrupt the search", async () => {
  const read = (status) => async (path) => {
    if (path.startsWith("/trajectories?")) return { items: [{ run: { id: "run" } }] };
    if (path.includes("/events?")) return { events: [{ seq: 2, kind: "model.requested", payload_id: "missing" }] };
    throw Object.assign(new Error("upstream"), { status });
  };
  const [result] = (await searchPrompts(read(404), "", "hello", "").next()).value;
  assert.equal(result.limited, true);
  assert.equal(result.hit, null);
  await assert.rejects(searchPrompts(read(502), "", "hello", "").next(), /upstream/);
});

test("timeline filters keep original sequence and distinguish failures from pending or incomplete events", async () => {
  const events = [];
  const read = async (path) => path.endsWith("=0") ? {
    events: [
      { seq: 1, kind: "tool.finished", metadata: { tool_name: "draft", execution_state: "needs_confirmation" } },
      { seq: 2, kind: "model.responded", metadata: { status: 500 } },
      { seq: 3, kind: "delivery.conflict", incomplete: true },
    ],
    has_more: true, next_seq: 3,
  } : {
    events: [
      { seq: 4, kind: "tool.finished", metadata: { tool_name: "send", execution_state: "failed" } },
      { seq: 5, kind: "delivery.failed" },
      { seq: 6, kind: "confirmation.finished", metadata: { business_state: "cancelled" } },
      { seq: 7, kind: "business.summary", metadata: { purpose: "recipient_delivery", business_state: "partial_failure" } },
      { seq: 8, kind: "run.finished", metadata: { execution_state: "failed" } },
    ],
  };
  for await (const page of eventPages(read, "run")) events.push(...page.events);
  assert.deepEqual(filterEvents(events, "error", "").map(({ seq }) => seq), [2, 4, 5, 7, 8]);
  assert.deepEqual(filterEvents(events, "tool", "send").map(({ seq }) => seq), [4]);
  assert.deepEqual(filterEvents(events, "delivery", "").map(({ seq }) => seq), [3, 5, 7]);
  assert.equal(failureType(events.at(-1)), "run");
  await assert.rejects(eventPages(async () => ({ events: [], has_more: true, next_seq: 0 }), "run").next(), /invalid event page/);
});
