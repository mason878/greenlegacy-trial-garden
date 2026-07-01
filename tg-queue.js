/* ============================================================
   tg-queue.js — Offline submission queue for the Trial Garden forms
   ------------------------------------------------------------
   WHAT IT DOES
   - Transparently intercepts the POST that rate.html / osu.html send to
     the Google Apps Script endpoint (script.google.com/macros/.../exec).
   - Saves every submission to the device first (IndexedDB) so it can NEVER
     be lost — even if signal drops, the tab closes, or the phone sleeps.
   - If the connection is good, it sends immediately (no change you'd notice).
   - If the connection is poor/offline, the submission waits in a queue and
     auto-retries in the background while the user keeps scanning plants.
   - Shows a small "queued" badge in the corner with the count waiting.

   HOW IT HOOKS IN
   - It overrides window.fetch and only touches POSTs to the Apps Script
     endpoint. Every other request (the GET that loads last ratings, the map
     data, etc.) passes straight through untouched.
   - No change to Audrey's submit() logic is required — just load this file
     with a single <script> tag in <head>.

   NOTES
   - Sends use mode:'no-cors'. Apps Script does not return CORS headers, so the
     browser can't read the response body; a resolved no-cors fetch means the
     request reached the server, a rejected one means no connection. That is the
     same delivery guarantee the old fire-and-forget code relied on, now with
     persistence + retry added on top.
   - Each queued item gets a unique submissionId (added to the payload). The
     backend ignores it today, but it's there so a dedup check can be added to
     the Apps Script later for bulletproof no-duplicate guarantees.
   ============================================================ */
