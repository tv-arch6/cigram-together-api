import { Miniflare } from "miniflare";
import assert from "node:assert/strict";
import fs from "node:fs";

const USERS = {
  tokA: { id: "u-a", name: "أحمد", email: "a@x.com", avatar_url: "https://img.example/a.png" },
  tokB: { id: "u-b", name: "سارة", email: "b@x.com", avatar_url: "" },
  tokC: { id: "u-c", name: "ثالث", email: "c@x.com" },
};
let authMode = "ok";
const mf = new Miniflare({
  modules: true, script: fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8"),
  compatibilityDate: "2026-10-06",
  durableObjects: { DIRECTORY: { className: "TogetherDirectory", useSQLite: true }, ROOM: { className: "TogetherRoom", useSQLite: true } },
  serviceBindings: { AUTH_API: async (req) => {
    if (authMode === "1042") return new Response("error code: 1042", { status: 404 });
    if (authMode === "500") return new Response("x", { status: 500 });
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    const u = USERS[tok];
    if (!u) return new Response("no", { status: 401 });
    return Response.json({ ok: true, user: u });
  } },
});
const base = "http://localhost";
const api = async (path, tok, body, hdr = {}) => {
  const r = await mf.dispatchFetch(base + path, { method: body === undefined ? "GET" : "POST", headers: Object.assign({ authorization: "Bearer " + tok, "content-type": "application/json" }, hdr), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(roomId, tok) {
  const r = await mf.dispatchFetch(base + "/rooms/" + roomId + "/ws", { headers: { upgrade: "websocket", authorization: "Bearer " + tok } });
  assert.equal(r.status, 101, "ws upgrade status " + r.status);
  const ws = r.webSocket; ws.accept();
  const inbox = []; const waiters = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); inbox.push(m); waiters.slice().forEach((w) => w(m)); });
  let n = 0;
  return {
    ws, inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    cmd(o) { const id = "c" + (++n); return new Promise((res) => { const w = (m) => { if (m.t === "ack" && m.id === id) { waiters.splice(waiters.indexOf(w), 1); res(m); } }; waiters.push(w); ws.send(JSON.stringify(Object.assign({ id }, o))); }); },
    waitFor: (pred, ms = 3000) => new Promise((res, rej) => { const f = inbox.find(pred); if (f) return res(f); const to = setTimeout(() => rej(new Error("timeout waiting")), ms); const w = (m) => { if (pred(m)) { clearTimeout(to); waiters.splice(waiters.indexOf(w), 1); res(m); } }; waiters.push(w); }),
    close: () => ws.close(),
  };
}
let passed = 0; const ok = (name) => { passed++; console.log("PASS", name); };

const content = { type: "episode", content_id: "ser1", series_id: "ser1", series_title: "مسلسل", title: "مسلسل", season: 1, episode: 1, poster: "https://p.example/x.jpg" };

// ---- health & auth
assert.equal((await (await mf.dispatchFetch(base + "/health")).json()).ok, true); ok("health");
assert.equal((await api("/rooms", "bad", { content })).status, 401); ok("invalid token -> 401");
authMode = "1042"; let r = await api("/rooms", "tokA", { content }); assert.equal(r.status, 503); assert.equal(r.json.error, "auth_unavailable"); ok("auth 404/1042 -> 503 (not 401)");
authMode = "500"; r = await api("/rooms", "tokA", { content }); assert.equal(r.status, 503); ok("auth 500 -> 503");
authMode = "ok";
assert.equal((await mf.dispatchFetch(base + "/rooms", { method: "POST", body: "{}" })).status, 401); ok("no token -> 401");

// ---- create (idempotent)
r = await api("/rooms", "tokA", { content }, { "idempotency-key": "k1" }); assert.equal(r.status, 201);
const roomId = r.json.room.id, code = r.json.code;
assert.equal(code.length, 8); assert.equal(r.json.room.role, "owner"); assert.equal(r.json.room.owner.name, "أحمد");
assert.ok(!JSON.stringify(r.json).includes("a@x.com"), "email must never leak");
const r2 = await api("/rooms", "tokA", { content }, { "idempotency-key": "k1" });
assert.equal(r2.json.reused, true); assert.equal(r2.json.room.id, roomId); ok("create + idempotency (no duplicate room)");
r = await api("/rooms", "tokA", { content: { type: "movie" } }); assert.equal(r.status, 400); ok("content validation");

