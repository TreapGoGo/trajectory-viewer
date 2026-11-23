export function runPath(id) {
  return "/trajectories/" + encodeURIComponent(id);
}

export async function* eventPages(read, runID, after = 0) {
  while (true) {
    const page = await read(runPath(runID) + "/events?after_seq=" + after);
    if (!Array.isArray(page.events) || (page.has_more &&
        (!Number.isSafeInteger(page.next_seq) || page.next_seq <= after))) {
      throw new Error("The cloud archive returned an invalid event page.");
    }
    yield page;
    if (!page.has_more) return;
    after = page.next_seq;
  }
}

function promptMatcher(query, role) {
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  return (messages) => {
    for (const message of messages) {
      if (!["user", "system", "developer"].includes(message?.role)) continue;
      const promptRole = message.role === "developer" ? "system" : message.role;
      if (role && role !== promptRole) continue;
      const parts = Array.isArray(message.content) ? message.content
        .filter((part) => ["text", "input_text"].includes(part?.type))
        .map((part) => part.text) : [message.content];
      for (const text of parts) {
        if (typeof text !== "string") continue;
        const match = pattern.exec(text);
        if (!match) continue;
        const before = Array.from(text.slice(0, match.index));
        const after = Array.from(text.slice(match.index + match[0].length));
        return {
          role: promptRole,
          before: (before.length > 45 ? "…" : "") + before.slice(-45).join(""),
          text: match[0],
          after: after.slice(0, 65).join("") + (after.length > 65 ? "…" : ""),
        };
      }
    }
    return null;
  };
}

async function findPrompt(read, row, match) {
  let limited = row.integrity === "incomplete";
  try {
    for await (const page of eventPages(read, row.run.id)) {
      for (const event of page.events) {
        if (event.kind !== "model.requested") continue;
        if (!event.payload_id) {
          limited = true;
          continue;
        }
        let payload;
        try {
          ({ payload } = await read(runPath(row.run.id) + "/payloads/" + encodeURIComponent(event.payload_id)));
        } catch (error) {
          if (error.status !== 404) throw error;
          limited = true;
          continue;
        }
        const messages = payload?.value?.messages;
        const searchable = Array.isArray(messages);
        limited ||= Boolean(!searchable || event.incomplete || payload.incomplete ||
          payload.redacted_paths?.some((path) => path === "$" || path === "$.messages" || path.startsWith("$.messages[")));
        const hit = searchable && match(messages);
        if (hit) return { row, hit: { ...hit, seq: event.seq }, limited };
      }
    }
  } catch (error) {
    if (error.status !== 404) throw error;
    limited = true;
  }
  return { row, hit: null, limited };
}

export async function* searchPrompts(read, filters, query, role) {
  const match = promptMatcher(query, role);
  const params = new URLSearchParams(filters);
  params.set("limit", "20");
  while (true) {
    const page = await read("/trajectories?" + params);
    if (!Array.isArray(page.items) || (page.has_more &&
        (!page.next_cursor || page.next_cursor === params.get("cursor")))) {
      throw new Error("The cloud archive returned an invalid trajectory page.");
    }
    for (let i = 0; i < page.items.length; i += 4) {
      const batch = await Promise.all(page.items.slice(i, i + 4).map((row) => findPrompt(read, row, match)));
      yield batch;
    }
    if (!page.has_more) return;
    params.set("cursor", page.next_cursor);
  }
}

const isFailure = (value) => value === "failed" || value === "partial_failure";

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
      return isFailure(meta.execution_state) || isFailure(meta.business_state) ? "step" : "";
    case "business.receipt":
    case "business.summary":
    case "confirmation.finished":
      return isFailure(meta.delivery_state) || isFailure(meta.business_state) ? "step" : "";
    default:
      return "";
  }
}

export function eventCategory(event) {
  const prefix = event.kind.split(".")[0];
  if (["model", "tool", "delivery"].includes(prefix)) return prefix;
  if (prefix === "span") {
    if (event.metadata?.tool_name || event.metadata?.operation === "tool") return "tool";
    if (event.metadata?.operation === "model") return "model";
  }
  if (["ui", "card", "confirmation"].includes(prefix)) return "confirmation";
  if (prefix === "business" && (event.metadata?.delivery_state ||
      ["recipient_delivery", "reply_delivery"].includes(event.metadata?.purpose))) return "delivery";
  return "other";
}

export function filterEvents(events, type, tool) {
  return events.filter((event) =>
    (!type || (type === "error" ? failureType(event) : eventCategory(event) === type)) &&
    (!tool || event.metadata?.tool_name === tool));
}
