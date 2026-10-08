// =====================================================================================
// CIGRAM Together API  —  "شاهد مع صديقك"  (v1: غرفة خاصة لشخصين)
//
//   Worker + 2 Durable Objects (SQLite-backed):
//     TogetherDirectory : رموز الدعوة + مفاتيح عدم التكرار (idempotency) + حدود المعدّل لإنشاء/انضمام
//     TogetherRoom      : غرفة واحدة = مصدر الحقيقة الوحيد لحالة التشغيل (WebSocket Hibernation)
//
//   Bindings المطلوبة (انظر wrangler.jsonc):
//     DIRECTORY (DO TogetherDirectory) ، ROOM (DO TogetherRoom) ، AUTH_API (Service → cigram-auth-api)
//   Vars اختيارية: AUTH_VERIFY_URL
//   لا توجد أسرار في هذا الـ Worker. الرمز الذي يرسله التطبيق يُتحقق منه لدى cigram-auth-api فقط.
//
//   المبادئ:
//   - الفيديو لا يمر من هنا إطلاقاً: كل هاتف يشغّل الرابط المصرّح له من الكتالوج، والخادم يحمل metadata/أحداث/رسائل فقط.
//   - الاسم والصورة يأتيان من خادم الحسابات (/me) وليس من العميل، فلا انتحال.
//   - البريد الإلكتروني لا يُخزَّن ولا يُرسل لأي عضو.
//   - الحالة المرجعية (position_ms + ref_ms بساعة الخادم + state_version) هي المرجع، لا ساعات الهواتف.
// =====================================================================================

const VERSION = "together-1.0.0";
const MAX_MSGS = 200;
const MAX_MOMENTS = 300;
const MAX_TEXT = 500;
const CODE_TTL_MS = 24 * 3600 * 1000;       // صلاحية رمز الدعوة
const ROOM_IDLE_MS = 24 * 3600 * 1000;      // تنظيف الغرفة الخاملة (يشمل حذف المحادثة)
const ABSENT_CLOSE_MS = 10 * 60 * 1000;     // غياب الطرفين معاً قبل إغلاق الغرفة
const START_LEAD_MS = 1500;                 // مهلة البدء المتزامن بعد جاهزية الطرفين
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بلا 0/O/1/I
const CODE_LEN = 8;

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new HttpError(status, code, message); }

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type, Authorization, Idempotency-Key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
function reply(obj, status = 200, extra) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, CORS, extra || {}) });
}

// ------------------------------------------------------------------ util
const enc = new TextEncoder();
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomCode() {
  const b = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function randomId(n = 16) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function cleanText(v, max) {
  let s = String(v == null ? "" : v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, "").trim();
  return s.length > max ? s.slice(0, max) : s;
}
function intIn(v, lo, hi, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
function httpsUrlOrEmpty(v) {
  const s = cleanText(v, 600);
  return /^https:\/\//i.test(s) ? s : "";
}
async function readJson(request, limit) {
  const txt = await request.text();
  if (txt.length > (limit || 8000)) fail(413, "too_large", "الطلب كبير جداً.");
  if (!txt) return {};
  try { const o = JSON.parse(txt); return o && typeof o === "object" ? o : {}; } catch (e) { fail(400, "bad_json", "JSON غير صالح."); }
}

// ------------------------------------------------------------------ auth (نفس عقد cigram-ads-api بعد الإصلاح)
const _authCache = new Map();
function bearerOf(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}
function pickUser(obj) {
  if (!obj || typeof obj !== "object") return null;
  const cand = [obj, obj.user, obj.data, obj.profile].filter((x) => x && typeof x === "object");
  for (const o of cand) {
    const id = o.sub || o.user_id || o.uid || o.id || "";
    const email = o.email || "";
    if (id || email) {
      return {
        id: String(id || ""), email: String(email || "").toLowerCase(),
        name: cleanText(o.name || o.username || o.display_name || "", 60) || "مستخدم سيكرام",
        avatar_url: httpsUrlOrEmpty(o.avatar_url || o.avatar || ""),
        gender: cleanText(o.gender || "", 12),
      };
    }
  }
  return null;
}
async function verifyUser(request, env) {
  const tok = bearerOf(request);
  if (!tok || tok.length > 4000) fail(401, "login_required", "سجّل الدخول أولاً.");
  const ck = await sha256Hex(tok);
  const hit = _authCache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.user;
  const verifyUrl = String(env.AUTH_VERIFY_URL || "https://cigram-auth-api.wwq-mixtv.workers.dev/me").trim();
  let user = null, authDown = false;
  try {
    const vreq = { headers: { authorization: "Bearer " + tok, accept: "application/json" } };
    const r = env.AUTH_API && typeof env.AUTH_API.fetch === "function" ? await env.AUTH_API.fetch(verifyUrl, vreq) : await fetch(verifyUrl, vreq);
    if (r.ok) user = pickUser(await r.json());
    else if (r.status !== 401 && r.status !== 403) authDown = true; // 404/1042/429/5xx = تعذّر التحقق، لا "رمز مرفوض"
  } catch (e) { authDown = true; }
  if (!user && authDown) fail(503, "auth_unavailable", "تعذر التحقق من حسابك حالياً. حاول بعد قليل — جلستك لم تنتهِ.");
  if (!user) fail(401, "invalid_token", "انتهت الجلسة. سجّل الدخول من جديد.");
  user.uid = (await sha256Hex("cigram-user|" + (user.id || user.email))).slice(0, 32);
  if (_authCache.size > 2000) _authCache.clear();
  _authCache.set(ck, { user, exp: Date.now() + 5 * 60000 });
  return user;
}
function publicProfile(u) { return { uid: u.uid, name: u.name, avatar_url: u.avatar_url || "" }; }

// ------------------------------------------------------------------ content validation (metadata فقط)
function cleanContent(c) {
  if (!c || typeof c !== "object") fail(400, "bad_content", "بيانات المحتوى ناقصة.");
  const type = c.type === "episode" ? "episode" : "movie";
  const out = {
    type,
    content_id: cleanText(c.content_id, 120),
    title: cleanText(c.title, 160),
    poster: httpsUrlOrEmpty(c.poster),
    series_id: cleanText(c.series_id, 120),
    series_title: cleanText(c.series_title, 160),
    season: intIn(c.season, 0, 999, 0),
    episode: intIn(c.episode, 0, 9999, 0),
    episode_id: cleanText(c.episode_id, 160),
  };
  if (!out.content_id && !out.series_id) fail(400, "bad_content", "معرّف المحتوى مطلوب.");
  if (!out.title && !out.series_title) fail(400, "bad_content", "عنوان المحتوى مطلوب.");
  if (type === "episode") {
    if (!out.series_id && !out.content_id) fail(400, "bad_content", "معرّف المسلسل مطلوب.");
    if (!out.episode) fail(400, "bad_content", "رقم الحلقة مطلوب.");
    if (!out.episode_id) out.episode_id = (out.series_id || out.content_id) + "|s" + out.season + "|e" + out.episode;
  } else if (!out.episode_id) {
    out.episode_id = out.content_id;
  }
  return out;
}

// ------------------------------------------------------------------ front Worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return reply({ ok: false, error: e.code, message: e.message }, e.status);
      console.log("together error", e && e.stack || e);
      return reply({ ok: false, error: "server_error", message: "خطأ داخلي في الخادم." }, 500);
    }
  },
};