// ---- join flow
let A = await connect(roomId, "tokA");
r = await api("/rooms/join", "tokB", { code: "ZZZZZZZZ" }); assert.equal(r.status, 404); ok("wrong code rejected");
r = await api("/rooms/join", "tokB", { code }); assert.equal(r.json.status, "pending");
const jr = await A.waitFor((m) => m.t === "join.request"); assert.equal(jr.user.name, "سارة"); ok("owner gets join.request with name");
r = await api("/rooms/join", "tokC", { code }); assert.equal(r.status, 409); assert.equal(r.json.error, "room_full"); ok("third user -> room_full");
r = await api("/rooms/" + roomId, "tokB"); assert.equal(r.json.room.role, "pending"); assert.equal(r.json.room.owner, undefined); ok("pending sees no room details");
let wsRes = await mf.dispatchFetch(base + "/rooms/" + roomId + "/ws", { headers: { upgrade: "websocket", authorization: "Bearer tokB" } }); assert.equal(wsRes.status, 403); ok("pending cannot open ws");
r = await api("/rooms/" + roomId + "/respond", "tokB", { accept: true }); assert.equal(r.status, 403); ok("guest cannot accept itself");
r = await api("/rooms/" + roomId + "/respond", "tokA", { accept: true }); assert.equal(r.json.room.guest.name, "سارة");
let B = await connect(roomId, "tokB"); ok("accept -> guest connects");
r = await api("/rooms/" + roomId, "tokC"); assert.equal(r.json.room.role, "none"); assert.equal(r.json.room.owner, undefined); ok("stranger sees nothing");
wsRes = await mf.dispatchFetch(base + "/rooms/" + roomId + "/ws", { headers: { upgrade: "websocket", authorization: "Bearer tokC" } }); assert.equal(wsRes.status, 403); ok("stranger cannot open ws");

// ---- start barrier + synchronized start
r = await api("/rooms/" + roomId + "/start", "tokB", {}); assert.equal(r.status, 403);
r = await api("/rooms/" + roomId + "/start", "tokA", {}); assert.equal(r.json.room.playback.status, "loading");
const epoch = r.json.room.epoch; assert.equal(epoch, 1);
await sleep(100);
let ack = await A.cmd({ t: "play", epoch }); assert.equal(ack.error, "loading"); ok("play refused while loading");
await A.cmd({ t: "ready", epoch });
let st = B.inbox.filter((m) => m.t === "state").pop(); assert.equal(st.room.playback.status, "loading"); ok("still loading until BOTH ready");
await B.cmd({ t: "ready", epoch });
const started = await A.waitFor((m) => m.t === "state" && m.room.playback.status === "playing");
const startedB = await B.waitFor((m) => m.t === "state" && m.room.playback.status === "playing");
assert.equal(started.room.playback.start_at, startedB.room.playback.start_at); assert.ok(started.room.playback.start_at > Date.now() - 100); ok("both ready -> both get same start_at (server clock)");

// ---- controls
ack = await A.cmd({ t: "seek", epoch, position_ms: 600000 }); assert.equal(ack.ok, true);
await B.waitFor((m) => m.t === "state" && m.cause === "seek"); ok("owner seek -> guest receives");
ack = await B.cmd({ t: "pause", epoch }); assert.equal(ack.error, "not_allowed"); ok("guest cannot control (server-enforced)");
await B.cmd({ t: "ctl.request", epoch, action: "pause", position_ms: 601000 });
const cr = await A.waitFor((m) => m.t === "ctl.request"); await A.cmd({ t: "ctl.respond", req_id: cr.req.req_id, accept: true });
st = await B.waitFor((m) => m.t === "state" && m.cause === "pause"); assert.equal(st.room.playback.status, "paused"); assert.equal(st.room.playback.position_ms, 601000); ok("guest request -> owner approves -> applied");
ack = await A.cmd({ t: "play", epoch: epoch + 5 }); assert.equal(ack.error, "stale_epoch"); ok("stale epoch command ignored");
await api("/rooms/" + roomId + "/settings", "tokA", { shared_control: true });
ack = await B.cmd({ t: "play", epoch, position_ms: 601000 }); assert.equal(ack.ok, true); ok("shared_control lets guest control");
await sleep(1200);
A.send({ t: "time", client_ms: 1 }); const tm = await A.waitFor((m) => m.t === "time"); assert.ok(tm.server_ms > 0); ok("time sync reply");
await A.cmd({ t: "sync" }); const snap = A.inbox.filter((m) => m.t === "snapshot").pop(); assert.ok(snap.room.playback.position_ms >= 601000 + 1000, "position advances from server clock: " + snap.room.playback.position_ms); ok("server computes live position");

// ---- chat
ack = await A.cmd({ t: "chat", message_id: "m1", text: "شفت شصار هسه؟", position_ms: 872000, epoch }); assert.equal(ack.ok, true);
const cm = await B.waitFor((m) => m.t === "chat"); assert.equal(cm.message.name, "أحمد"); assert.equal(cm.message.avatar_url, "https://img.example/a.png"); assert.equal(cm.message.position_ms, 872000); assert.ok(cm.message.sent_at > 0); ok("chat: name+avatar+video position(ms)+sent time");
ack = await A.cmd({ t: "chat", message_id: "m1", text: "شفت شصار هسه؟", position_ms: 872000, epoch }); assert.equal(ack.duplicate, true); assert.equal(B.inbox.filter((m) => m.t === "chat").length, 1); ok("retry same message_id -> no duplicate");
let limited = 0; for (let i = 0; i < 8; i++) { const a = await B.cmd({ t: "chat", message_id: "s" + i, text: "x" + i, position_ms: 1, epoch }); if (a.error === "rate_limited") limited++; } assert.ok(limited >= 2); ok("chat rate limit");
ack = await B.cmd({ t: "chat", message_id: "spoof", text: "<b>hi</b>", name: "المالك", avatar_url: "https://evil", position_ms: 5, epoch }); await sleep(5200);
ack = await B.cmd({ t: "chat", message_id: "spoof2", text: "hi", name: "المالك", position_ms: 5, epoch });
const spoof = await A.waitFor((m) => m.t === "chat" && m.message.message_id === "spoof2"); assert.equal(spoof.message.name, "سارة"); ok("client cannot spoof name/avatar");

