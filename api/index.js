// Vercel function: the workbench HTTP API without server-side state.
//
// Same surface as the Go server (main.go): /api/session, /api/login,
// /api/logout, /api/trajectories[/{id}[/events|/payloads/{payload}]] and
// /api/bundle/{id}. vercel.json rewrites /api/* here with ?path=<rest>.
//
// The Tuple backend token lives only in an HttpOnly, Secure, SameSite=Strict
// cookie. With SESSION_SECRET set (recommended) the cookie is AES-256-GCM
// encrypted; without it the cookie holds the token as plain base64.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const UPSTREAM = (process.env.TRAJECTORY_API_ORIGIN || "https://backend.tuple.fun").replace(/\/+$/, "");
const SECRET = process.env.SESSION_SECRET || "";
const SESSION_COOKIE = "trajectory_session";
const DEVICE_COOKIE = "trajectory_device";
const SESSION_TTL = 30 * 24 * 3600; // seconds; matches the backend web token
const QUERY_KEYS = ["cursor", "status", "agent_uid", "invocation_id", "from_at_ms", "to_at_ms", "limit", "after_seq", "children_after", "snapshot_seq"];
const UPSTREAM_TIMEOUT = 20_000;
const MAX_PARALLEL = 10;

const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_:.-]{1,160}$/.test(id) && id !== "." && id !== "..";

