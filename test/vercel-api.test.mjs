// node --test test/ — the Vercel function (api/index.js) against a fake Tuple backend.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const TOKEN = "upstream-owner-token";

function fakeBackend() {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://backend");
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url.pathname === "/v1/user/email/login") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.password !== "right") return json(200, { data: {} });
        assert.equal(body.flag, 1);
        assert.match(body.device.device_id, /^[0-9a-f]{32}$/);
        json(200, { data: { uid: "owner", name: "Owner", token: TOKEN } });
      });
      return;
    }
    if (req.headers.token !== TOKEN) return json(401, { error: "unauthorized" });
    const path = url.pathname.replace("/v1/agent/trajectories", "");
    if (path === "") return json(200, { items: [{ run: { id: "parent" } }], has_more: false, echo: Object.fromEntries(url.searchParams) });
    if (path === "/parent") return json(200, { run: { id: "parent", started_at_ms: 1 }, execution_state: "succeeded", children: ["child"] });
    if (path === "/child") return json(200, { run: { id: "child" }, children: [] });
    if (path.endsWith("/events")) {
      const run = path.split("/")[1];
      if (run === "parent" && !url.searchParams.get("after_seq")) {
        return json(200, { events: [{ seq: 1, kind: "run.accepted", payload_id: "parent:1" }], has_more: true, next_seq: 1 });
      }
      return json(200, { events: [{ seq: 2, kind: "run.finished", payload_id: `${run}:2` }], has_more: false, next_seq: 2 });
    }
    if (path.includes("/payloads/")) return json(200, { payload: { id: path.split("/").pop(), value: { ok: true } } });
    json(404, { error: "not found" });
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function harness(secret) {
  const backend = fakeBackend();
  process.env.TRAJECTORY_API_ORIGIN = await listen(backend);
  if (secret) process.env.SESSION_SECRET = secret;
  else delete process.env.SESSION_SECRET;
  // A distinct specifier gives a fresh module that re-reads the environment.
  const { default: handler } = await import(`../api/index.js?${secret ? "sealed" : "plain"}`);
  const app = createServer((req, res) => handler(req, res));
  const base = await listen(app);
  const call = (path, { method = "GET", cookie = "", body, origin = base } = {}) => fetch(base + path, {
    method, redirect: "manual",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const close = () => Promise.all([new Promise((r) => backend.close(r)), new Promise((r) => app.close(r))]);
  return { call, close };
}

const sessionCookie = (response) => response.headers.getSetCookie()
  .find((value) => value.startsWith("trajectory_session=") && !value.includes("Max-Age=0"))?.split(";")[0] ?? "";

for (const secret of ["test-secret", ""]) {
  test(`login, archive proxy, bundle and logout (${secret ? "encrypted" : "plain"} cookie)`, async () => {
    const { call, close } = await harness(secret);
    try {
      assert.equal((await call("/api/session")).status, 401);
      assert.equal((await call("/api/trajectories")).status, 401);
      assert.equal((await call("/api/login", { method: "POST", origin: "https://evil.example", body: { email: "a@b.c", password: "right" } })).status, 403);
      assert.equal((await call("/api/login", { method: "POST", body: { email: "a@b.c", password: "wrong" } })).status, 401);

      const login = await call("/api/login", { method: "POST", body: { email: "a@b.c", password: "right" } });
      assert.equal(login.status, 200);
      const cookie = sessionCookie(login);
      assert.ok(cookie, "session cookie set");
      assert.ok(login.headers.getSetCookie().every((value) => /HttpOnly; Secure; SameSite=Strict/.test(value)));
      if (secret) assert.ok(!Buffer.from(cookie.split(".").slice(1).join("."), "base64url").toString().includes(TOKEN), "token is encrypted");
      assert.ok(!JSON.stringify(await login.json()).includes(TOKEN), "token never returned in a body");

      assert.deepEqual(await (await call("/api/session", { cookie })).json(), { name: "Owner" });
      const list = await (await call("/api/trajectories?limit=5&owner_uid=x", { cookie })).json();
      assert.deepEqual(list.echo, { limit: "5" }, "only whitelisted query keys reach the backend");
      const viaRewrite = await call("/api/index?path=trajectories/parent/events&limit=500", { cookie });
      assert.equal(viaRewrite.status, 200, "rewritten ?path= form works");
      const payload = await call("/api/trajectories/parent/payloads/parent:1", { cookie });
      assert.match(payload.headers.get("cache-control"), /immutable/);

      const bundle = await (await call("/api/bundle/parent", { cookie })).json();
      assert.equal(bundle.events.length, 2);
      assert.deepEqual(Object.keys(bundle.payloads).sort(), ["parent:1", "parent:2"]);
      assert.equal(bundle.children.length, 1);
      assert.equal(bundle.children[0].id, "child");

      assert.equal((await call("/api/trajectories/..%2F..", { cookie })).status, 400);
      const tampered = cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA");
      assert.equal((await call("/api/session", { cookie: tampered })).status, secret ? 401 : (await call("/api/session", { cookie: tampered })).status);

      const logout = await call("/api/logout", { method: "POST", cookie });
      assert.equal(logout.status, 204);
      assert.ok(logout.headers.getSetCookie().some((value) => value.startsWith("trajectory_session=;") && value.includes("Max-Age=0")));
    } finally {
      await close();
    }
  });
}