// ---- moments (episode 1)
ack = await A.cmd({ t: "moment", moment_id: "mo1", text: "لقطة حلوة", position_ms: 1403000 }); assert.equal(ack.ok, true);
r = await api("/rooms/" + roomId + "/moments", "tokB"); assert.equal(r.json.moments.length, 1); ok("moment saved");

// ---- reconnect gets authoritative snapshot (no old command replay)
B.close(); await sleep(200);
await A.waitFor((m) => m.t === "presence" && Object.values(m.presence).includes(false)); ok("presence update on disconnect");
B = await connect(roomId, "tokB");
B.send({ t: "sync" });                                  // the Android client always asks for a fresh snapshot right after (re)connecting
const sn = await B.waitFor((m) => m.t === "snapshot"); assert.equal(sn.room.epoch, 1); assert.equal(sn.room.playback.status, "playing"); ok("reconnect -> snapshot of current state");

// ---- wait me
await B.cmd({ t: "wait.request" }); await A.waitFor((m) => m.t === "wait.request");
await A.cmd({ t: "wait.respond", accept: true }); st = await B.waitFor((m) => m.t === "state" && m.cause === "wait.responded"); assert.equal(st.room.playback.status, "paused");
await B.cmd({ t: "wait.back" }); await A.waitFor((m) => m.t === "wait.back"); ok("wait me: request -> owner accepts -> pause -> back");

// ---- next episode: consent + barrier + epoch + separate comments
const ep2 = Object.assign({}, content, { episode: 2 });
await A.cmd({ t: "episode.request", content: ep2 });
st = await B.waitFor((m) => m.t === "state" && m.cause === "episode.request"); assert.equal(st.room.pending_change.content.episode, 2);
ack = await A.cmd({ t: "episode.respond", accept: true }); assert.equal(ack.error, "bad_request"); ok("requester cannot approve own change");
await B.cmd({ t: "episode.respond", accept: true });
st = await A.waitFor((m) => m.t === "state" && m.cause === "episode.changed"); assert.equal(st.room.epoch, 2); assert.equal(st.room.playback.status, "loading"); assert.equal(st.room.playback.position_ms, 0); assert.equal(st.room.content.episode, 2); ok("episode change after consent: epoch++ + loading from 0");
ack = await A.cmd({ t: "seek", epoch: 1, position_ms: 5 }); assert.equal(ack.error, "stale_epoch"); ok("late command from old episode ignored");
await A.cmd({ t: "ready", epoch: 2 }); await B.cmd({ t: "ready", epoch: 2 });
await A.waitFor((m) => m.t === "state" && m.cause === "start" && m.room.epoch === 2); ok("episode 2 starts after both ready (no new room)");
await A.cmd({ t: "chat", message_id: "e2m", text: "الحلقة الثانية", position_ms: 1000, epoch: 2 });
r = await api("/rooms/" + roomId + "/messages?episode_id=" + encodeURIComponent(content.series_id + "|s1|e1"), "tokA"); const e1 = r.json.messages.filter((m) => !m.system).map((m) => m.message_id);
assert.ok(e1.includes("m1") && !e1.includes("e2m")); ok("chat history filtered per episode");
r = await api("/rooms/" + roomId + "/moments", "tokA"); assert.equal(r.json.moments.length, 0); ok("moments separated per episode");

// ---- leave / kick / close
await api("/rooms/" + roomId + "/report", "tokB", { reason: "test" });
r = await api("/rooms/" + roomId + "/kick", "tokB", { ban: true }); assert.equal(r.status, 403); ok("guest cannot kick");
r = await api("/rooms/" + roomId + "/kick", "tokA", { ban: true }); assert.equal(r.status, 200);
await B.waitFor((m) => m.t === "kicked"); ok("owner kicks+bans guest");
r = await api("/rooms/join", "tokB", { code }); assert.equal(r.status, 403); assert.equal(r.json.error, "banned"); ok("banned user cannot rejoin");
r = await api("/rooms/" + roomId + "/close", "tokA", {}); assert.equal(r.json.closed, true);
r = await api("/rooms/" + roomId, "tokA"); assert.equal(r.status, 410); ok("close -> 410");
r = await api("/rooms/join", "tokC", { code }); assert.equal(r.status, 404); ok("closed room's code is dropped");

console.log("\nALL", passed, "CHECKS PASSED");
A.close(); B.close(); await mf.dispose(); process.exit(0);
