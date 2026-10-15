/* Deadline accounts: a small Supabase client (sign-up / sign-in with a username and password, plus one
   row of saved state per person) and the sync that keeps this device's list in step with the account.
   No build step and no supabase-js. The page loads this file only when config.js turns accounts on;
   under Node it exports the same object, so the merge logic can be unit-tested.

   Saved on this device (localStorage):
     deadline.session        { access_token, refresh_token, expires_at, user: { id, username, display_name } }
     deadline.acct.<user id> { state, base, rev, dirty }   base = the state as last agreed with the server
   On the server: public.deadline_state, one row per user, data = { v: 1, rev, state }. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeadlineAccount = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SESSION_KEY = "deadline.session";
  const recKey = id => "deadline.acct." + id;
  const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/;
  const MIN_PASSWORD = 8, MAX_PASSWORD_BYTES = 72;   // Supabase Auth refuses passwords over 72 bytes
  const arr = v => Array.isArray(v) ? v : [];
  const obj = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
  const num = v => Number.isFinite(+v) ? +v : 0;

  // ---------- usernames + passwords ----------
  function checkUsername(u) {
    u = String(u || "").trim();
    if (!u) return "Pick a username.";
    if (u.length < 3) return "Usernames need at least 3 characters.";
    if (u.length > 24) return "Usernames can be 24 characters at most.";
    if (!USERNAME.test(u)) return "Usernames can only use letters, numbers, _ . and -, and start with a letter or number.";
    return "";
  }
  const loginEmail = (u, domain) => String(u || "").trim().toLowerCase() + "@" + String(domain || "users.deadline.invalid").replace(/^@/, "");
  const utf8Length = s => typeof TextEncoder === "function" ? new TextEncoder().encode(s).length : unescape(encodeURIComponent(s)).length;
  // the same rules for a new account and a new password ("Your password" / "Your new password")
  function checkPassword(pw, label) {
    pw = String(pw == null ? "" : pw); label = label || "Your password";
    if (pw.length < MIN_PASSWORD) return `${label} needs at least ${MIN_PASSWORD} characters.`;
    if (!pw.trim()) return `${label} can’t be only spaces.`;
    if (utf8Length(pw) > MAX_PASSWORD_BYTES) return `${label} is too long. Use ${MAX_PASSWORD_BYTES} characters or fewer (an emoji or accented letter counts as 2 to 4).`;
    return "";
  }

  // ---------- 3-way merge ----------
  // Same value, written in any key order (Postgres jsonb sorts keys), gives the same string.
  function canon(v) {
    if (v === undefined) return "~";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(x => x === undefined ? "null" : canon(x)).join(",") + "]";
    return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  // unchanged on one side: take the other; changed on both: local wins
  function pick3(b, l, r) {
    const cb = canon(b), cl = canon(l), cr = canon(r);
    if (cl === cr || cr === cb) return l;
    if (cl === cb) return r;
    return l;
  }
  function mergeMap(b, l, r) {
    b = obj(b); l = obj(l); r = obj(r);
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
      const v = pick3(b[k], l[k], r[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  // (L ∩ R) ∪ (L − B) ∪ (R − B), in local order, then remote additions
  function mergeSet(b, l, r) {
    const B = new Set(arr(b)), L = new Set(arr(l)), R = new Set(arr(r)), out = new Set();
    for (const x of L) if (R.has(x) || !B.has(x)) out.add(x);
    for (const x of R) if (!L.has(x) && !B.has(x)) out.add(x);
    return [...out];
  }
  // the same deadline changed on both devices: field by field, so a done tick on the phone and a new due
  // date from the laptop both stay; a field changed on both takes this device's value
  function pickFields(b, l, r) {
    if (!isObj(b) || !isObj(l) || !isObj(r)) return pick3(b, l, r);
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
      const v = pick3(b[k], l[k], r[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  const byId = list => { const m = new Map(); for (const x of arr(list)) if (x && x.id != null && !m.has(x.id)) m.set(x.id, x); return m; };
  // keyed by id; absent = deleted. Deleted on one side and edited on the other keeps the edit, unless
  // the id is in `gone` (it went to Recently deleted); that also holds for one added on one side only
  // (restored on one device, restored and deleted again on the other).
  function mergeKeyed(B, L, R, gone, fieldwise) {
    const mb = byId(B), ml = byId(L), mr = byId(R);
    const decide = id => {
      const b = mb.get(id), l = ml.get(id), r = mr.get(id);
      if (l && r) return fieldwise ? pickFields(b, l, r) : pick3(b, l, r);
      const one = l || r;
      if (!one) return undefined;
      if (gone && gone.has(id)) return undefined;          // in Recently deleted: not on the list too
      if (!b) return one;                                  // added on one side
      if (canon(one) === canon(b)) return undefined;       // deleted on the other side, untouched here
      return one;                                          // deleted there (not into Recently deleted), edited here
    };
    const out = [], done = new Set();
    for (const x of arr(L)) {
      if (!x || x.id == null) { if (x) out.push(x); continue; }
      if (done.has(x.id)) continue;
      done.add(x.id);
      const v = decide(x.id); if (v) out.push(v);
    }
    for (const x of arr(R)) {
      if (!x || x.id == null || done.has(x.id)) continue;
      done.add(x.id);
      const v = decide(x.id); if (v) out.push(v);
    }
    return out;
  }
  // The laptop's Canvas sign-in and the Canvas calendar file give the same assignment different uids;
  // like the app's own Canvas import (mergeCanvas in index.html), they match on title + due date
  // (+ course when both have one).
  const apiUid = u => /^canvas-api-/.test(String(u || ""));
  const low = s => String(s || "").trim().toLowerCase();
  const sameTask = (a, b) => a.source === "canvas" && b.source === "canvas" && apiUid(a.uid) !== apiUid(b.uid) && !!a.due && a.due === b.due
    && low(a.title) === low(b.title) && (!a.meta || !b.meta || a.meta === b.meta);
  // Two devices both said Yes to a program, or imported the same Canvas task: keep one copy, the one
  // already in base, else local's (earlier in the list).
  function dedupeItems(items, baseItems, localItems) {
    const inBase = new Set(arr(baseItems).map(i => i && i.id)), inLocal = new Set(arr(localItems).map(i => i && i.id));
    const rank = it => inBase.has(it.id) ? 0 : inLocal.has(it.id) ? 1 : 2;
    let out = arr(items).filter(Boolean);
    for (const keyOf of [it => it.uid ? "u:" + it.uid : "", it => it.programId ? "p:" + it.programId : ""]) {
      const best = new Map();
      for (const it of out) { const k = keyOf(it); if (k && (!best.has(k) || rank(it) < rank(best.get(k)))) best.set(k, it); }
      out = out.filter(it => { const k = keyOf(it); return !k || best.get(k) === it; });
    }
    const byDue = new Map(), drop = new Set();
    for (const it of out) if (it.source === "canvas" && it.due) byDue.set(it.due, (byDue.get(it.due) || []).concat(it));
    for (const group of byDue.values()) {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!drop.has(a) && !drop.has(b) && sameTask(a, b)) drop.add(rank(b) < rank(a) ? a : b);
      }
    }
    return drop.size ? out.filter(it => !drop.has(it)) : out;
  }
  // The same deadline (or the same program's No) deleted on two devices: one Recently deleted entry,
  // the one already agreed (in base), else this device's.
  function collapseTrash(trash, baseTrash) {
    const inBase = new Set(arr(baseTrash).map(t => t && t.id));
    const keyOf = t => !t ? "" : t.kind === "item" ? (t.item && t.item.id != null ? "i:" + t.item.id : "") : t.kind === "program" && t.programId ? "p:" + t.programId : "";
    const best = new Map();
    for (const t of trash) { const k = keyOf(t); if (k && (!best.has(k) || (inBase.has(t.id) && !inBase.has(best.get(k).id)))) best.set(k, t); }
    return trash.filter(t => { const k = keyOf(t); return !k || best.get(k) === t; });
  }
  // A program deadline on the list means yes, whichever device said what: its No and any deleted copy of
  // it leave Recently deleted (restoring that copy would only put a second one on the list).
  function settlePrograms(out) {
    const progs = new Set(arr(out.items).filter(i => i && i.programId).map(i => i.programId));
    if (!progs.size) return out;
    out.decisions = Object.assign({}, obj(out.decisions));
    for (const p of progs) out.decisions[p] = "yes";
    out.trash = arr(out.trash).filter(t => !(t && (t.kind === "program" ? progs.has(t.programId) : t.item && progs.has(t.item.programId))));
    return out;
  }
  function mergeCanvasField(b, l, r) {
    if (l === undefined && r === undefined) return undefined;
    b = obj(b); const L = obj(l), R = obj(r), out = {};
    for (const k of new Set([...Object.keys(L), ...Object.keys(R), ...Object.keys(b)])) {
      const v = k === "removed" ? mergeSet(b[k], L[k], R[k]) : pick3(b[k], L[k], R[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  function merge3(base, local, remote) {
    const B = obj(base), L = obj(local), R = obj(remote), out = {};
    for (const k of new Set([...Object.keys(L), ...Object.keys(R), ...Object.keys(B)])) {
      if (k === "items" || k === "trash") continue;
      let v;
      if (k === "decisions") v = mergeMap(B[k], L[k], R[k]);
      else if (k === "seen") v = mergeSet(B[k], L[k], R[k]);
      else if (k === "canvas") v = mergeCanvasField(B[k], L[k], R[k]);
      else if (k === "visits") v = Math.max(num(L[k]), num(R[k]));
      else v = pick3(B[k], L[k], R[k]);
      if (v !== undefined) out[k] = v;
    }
    out.trash = collapseTrash(mergeKeyed(B.trash, L.trash, R.trash, null), B.trash);
    const gone = new Set(out.trash.filter(t => t && t.item && t.item.id != null).map(t => t.item.id));
    out.items = dedupeItems(mergeKeyed(B.items, L.items, R.items, gone, true), B.items, L.items);
    return settlePrograms(out);
  }
  // Guest data (saved before signing in) joins the account: the account's copy wins wherever both have one.
  function mergeGuest(acct, guest) {
    const A = obj(acct), G = obj(guest);
    const out = Object.assign({}, G, A);
    const ids = new Set(arr(A.items).map(i => i && i.id));
    out.items = dedupeItems(arr(A.items).concat(arr(G.items).filter(i => i && !ids.has(i.id))), A.items, A.items);
    const tids = new Set(arr(A.trash).map(t => t && t.id)), onList = new Set(out.items.map(i => i.id));
    out.trash = collapseTrash(arr(A.trash).concat(arr(G.trash).filter(t => t && !tids.has(t.id))), A.trash)
      .filter(t => !(t && t.kind === "item" && t.item && onList.has(t.item.id)));
    out.decisions = Object.assign({}, obj(G.decisions), obj(A.decisions));
    // a program that is on the merged list counts as a yes, wherever the answer came from
    settlePrograms(out);
    out.seen = [...new Set(arr(A.seen).concat(arr(G.seen)))];
    const ca = obj(A.canvas), cg = obj(G.canvas);
    out.canvas = Object.assign({}, cg, ca, {
      feed: ca.feed || cg.feed || "",
      lastImport: [ca.lastImport, cg.lastImport].filter(Boolean).sort().pop() || null,
      removed: [...new Set(arr(ca.removed).concat(arr(cg.removed)))],
    });
    out.visits = Math.max(num(A.visits), num(G.visits));
    out.name = A.name || G.name || "";
    if (A.trashMigrated || G.trashMigrated) out.trashMigrated = true;
    return out;
  }
  // Only what this device changed since it last agreed with the server: base and state cut down to the
  // deadlines, Recently deleted entries, choices and fields that differ. merge3 treats everything left out
  // as the server's, so merging this into the account later gives the same result as the full copy would.
  // null when no deadline, entry or choice changed (opening the app counts a visit and marks programs seen).
  function pendingOnly(base, state) {
    const B = obj(base), L = obj(state), b = {}, l = {};
    let worth = false;
    for (const k of new Set([...Object.keys(B), ...Object.keys(L)])) {
      if (canon(B[k]) === canon(L[k])) continue;
      if (k === "items" || k === "trash" || k === "decisions" || k === "canvas") worth = true;
      if (k === "items" || k === "trash") {
        const mb = byId(B[k]), ml = byId(L[k]), touched = id => canon(mb.get(id)) !== canon(ml.get(id));
        b[k] = arr(B[k]).filter(x => x && x.id != null && touched(x.id));
        l[k] = arr(L[k]).filter(x => x && (x.id == null || touched(x.id)));
      } else if (k === "decisions" || k === "canvas") {
        const ob = obj(B[k]), ol = obj(L[k]);
        b[k] = {}; l[k] = {};
        for (const kk of new Set([...Object.keys(ob), ...Object.keys(ol)])) {
          if (canon(ob[kk]) === canon(ol[kk])) continue;
          if (kk in ob) b[k][kk] = ob[kk];
          if (kk in ol) l[k][kk] = ol[kk];
        }
      } else {
        if (k in B) b[k] = B[k];
        if (k in L) l[k] = L[k];
      }
    }
    return worth ? { base: b, state: l } : null;
  }
  // Postgres can't keep U+0000 or half of a surrogate pair (an emoji cut in two) in jsonb, so one such
  // character would stop the whole list from ever saving again: they're dropped before sending.
  const BAD_TEXT = /[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]|\u0000/g;
  function scrub(v) {
    if (typeof v === "string") return v.replace(BAD_TEXT, m => m.length === 2 ? m : "");
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[scrub(k)] = scrub(v[k]); return o; }
    return v;
  }

  // ---------- plain-words errors ----------
  function friendly(e) {
    if (!e) return "Something went wrong. Try again.";
    if (e.friendly) return e.friendly;
    if (e.network) return "Can’t reach the server. Check your internet connection and try again.";
    if (e.signedOut) return "You’re signed out. Sign in again.";
    const code = String(e.error_code || e.code || ""), msg = String(e.msg || "");
    if (e.status === 429 || /rate_limit/.test(code) || /rate limit/i.test(msg)) return "Too many tries. Wait a minute, then try again.";
    if (code === "user_already_exists" || code === "email_exists" || /already registered/i.test(msg)) return "That username is taken. Try a different one.";
    if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return "Wrong username or password.";
    if (code === "email_not_confirmed") return "Accounts can’t sign in yet: the app’s owner needs to turn off “Confirm email” in Supabase (Authentication → Sign In / Providers → Email).";
    if (code === "signup_disabled" || /signups not allowed/i.test(msg)) return "New accounts are switched off right now. Ask the app’s owner to turn sign-ups back on in Supabase.";
    if (code === "email_address_invalid") return "Supabase won’t accept the sign-in address the app makes from usernames. The app’s owner needs to change usernameDomain in config.js.";
    if (code === "42501" || /permission denied/i.test(msg)) return "Your account works, but saving is blocked: the app’s owner needs to run the table setup in Supabase again, including the “grant select, insert, update, delete … to authenticated” line.";
    // the size limit in the owner's table setup (README: deadline_state_size)
    if (code === "23514") return "Your list is too big to save to your account. Delete deadlines you don’t need and empty Recently deleted, then it syncs again.";
    if ((code === "22P02" || code === "22P05") && /json|unicode|surrogate/i.test(msg)) return "A deadline has a character that can’t be saved to your account. Deadline will try again in a minute.";
    if (code === "42P01" || code === "PGRST205" || /deadline_state/.test(msg)) return "Saving isn’t set up yet: the app’s owner needs to create the deadline_state table in Supabase.";
    if (code === "weak_password") return "That password is too easy to guess. Use at least 8 characters with a mix of letters and numbers.";
    if (/longer than 72|72 characters/i.test(msg)) return `That password is too long. Use ${MAX_PASSWORD_BYTES} characters or fewer.`;
    if (code === "same_password") return "Your new password has to be different from your current one.";
    if (code === "current_password_mismatch") return "Your current password isn’t right.";
    if (code === "reauthentication_needed" || code === "current_password_required") return "Sign out, sign back in, then change your password right away.";
    if (code === "refresh_token_not_found" || code === "session_not_found" || code === "session_expired") return "You were signed out. Sign in again.";
    if (e.conflict) return "Your devices kept changing at the same moment. Deadline will try again in a minute.";
    if (e.status === 401 && /api key/i.test(msg)) return "The app’s Supabase key in config.js isn’t right. Ask the app’s owner to check it.";
    if (e.status >= 500) return "The server had a problem. Try again in a minute.";
    return `Something went wrong${e.status ? ` (error ${e.status})` : ""}. Try again in a minute.`;
  }

  // ---------- client + sync ----------
  function memoryStore() {
    const m = {};
    return { get: k => k in m ? JSON.parse(m[k]) : null, set: (k, v) => { m[k] = JSON.stringify(v); }, remove: k => { delete m[k]; } };
  }
  // one tab at a time refreshes the session or talks to the row (other tabs share the same saved copy)
  function withLock(name, fn) {
    const locks = typeof navigator !== "undefined" && navigator.locks;
    return locks && locks.request ? locks.request(name, () => fn()) : fn();
  }

  function create(cfg, hooks) {
    hooks = hooks || {};
    const base = String(cfg.supabaseUrl || "").trim().replace(/\/+$/, "");
    const key = String(cfg.supabaseKey || "").trim();
    const domain = String(cfg.usernameDomain || "users.deadline.invalid").trim();
    const store = hooks.store || memoryStore();
    const fire = (name, ...a) => { try { if (hooks[name]) hooks[name](...a); } catch (e) { setTimeout(() => { throw e; }); } };
    const signedOutErr = () => Object.assign(new Error("signed out"), { signedOut: true });

    // apikey always; Authorization only with a person's access token (never the publishable key)
    async function call(path, { method = "GET", body, token, headers, keepalive, timeout = 20000 } = {}) {
      const h = Object.assign({ apikey: key }, headers || {});
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined) h["content-type"] = "application/json";
      if (token) h.authorization = "Bearer " + token;
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), timeout) : 0;
      let res, text;
      try {
        res = await fetch(base + path, { method, headers: h, body: payload, cache: "no-store", signal: ctl ? ctl.signal : undefined,
          keepalive: !!keepalive && (!payload || payload.length < 60000) });
        text = await res.text();
      } catch (e) {
        throw Object.assign(new Error("network"), { network: true });
      } finally { clearTimeout(t); }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) {}
      if (!res.ok) {
        const d = obj(data);
        throw Object.assign(new Error("HTTP " + res.status), { status: res.status, code: d.code, error_code: d.error_code, msg: d.msg || d.message || d.error_description || "" });
      }
      return data;
    }

    const readSession = () => { const s = store.get(SESSION_KEY); return s && s.access_token && s.user && s.user.id ? s : null; };
    const expiring = s => !s.expires_at || s.expires_at * 1000 - Date.now() < 60000;
    function sessionFrom(data, prev) {
      const u = obj(data.user), m = obj(u.user_metadata), p = obj(prev && prev.user);
      return {
        access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: num(data.expires_at) || Math.floor(Date.now() / 1000) + (num(data.expires_in) || 3600),
        user: {
          id: u.id || p.id,
          username: m.username || p.username || String(u.email || "").split("@")[0],
          display_name: typeof m.display_name === "string" ? m.display_name : (p.display_name || ""),
        },
      };
    }
    function setSession(s) { const old = readSession(); store.set(SESSION_KEY, s); fire("onSession", s, old); }
    // best effort: end a session on the server (scope=local: only that one, the person's other devices stay signed in)
    const logout = token => call("/auth/v1/logout?scope=local", { method: "POST", token, timeout: 4000 }).catch(() => {});
    // the refresh token was revoked or ran out: signed out, with a message. Changes that never reached the
    // server stay on the device (only those, not the whole list) and are merged in if this person signs in
    // here again; the page drops them after a while (index.html, sweepAccounts).
    function endSession(msg) {
      const s = readSession();
      stop();
      store.remove(SESSION_KEY);
      if (s) {
        const k = recKey(s.user.id), rec = store.get(k);
        const left = rec && rec.dirty && rec.state ? pendingOnly(rec.base, rec.state) : null;
        if (left) store.set(k, { state: left.state, base: left.base, rev: num(rec.rev), dirty: true, keptAt: Date.now() });
        else store.remove(k);
      }
      fire("onSignedOut", msg);
    }

    // a fresh access token, refreshed shortly before it expires (refresh tokens rotate, so re-read storage first)
    function fresh(force) {
      const s = readSession();
      if (!s) return Promise.reject(signedOutErr());
      if (!force && !expiring(s)) return Promise.resolve(s);
      return withLock("deadline-refresh", async () => {
        const cur = readSession();
        if (!cur) throw signedOutErr();
        if (cur.refresh_token !== s.refresh_token && !expiring(cur)) return cur;   // another tab just did it
        let data;
        try {
          data = await call("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: cur.refresh_token } });
        } catch (e) {
          if (e.network || !(e.status === 400 || e.status === 401)) throw e;      // offline: stay signed in
          const now = readSession();
          if (!now) throw signedOutErr();                                         // signed out meanwhile
          if (now.refresh_token !== cur.refresh_token) return now;
          endSession("You were signed out. If your password was changed on another device, sign in with the new one.");
          throw signedOutErr();
        }
        const ns = sessionFrom(data, cur);
        // Signed out (in this tab or another) or signed in as someone else while the answer was on its way:
        // never write it back (the next person to open the app would be signed in as this student). The new
        // tokens belong to nobody now, so that session is ended on the server too.
        const now = readSession();
        if (!now || now.user.id !== cur.user.id) { logout(ns.access_token); throw signedOutErr(); }
        if (now.refresh_token !== cur.refresh_token) return now;                // replaced meanwhile on this device
        setSession(ns);
        return ns;
      });
    }
    async function authed(path, opts) {
      let s = await fresh(false);
      try { return await call(path, Object.assign({}, opts, { token: s.access_token })); }
      catch (e) {
        if (e.status !== 401 || e.code === "42501") throw e;
        s = await fresh(true);
        return call(path, Object.assign({}, opts, { token: s.access_token }));
      }
    }

    // ----- account actions -----
    async function signUp({ username, displayName, password }) {
      const bad = checkUsername(username);
      if (bad) throw Object.assign(new Error(bad), { friendly: bad });
      const data = await call("/auth/v1/signup", { method: "POST", body: { email: loginEmail(username, domain), password, data: { username: String(username).trim(), display_name: displayName } } });
      if (!data || !data.access_token) throw Object.assign(new Error("no session"), { error_code: "email_not_confirmed" });
      const s = sessionFrom(data);
      store.set(SESSION_KEY, s);
      return s;
    }
    async function signIn({ username, password }) {
      if (checkUsername(username)) throw Object.assign(new Error("bad username"), { error_code: "invalid_credentials" });
      const data = await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email: loginEmail(username, domain), password } });
      const s = sessionFrom(data);
      store.set(SESSION_KEY, s);
      return s;
    }
    // drop the session on this device only (no network), e.g. when loading the account failed
    function forget() { stop(); store.remove(SESSION_KEY); }
    // The session and the account's list leave this device at once (before the returned promise does any
    // network), so the page can show the signed-out screen right away; the server is told in the background.
    function signOut() {
      const s = readSession();
      stop();
      store.remove(SESSION_KEY);
      if (!s) return Promise.resolve();
      store.remove(recKey(s.user.id));
      // scope=local: only this device; the phone stays signed in when the laptop signs out
      return logout(s.access_token);
    }
    async function setDisplayName(name) {
      const u = obj(await authed("/auth/v1/user", { method: "PUT", body: { data: { display_name: name } } }));
      const cur = readSession();
      if (!cur) return;
      const dn = typeof obj(u.user_metadata).display_name === "string" ? u.user_metadata.display_name : name;
      setSession(Object.assign({}, cur, { user: Object.assign({}, cur.user, { display_name: dn }) }));
    }
    // checks the current password by signing in with it, then sets the new one with that fresh session
    async function changePassword(current, next) {
      const s = await fresh(false);
      let data;
      try {
        data = await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email: loginEmail(s.user.username, domain), password: current } });
      } catch (e) {
        if (e.error_code === "invalid_credentials") throw Object.assign(new Error("wrong password"), { friendly: "Your current password isn’t right." });
        throw e;
      }
      const ns = sessionFrom(data, s);
      const now = readSession();
      if (!now || now.user.id !== s.user.id) { logout(ns.access_token); throw signedOutErr(); }   // signed out meanwhile
      setSession(ns);
      logout(s.access_token);
      // current_password is for projects that require it; Supabase signs out the other devices after this
      await call("/auth/v1/user", { method: "PUT", token: ns.access_token, body: { password: next, current_password: current } });
    }

    // ----- the saved row -----
    async function fetchRow() {
      const s = readSession();
      if (!s) throw signedOutErr();
      const rows = await authed(`/rest/v1/deadline_state?user_id=eq.${encodeURIComponent(s.user.id)}&select=data`, {});
      const d = Array.isArray(rows) && rows[0] ? rows[0].data : null;
      if (!d || typeof d !== "object") return null;
      return { rev: num(d.rev), state: obj(d.state) };
    }

    let started = false, running = null, wantPull = false, wantPush = false, keep = false;
    let pushTimer = 0, retryTimer = 0, pollTimer = 0;
    let status = { state: "idle", at: 0, error: "" };
    function setStatus(state, error) {
      status = { state, at: state === "synced" ? Date.now() : status.at, error: error || "" };
      fire("onStatus", status);
    }
    const mine = id => { const s = readSession(); return started && !!s && s.user.id === id; };
    function adopt(k, id, remote) {
      store.set(k, { state: remote.state, base: remote.state, rev: remote.rev, dirty: false });
      fire("onRemote", remote.state, id);
    }
    function mergeIn(k, id, rec, remote) {
      const merged = merge3(rec.base, rec.state, remote.state);
      store.set(k, { state: merged, base: remote.state, rev: remote.rev, dirty: true });
      fire("onRemote", merged, id);
    }

    // send local changes: only if the row is still at the rev this device last saw; otherwise merge and retry
    async function pushOnce() {
      let conflicts = 0;
      for (;;) {
        const s = readSession();
        if (!s) return;
        const id = s.user.id, k = recKey(id), rec = store.get(k);
        if (!rec || !rec.state || !rec.dirty) { setStatus("synced"); return; }
        const rev = num(rec.rev);
        if (rev && canon(rec.state) === canon(rec.base)) { rec.dirty = false; store.set(k, rec); setStatus("synced"); return; }
        const clean = scrub(rec.state);
        if (canon(clean) !== canon(rec.state)) { rec.state = clean; store.set(k, rec); fire("onRemote", clean, id); }
        setStatus("syncing");
        const sent = rec.state, data = { v: 1, rev: rev + 1, state: sent }, updated_at = new Date().toISOString();
        let ok;
        if (!rev) {
          ok = await authed("/rest/v1/deadline_state", { method: "POST", headers: { prefer: "return=minimal" }, body: { user_id: id, data, updated_at }, keepalive: keep })
            .then(() => true, e => { if (e.status === 409 || e.code === "23505") return false; throw e; });
        } else {
          const rows = await authed(`/rest/v1/deadline_state?user_id=eq.${encodeURIComponent(id)}&data-%3E%3Erev=eq.${rev}&select=user_id`,
            { method: "PATCH", headers: { prefer: "return=representation" }, body: { data, updated_at }, keepalive: keep });
          ok = Array.isArray(rows) && rows.length > 0;
        }
        if (!mine(id)) return;
        const cur = store.get(k) || { state: sent };
        if (ok) {
          cur.base = sent; cur.rev = rev + 1; cur.dirty = canon(cur.state) !== canon(sent);
          store.set(k, cur);
          if (!cur.dirty) { setStatus("synced"); return; }
          continue;                                          // edited again while that was on its way
        }
        if (++conflicts > 3) throw Object.assign(new Error("conflict"), { conflict: true });
        const remote = await fetchRow();
        if (!mine(id)) return;
        const now = store.get(k) || cur;
        if (!remote) { now.rev = 0; now.dirty = true; store.set(k, now); continue; }
        mergeIn(k, id, now, remote);
      }
    }
    // After a pull this device's list holds everything the server had: onFresh tells the page, which holds
    // back automatic edits (the weekly program dates, the laptop's Canvas sync) until then.
    async function pullOnce() {
      const s = readSession();
      if (!s) return;
      const id = s.user.id, k = recKey(id);
      const remote = await fetchRow();
      if (!mine(id)) return;
      const rec = store.get(k);
      if (!remote) {
        fire("onFresh", id);
        const now = store.get(k);
        if (!now || !now.state) { setStatus("synced"); return; }
        if (now.rev || !now.dirty) { now.rev = 0; now.dirty = true; store.set(k, now); }   // the row is gone: save it again
        return pushOnce();
      }
      if (!rec || !rec.state || (remote.rev !== num(rec.rev) && !rec.dirty)) adopt(k, id, remote);
      else if (remote.rev !== num(rec.rev)) mergeIn(k, id, rec, remote);
      fire("onFresh", id);
      const now = store.get(k);
      if (now && now.dirty) return pushOnce();
      setStatus("synced");
    }
    function failed(e) {
      if (e && e.signedOut) return;
      clearTimeout(retryTimer);
      if (e && e.network) setStatus("offline");
      else setStatus("error", friendly(e));
      retryTimer = setTimeout(pull, e && e.network ? 15000 : 60000);
    }
    function kick() {
      if (!started) return Promise.resolve();
      if (running) return running;
      running = (async () => {
        try {
          while (started && (wantPull || wantPush)) {
            const p = wantPull;
            wantPull = wantPush = false;
            await withLock("deadline-sync", () => p ? pullOnce() : pushOnce());
          }
        } catch (e) { failed(e); }
        finally { running = null; keep = false; }
      })();
      return running;
    }
    function pull() { if (!started) return; wantPull = true; kick(); }
    function queuePush() {
      if (!started) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => { wantPush = true; kick(); }, 1000);
    }
    function isDirty() {
      const s = readSession(), r = s && store.get(recKey(s.user.id));
      return !!(r && r.dirty && !(r.rev && canon(r.state) === canon(r.base)));
    }
    // leaving the page: send what's waiting now, best effort
    function flush() {
      if (!started || !isDirty()) return;
      clearTimeout(pushTimer);
      keep = true; wantPush = true; kick();
    }
    function syncNow() { if (!started) return Promise.resolve(); clearTimeout(pushTimer); wantPush = true; return kick(); }
    function start(pulled) {
      if (started) return;
      started = true;
      if (pulled) wantPush = true; else wantPull = true;
      kick();
      clearInterval(pollTimer);
      pollTimer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") pull(); }, 60000);
    }
    function stop() {
      started = false; wantPull = wantPush = false;
      clearTimeout(pushTimer); clearTimeout(retryTimer); clearInterval(pollTimer);
      status = { state: "idle", at: 0, error: "" };
    }
    if (typeof window !== "undefined" && window.addEventListener && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); else pull(); });
      window.addEventListener("pagehide", flush);
      window.addEventListener("focus", pull);
      window.addEventListener("online", pull);
    }

    return {
      session: readSession, status: () => Object.assign({ dirty: isDirty() }, status),
      signUp, signIn, signOut, forget, setDisplayName, changePassword, fetchRow,
      start, stop, pull, queuePush, syncNow, isDirty,
    };
  }

  return { SESSION_KEY, recKey, MIN_PASSWORD, MAX_PASSWORD_BYTES, checkUsername, checkPassword, loginEmail, canon, merge3, mergeGuest, dedupeItems,
    pendingOnly, scrub, friendly, create };
});
