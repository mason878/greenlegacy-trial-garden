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
  var TG_VERSION = "20260717d";  // bump on every JS deploy; must match the ?v= in the HTML <script> includes
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

  // Every IndexedDB operation retries ONCE on a completely fresh connection.
  // iOS invalidates DB handles mid-session (sleep/background); with the old
  // helpers a stale handle made getAll() fail or return [] — so the bar LIED
  // "All saved" while unsent ratings sat frozen, and flush() sent nothing,
  // until a manual refresh rebuilt the handle (2026-07-16 field report).
  function idbOp(mode, makeReq) {
    function attempt() {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t, st, req;
          try {
            t = db.transaction(STORE, mode);
            st = t.objectStore(STORE);
            req = makeReq(st);
          } catch (e) { reject(e); return; }
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
    return attempt().catch(function () {
      dbPromise = null;               // stale handle — rebuild from scratch
      return attempt();
    });
  }

  function putItem(item) {
    return idbOp("readwrite", function (st) { return st.put(item); });
  }

  /* ---------- no-hang helpers (v-o) ----------
     iOS IndexedDB doesn't just reject after camera/background abuse — it can
     HANG (neither resolve nor reject). A hung put froze the whole submit with
     no error, no alert, no queue increment: the invisible-loss Mason described
     ("count stops ascending → those are gone"). Every storage wait now has a
     hard timeout, and timedPut NEVER rejects — it reports true/false. */
  function timedPut(item, ms) {
    return Promise.race([
      putItem(item).then(function () { return true; }, function () { return false; }),
      new Promise(function (rs) { setTimeout(function () { rs(false); }, ms || 2500); })
    ]);
  }
  function timedVal(p, ms, fallback) {
    return Promise.race([
      Promise.resolve(p).catch(function () { return fallback; }),
      new Promise(function (rs) { setTimeout(function () { rs(fallback); }, ms); })
    ]);
  }
  function toast(msg, ms, bg) {
    try {
      var t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;left:8px;right:8px;bottom:14px;z-index:2147483647;' +
        'background:' + (bg || '#7a1d1d') + ';color:#fff;font:700 14px/1.4 system-ui,-apple-system,sans-serif;' +
        'padding:12px 14px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.5);text-align:center';
      (document.body || document.documentElement).appendChild(t);
      setTimeout(function () { try { t.parentNode.removeChild(t); } catch (e) {} }, ms || 4000);
    } catch (e) {}
  }

  function deleteItem(id) {
    return idbOp("readwrite", function (st) { return st.delete(id); })
      .catch(function () {});
  }

  // Resolves with the real queue; REJECTS if storage is unreadable even after
  // a fresh connection — callers must NOT treat that as "queue is empty".
  function getAll() {
    return idbOp("readonly", function (st) { return st.getAll(); })
      .then(function (res) { return res || []; });
  }

  /* ---------- localStorage mirror (v-i) ----------
     iOS can kill IndexedDB or silently SWAP it for a fresh EMPTY database
     after camera/background use — queued items become invisible with NO
     error (bar said "All saved" while ratings sat unreachable). Every item
     that fits is therefore ALSO written to localStorage, and every reader
     uses the UNION of both stores. */
  var LSQ = 'tgLSQ';
  function lsAll() {
    try { return JSON.parse(localStorage.getItem(LSQ) || '[]'); } catch (e) { return []; }
  }
  function lsWrite(list) {
    try { localStorage.setItem(LSQ, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function lsPut(item) {
    try {
      var L = lsAll().filter(function (x) { return x && x.id !== item.id; });
      L.push(item);
      var total = 0;
      for (var i = 0; i < L.length; i++) total += String(L[i].body || '').length;
      if (total > 4500000) return false; // over LS budget — IDB only (v-k: raised from 3.5MB)
      return lsWrite(L);
    } catch (e) { return false; }
  }
  function lsDel(id) {
    try { lsWrite(lsAll().filter(function (x) { return x && x.id !== id; })); } catch (e) {}
  }
  /* ---------- photo shrink-to-fit (v-k) ----------
     localStorage has a hard ~5MB quota — with full-size photos the mirror
     capped out at ~7 items and the 8th hit "storage error" when IndexedDB
     was also dead. If an item won't fit, progressively recompress its photo
     (1200px/0.7 → 900/0.6 → 640/0.5) until the LS copy fits. IndexedDB (when
     alive) keeps the full-quality original; the shrunk copy only gets sent
     if IDB is gone — a smaller photo beats a lost rating. */
  function shrinkDataUrl(du, maxPx, q) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.width, h = img.height, sc = Math.min(1, maxPx / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * sc));
          c.height = Math.max(1, Math.round(h * sc));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', q));
        } catch (e) { rej(e); }
      };
      img.onerror = rej;
      img.src = du;
    });
  }
  function photoRefs_(obj) {
    // Accessors for every embedded photo, covering BOTH shapes: bare
    // data:image strings AND rate.html's photos:[{name,data(raw base64)}].
    var refs = [];
    for (var k in obj) {
      (function (key) {
        var v = obj[key];
        if (typeof v === 'string' && v.indexOf('data:image') === 0) {
          refs.push({ get: function () { return obj[key]; },
                      set: function (nd) { obj[key] = nd; } });
        }
      })(k);
    }
    if (obj.photos && obj.photos.length) {
      obj.photos.forEach(function (p) {
        if (p && typeof p.data === 'string' && p.data.length > 2000) {
          refs.push({ get: function () { return 'data:image/' + ((p.type||'').indexOf('webp')>=0?'webp':'jpeg') + ';base64,' + p.data; },
                      set: function (nd) { p.data = String(nd).split(',')[1] || ''; p.type = 'image/jpeg'; /* shrink re-encodes as JPEG — retag (v-717b) */ } });
        }
      });
    }
    return refs;
  }
  function shrinkBodyToFit(item) {
    var obj; try { obj = JSON.parse(item.body); } catch (e) { return Promise.resolve(false); }
    if (!obj || typeof obj !== 'object') return Promise.resolve(false);
    var refs = photoRefs_(obj);
    if (!refs.length) return Promise.resolve(false);
    var steps = [[1200, 0.7], [900, 0.6], [640, 0.5]];
    var i = 0;
    function attempt() {
      if (i >= steps.length) return false;
      var st = steps[i++];
      var ch = Promise.resolve();
      refs.forEach(function (ref) {
        ch = ch.then(function () {
          return shrinkDataUrl(ref.get(), st[0], st[1]).then(function (nd) { ref.set(nd); }, function () {});
        });
      });
      return ch.then(function () {
        var copy = { id: item.id, url: item.url, body: JSON.stringify(obj),
                     ts: item.ts, attempts: item.attempts || 0, shrunk: true };
        return lsPut(copy) ? true : attempt();
      });
    }
    return Promise.resolve().then(attempt);
  }

  /* ---------- mirror compaction (v-l) ----------
     v-k only shrank the INCOMING item — with ~12 full-size photos already in
     the mirror there was no room left, so item 13 was refused even shrunk
     (field cap Mason hit). When the mirror is full, recompress EVERY stored
     copy (pass 1: >150kB → 900px/0.6; pass 2: >80kB → 640px/0.5) to make
     room. Raises worst-case dead-IDB capacity to ~50 items. */
  function compactLS() {
    var L = lsAll();
    if (!L.length) return Promise.resolve(false);
    var passes = [[900, 0.6, 150000], [640, 0.5, 80000]];
    var p = 0;
    function pass() {
      if (p >= passes.length) return Promise.resolve(lsWrite(L));
      var cfg = passes[p++];
      var i = 0;
      function next() {
        if (i >= L.length) {
          var total = 0;
          for (var t = 0; t < L.length; t++) total += String(L[t].body || '').length;
          if (total <= 4000000) return Promise.resolve(lsWrite(L));
          return pass();
        }
        var it = L[i++];
        if (String(it.body || '').length <= cfg[2]) return next();
        var obj; try { obj = JSON.parse(it.body); } catch (e) { return next(); }
        var refs = photoRefs_(obj);
        if (!refs.length) return next();
        var ch = Promise.resolve();
        refs.forEach(function (ref) {
          ch = ch.then(function () {
            return shrinkDataUrl(ref.get(), cfg[0], cfg[1]).then(function (nd) { ref.set(nd); }, function () {});
          });
        });
        return ch.then(function () {
          it.body = JSON.stringify(obj); it.shrunk = true;
          return next();
        });
      }
      return next();
    }
    return pass();
  }

  // Union of both stores. idbOk=false means IndexedDB itself is unreadable
  // (items may still come from the LS mirror). Never rejects.
  function allItems() {
    // v-j: after a rapid refresh, iOS can leave the previous page's IndexedDB
    // teardown in progress — this page's read then HANGS (neither resolves nor
    // rejects) and the bar used to freeze on its boot placeholder. Race the
    // read against a 3s timer; on timeout fall back to the LS mirror.
    var idbRead = getAll().then(
      function (idb) { return { idbOk: true, idb: idb }; },
      function () { return { idbOk: false, idb: [] }; }
    );
    var idbTimeout = new Promise(function (rs) {
      setTimeout(function () { rs({ idbOk: false, idb: [] }); }, 3000);
    });
    return Promise.race([idbRead, idbTimeout]).then(function (r) {
      var seen = {}, out = [];
      r.idb.forEach(function (it) { if (it && it.id && !seen[it.id]) { seen[it.id] = 1; out.push(it); } });
      lsAll().forEach(function (it) { if (it && it.id && !seen[it.id]) { seen[it.id] = 1; out.push(it); } });
      return { items: out, idbOk: r.idbOk };
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
    return tfetch(endpointBase + "?action=savedids&ping=" + Date.now(),
                      { method: "GET", cache: "no-store" }, 12000)
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
    // v20260717a: if the caller PRE-stamped one (split transport), respect it —
    // the photo packet references the scores packet by this id.
    try {
      var obj = JSON.parse(bodyStr);
      if (obj && typeof obj === 'object') {
        if (typeof obj.submissionId === 'string' && obj.submissionId.length >= 8) {
          id = obj.submissionId;
        } else {
          obj.submissionId = id;
          bodyStr = JSON.stringify(obj);
        }
      }
    } catch (e) { /* not JSON — store as-is */ }
    var item = { id: id, url: url, body: bodyStr, ts: Date.now(), attempts: 0 };
    // iOS WebKit invalidates IndexedDB handles on long-open/backgrounded pages;
    // a put on a stale handle rejects. Retry ONCE with a completely fresh
    // connection before giving up (2026-07-16 silent-loss incident).
    // v-i: WRITE-THROUGH — mirror to localStorage FIRST (synchronous; survives
    // iOS killing or swapping IndexedDB), then IndexedDB. The submission is
    // safe (and the form may redirect) if EITHER store holds it.
    var lsOk = lsPut(item);
    // v-o: every stage is timeout-raced — a wedged compressor or dead IDB can
    // slow a submit, never hang it. Chain: full item in LS → compact mirror &
    // retry → shrink this item's photo → LAST RESORT: strip the photo and
    // save the scores (a ~1kB record ALWAYS fits — data loss impossible,
    // worst case is a lost photo, loudly flagged).
    var lsHeldP = lsOk ? Promise.resolve(true)
      : timedVal(compactLS(), 6000, false).then(function () {
          if (lsPut(item)) return true;
          return timedVal(shrinkBodyToFit(item), 6000, false);
        }).then(function (held) {
          if (held) return true;
          try {
            var o = JSON.parse(item.body);
            if (o && typeof o === 'object') {
              var dropped = false;
              for (var k in o) {
                if (typeof o[k] === 'string' && o[k].indexOf('data:image') === 0) { o[k] = ''; dropped = true; }
              }
              if (o.photos && o.photos.length) { o.photos = []; dropped = true; }
              if (dropped) {
                var lite = { id: item.id, url: item.url, body: JSON.stringify(o),
                             ts: item.ts, attempts: item.attempts || 0, shrunk: true, photoDropped: true };
                if (lsPut(lite)) {
                  toast('⚠ Photo dropped to save this rating — scores are safe. Retake the photo later.');
                  return 'lite';
                }
              }
            }
          } catch (e) {}
          return false;
        });
    return lsHeldP.then(function (lsHeld) {
      return timedPut(item, 2500).then(function (ok1) {
        if (ok1) { storageFailed = false; updateBadge(); return; }
        dbPromise = null;
        return timedPut(item, 2500).then(function (ok2) {
          if (ok2 || lsHeld) { storageFailed = false; updateBadge(); return; }
          throw new Error('no storage'); // caller falls back to direct-send+confirm (+alert)
        });
      });
    });
  }

  /* ---------- sending ---------- */
  // Ask the backend (readable GET) whether this submissionId already saved.
  function isSaved(item) {
    var base = item.url.split("?")[0];
    var check = base + "?action=check&id=" + encodeURIComponent(item.id);
    return tfetch(check, { method: "GET" }, 12000)
      .then(function (r) { endpointOk = r.ok ? true : endpointOk; return r.ok ? r.json() : { saved: false }; })
      .then(function (j) { return !!(j && j.saved); })
      .catch(function () { endpointOk = false; return false; });
  }

  function sendItem(item) {
    if (sending[item.id]) return Promise.resolve();
    sending[item.id] = true;
    return isSaved(item).then(function (saved) {
      if (saved) return deleteItem(item.id);
      return tfetch(item.url, {
        method: "POST",
        mode: "no-cors",
        body: item.body,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      }, 30000).then(function () {
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
    return tfetch(base + "?action=savedids&t=" + Date.now(), { method: "GET" }, 12000)
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
  var flushStartedAt = 0;
  var RESEND_MS = 12000;   // don't re-send an item we already sent within this window
  function flush() {
    // Watchdog: a flush cycle can't legitimately take 2 minutes now that every
    // network call has a timeout — if the flag is that old it's wedged; reset.
    if (flushing && Date.now() - flushStartedAt > 120000) flushing = false;
    if (flushing) return;
    if (!navigator.onLine) { updateBadge(); return; }
    flushing = true;
    flushStartedAt = Date.now();
    allItems().then(function (res) {
      var items = res.items;
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
            if (saved && saved[item.id]) { logConfirmed(item); lsDel(item.id); return deleteItem(item.id); }
            if (item.lastSent && (now - item.lastSent) < RESEND_MS) return;
            item.lastSent = now;
            lsPut(item); // keep LS mirror in sync (works even when IDB is dead)
            return timedPut(item, 2500).then(function () {
              // 30s cap per item: a slow/jammed item gets skipped this cycle
              // (kept + retried later) instead of blocking everything behind it.
              return tfetch(item.url, {
                method: "POST", mode: "no-cors", body: item.body,
                headers: { "Content-Type": "text/plain;charset=utf-8" }
              }, 30000).catch(function () {});
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

  // Fetch with a hard timeout. iOS leaves fetches hanging FOREVER after
  // wifi/cell transitions; one hung request used to wedge the whole upload
  // loop while the bar showed "Uploading…" (2026-07-16). Never again.
  function tfetch(url, opts, ms) {
    opts = opts || {};
    try {
      var ctl = new AbortController();
      opts.signal = ctl.signal;
      var timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ms || 30000);
      return ORIG_FETCH(url, opts).then(function (r) {
        clearTimeout(timer); return r;
      }, function (e) {
        clearTimeout(timer); throw e;
      });
    } catch (e) { // very old browsers without AbortController
      return ORIG_FETCH(url, opts);
    }
  }
  if (ORIG_FETCH) {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var method = ((init && init.method) ||
                      (input && input.method) || "GET").toUpperCase();
        if (method === "POST" && ENDPOINT_RE.test(url)) {
          var body = init && init.body;
          var sendSingle = function (body) {
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
            // v-i: a direct-send alone is NOT proof of save (no-cors resolve
            // only means "reached server"). Stamp an id, send, then CONFIRM
            // via ?action=check&id=. Only a confirmed save resolves (letting
            // the form redirect); otherwise REJECT so the form stays on
            // screen with the rater's data intact for a retry.
            var dsid = uuid();
            var sendBody = body;
            try {
              var ob = JSON.parse(typeof body === 'string' ? body : String(body));
              if (ob && typeof ob === 'object') { ob.submissionId = dsid; sendBody = JSON.stringify(ob); }
              else dsid = null;
            } catch (e3) { dsid = null; }
            var dsBase = (url || '').split('?')[0];
            return tfetch(url, {
              method: 'POST', mode: 'no-cors', body: sendBody,
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              keepalive: true
            }, 45000).then(function () {
              if (!dsid) return new Response(null, { status: 202 });
              var tries = 0;
              function poll() {
                tries++;
                return tfetch(dsBase + '?action=check&id=' + encodeURIComponent(dsid), { method: 'GET' }, 12000)
                  .then(function (r) { return r.json(); })
                  .then(function (js) {
                    if (js && js.saved) { try { logConfirmed({ body: sendBody, ts: Date.now() }); } catch (eL) {} return new Response(null, { status: 202 }); }
                    if (tries >= 4) throw new Error('save unconfirmed');
                    return new Promise(function (rs) { setTimeout(rs, 4000); }).then(poll);
                  });
              }
              return poll().catch(function (ePoll) {
                try { alert('⚠ RATING NOT SAVED — this phone has no working storage and the server could not confirm the save. Get signal and SUBMIT THIS PLANT AGAIN.'); } catch (eA) {}
                throw ePoll;
              });
            });
          });
          };
          // v20260717a SPLIT TRANSPORT (rate.html only): scores travel as a ~1kB
          // packet that survives any storage/network abuse; photos trail behind as
          // separate packets keyed to the rating's submissionId and attach to the
          // row server-side (backend v5 photoFor). Photo-only submissions (Beds
          // 56 & 57) and packets without photos are NOT split.
          try {
            if (/rate\.html/i.test(location.pathname)) {
              var sp = JSON.parse(typeof body === 'string' ? body : String(body));
              var hasP = sp && sp.photos && sp.photos.length;
              var hasS = sp && !(sp.VEG == null && sp.UNI == null && sp.FLO == null && sp.RES == null);
              if (sp && typeof sp === 'object' && hasP && !hasS && !sp.photoFor) {
                // v-717c PHOTO-LATER: photo-only submission for a sku THIS device
                // already saved a rating for → attach to that row, no new row.
                var prior = null;
                try {
                  var LOG = JSON.parse(localStorage.getItem('tgSentLog') || '[]');
                  for (var li = 0; li < LOG.length; li++) {
                    if (LOG[li] && LOG[li].sku === sp.sku && LOG[li].id && !LOG[li].ph) { prior = LOG[li]; break; }
                  }
                } catch (eL2) {}
                if (prior) {
                  var pp3 = { photoFor: prior.id, sku: sp.sku, date: sp.date,
                              photos: sp.photos, submissionId: uuid() };
                  return enqueue(url, JSON.stringify(pp3)).then(function () {
                    flush();
                    try { toast('📷 Photos will attach to your earlier ' + sp.sku + ' rating.', 3500, '#1d4a2a'); } catch (eT) {}
                    return new Response(null, { status: 202 });
                  }).catch(function () { return sendSingle(body); });
                }
              }
              if (sp && typeof sp === 'object' && hasP && hasS && !sp.photoFor) {
                var sid2 = uuid(), pid2 = uuid();
                var pArr = sp.photos;
                sp.photos = []; sp.submissionId = sid2; sp.photosFollow = pArr.length;
                var pp = { photoFor: sid2, sku: sp.sku, date: sp.date,
                           photos: pArr, submissionId: pid2 };
                return enqueue(url, JSON.stringify(sp)).then(function () {
                  // photos are best-effort: scores must never be blocked by them
                  return enqueue(url, JSON.stringify(pp)).catch(function () {
                    toast('⚠ Photo could not be stored — rating is safe. Retake the photo later.');
                  });
                }).then(function () {
                  flush();
                  return new Response(null, { status: 202 });
                }).catch(function () {
                  return sendSingle(body); // split couldn't store — classic single packet
                });
              }
            }
          } catch (eSplit) { /* malformed body — fall through to single path */ }
          return sendSingle(body);
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
        '#panel{top:38px!important;bottom:0!important;max-height:none!important;border-radius:0!important}' + // v-717c: bed panel = solid full screen below the bar (was a floaty bottom sheet)
        '.phead{top:0!important}.phead .x{font-size:30px!important;padding:2px 12px!important}' + // header sticks to panel top; bigger close target
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
    queueEl.textContent = '…'; // v-j: NEUTRAL boot text — never claim saved before real data
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
    var verEl = document.createElement('span');
    verEl.id = 'tgVer';
    verEl.style.cssText = 'flex:none;opacity:.8;font:700 12px/1 system-ui,sans-serif;color:#cfe3cf;letter-spacing:.5px';
    verEl.textContent = 'v\u00B7' + TG_VERSION.slice(-4);
    barEl.appendChild(conn); barEl.appendChild(queueEl); barEl.appendChild(verEl); barEl.appendChild(refreshEl);
    queueEl.style.cursor = 'pointer';
    queueEl.addEventListener('click', togglePanel);
    (document.body || document.documentElement).appendChild(barEl);
    return barEl;
  }

  // Kept the name updateBadge so existing callers keep working.
  /* ---------- queue inspector (v-h): tap the counter text to see every
     pending item on THIS device and its recent confirmed saves ---------- */
  function skuOf(body) {
    try { var o = JSON.parse(body); if (o && o.sku) return String(o.sku); } catch (e) {}
    var m = String(body || '').match(/GL-\d{4}/);
    return m ? m[0] : '(unknown)';
  }
  function logConfirmed(item) {
    try {
      var L = JSON.parse(localStorage.getItem('tgSentLog') || '[]');
      var isPh = String(item.body || '').indexOf('"photoFor"') >= 0 ? 1 : 0;
      L.unshift({ sku: skuOf(item.body), ts: item.ts, ct: Date.now(), id: item.id, ph: isPh });
      localStorage.setItem('tgSentLog', JSON.stringify(L.slice(0, 50)));
    } catch (e) {}
  }
  function fmtAge(ms) {
    var s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm';
    return (m / 60).toFixed(1) + 'h';
  }
  var panelEl = null;
  function pline(txt, bold, color) {
    var d = document.createElement('div');
    d.textContent = txt;
    d.style.cssText = 'padding:3px 0' + (bold ? ';font-weight:700;margin-top:8px' : '') + (color ? ';color:' + color : '');
    return d;
  }
  function fillPanel() {
    if (!panelEl) return;
    var el = panelEl;
    var now = Date.now();
    allItems().then(function (res) { return (!res.idbOk && !res.items.length) ? null : res.items; }).then(function (items) {
      if (!panelEl) return;
      el.textContent = '';
      if (items === null) {
        el.appendChild(pline('⚠ Storage unreadable — close & reopen this page', true, '#ffb3b3'));
        items = [];
      } else {
        el.appendChild(pline('Waiting to upload (' + items.length + ')', true));
        if (!items.length) el.appendChild(pline('— nothing pending —', false, '#9fbf9f'));
        items.sort(function (a, b) { return a.ts - b.ts; }).forEach(function (it) {
          el.appendChild(pline('⬆ ' + skuOf(it.body) + ' · queued ' + fmtAge(now - it.ts) + ' ago · ' +
            (it.lastSent ? 'last try ' + fmtAge(now - it.lastSent) + ' ago' : 'not tried yet') +
            ' · ' + Math.max(1, Math.round(String(it.body || '').length / 1024)) + 'kB'));
        });
      }
      var L = [];
      try { L = JSON.parse(localStorage.getItem('tgSentLog') || '[]'); } catch (e) {}
      el.appendChild(pline('Saved to sheet from this device (last ' + Math.min(L.length, 20) + ')', true));
      if (!L.length) el.appendChild(pline('— none confirmed yet on this device —', false, '#9fbf9f'));
      L.slice(0, 20).forEach(function (r) {
        el.appendChild(pline('✓ ' + r.sku + ' · rated ' + fmtAge(now - r.ts) + ' ago · confirmed ' + fmtAge(now - r.ct) + ' ago', false, '#9fdf9f'));
      });
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '⬆ Send now';
      btn.style.cssText = 'margin-top:10px;border:0;border-radius:16px;padding:8px 14px;font:600 13px/1 system-ui,sans-serif;background:#3f7d46;color:#fff';
      btn.addEventListener('click', function () {
        btn.textContent = '…';
        allItems().then(function (res) {
          return Promise.all(res.items.map(function (it) { it.lastSent = 0; lsPut(it); return putItem(it).catch(function () {}); }));
        }).catch(function () {}).then(function () {
          flushing = false; flush(); setTimeout(fillPanel, 2000);
        });
      });
      el.appendChild(btn);
      var cls = document.createElement('button');
      cls.type = 'button';
      cls.textContent = 'Close';
      cls.style.cssText = 'margin:10px 0 0 8px;border:0;border-radius:16px;padding:8px 14px;font:600 13px/1 system-ui,sans-serif;background:#444;color:#fff';
      cls.addEventListener('click', togglePanel);
      el.appendChild(cls);
      var qlink = document.createElement('a');
      qlink.href = 'queue.html?cb=' + TG_VERSION;
      qlink.textContent = 'Open full queue page →';
      qlink.style.cssText = 'display:inline-block;margin:10px 0 0 12px;color:#9fdf9f;font:600 13px/1 system-ui,sans-serif';
      el.appendChild(qlink);
    });
  }
  function togglePanel() {
    if (panelEl) { try { panelEl.parentNode.removeChild(panelEl); } catch (e) {} panelEl = null; return; }
    panelEl = document.createElement('div');
    panelEl.id = 'tgPanel';
    panelEl.style.cssText = 'position:fixed;top:38px;left:0;right:0;max-height:65vh;overflow:auto;z-index:2147483646;background:#1c241c;color:#fff;font:500 13px/1.5 system-ui,-apple-system,sans-serif;padding:10px 14px 14px;box-shadow:0 8px 16px rgba(0,0,0,.45)';
    (document.body || document.documentElement).appendChild(panelEl);
    fillPanel();
  }
  setInterval(function () { if (panelEl) fillPanel(); }, 3000);

  /* ---------- plant queue-status marks (v-m) ----------
     Raters had no way to see, when picking a plant, whether it was already
     submitted (Mason was manually cross-checking names/numbers). Every
     rate-link gets a badge: ⬆ = in THIS phone's queue (stored, not yet
     confirmed), ✓ = confirmed saved from THIS phone. rate.html additionally
     shows a notice strip when its current SKU is already pending/saved. */
  function skuFromHref(h) {
    var i = String(h || '').indexOf('sku=');
    if (i < 0) return null;
    var s = String(h).slice(i + 4);
    var amp = s.indexOf('&');
    if (amp >= 0) s = s.slice(0, amp);
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  function decorateSkuLinks() {
    allItems().then(function (res) {
      var pending = {};
      res.items.forEach(function (it) { pending[skuOf(it.body)] = true; });
      var saved = {};
      try {
        JSON.parse(localStorage.getItem('tgSentLog') || '[]').forEach(function (r) { saved[r.sku] = true; });
      } catch (e) {}
      // badges on plant links
      var links = document.querySelectorAll('a[href*="rate.html"]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var sku = skuFromHref(a.getAttribute('href'));
        if (!sku) continue;
        var mark = a.querySelector('.tgMark');
        var want = pending[sku] ? '⬆' : (saved[sku] ? '✓' : '');
        if (!want) { if (mark) mark.textContent = ''; continue; }
        if (!mark) {
          mark = document.createElement('span');
          mark.className = 'tgMark';
          mark.style.cssText = 'margin-left:6px;font-weight:800';
          a.appendChild(mark);
        }
        mark.textContent = want;
        mark.style.color = pending[sku] ? '#d97706' : '#16a34a';
        mark.title = pending[sku] ? 'In upload queue on this phone' : 'Saved from this phone';
      }
      // notice strip on the rating form itself
      if (/rate\.html/i.test(location.pathname)) {
        var cur = null;
        try { cur = new URLSearchParams(location.search).get('sku'); } catch (e) {}
        var note = document.getElementById('tgSkuNote');
        var txt = '', bg = '', fg = '';
        if (cur && pending[cur]) {
          txt = '⬆ ' + cur + ' is already in this phone\u2019s upload queue (stored, not yet confirmed). Submitting again adds a second rating.';
          bg = '#2e2508'; fg = '#fde68a';
        } else if (cur && saved[cur]) {
          txt = '✓ ' + cur + ' was already rated & saved from this phone. Submitting again adds a second rating.';
          bg = '#0f2a18'; fg = '#9fdf9f';
        }
        if (txt) {
          if (!note) {
            note = document.createElement('div');
            note.id = 'tgSkuNote';
            note.style.cssText = 'padding:8px 12px;font:600 13px/1.4 system-ui,-apple-system,sans-serif';
            if (document.body) document.body.insertBefore(note, document.body.firstChild);
          }
          note.textContent = txt;
          note.style.background = bg;
          note.style.color = fg;
        } else if (note) {
          note.parentNode.removeChild(note);
        }
      }
    }).catch(function () {});
  }
  setInterval(decorateSkuLinks, 3000);
  setTimeout(decorateSkuLinks, 800);

  function updateBadge() {
    ensureBar();
    var online = navigator.onLine;
    // Truthful dot: red if offline OR the save endpoint is unreachable.
    var saving = online && (endpointOk !== false);
    if (storageFailed) {
      dotEl.style.background = "#ef4444"; connTextEl.textContent = "Storage error";
      queueEl.style.color = "#fca5a5";
      queueEl.textContent = "⚠ STORAGE ERROR — close & reopen this page";
      return allItems().then(function (res) { lastN = res.items.length; });
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
    return allItems().then(function (res) {
      var items = res.items;
      if (!res.idbOk) {
        dotEl.style.background = '#ef4444'; connTextEl.textContent = 'Storage glitch';
        queueEl.style.color = '#fca5a5';
        queueEl.textContent = items.length ? ('⚠ ' + items.length + ' to upload — close & reopen this page') : '⚠ Storage glitch — tap Refresh';
        lastN = items.length;
        return;
      }
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
    }).catch(function () {
      // Storage unreadable even after a fresh connection: NEVER claim "saved".
      dotEl.style.background = "#ef4444"; connTextEl.textContent = "Storage glitch";
      queueEl.style.color = "#fca5a5";
      queueEl.textContent = "⚠ Storage glitch — tap Refresh";
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
        'a[href*="rate.html"],a[href*="osu.html"],a[href*="index.html"]');
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        try {
          var href = a.getAttribute("href") || "";
          if (!href || href.indexOf("//") === 0 || /^https?:/i.test(href)) continue; // relative links only
          if (href.indexOf("cb=" + TG_VERSION) !== -1) continue;
          // RAW string append — do NOT parse/re-serialize the URL. Container and
          // basket SKUs contain spaces; URL-normalizing re-encoded them and broke
          // the form's SKU lookup ("SKU not found", 2026-07-16). Appending bytes
          // leaves the original link exactly as the map built it.
          var hash = "";
          var hi = href.indexOf("#");
          if (hi !== -1) { hash = href.slice(hi); href = href.slice(0, hi); }
          href += (href.indexOf("?") !== -1 ? "&" : "?") + "cb=" + TG_VERSION;
          a.setAttribute("href", href + hash);
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
    return tfetch(ownScriptBase() + "?vc=" + Date.now(), { cache: "no-store" }, 12000)
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var m = txt.match(/TG_VERSION\s*=\s*["']([^"']+)["']/);
        if (m && m[1] && m[1] !== TG_VERSION) { onVersionMismatch(m[1]); }
      }).catch(function () {});
  }

  // (Removed 2026-07-16: the "use Chrome, not Safari" banner. On-device
  // diagnostics proved the save path works identically in Safari and Chrome;
  // the real culprits were browser-agnostic queue bugs, all fixed by v20260716d.)

  /* ---------- triggers ---------- */
  function init() {
    ensureBar();
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
  // iOS invalidates IndexedDB handles while the page sleeps in the background
  // or sits in the back-forward cache. Rebuild the connection every time the
  // page comes back to life, before anything reads or writes the queue.
  window.addEventListener("pageshow", function () { dbPromise = null; storageFailed = false; updateBadge(); flush(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { dbPromise = null; storageFailed = false; updateBadge(); flush(); }
  });
  setInterval(function () {
    updateBadge();
    getAll().then(function (items) { if (items.length) flush(); });
  }, RETRY_MS);
  setInterval(function () { if (Date.now() - lastPing > PING_MS - 1000) pingEndpoint(); }, PING_MS);
  setInterval(checkVersion, 60000);

  // Expose a tiny API for manual use / debugging.
  /* ---------- persistent storage request (v-n) ----------
     Formally asks the browser to protect this origin's IndexedDB/localStorage
     from eviction under storage pressure. Best-effort — iOS grants it
     silently for sites used often; every bit of protection helps the queue
     survive camera-heavy sessions. */
  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(function (granted) {
        try { window.TGQueue && (window.TGQueue.persisted = !!granted); } catch (e) {}
      }).catch(function () {});
    }
  } catch (e) {}

  window.TGQueue = {
    flush: flush, pending: getAll, version: TG_VERSION,
    allItems: allItems,
    sentLog: function () { try { return JSON.parse(localStorage.getItem('tgSentLog') || '[]'); } catch (e) { return []; } },
    forceSend: function () {
      return allItems().then(function (res) {
        return Promise.all(res.items.map(function (it) { it.lastSent = 0; lsPut(it); return putItem(it).catch(function () {}); }));
      }).catch(function () {}).then(function () { flushing = false; flush(); });
    },
    checkVersion: checkVersion, ping: pingEndpoint,
    health: function () { return { endpointBase: endpointBase, endpointOk: endpointOk }; }
  };
})();