function dir(env) { return env.DIRECTORY.get(env.DIRECTORY.idFromName("dir")); }
function roomStub(env, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) fail(404, "no_room", "الغرفة غير موجودة.");
  return env.ROOM.get(env.ROOM.idFromName(id));
}
async function op(stub, name, p) {
  const r = await stub.fetch("https://do/op", { method: "POST", body: JSON.stringify({ op: name, p: p || {} }) });
  const j = await r.json();
  if (!r.ok || j.ok === false) fail(r.status >= 400 ? r.status : 500, j.error || "do_error", j.message || "تعذر تنفيذ الطلب.");
  return j;
}

async function route(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  if (path === "/health") return reply({ ok: true, service: "cigram-together-api", version: VERSION });
  if (!env.DIRECTORY || !env.ROOM) return reply({ ok: false, error: "missing_binding", message: "Durable Objects غير مربوطة." }, 500);

  const user = await verifyUser(request, env);
  const me = publicProfile(user);

  if (method === "POST" && path === "/rooms") {
    const body = await readJson(request, 6000);
    const content = cleanContent(body.content);
    const idem = cleanText(request.headers.get("idempotency-key") || body.idempotency_key || "", 80);
    const d = dir(env);
    const g = await op(d, "gate", { uid: me.uid, kind: "create", idem });
    if (g.existing) {                                   // ضغطة مكررة/إعادة محاولة بعد timeout → نفس الغرفة
      const room = await op(roomStub(env, g.existing.room_id), "view", { uid: me.uid });
      return reply({ ok: true, reused: true, code: g.existing.code, room: room.room });
    }
    const roomId = randomId(16);
    const reg = await op(d, "register_code", { room_id: roomId, uid: me.uid, idem });
    const created = await op(roomStub(env, roomId), "create", { id: roomId, code: reg.code, owner: me, content });
    return reply({ ok: true, code: reg.code, room: created.room }, 201);
  }

  if (method === "POST" && path === "/rooms/join") {
    const body = await readJson(request, 1000);
    const code = cleanText(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== CODE_LEN) fail(400, "bad_code", "رمز الدعوة غير صحيح.");
    await op(dir(env), "gate", { uid: me.uid, kind: "join" });
    const r = await op(dir(env), "resolve_code", { code });
    const res = await op(roomStub(env, r.room_id), "join", { user: me });
    return reply({ ok: true, status: res.status, room: res.room });
  }

  let m = /^\/rooms\/([a-f0-9]{32})(?:\/([a-z]+))?$/.exec(path);
  if (!m) return reply({ ok: false, error: "not_found", message: "المسار غير موجود." }, 404);
  const roomId = m[1], act = m[2] || "";
  const stub = roomStub(env, roomId);

  if (act === "ws") {
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") fail(426, "upgrade_required", "يتطلب WebSocket.");
    await op(stub, "authorize", { uid: me.uid });        // عضو فقط (مالك أو ضيف مقبول)
    const h = new Headers(request.headers);
    h.set("x-uid", me.uid);
    return stub.fetch(new Request("https://do/ws", { method: "GET", headers: h }));
  }
  if (method === "GET" && act === "") return reply(Object.assign({ ok: true }, await op(stub, "view", { uid: me.uid })));
  if (method === "GET" && act === "messages") {
    return reply(Object.assign({ ok: true }, await op(stub, "messages", { uid: me.uid, episode_id: url.searchParams.get("episode_id") || "", after: url.searchParams.get("after") || "0" })));
  }
  if (method === "GET" && act === "moments") {
    return reply(Object.assign({ ok: true }, await op(stub, "moments", { uid: me.uid, episode_id: url.searchParams.get("episode_id") || "" })));
  }
  if (method === "POST") {
    const body = await readJson(request, 3000);
    if (act === "respond") return reply(Object.assign({ ok: true }, await op(stub, "respond", { uid: me.uid, accept: body.accept === true })));
    if (act === "start") return reply(Object.assign({ ok: true }, await op(stub, "start", { uid: me.uid })));
    if (act === "leave") return reply(Object.assign({ ok: true }, await op(stub, "leave", { uid: me.uid })));
    if (act === "close") return reply(Object.assign({ ok: true }, await op(stub, "close", { uid: me.uid })));
    if (act === "kick") return reply(Object.assign({ ok: true }, await op(stub, "kick", { uid: me.uid, ban: body.ban === true })));
    if (act === "settings") return reply(Object.assign({ ok: true }, await op(stub, "settings", { uid: me.uid, shared_control: body.shared_control })));
    if (act === "report") return reply(Object.assign({ ok: true }, await op(stub, "report", { uid: me.uid, reason: cleanText(body.reason, 300) })));
  }
  return reply({ ok: false, error: "not_found", message: "المسار غير موجود." }, 404);
}