// ---------- cookies ----------
function readCookies(req) {
  const jar = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return jar;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function key() {
  return createHash("sha256").update("trajectory-workbench\0" + SECRET).digest();
}

export function seal(data) {
  const plain = Buffer.from(JSON.stringify(data));
  if (!SECRET) return "p1." + plain.toString("base64url");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return "s1." + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal(value) {
  try {
    let plain;
    if (SECRET && value?.startsWith("s1.")) {
      const raw = Buffer.from(value.slice(3), "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    } else if (!SECRET && value?.startsWith("p1.")) {
      plain = Buffer.from(value.slice(3), "base64url");
    } else {
      return null;
    }
    const data = JSON.parse(plain.toString("utf8"));
    if (!data?.t || !(data.x * 1000 > Date.now())) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------- responses ----------
function send(res, status, value, { cache = "no-store", cookies } = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (cookies?.length) res.setHeader("Set-Cookie", cookies);
  res.end(value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));
}

const fail = (res, status, error, options) => send(res, status, { error }, options);
const expired = (res) => fail(res, 401, "Your sign-in expired. Sign in again.", { cookies: [cookie(SESSION_COOKIE, "", 0)] });

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

// ---------- upstream ----------
class UpstreamStatus extends Error {
  constructor(status) {
    super("upstream status " + status);
    this.status = status;
  }
}

async function upstream(path, { query, token, body } = {}) {
  const url = new URL(UPSTREAM + "/v1/" + path);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (token) {
    headers.token = token;
    headers.device_flag = "1";
  }
  const response = await fetch(url, {
    method: body ? "POST" : "GET", headers, redirect: "manual",
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  });
  return { status: response.status, text: await response.text() };
}

async function archiveJSON(sub, token, query) {
  const { status, text } = await upstream("agent/trajectories" + sub, { query, token });
  if (status !== 200) throw new UpstreamStatus(status);
  return JSON.parse(text);
}

function limiter(size) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= size) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

// Mirrors buildBundle in bundle.go.
export async function buildBundle(token, id, depth, run = limiter(MAX_PARALLEL)) {
  const result = { id, detail: null, events: [], payloads: {}, children: [], problems: [], fetched_ms: Date.now() };
  const detail = await run(() => archiveJSON("/" + id, token));
  result.detail = detail;
  const children = [...(detail.children ?? [])];
  for (let page = 0, next = detail; next.has_more_children && next.next_child_cursor && page < 20; page++) {
    const cursor = next.next_child_cursor;
    try {
      next = await run(() => archiveJSON("/" + id, token, { children_after: cursor }));
      children.push(...(next.children ?? []));
    } catch (error) {
      result.problems.push(`children page after ${cursor}: ${error.message}`);
      break;
    }
  }
  for (let after = 0, page = 0; page < 50; page++) {
    const query = { limit: "500" };
    if (after) query.after_seq = String(after);
    let events;
    try {
      events = await run(() => archiveJSON(`/${id}/events`, token, query));
    } catch (error) {
      if (page === 0) throw error;
      result.problems.push(`events after ${after}: ${error.message}`);
      break;
    }
    result.events.push(...(events.events ?? []));
    if (!events.has_more || !(events.next_seq > after)) break;
    after = events.next_seq;
  }
  await Promise.all([
    ...result.events.filter((event) => validId(event.payload_id)).map(async (event) => {
      try {
        const reply = await run(() => archiveJSON(`/${id}/payloads/${event.payload_id}`, token));
        result.payloads[event.payload_id] = reply.payload ?? { error: "missing" };
      } catch (error) {
        result.payloads[event.payload_id] = { error: error.message };
      }
    }),
    ...(depth > 0 ? children.filter(validId) : []).map(async (child, index) => {
      try {
        result.children[index] = await buildBundle(token, child, depth - 1, run);
      } catch (error) {
        result.problems.push(`child ${child}: ${error.message}`);
      }
    }),
  ]);
  result.children = result.children.filter(Boolean);
  return result;
}

function archiveError(res, status) {
  if (status === 401) return expired(res);
  if (status === 403 || status === 404) return fail(res, status, "This archive is unavailable to your account.");
  if (status === 400) return fail(res, 400, "The cloud archive rejected these filters.");
  return fail(res, 502, "Unexpected response from the cloud archive.");
}

// ---------- routes ----------
async function login(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, "Invalid request.");
  }
  const email = String(body?.email ?? "").trim();
  const password = String(body?.password ?? "");
  if (!email || !password) return fail(res, 400, "Enter your email and password.");
  const cookies = [];
  let device = readCookies(req)[DEVICE_COOKIE];
  if (!/^[0-9a-f]{32}$/.test(device ?? "")) {
    device = randomBytes(16).toString("hex");
    cookies.push(cookie(DEVICE_COOKIE, device, 365 * 24 * 3600));
  }
  let reply;
  try {
    reply = await upstream("user/email/login", {
      body: { email, password, flag: 1, device: { device_id: device, device_name: "Trajectory workbench", device_model: "Web" } },
    });
  } catch {
    return fail(res, 502, "The Tuple sign-in service is unavailable.");
  }
  if (reply.status >= 500) return fail(res, 502, "The Tuple sign-in service is unavailable.");
  let data;
  try {
    data = JSON.parse(reply.text)?.data;
  } catch {
    return fail(res, 502, "Unexpected sign-in response.");
  }
  if (reply.status !== 200 || !data?.uid || !data?.token) {
    return fail(res, 401, "Tuple could not sign you in. Check your credentials and try again.", { cookies });
  }
  const session = seal({ t: data.token, n: data.name || "", x: Math.floor(Date.now() / 1000) + SESSION_TTL });
  cookies.push(cookie(SESSION_COOKIE, session, SESSION_TTL));
  return send(res, 200, { name: data.name || "" }, { cookies });
}

async function archive(req, res, session, parts, url) {
  const [id, kind, payload] = parts;
  let sub = "";
  if (id !== undefined) {
    if (!validId(id)) return fail(res, 400, "Invalid archive ID.");
    sub = "/" + id;
    if (kind === "events" && parts.length === 2) sub += "/events";
    else if (kind === "payloads" && parts.length === 3) {
      if (!validId(payload)) return fail(res, 400, "Invalid content ID.");
      sub += "/payloads/" + payload;
    } else if (parts.length > 1) return fail(res, 404, "Not found.");
  }
  const query = {};
  for (const name of QUERY_KEYS) {
    const value = url.searchParams.get(name);
    if (value) query[name] = value;
  }
  let reply;
  try {
    reply = await upstream("agent/trajectories" + sub, { query, token: session.t });
  } catch {
    return fail(res, 502, "The cloud archive service is unavailable.");
  }
  if (reply.status !== 200) return archiveError(res, reply.status);
  try {
    JSON.parse(reply.text);
  } catch {
    return fail(res, 502, "Unexpected response from the cloud archive.");
  }
  // Payloads never change; event pages can still grow for a short while.
  const cache = sub.includes("/payloads/") ? "private, max-age=31536000, immutable"
    : sub.endsWith("/events") ? "private, max-age=20" : "no-store";
  return send(res, 200, reply.text, { cache });
}

async function bundle(req, res, session, id, url) {
  if (!validId(id)) return fail(res, 400, "Invalid archive ID.");
  const depth = Math.min(4, Math.max(0, Number.parseInt(url.searchParams.get("depth") ?? "2", 10) || 0));
  const started = Date.now();
  let result;
  try {
    result = await buildBundle(session.t, id, depth);
  } catch (error) {
    if (error instanceof UpstreamStatus) return archiveError(res, error.status);
    return fail(res, 502, "The cloud archive service is unavailable.");
  }
  result.took_ms = Date.now() - started;
  // Finished runs rarely change; a refresh asks with ?fresh=1, a different URL.
  const finished = ["succeeded", "failed", "interrupted"].includes(result.detail?.execution_state);
  const old = Date.now() - (result.detail?.run?.started_at_ms ?? Date.now()) > 10 * 60_000;
  return send(res, 200, result, { cache: finished && old && url.searchParams.get("fresh") !== "1" ? "private, max-age=600" : "no-store" });
}

export default async function handler(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  let path = url.searchParams.get("path");
  if (path === null) path = url.pathname.replace(/^\/api\/?/, "");
  path = path.replace(/^\/+|\/+$/g, "");
  if (path === "index") path = "";
  const parts = path ? path.split("/") : [];
  try {
    if (req.method === "POST") {
      if (!sameOrigin(req)) return fail(res, 403, "Invalid request origin.");
      if (path === "login") return await login(req, res);
      if (path === "logout") {
        res.statusCode = 204;
        res.setHeader("Set-Cookie", [cookie(SESSION_COOKIE, "", 0)]);
        res.setHeader("Cache-Control", "no-store");
        return res.end();
      }
      return fail(res, 405, "Method not allowed.");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Method not allowed.");
    const session = unseal(readCookies(req)[SESSION_COOKIE]);
    if (path === "session") return session ? send(res, 200, { name: session.n }) : fail(res, 401, "Sign in to view cloud archives.");
    if (!session) return fail(res, 401, "Sign in to view cloud archives.");
    if (parts[0] === "trajectories") return await archive(req, res, session, parts.slice(1), url);
    if (parts[0] === "bundle" && parts.length === 2) return await bundle(req, res, session, parts[1], url);
    return fail(res, 404, "Not found.");
  } catch {
    return fail(res, 502, "The cloud archive service is unavailable.");
  }
}