(function () {
  "use strict";

  var DB_NAME = "tgQueueDB";
  var STORE = "submissions";
  var ENDPOINT_RE = /script\.google\.com\/macros\//i;
  var RETRY_MS = 20000;          // background retry interval while items remain
  var sending = {};              // ids currently in-flight on this page
  var dbPromise = null;
  var lastN = 0, savedTimer = null;  // for the "all saved" confirmation
  var TG_VERSION = "20260701g";      // bump on every JS deploy; must match the ?v= in the HTML <script> includes
  var updateAvailable = false;

  /* ---------- IndexedDB helpers ---------- */
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function putItem(item) {
    return tx("readwrite").then(function (store) {
      return new Promise(function (resolve, reject) {
        var r = store.put(item);
        r.onsuccess = function () { resolve(); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function deleteItem(id) {
    return tx("readwrite").then(function (store) {
      return new Promise(function (resolve) {
        var r = store.delete(id);
        r.onsuccess = function () { resolve(); };
        r.onerror = function () { resolve(); };
      });
    });
  }

  function getAll() {
    return tx("readonly").then(function (store) {
      return new Promise(function (resolve) {
        var r = store.getAll();
        r.onsuccess = function () { resolve(r.result || []); };
        r.onerror = function () { resolve([]); };
      });
    });
  }

  /* ---------- queueing ---------- */
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function enqueue(url, body) {
    var bodyStr = typeof body === "string" ? body : "";
    var id = uuid();
    // Stamp a submissionId into the JSON payload (future-proofs backend dedup).
    try {
      var obj = JSON.parse(bodyStr);
      if (obj && typeof obj === "object") {
        obj.submissionId = id;
        bodyStr = JSON.stringify(obj);
      }
    } catch (e) { /* not JSON — store as-is */ }
    return putItem({
      id: id,
      url: url,
      body: bodyStr,
      ts: Date.now(),
      attempts: 0
    }).then(updateBadge);
  }

  /* ---------- sending ---------- */
  // Ask the backend (readable GET) whether this submissionId already saved.
  // GET responses from the Apps Script web app ARE readable (CORS-enabled),
  // unlike the no-cors POST — so this is how we get a real save confirmation.
  function isSaved(item) {
    var base = item.url.split("?")[0];
    var check = base + "?action=check&id=" + encodeURIComponent(item.id);
    return ORIG_FETCH(check, { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : { saved: false }; })
      .then(function (j) { return !!(j && j.saved); })
      .catch(function () { return false; }); // can't confirm -> treat as not saved
  }

  function sendItem(item) {
    if (sending[item.id]) return Promise.resolve();
    sending[item.id] = true;
    // 1) Confirm-first: if it already landed on a previous attempt, just drop it.
    //    This prevents re-uploading photos and prevents duplicate rows.
    return isSaved(item).then(function (saved) {
      if (saved) return deleteItem(item.id);
      // 2) Not saved yet -> send it (no-cors; can't read the reply here).
      return ORIG_FETCH(item.url, {
        method: "POST",
        mode: "no-cors",
        body: item.body,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      }).then(function () {
        // Delivered to the server, but we do NOT delete yet. We keep the item
        // and let the NEXT flush confirm via isSaved() before removing it, so
        // a submission is never dropped until we've verified it actually saved.
        item.attempts = (item.attempts || 0) + 1;
        return putItem(item);
      }).catch(function () {
        // No connection. Keep it; bump attempts for visibility.
        item.attempts = (item.attempts || 0) + 1;
        return putItem(item);
      });
    }).then(function () {
      delete sending[item.id];
      updateBadge();
    }).catch(function () {
      delete sending[item.id];
    });
  }

  // One request that returns every submissionId already saved on the server,
  // so a whole burst is confirmed in a single call (no per-item check storm).
  function getSavedIds(base) {
    return ORIG_FETCH(base + "?action=savedids&t=" + Date.now(), { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ids) return null;
        var s = {}; j.ids.forEach(function (id) { s[String(id)] = 1; });
        return s;
      })
      .catch(function () { return null; }); // can't confirm -> treat none as saved (safe: we keep + resend)
  }

  var flushing = false;
  var RESEND_MS = 12000;   // don't re-send an item we already sent within this window
  function flush() {
    if (flushing) return;
    if (!navigator.onLine) { updateBadge(); return; }
    flushing = true;
    getAll().then(function (items) {
      if (!items.length) return;
      items.sort(function (a, b) { return a.ts - b.ts; });
      var base = (items[0].url || "").split("?")[0];
      return getSavedIds(base).then(function (saved) {
        var now = Date.now();
        var chain = Promise.resolve();
        items.forEach(function (item) {
          chain = chain.then(function () {
            if (!navigator.onLine) return;
            // Confirmed saved on the server -> safe to drop from the queue.
            if (saved && saved[item.id]) return deleteItem(item.id);
            // Not confirmed yet: (re)send only if we haven't sent it very recently.
            if (item.lastSent && (now - item.lastSent) < RESEND_MS) return;
            item.lastSent = now;
            return putItem(item).then(function () {
              return ORIG_FETCH(item.url, {
                method: "POST", mode: "no-cors", body: item.body,
                headers: { "Content-Type": "text/plain;charset=utf-8" }
              }).catch(function () {});
            });
          });
        });
        return chain;
      });
    }).then(function () {
      flushing = false;
      updateBadge();
    }).catch(function () {
      flushing = false;
    });
  }

  /* ---------- fetch override ---------- */
  var ORIG_FETCH = window.fetch ? window.fetch.bind(window) : null;
  if (ORIG_FETCH) {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var method = ((init && init.method) ||
                      (input && input.method) || "GET").toUpperCase();
        if (method === "POST" && ENDPOINT_RE.test(url)) {
          var body = init && init.body;
          // Persist first, then try to send; return immediately so the
          // form's UI proceeds exactly as before.
          enqueue(url, body).then(flush);
          return Promise.resolve(new Response(null, { status: 202 }));
        }
      } catch (e) { /* fall through to real fetch */ }
      return ORIG_FETCH(input, init);
    };
  }

  /* ---------- top status bar ---------- */
  var barEl = null, dotEl = null, connTextEl = null, queueEl = null, refreshEl = null;

  function ensureBar() {
    if (barEl) return barEl;
    // Push page content down so the fixed bar doesn't cover it; keep sticky headers below it too.
    try {
      var st = document.createElement("style");
      st.textContent = "body{padding-top:38px!important}header{top:38px!important}" +
        "@keyframes tgpulse{0%,100%{opacity:1}50%{opacity:.5}}";
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
    barEl = document.createElement("div");
    barEl.id = "tgBar";
    barEl.style.cssText = [
      "position:fixed","top:0","left:0","right:0","height:38px","z-index:2147483647",
      "display:flex","align-items:center","justify-content:space-between","gap:8px",
      "padding:0 10px","background:#243024","color:#fff",
      "font:600 13px/1 system-ui,-apple-system,sans-serif","box-shadow:0 1px 6px rgba(0,0,0,.25)"
    ].join(";");
    var conn = document.createElement("div");
    conn.style.cssText = "display:flex;align-items:center;gap:6px;white-space:nowrap";
    dotEl = document.createElement("span");
    dotEl.style.cssText = "width:9px;height:9px;border-radius:50%;background:#22c55e;display:inline-block;flex:none";
    connTextEl = document.createElement("span");
    connTextEl.textContent = "Live";
    conn.appendChild(dotEl); conn.appendChild(connTextEl);
    queueEl = document.createElement("div");
    queueEl.style.cssText = "flex:1;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    queueEl.textContent = "✓ All saved";
    refreshEl = document.createElement("button");
    refreshEl.type = "button";
    refreshEl.style.cssText = [
      "border:0","border-radius:16px","padding:8px 12px","font:600 13px/1 system-ui,sans-serif",
      "background:#3f7d46","color:#fff","cursor:pointer","white-space:nowrap","flex:none"
    ].join(";");
    refreshEl.textContent = "↻ Refresh";
    refreshEl.addEventListener("click", function () {
      refreshEl.textContent = "↻ …";
      // Reload with a cache-buster on the page URL so we fetch the newest HTML + code
      // (while preserving existing params like ?sku= / ?bed=).
      try {
        var u = new URL(location.href);
        u.searchParams.set("r", String(Date.now()));
        location.href = u.toString();
      } catch (e) { location.reload(); }
    });
    barEl.appendChild(conn); barEl.appendChild(queueEl); barEl.appendChild(refreshEl);
    (document.body || document.documentElement).appendChild(barEl);
    return barEl;
  }

  // Kept the name updateBadge so existing callers (flush/sendItem/enqueue) keep working.
  function updateBadge() {
    ensureBar();
    var online = navigator.onLine;
    dotEl.style.background = online ? "#22c55e" : "#ef4444";
    connTextEl.textContent = online ? "Live" : "Offline";
    if (updateAvailable) {
      refreshEl.textContent = "↻ Update now";
      refreshEl.style.background = "#b45309";
      refreshEl.style.animation = "tgpulse 1.2s ease-in-out infinite";
    }
    return getAll().then(function (items) {
      var n = items.length;
      if (n === 0) {
        queueEl.style.color = "#86efac";
        queueEl.textContent = "✓ All saved";
      } else {
        queueEl.style.color = "#fde68a";
        queueEl.textContent = (online ? "⬆ Uploading… " : "⚠ Offline · ") + n + " to upload";
      }
      lastN = n;
    });
  }

  /* ---------- version / update check ---------- */
  function ownScriptBase() {
    try {
      var s = document.querySelector('script[src*="tg-queue.js"]');
      if (s && s.src) return s.src.split("?")[0];
    } catch (e) {}
    return "tg-queue.js";
  }
  function checkVersion() {
    return ORIG_FETCH(ownScriptBase() + "?vc=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var m = txt.match(/TG_VERSION\s*=\s*["']([^"']+)["']/);
        if (m && m[1] && m[1] !== TG_VERSION) { updateAvailable = true; updateBadge(); }
      }).catch(function () {});
  }

  /* ---------- triggers ---------- */
  function init() {
    ensureBar();
    updateBadge();
    flush();
    checkVersion();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  window.addEventListener("online", function () { updateBadge(); flush(); });
  window.addEventListener("offline", updateBadge);
  window.addEventListener("focus", function () { updateBadge(); flush(); checkVersion(); });
  setInterval(function () {
    updateBadge();
    getAll().then(function (items) { if (items.length) flush(); });
  }, RETRY_MS);
  setInterval(checkVersion, 60000);

  // Expose a tiny API for manual use / debugging.
  window.TGQueue = { flush: flush, pending: getAll, version: TG_VERSION, checkVersion: checkVersion };
})();