// =====================================================================================
//  TogetherDirectory
// =====================================================================================
export class TogetherDirectory {
  constructor(state, env) { this.state = state; this.s = state.storage; this.env = env; this.rl = new Map(); }

  async fetch(request) {
    try {
      const { op, p } = await request.json();
      const fn = this["op_" + op];
      if (!fn) fail(400, "bad_op", "عملية غير معروفة.");
      return new Response(JSON.stringify(Object.assign({ ok: true }, await fn.call(this, p || {}))), { headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e instanceof HttpError) return new Response(JSON.stringify({ ok: false, error: e.code, message: e.message }), { status: e.status, headers: { "content-type": "application/json" } });
      console.log("dir error", e && e.stack || e);
      return new Response(JSON.stringify({ ok: false, error: "server_error", message: "خطأ داخلي." }), { status: 500 });
    }
  }

  // حدود المعدّل: 10 إنشاءات/ساعة و30 محاولة انضمام/ساعة لكل مستخدم (تمنع تخمين الرموز)
  async op_gate(p) {
    const now = Date.now();
    const lim = p.kind === "create" ? 10 : 30;
    const key = p.kind + "|" + p.uid;
    const arr = (this.rl.get(key) || []).filter((t) => now - t < 3600000);
    if (arr.length >= lim) fail(429, "rate_limited", "محاولات كثيرة. انتظر قليلاً.");
    arr.push(now);
    this.rl.set(key, arr);
    if (this.rl.size > 5000) this.rl.clear();
    if (p.kind === "create" && p.idem) {
      const ex = await this.s.get("idem|" + p.uid + "|" + p.idem);
      if (ex && ex.exp > now) return { existing: ex };
    }
    return {};
  }
  async op_register_code(p) {
    const now = Date.now();
    let code = "";
    for (let i = 0; i < 12; i++) {
      const c = randomCode();
      if (!(await this.s.get("code|" + c))) { code = c; break; }
    }
    if (!code) fail(503, "code_space", "تعذر إنشاء رمز. حاول مجدداً.");
    await this.s.put("code|" + code, { room_id: p.room_id, exp: now + CODE_TTL_MS });
    if (p.idem) await this.s.put("idem|" + p.uid + "|" + p.idem, { room_id: p.room_id, code, exp: now + 600000 });
    await this.state.storage.setAlarm(now + CODE_TTL_MS + 60000);
    return { code };
  }
  async op_resolve_code(p) {
    const r = await this.s.get("code|" + p.code);
    if (!r) fail(404, "bad_code", "رمز الدعوة غير صحيح أو منتهٍ.");
    if (r.exp < Date.now()) { await this.s.delete("code|" + p.code); fail(410, "code_expired", "انتهت صلاحية رمز الدعوة."); }
    return { room_id: r.room_id };
  }
  async op_drop_code(p) { await this.s.delete("code|" + p.code); return {}; }
  async alarm() {
    const now = Date.now();
    const all = await this.s.list({ prefix: "code|" });
    for (const [k, v] of all) if (v.exp < now) await this.s.delete(k);
    const idem = await this.s.list({ prefix: "idem|" });
    for (const [k, v] of idem) if (v.exp < now) await this.s.delete(k);
  }
}

// =====================================================================================
//  TogetherRoom
// =====================================================================================
export class TogetherRoom {
  constructor(state, env) {
    this.state = state; this.s = state.storage; this.env = env;
    this.room = null;
    this.rl = new Map();
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.state.blockConcurrencyWhile(async () => { this.room = (await this.s.get("room")) || null; });
  }

