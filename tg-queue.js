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
   - Shows a top status bar: connection state, queue count, and a Refresh.

   HOW IT HOOKS IN
   - It overrides window.fetch and only touches POSTs to the Apps Script
     endpoint. Every other request (the GET that loads last ratings, the map
     data, etc.) passes straight through untouched.
   - No change to Audrey's submit() logic is required — just load this file
     with a single <script> tag in <head>.

   SAVE GUARANTEE
   - Sends use mode:'no-cors' (Apps Script returns no CORS headers, so the
     POST reply can't be read). We therefore CONFIRM every save with a
     readable GET (?action=savedids / ?action=check) before removing an item
     from the queue. Nothing is dropped until the server confirms it saved.

   TRUTHFUL STATUS (added 2026-07-15)
   - The connection dot no longer trusts navigator.onLine alone. It reflects
     whether the SAVE ENDPOINT is actually reachable: green "Live" only when a
     recent GET to the endpoint succeeded; red "Not saving" when the phone has
     internet but the endpoint can't be reached (the exact failure that used to
     hide behind a false green dot and silently lose ratings).
   ============================================================ */
(function () {
  "use strict";

  var DB_NAME = "tgQueueDB";
  var STORE = "submissions";
  var ENDPOINT_RE = /script\.google\.com\/macros\//i;
  var RETRY_MS = 20000;          // background retry interval while items remain
  var PING_MS = 30000;           // endpoint health-check interval
  var sending = {};              // ids currently in-flight on this page
  var dbPromise = null;
  var lastN = 0;
  var TG_VERSION = "20260716c";  // bump on every JS deploy; must match the ?v= in the HTML <script> includes
  var storageFailed = false;     // set when IndexedDB writes fail even after retry (iOS stale-handle)
  var updateAvailable = false;
  var BOOT_TS = Date.now();      // used to allow auto-reload only right after the page opens

  // Endpoint health: null = unknown, true = reachable/saving, false = NOT saving.
  var endpointBase = null;
  var endpointOk = null;
  var lastPing = 0;
  try { endpointBase = localStorage.getItem("tgEndpointBase") || null; } catch (e) {}

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

  /* ---------- endpoint memory + health ---------- */
  function rememberEndpoint(url) {
    try {
      var b = (url || "").split("?")[0];
      if (b && ENDPOINT_RE.test(b) && b !== endpointBase) {
        endpointBase = b;
        localStorage.setItem("tgEndpointBase", b);
      }
    } catch (e) {}
  }

  // A readable GET to the save endpoint. Success => we can actually save here.
  function pingEndpoint() {
    if (!endpointBase) { endpointOk = null; return Promise.resolve(); }
    lastPing = Date.now();
    return ORIG_FETCH(endpointBase + "?action=savedids&ping=" + Date.now(),
                      { method: "GET", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { endpointOk = !!(j && j.ids); })
      .catch(function () { endpointOk = false; })
      .then(function () { updateBadge(); });
  }

  /* ---------- queueing ---------- */
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function enqueue(url, body) {
    rememberEndpoint(url);
    var bodyStr = typeof body === "string" ? body : "";
    var id = uuid();
    // Stamp a submissionId into the JSON payload (backend dedups on it).
    try {
      var obj = JSON.parse(bodyStr);
      if (obj && typeof obj === "object") {
        obj.submissionId = id;
        bodyStr = JSON.stringify(obj);
      }
    } catch (e) { /* not JSON — store as-is */ }
    var item = { id: id, url: url, body: bodyStr, ts: Date.now(), attempts: 0 };
    // iOS WebKit invalidates IndexedDB handles on long-open/backgrounded pages;
    // a put on a stale handle rejects. Retry ONCE with a completely fresh
    // connection before giving up (2026-07-16 silent-loss incident).
    return putItem(item).catch(function () {
      dbPromise = null;
      return putItem(item);
    }).then(function () {
      storageFailed = false;
      updateBadge();
    });
  }

  /* ---------- sending ---------- */
  // Ask the backend (readable GET) whether this submissionId already saved.
  function isSaved(item) {
    var base = item.url.split("?")[0];
    var check = base + "?action=check&id=" + encodeURIComponent(item.id);
    return ORIG_FETCH(check, { method: "GET" })
      .then(function (r) { endpointOk = r.ok ? true : endpointOk; return r.ok ? r.json() : { saved: false }; })
      .then(function (j) { return !!(j && j.saved); })
      .catch(function () { endpointOk = false; return false; });
  }

  function sendItem(item) {
    if (sending[item.id]) return Promise.resolve();
    sending[item.id] = true;
    return isSaved(item).then(function (saved) {
      if (saved) return deleteItem(item.id);
      return ORIG_FETCH(item.url, {
        method: "POST",
        mode: "no-cors",
        body: item.body,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      }).then(function () {
        // Delivered, but do NOT delete yet — the next flush confirms via
        // isSaved()/savedids before removing it, so nothing is dropped early.
        item.attempts = (item.attempts || 0) + 1;
        return putItem(item);
      }).catch(function () {
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
  // so a whole burst is confirmed in a single call. Also doubles as a health ping.
  function getSavedIds(base) {
    return ORIG_FETCH(base + "?action=savedids&t=" + Date.now(), { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ids) { endpointOk = false; return null; }
        endpointOk = true; lastPing = Date.now();
        var s = {}; j.ids.forEach(function (id) { s[String(id)] = 1; });
        return s;
      })
      .catch(function () { endpointOk = false; return null; });
  }

  var flushing = false;
  var RESEND_MS = 12000;   // don't re-send an item we already sent within this window
  function flush() {
    if (flushing) return;
    if (!navigator.onLine) { updateBadge(); return; }
    flushing = true;
    getAll().then(function (items) {
      if (!items.length) return;
      rememberEndpoint(items[0].url);
      items.sort(function (a, b) { return a.ts - b.ts; });
      var base = (items[0].url || "").split("?")[0];
      return getSavedIds(base).then(function (saved) {
        var now = Date.now();
        var chain = Promise.resolve();
        items.forEach(function (item) {
          chain = chain.then(function () {
            if (!navigator.onLine) return;
            if (saved && saved[item.id]) return deleteItem(item.id);
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
        return chain.then(function () {
          // If we (re)sent anything this cycle, confirm quickly instead of
          // waiting for the next 20s interval — makes "N to upload" clear in
          // seconds after a successful save rather than minutes.
          var sentAny = items.some(function (it) { return it.lastSent === now; });
          if (sentAny) setTimeout(function () { flush(); }, 3500);
        });
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
          // CRITICAL: resolve only AFTER the submission is persisted to IndexedDB.
          // The form does `await fetch(...)` then immediately redirects to the bed
          // list; if we resolved before the async save committed, the navigation
          // aborted the save and the rating was lost (never stored, never sent).
          // Awaiting enqueue here makes the redirect wait for persistence; flush()
          // then sends it, and the next page load re-flushes from IndexedDB, so a
          // submission can never be dropped by the post-submit navigation.
          return enqueue(url, body).then(function () {
            flush();
            return new Response(null, { status: 202 });
          }).catch(function () {
            // Storage is broken even after a fresh-connection retry (iOS stale
            // IndexedDB). NEVER fake success here — that silently lost ratings
            // on 2026-07-16. Fall back to sending the rating DIRECTLY to the
            // server (the form's await now genuinely waits on the real send),
            // and raise a loud red storage warning so the rater knows to
            // close+reopen the page.
            storageFailed = true;
            try { updateBadge(); } catch (e2) {}
            return ORIG_FETCH(url, {
              method: "POST", mode: "no-cors", body: body,
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              keepalive: true
            });
          });
        }
      } catch (e) { /* fall through to real fetch */ }
      return ORIG_FETCH(input, init);
    };
  }

  /* ---------- top status bar ---------- */
  var barEl = null, dotEl = null, connTextEl = null, queueEl = null, refreshEl = null;

  function ensureBar() {
    if (barEl) return barEl;
    try {
      var st = document.createElement("style");
      st.textContent = "body{padding-top:38px!important}header{top:38px!important}" +
        ".phead{top:38px!important}" + // bed-panel sticky header (its X was hidden under the bar when scrolled)
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

  // Kept the name updateBadge so existing callers keep working.
  function updateBadge() {
    ensureBar();
    var online = navigator.onLine;
    // Truthful dot: red if offline OR the save endpoint is unreachable.
    var saving = online && (endpointOk !== false);
    if (storageFailed) {
      dotEl.style.background = "#ef4444"; connTextEl.textContent = "Storage error";
      queueEl.style.color = "#fca5a5";
      queueEl.textContent = "⚠ STORAGE ERROR — close & reopen this page";
      return getAll().then(function (items) { lastN = items.length; });
    }
    if (!online) {
      dotEl.style.background = "#ef4444"; connTextEl.textContent = "Offline";
    } else if (endpointOk === false) {
      dotEl.style.background = "#ef4444"; connTextEl.textContent = "Not saving";
    } else {
      dotEl.style.background = "#22c55e"; connTextEl.textContent = "Live";
    }
    if (updateAvailable) {
      refreshEl.textContent = "↻ Update now";
      refreshEl.style.background = "#b45309";
      refreshEl.style.animation = "tgpulse 1.2s ease-in-out infinite";
    }
    return getAll().then(function (items) {
      var n = items.length;
      if (n === 0) {
        if (!saving && online) { queueEl.style.color = "#fca5a5"; queueEl.textContent = "⚠ Can't reach server"; }
        else { queueEl.style.color = "#86efac"; queueEl.textContent = "✓ All saved"; }
      } else {
        if (!online) { queueEl.style.color = "#fde68a"; queueEl.textContent = "⚠ Offline · " + n + " to upload"; }
        else if (endpointOk === false) { queueEl.style.color = "#fca5a5"; queueEl.textContent = "⚠ NOT SAVING · " + n + " stuck — reload"; }
        else { queueEl.style.color = "#fde68a"; queueEl.textContent = "⬆ Uploading… " + n + " to upload"; }
      }
      lastN = n;
    });
  }

  /* ---------- force-fresh page links (kill the stale-cache trap) ---------- */
  // The map, form and OSU pages link to each other with plain relative URLs
  // (rate.html?sku=..., index.html?bed=..., osu.html?plant=...). iOS HTTP cache
  // served WEEKS-old copies of those pages even after deploys — a cached old
  // rate.html silently lost submissions (2026-07-16 Bed 4/21 incident). This
  // stamps every such link with the running TG_VERSION so a new deploy always
  // changes the URL → the cache can never serve a stale page again.
  function stampLinks() {
    try {
      var links = document.querySelectorAll(
        'a[href*="rate.html"],a[href*="osu.html"],a[href*="index.html"],a[href="./"],a[href=""]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        try {
          var u = new URL(a.getAttribute("href"), location.href);
          if (u.origin !== location.origin) continue;
          if (u.searchParams.get("cb") === TG_VERSION) continue;
          u.searchParams.set("cb", TG_VERSION);
          a.setAttribute("href", u.pathname + u.search + u.hash);
        } catch (e) {}
      }
    } catch (e) {}
  }
  // Also catch JS-driven navigations to those pages (location.href = ...).
  // We can't wrap location, but re-stamping on click covers anchor taps that
  // were (re)built dynamically after our last pass.
  document.addEventListener("click", stampLinks, true);

  /* ---------- version / update check ---------- */
  function ownScriptBase() {
    try {
      var s = document.querySelector('script[src*="tg-queue.js"]');
      if (s && s.src) return s.src.split("?")[0];
    } catch (e) {}
    return "tg-queue.js";
  }
  // Is it safe to auto-reload without losing work? Only right after the page
  // opened (nothing entered yet) and with an empty queue and no field being edited.
  function safeToAutoReload() {
    if (Date.now() - BOOT_TS > 8000) return false;          // only during the "just opened" window
    // NOTE: queued items do NOT block the reload — the queue lives in IndexedDB
    // and fully survives a reload. (The old "pending items" guard backfired: a
    // stuck queue kept stale pages stuck on old code forever. 2026-07-16)
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false; // someone's typing
    return true;
  }

  // Force a fully fresh load: a unique query string makes the CDN serve new
  // HTML (which carries the new ?v= for this script), so the device lands on
  // the current version. sessionStorage guard prevents any reload loop.
  function hardReloadToLatest(deployedVer) {
    try {
      if (sessionStorage.getItem("tgReloadedFor") === deployedVer) return false;
      sessionStorage.setItem("tgReloadedFor", deployedVer);
    } catch (e) {}
    try {
      var u = new URL(location.href);
      u.searchParams.set("_v", deployedVer);   // version-specific = CDN cache miss
      u.searchParams.set("r", String(Date.now()));
      location.replace(u.toString());          // replace() = no extra history entry
    } catch (e) { location.reload(); }
    return true;
  }

  function onVersionMismatch(deployedVer) {
    var reloadedFor = null;
    try { reloadedFor = sessionStorage.getItem("tgReloadedFor"); } catch (e) {}
    // Fresh open on stale code -> silently heal to the current version.
    if (safeToAutoReload() && reloadedFor !== deployedVer) {
      hardReloadToLatest(deployedVer);
    } else {
      // Mid-session (rater may be entering data) -> loud manual button instead.
      updateAvailable = true; updateBadge();
    }
  }

  function checkVersion() {
    return ORIG_FETCH(ownScriptBase() + "?vc=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var m = txt.match(/TG_VERSION\s*=\s*["']([^"']+)["']/);
        if (m && m[1] && m[1] !== TG_VERSION) { onVersionMismatch(m[1]); }
      }).catch(function () {});
  }

  /* ---------- browser recommendation (use Chrome, not Safari) ---------- */
  function browserBanner() {
    try {
      var ua = navigator.userAgent || "";
      var isIOS = /iPhone|iPad|iPod/.test(ua) ||
                  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      var isChrome = /CriOS/.test(ua);            // Chrome on iOS
      var isOtherOk = /FxiOS|EdgiOS/.test(ua);    // Firefox/Edge on iOS (leave alone)
      if (!isIOS || isChrome || isOtherOk) return; // only warn iOS Safari / in-app webviews
      if (document.getElementById("tgUseChrome")) return;
      var bar = document.createElement("div");
      bar.id = "tgUseChrome";
      bar.style.cssText = [
        "background:#b45309", "color:#fff", "padding:10px 12px",
        "font:600 13px/1.35 system-ui,-apple-system,sans-serif", "text-align:center"
      ].join(";");
      var msg = document.createElement("span");
      msg.textContent = "⚠ For reliable saving, open this in Chrome — Safari can block saves. ";
      var link = document.createElement("a");
      link.textContent = "Open in Chrome";
      link.href = location.href.replace(/^https?:\/\//, "googlechromes://");
      link.style.cssText = "color:#fff;text-decoration:underline;font-weight:800;white-space:nowrap";
      bar.appendChild(msg); bar.appendChild(link);
      var body = document.body || document.documentElement;
      body.insertBefore(bar, body.firstChild);
    } catch (e) {}
  }

  /* ---------- triggers ---------- */
  function init() {
    ensureBar();
    browserBanner();
    stampLinks();
    updateBadge();
    pingEndpoint();
    flush();
    checkVersion();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  window.addEventListener("online", function () { updateBadge(); pingEndpoint(); flush(); });
  window.addEventListener("offline", updateBadge);
  window.addEventListener("focus", function () { updateBadge(); pingEndpoint(); flush(); checkVersion(); });
  setInterval(function () {
    updateBadge();
    getAll().then(function (items) { if (items.length) flush(); });
  }, RETRY_MS);
  setInterval(function () { if (Date.now() - lastPing > PING_MS - 1000) pingEndpoint(); }, PING_MS);
  setInterval(checkVersion, 60000);

  // Expose a tiny API for manual use / debugging.
  window.TGQueue = {
    flush: flush, pending: getAll, version: TG_VERSION,
    checkVersion: checkVersion, ping: pingEndpoint,
    health: function () { return { endpointBase: endpointBase, endpointOk: endpointOk }; }
  };
})();