  async save() { await this.s.put("room", this.room); }
  now() { return Date.now(); }
  touch() { this.room.last_activity = this.now(); }

  // ---------------- HTTP/WS entry
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.upgrade(request);
    try {
      const { op, p } = await request.json();
      const fn = this["op_" + op];
      if (!fn) fail(400, "bad_op", "عملية غير معروفة.");
      const out = await fn.call(this, p || {});
      return new Response(JSON.stringify(Object.assign({ ok: true }, out)), { headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e instanceof HttpError) return new Response(JSON.stringify({ ok: false, error: e.code, message: e.message }), { status: e.status, headers: { "content-type": "application/json" } });
      console.log("room error", e && e.stack || e);
      return new Response(JSON.stringify({ ok: false, error: "server_error", message: "خطأ داخلي." }), { status: 500 });
    }
  }

  // ---------------- membership
  role(uid) {
    const r = this.room;
    if (!r) return "";
    if (r.owner.uid === uid) return "owner";
    if (r.guest && r.guest.uid === uid) return "guest";
    return "";
  }
  mustExist() {
    if (!this.room) fail(404, "no_room", "الغرفة غير موجودة.");
    if (this.room.status === "closed") fail(410, "room_closed", "أُغلقت الغرفة.");
  }
  mustBeMember(uid) { this.mustExist(); const r = this.role(uid); if (!r) fail(403, "not_member", "لست عضواً في هذه الغرفة."); return r; }
  mustBeOwner(uid) { if (this.mustBeMember(uid) !== "owner") fail(403, "owner_only", "هذا الإجراء لصاحب الغرفة فقط."); }

  // ---------------- views
  playbackNow() {
    const pb = this.room.playback;
    const now = this.now();
    let pos = pb.position_ms;
    if (pb.status === "playing") pos = pb.position_ms + Math.max(0, now - pb.ref_ms);
    return { status: pb.status, position_ms: Math.max(0, Math.round(pos)), ref_ms: pb.ref_ms, state_version: pb.state_version, server_ms: now, start_at: pb.start_at || 0 };
  }
  publicRoom(forUid) {
    const r = this.room;
    const role = this.role(forUid);
    const base = { id: r.id, status: r.status, content: r.content };
    if (!role) return Object.assign(base, { role: forUid && r.pending && r.pending.uid === forUid ? "pending" : "none" });
    return Object.assign(base, {
      role, code: role === "owner" ? r.code : undefined,
      owner: r.owner, guest: r.guest || null,
      pending: role === "owner" ? (r.pending || null) : undefined,
      shared_control: !!r.shared_control, epoch: r.epoch,
      playback: this.playbackNow(), ready: r.ready,
      presence: this.presence(), pending_change: r.pending_change || null,
      wait_request: r.wait_request || null,
    });
  }
  presence(except) {                                       // except: السوكت الذي يُغلق الآن (ما زال يظهر داخل معالج الإغلاق)
    const out = {};
    for (const who of [this.room.owner, this.room.guest]) if (who) out[who.uid] = this.state.getWebSockets(who.uid).filter((w) => w !== except).length > 0;
    return out;
  }

  // ---------------- HTTP ops
  async op_create(p) {
    if (this.room) fail(409, "exists", "الغرفة موجودة.");
    const now = this.now();
    this.room = {
      id: p.id, code: p.code, created_at: now, last_activity: now,
      owner: p.owner, guest: null, pending: null, banned: [],
      status: "waiting", content: p.content, shared_control: false,
      epoch: 0, ready: {}, seq: 0, msgs: [], moments: [], reports: [],
      playback: { state_version: 1, status: "paused", position_ms: 0, ref_ms: now, start_at: 0 },
      pending_change: null, wait_request: null, absent_since: 0,
    };
    await this.save();
    await this.s.setAlarm(now + 60000);
    return { room: this.publicRoom(p.owner.uid) };
  }
  async op_view(p) {
    this.mustExist();
    return { room: this.publicRoom(p.uid) };
  }
  async op_authorize(p) { this.mustBeMember(p.uid); return {}; }

  async op_join(p) {
    this.mustExist();
    const r = this.room, u = p.user;
    if (r.banned.indexOf(u.uid) >= 0) fail(403, "banned", "لا يمكنك الانضمام لهذه الغرفة.");
    if (r.owner.uid === u.uid) return { status: "owner", room: this.publicRoom(u.uid) };
    if (r.guest && r.guest.uid === u.uid) return { status: "member", room: this.publicRoom(u.uid) };
    if (r.pending && r.pending.uid === u.uid) return { status: "pending", room: this.publicRoom(u.uid) };
    if (r.guest || r.pending) fail(409, "room_full", "الغرفة مكتملة (الإصدار الأول يدعم شخصين).");
    r.pending = Object.assign({ requested_at: this.now() }, u);
    this.touch(); await this.save();
    this.broadcast({ t: "join.request", user: u }, [r.owner.uid]);
    return { status: "pending", room: this.publicRoom(u.uid) };
  }
  async op_respond(p) {
    this.mustBeOwner(p.uid);
    const r = this.room;
    if (!r.pending) fail(409, "no_pending", "لا يوجد طلب انضمام.");
    const who = r.pending; r.pending = null;
    if (p.accept) {
      r.guest = { uid: who.uid, name: who.name, avatar_url: who.avatar_url };
      this.touch(); await this.save();
      this.broadcastState({ t: "join.accepted" });
    } else {
      this.touch(); await this.save();
      this.broadcast({ t: "join.rejected", uid: who.uid });
      this.broadcastState({});
    }
    return { room: this.publicRoom(p.uid) };
  }
  async op_start(p) {
    this.mustBeOwner(p.uid);
    const r = this.room;
    if (!r.guest) fail(409, "no_guest", "بانتظار صديقك.");
    if (r.status === "waiting") r.status = "active";
    this.beginLoad(r.content);                           // نفس حاجز الجاهزية المستخدم عند تغيير الحلقة
    this.touch(); await this.save();
    this.broadcastState({ t: "room.started" });
    return { room: this.publicRoom(p.uid) };
  }
  async op_leave(p) {
    this.mustBeMember(p.uid);
    const r = this.room;
    if (r.owner.uid === p.uid) return this.closeRoom("owner_left");
    r.guest = null; r.ready = {}; r.pending_change = null; r.wait_request = null;
    r.playback = this.freeze();
    this.touch(); await this.save();
    this.broadcastState({ t: "guest.left" });
    return { left: true };
  }
  async op_close(p) { this.mustBeOwner(p.uid); return this.closeRoom("owner_closed"); }
  async op_kick(p) {
    this.mustBeOwner(p.uid);
    const r = this.room;
    if (!r.guest) fail(409, "no_guest", "لا يوجد ضيف.");
    const g = r.guest;
    if (p.ban && r.banned.indexOf(g.uid) < 0) r.banned.push(g.uid);
    r.guest = null; r.ready = {}; r.pending_change = null; r.wait_request = null;
    r.playback = this.freeze();
    this.touch(); await this.save();
    for (const ws of this.state.getWebSockets(g.uid)) { try { ws.send(JSON.stringify({ t: "kicked" })); ws.close(4403, "kicked"); } catch (e) {} }
    this.broadcastState({ t: "guest.left" });
    return {};
  }
  async op_settings(p) {
    this.mustBeOwner(p.uid);
    if (typeof p.shared_control === "boolean") this.room.shared_control = p.shared_control;
    this.touch(); await this.save();
    this.broadcastState({});
    return { room: this.publicRoom(p.uid) };
  }
  async op_report(p) {
    this.mustBeMember(p.uid);
    const r = this.room;
    r.reports.push({ by: p.uid, reason: p.reason, at: this.now() });
    if (r.reports.length > 20) r.reports.shift();
    await this.save();
    console.log("together report room=" + r.id);           // يظهر في سجلات Cloudflare للمراجعة اليدوية
    return {};
  }
  async op_messages(p) {
    this.mustBeMember(p.uid);
    const after = intIn(p.after, 0, 1e12, 0);
    let list = this.room.msgs.filter((m) => m.seq > after);
    if (p.episode_id) list = list.filter((m) => m.episode_id === p.episode_id || m.system);
    return { messages: list.slice(-100) };
  }
  async op_moments(p) {
    this.mustBeMember(p.uid);
    const e = p.episode_id || this.room.content.episode_id;
    return { moments: this.room.moments.filter((m) => m.episode_id === e) };
  }

  async closeRoom(reason) {
    const r = this.room;
    r.status = "closed"; r.playback = this.freeze(); r.msgs = []; r.moments = [];
    await this.save();
    this.broadcast({ t: "room.closed", reason });
    for (const ws of this.state.getWebSockets()) { try { ws.close(4000, "closed"); } catch (e) {} }
    try { await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("dir")).fetch("https://do/op", { method: "POST", body: JSON.stringify({ op: "drop_code", p: { code: r.code } }) }); } catch (e) {}
    return { closed: true };
  }

  // ---------------- playback state machine (مصدر الحقيقة)
  freeze() {                                              // يثبّت الموضع عند الإيقاف
    const n = this.playbackNow();
    return { state_version: this.room.playback.state_version + 1, status: n.status === "loading" ? "loading" : "paused", position_ms: n.position_ms, ref_ms: this.now(), start_at: 0 };
  }
  setPlayback(status, position_ms, extra) {
    const pb = this.room.playback;
    this.room.playback = Object.assign({ state_version: pb.state_version + 1, status, position_ms: Math.max(0, Math.floor(position_ms)), ref_ms: this.now(), start_at: 0 }, extra || {});
  }
  beginLoad(content) {                                    // تحميل حلقة/فيلم جديد: الجميع يجب أن يرسل ready
    const r = this.room;
    r.content = content; r.epoch += 1; r.ready = {}; r.pending_change = null; r.wait_request = null;
    this.setPlayback("loading", 0);
    this.addSystem("episode", content);
  }
  maybeStartAfterReady() {
    const r = this.room;
    if (r.playback.status !== "loading" || !r.guest) return false;
    if (!(r.ready[r.owner.uid] && r.ready[r.guest.uid])) return false;
    const startAt = this.now() + START_LEAD_MS;           // الطرفان يبدآن عند نفس لحظة ساعة الخادم
    this.room.playback = { state_version: r.playback.state_version + 1, status: "playing", position_ms: 0, ref_ms: startAt, start_at: startAt };
    return true;
  }
  addSystem(kind, content) {
    const r = this.room;
    r.seq += 1;
    r.msgs.push({ seq: r.seq, system: true, kind, episode_id: content.episode_id, text: kind === "episode" ? this.episodeLabel(content) : "", sent_at: this.now() });
    if (r.msgs.length > MAX_MSGS) r.msgs.shift();
  }
  episodeLabel(c) {
    if (c.type === "episode") return (c.series_title || c.title) + " — الموسم " + c.season + " الحلقة " + c.episode;
    return c.title;
  }

  // ---------------- broadcast
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  broadcast(obj, uids) {
    const s = JSON.stringify(obj);
    const targets = uids ? uids.flatMap((u) => this.state.getWebSockets(u)) : this.state.getWebSockets();
    for (const ws of targets) { try { ws.send(s); } catch (e) {} }
  }
  broadcastState(extra) {
    const r = this.room;
    for (const who of [r.owner, r.guest]) {
      if (!who) continue;
      const msg = Object.assign({}, extra || {}, { t: "state", room: this.publicRoom(who.uid) });
      if (extra && extra.t && extra.t !== "state" && !extra.cause) msg.cause = extra.t;   // t يبقى "state" دائماً؛ السبب في cause
      for (const ws of this.state.getWebSockets(who.uid)) this.send(ws, msg);
    }
  }

  // ---------------- WebSocket (Hibernation API)
  upgrade(request) {
    const uid = request.headers.get("x-uid") || "";
    if (!this.room || !uid || !this.role(uid)) return new Response("forbidden", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [uid]);
    server.serializeAttachment({ uid });
    // اتصال جديد يحل محل القديم لنفس المستخدم (جهاز واحد نشط)
    for (const old of this.state.getWebSockets(uid)) if (old !== server) { try { old.close(4001, "replaced"); } catch (e) {} }
    this.room.absent_since = 0;
    this.touch();
    this.save().then(() => {
      this.send(server, { t: "snapshot", room: this.publicRoom(uid), server_ms: this.now() });
      this.broadcast({ t: "presence", presence: this.presence() });
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(ws, code, reason) {
    if (!this.room) return;
    this.broadcast({ t: "presence", presence: this.presence(ws) });
    if (this.state.getWebSockets().filter((w) => w !== ws).length === 0) { this.room.absent_since = this.now(); await this.save(); await this.s.setAlarm(this.now() + ABSENT_CLOSE_MS); }
  }
  async webSocketError(ws) { try { ws.close(1011, "error"); } catch (e) {} }

  rate(uid, kind, max, windowMs) {
    const now = this.now(), key = kind + "|" + uid;
    const arr = (this.rl.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return false;
    arr.push(now); this.rl.set(key, arr);
    return true;
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > 4000) return;
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    const att = ws.deserializeAttachment() || {};
    const uid = att.uid;
    if (!this.room || this.room.status === "closed" || !uid || !this.role(uid)) { try { ws.close(4403, "forbidden"); } catch (e) {} return; }
    const reqId = msg.id;
    const ack = (ok, extra) => this.send(ws, Object.assign({ t: "ack", id: reqId, ok }, extra || {}));
    try {
      await this.handle(ws, uid, msg, ack);
    } catch (e) {
      if (e instanceof HttpError) ack(false, { error: e.code, message: e.message });
      else { console.log("ws error", e && e.stack || e); ack(false, { error: "server_error" }); }
    }
  }

  canControl(uid) { return this.role(uid) === "owner" || !!this.room.shared_control; }

  async handle(ws, uid, msg, ack) {
    const r = this.room;
    const role = this.role(uid);
    const me = role === "owner" ? r.owner : r.guest;
    const t = String(msg.t || "");
    // أوامر التشغيل تحمل epoch؛ أمر من حلقة قديمة يُتجاهل (مثل أمر متأخر بعد تغيير الحلقة)
    const stale = (m) => m.epoch !== undefined && Number(m.epoch) !== r.epoch;

    if (t === "time") { this.send(ws, { t: "time", client_ms: msg.client_ms, server_ms: this.now() }); return; }
    if (t === "sync") { this.send(ws, { t: "snapshot", room: this.publicRoom(uid), server_ms: this.now() }); return ack(true); }

    if (t === "play" || t === "pause" || t === "seek") {
      if (stale(msg)) return ack(false, { error: "stale_epoch" });
      if (!this.canControl(uid)) return ack(false, { error: "not_allowed", message: "التحكم لصاحب الغرفة. أرسل طلباً." });
      if (!r.guest) return ack(false, { error: "no_guest" });
      if (r.playback.status === "loading") return ack(false, { error: "loading" });
      const cur = this.playbackNow();
      let pos = msg.position_ms === undefined ? cur.position_ms : intIn(msg.position_ms, 0, 48 * 3600 * 1000, cur.position_ms);
      if (t === "play") this.setPlayback("playing", pos);
      else if (t === "pause") this.setPlayback("paused", pos);
      else this.setPlayback(cur.status === "playing" ? "playing" : "paused", pos);
      this.touch(); await this.save();
      this.broadcastState({ t: "state", cause: t, by: uid });
      return ack(true, { state_version: r.playback.state_version });
    }

    if (t === "ctl.request") {                            // ضيف بلا صلاحية يطلب إجراءً من المالك
      if (stale(msg)) return ack(false, { error: "stale_epoch" });
      if (role === "owner") return ack(false, { error: "bad_request" });
      if (!this.rate(uid, "ctl", 5, 10000)) return ack(false, { error: "rate_limited" });
      const action = ["play", "pause", "seek"].indexOf(msg.action) >= 0 ? msg.action : "";
      if (!action) return ack(false, { error: "bad_request" });
      const req = { req_id: randomId(6), from: uid, name: me.name, action, position_ms: intIn(msg.position_ms, 0, 48 * 3600 * 1000, 0), epoch: r.epoch, at: this.now() };
      this.broadcast({ t: "ctl.request", req }, [r.owner.uid]);
      r.pending_ctl = req; await this.save();
      return ack(true);
    }
    if (t === "ctl.respond") {
      if (role !== "owner") return ack(false, { error: "owner_only" });
      const req = r.pending_ctl;
      if (!req || req.req_id !== msg.req_id) return ack(false, { error: "no_request" });
      r.pending_ctl = null; await this.save();
      if (msg.accept === true && req.epoch === r.epoch && r.playback.status !== "loading") {
        const cur = this.playbackNow();
        if (req.action === "play") this.setPlayback("playing", req.position_ms || cur.position_ms);
        else if (req.action === "pause") this.setPlayback("paused", req.position_ms || cur.position_ms);
        else this.setPlayback(cur.status === "playing" ? "playing" : "paused", req.position_ms);
        this.touch(); await this.save();
        this.broadcastState({ t: "state", cause: req.action, by: uid });
      } else {
        this.broadcast({ t: "ctl.denied", req_id: req.req_id }, [req.from]);
      }
      return ack(true);
    }

    if (t === "ready") {                                  // الجهاز حمّل الفيديو وهو جاهز للبدء
      if (stale(msg)) return ack(false, { error: "stale_epoch" });
      r.ready[uid] = true;
      const started = this.maybeStartAfterReady();
      this.touch(); await this.save();
      if (started) this.broadcastState({ t: "state", cause: "start", by: uid });
      else this.broadcast({ t: "ready", ready: r.ready });
      return ack(true);
    }
    if (t === "buffering") {                              // معلومة للطرف الآخر فقط؛ لا نوقف الفيلم لكل تقطيع عابر
      this.broadcast({ t: "buffering", uid, on: msg.on === true }, [role === "owner" ? (r.guest && r.guest.uid) : r.owner.uid].filter(Boolean));
      return;
    }

    if (t === "chat") {
      if (!r.guest) return ack(false, { error: "no_guest" });
      const text = cleanText(msg.text, MAX_TEXT);
      const mid = cleanText(msg.message_id, 60);
      if (!text || !mid) return ack(false, { error: "bad_request" });
      const dup = r.msgs.find((m) => m.message_id === mid && m.uid === uid);   // إعادة محاولة/إعادة اتصال لا تكرر الرسالة
      if (dup) return ack(true, { seq: dup.seq, duplicate: true });
      if (!this.rate(uid, "chat", 5, 5000)) return ack(false, { error: "rate_limited", message: "رسائل كثيرة بسرعة." });
      if (stale(msg)) return ack(false, { error: "stale_epoch" });
      r.seq += 1;
      const m = {
        seq: r.seq, message_id: mid, uid, name: me.name, avatar_url: me.avatar_url || "", text,
        position_ms: intIn(msg.position_ms, 0, 48 * 3600 * 1000, 0),   // موضع الفيديو لحظة الإرسال (غير وقت الساعة)
        episode_id: r.content.episode_id, sent_at: this.now(),
      };
      r.msgs.push(m); if (r.msgs.length > MAX_MSGS) r.msgs.shift();
      this.touch(); await this.save();
      this.broadcast({ t: "chat", message: m });
      return ack(true, { seq: m.seq });
    }
    if (t === "reaction") {
      const kind = ["like", "laugh", "wow", "clap", "sad"].indexOf(msg.kind) >= 0 ? msg.kind : "";
      if (!kind || !r.guest) return ack(false, { error: "bad_request" });
      if (!this.rate(uid, "react", 6, 5000)) return ack(false, { error: "rate_limited" });
      this.broadcast({ t: "reaction", uid, name: me.name, kind });
      return ack(true);
    }
    if (t === "moment") {
      const text = cleanText(msg.text, 200);
      const mid = cleanText(msg.moment_id, 60);
      if (!text || !mid || !r.guest) return ack(false, { error: "bad_request" });
      const dup = r.moments.find((m) => m.moment_id === mid && m.uid === uid);
      if (dup) return ack(true, { duplicate: true });
      if (!this.rate(uid, "moment", 6, 30000)) return ack(false, { error: "rate_limited" });
      const mo = { moment_id: mid, uid, name: me.name, avatar_url: me.avatar_url || "", text, position_ms: intIn(msg.position_ms, 0, 48 * 3600 * 1000, 0), episode_id: r.content.episode_id, room_id: r.id, created_at: this.now() };
      r.moments.push(mo); if (r.moments.length > MAX_MOMENTS) r.moments.shift();
      this.touch(); await this.save();
      this.broadcast({ t: "moment", moment: mo });
      return ack(true);
    }
    if (t === "wait.request") {                           // «انتظرني»: طلب مؤدب، لا أمر قسري
      if (role === "owner" || !r.guest) return ack(false, { error: "bad_request" });
      if (!this.rate(uid, "wait", 3, 60000)) return ack(false, { error: "rate_limited" });
      r.wait_request = { from: uid, name: me.name, at: this.now() };
      await this.save();
      this.broadcast({ t: "wait.request", from: uid, name: me.name }, [r.owner.uid]);
      return ack(true);
    }
    if (t === "wait.respond") {
      if (role !== "owner" || !r.wait_request) return ack(false, { error: "bad_request" });
      const from = r.wait_request.from;
      if (msg.accept === true) { const cur = this.playbackNow(); this.setPlayback("paused", cur.position_ms); r.wait_request.accepted = true; }
      else r.wait_request = null;
      await this.save();
      this.broadcastState({ t: "wait.responded", accept: msg.accept === true });
      return ack(true);
    }
    if (t === "wait.back") {                              // «رجعت، نكمل»
      if (!r.wait_request || r.wait_request.from !== uid) return ack(false, { error: "bad_request" });
      r.wait_request = null; await this.save();
      this.broadcast({ t: "wait.back", from: uid, name: me.name });
      this.broadcastState({});
      return ack(true);
    }

    // ---- الانتقال للحلقة التالية/موسم: اقتراح ثم موافقة الطرف الآخر ثم حاجز جاهزية
    if (t === "episode.request") {
      if (!r.guest) return ack(false, { error: "no_guest" });
      if (!this.rate(uid, "ep", 6, 60000)) return ack(false, { error: "rate_limited" });
      const content = cleanContent(msg.content);
      r.pending_change = { from: uid, name: me.name, content, at: this.now() };
      await this.save();
      this.broadcastState({ t: "episode.request" });
      return ack(true);
    }
    if (t === "episode.respond") {
      const pc = r.pending_change;
      if (!pc) return ack(false, { error: "no_request" });
      if (pc.from === uid) return ack(false, { error: "bad_request", message: "الطرف الآخر هو من يردّ." });
      if (msg.accept === true) {
        this.beginLoad(pc.content);
        this.touch(); await this.save();
        this.broadcastState({ t: "episode.changed" });
      } else {
        r.pending_change = null; await this.save();
        this.broadcastState({ t: "episode.declined" });
      }
      return ack(true);
    }
  }

  // ---------------- تنظيف دوري (الاحتفاظ: 24 ساعة بعد آخر نشاط، ثم تُحذف الغرفة والمحادثة نهائياً)
  async alarm() {
    if (!this.room) return;
    const now = this.now(), r = this.room;
    if (r.status === "closed" || now - r.last_activity > ROOM_IDLE_MS) { await this.s.deleteAll(); this.room = null; return; }
    if (this.state.getWebSockets().length === 0 && r.absent_since && now - r.absent_since >= ABSENT_CLOSE_MS) { await this.closeRoom("absent"); await this.s.setAlarm(now + 60000); return; }
    await this.s.setAlarm(now + 5 * 60000);
  }
}
