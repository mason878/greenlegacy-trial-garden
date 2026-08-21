/* photoup.js - Green Legacy Trial Garden rating form
Upload-at-capture photo handling. Version 20260820b

WHY THIS EXISTS
Photos used to ride inside the rating payload: base64 into JSON, parked in
phone storage, uploaded later in a batch, and sacrificed first when anything
went wrong. That put a photo's most fragile hours on a phone with an
unreliable IndexedDB.

WHAT CHANGES
A photo now uploads the MOMENT it is taken, while the rater is still at the
plant, and shows its own status: uploading, then saved, or RETRY. Photo bytes
never enter the tg-queue sync queue (uploads use XMLHttpRequest, which
tg-queue's fetch override does not intercept), so the storage pressure that
caused photo loss cannot occur. Submit is blocked while a photo is
unconfirmed. Requires backend Version 6 (stagePhoto / action=photocheck).

The plant tie stays automatic: the SKU comes from the ?sku= in the URL the map
or QR opened, so a photo cannot be filed against the wrong plant.

HOW IT HOOKS IN (same override pattern freshness.js uses on index.html)
Loads AFTER rate.html's inline script and takes over the photo input, the
thumbnail rendering and the submit button. Safe to remove: delete the script
tag and the form reverts to its previous behaviour.
*/
(function () {
 "use strict";

 var PU_VERSION = "20260820b";
 if (String(location.pathname).toLowerCase().indexOf("rate.html") < 0) return;

 // endpoint: read from the page at runtime, no token hardcoded here
 function findEndpoint() {
  var needle = "script.google.com/macros/s/";
  try {
   var ss = document.querySelectorAll("script:not([src])");
   for (var i = 0; i < ss.length; i++) {
    var t = String(ss[i].textContent || "");
    var a = t.indexOf(needle);
    if (a < 0) continue;
    var b = t.indexOf("/exec", a);
    if (b < 0) continue;
    var start = t.lastIndexOf("https", a);
    if (start < 0) continue;
    return t.slice(start, b + 5);
   }
  } catch (e) {}
  try { var m = localStorage.getItem("tgEndpointBase"); if (m) return m; } catch (e) {}
  return null;
 }
 var EP = findEndpoint();
 var CURSKU = String((new URLSearchParams(location.search)).get("sku") || "").toUpperCase().trim();

 // pics entries: id, thumb, data, type, status (up / ok / err), n
 var pics = [];

 function uuid() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return "p-" + Date.now() + "-" + Math.random().toString(16).slice(2);
 }
 function isWebp(t) { return String(t || "").indexOf("webp") >= 0; }

 // transport. XMLHttpRequest on purpose: tg-queue.js overrides window.fetch and
 // would queue this POST, putting photo bytes back into phone storage - the
 // exact thing being eliminated. The POST reply is unreadable cross-origin, so
 // a readable GET (action=photocheck) is the source of truth for "did it save".
 function post(body) {
  return new Promise(function (res, rej) {
   try {
    var x = new XMLHttpRequest();
    x.open("POST", EP, true);
    x.setRequestHeader("Content-Type", "text/plain;charset=utf-8");
    x.timeout = 45000;
    x.onloadend = function () { res(); };
    x.ontimeout = function () { rej(new Error("timeout")); };
    x.send(body);
   } catch (e) { rej(e); }
  });
 }
 function getJSON(url, ms) {
  return new Promise(function (res, rej) {
   var x = new XMLHttpRequest();
   x.open("GET", url, true);
   x.timeout = ms || 15000;
   x.onload = function () { try { res(JSON.parse(x.responseText)); } catch (e) { rej(e); } };
   x.onerror = function () { rej(new Error("net")); };
   x.ontimeout = function () { rej(new Error("timeout")); };
   x.send();
  });
 }
 function confirmPhoto(p) {
  var url = EP + "?action=photocheck&id=" + encodeURIComponent(p.id) + "&t=" + Date.now();
  var tries = 0;
  function poll() {
   tries++;
   return getJSON(url, 15000).then(function (j) {
    if (j && j.saved) { p.status = "ok"; paint(); return true; }
    if (tries >= 20) throw new Error("unconfirmed");
    return new Promise(function (r) { setTimeout(r, 3000); }).then(poll);
   });
  }
  return poll();
 }
 function upload(p) {
  if (!EP || !p.data) { p.status = "err"; paint(); return Promise.resolve(); }
  p.status = "up"; paint();
  var ext = isWebp(p.type) ? ".webp" : ".jpg";
  var body = JSON.stringify({
   stagePhoto: 1,
   sku: CURSKU,
   date: new Date().toISOString(),
   submissionId: p.id,
   photos: [{ name: CURSKU + "_" + Date.now() + "_" + (p.n || 1) + ext, data: p.data, type: p.type }]
  });
  return post(body)
  .then(function () { return confirmPhoto(p); })
  .catch(function () { p.status = "err"; paint(); });
 }
 function onPick(e) {
  var files = [].slice.call((e.target && e.target.files) || []);
  try { e.target.value = ""; } catch (e2) {}
  files.forEach(function (f) {
   var p = { id: uuid(), status: "up", type: "image/jpeg", n: pics.length + 1 };
   pics.push(p);
   paint();
   Promise.resolve()
   .then(function () { return window.compressPhoto(f); })
   .then(function (out) {
    p.data = (out && out.data) || "";
    p.type = (out && out.type) || "image/jpeg";
    try { p.thumb = "data:" + p.type + ";base64," + p.data; } catch (e3) {}
    return upload(p);
   })
   .catch(function () { p.status = "err"; paint(); });
  });
 }

 function paint() {
  var t = document.getElementById("thumbs");
  if (!t) return;
  t.innerHTML = "";
  pics.forEach(function (p) {
   var d = document.createElement("div");
   d.className = "t";
   d.style.position = "relative";
   if (p.thumb) {
    var im = document.createElement("img");
    im.src = p.thumb;
    d.appendChild(im);
   }
   var b = document.createElement("span");
   b.style.cssText = "position:absolute;left:0;right:0;bottom:0;top:auto;width:auto;height:auto;border-radius:0;display:block;text-align:center;color:#fff;font:700 9px/1.7 system-ui,-apple-system,sans-serif";
   if (p.status === "ok") {
    b.textContent = "saved";
    b.style.background = "rgba(22,163,74,.92)";
   } else if (p.status === "up") {
    b.textContent = "uploading";
    b.style.background = "rgba(180,83,9,.92)";
   } else {
    b.textContent = "RETRY";
    b.style.background = "rgba(192,57,43,.95)";
    d.style.cursor = "pointer";
    d.title = "Tap to retry this photo";
    d.addEventListener("click", function () { if (p.data) upload(p); });
   }
   d.appendChild(b);
   t.appendChild(d);
  });
  banner();
 }
 function banner() {
  var host = document.getElementById("thumbs");
  if (!host || !host.parentNode) return;
  var el = document.getElementById("puStat");
  var pend = 0, bad = 0, ok = 0;
  pics.forEach(function (p) {
   if (p.status === "up") pend++;
   else if (p.status === "err") bad++;
   else ok++;
  });
  var txt = "", bg = "", fg = "";
  if (bad) {
   txt = bad + " photo(s) failed - tap the red tile to retry";
   bg = "#fbe4e1"; fg = "#a5301f";
  } else if (pend) {
   txt = pend + " photo(s) uploading - wait for the green check";
   bg = "#fff5e6"; fg = "#8a5a10";
  } else if (ok) {
   txt = ok + " photo(s) saved to Drive";
   bg = "#e3f0e4"; fg = "#2f5136";
  }
  if (!txt) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
  if (!el) {
   el = document.createElement("div");
   el.id = "puStat";
   el.style.cssText = "margin-top:8px;padding:7px 10px;border-radius:9px;font:600 12px/1.4 system-ui,-apple-system,sans-serif";
   host.parentNode.insertBefore(el, host.nextSibling);
  }
  el.textContent = txt;
  el.style.background = bg;
  el.style.color = fg;
 }

 // gated submit. rate.html attached its own click handler bound to the ORIGINAL
 // submit function, so reassigning window.submit alone would not intercept it.
 // The button is replaced with a clone to drop that listener.
 var ORIG_SUBMIT = window.submit;
 function gatedSubmit() {
  var pend = 0, bad = 0;
  pics.forEach(function (p) {
   if (p.status === "up") pend++;
   else if (p.status === "err") bad++;
  });
  if (pend || bad) {
   var msg = bad
   ? bad + " photo(s) failed to upload. Tap the red tile to retry before submitting."
    : pend + " photo(s) still uploading. Wait for the green check - it only takes a second.";
   try { if (window.toast) window.toast(msg, 4000); else alert(msg); } catch (e) { alert(msg); }
   paint();
   return;
  }
  // Photos are already safe in Drive; the rating travels on its own.
 pics = [];
  paint();
  try { return ORIG_SUBMIT.apply(this, arguments); }
  catch (e) {
   try { if (window.toast) window.toast("Submit failed - try again", 3000); } catch (e2) {}
  }
 }
 function hook() {
  var pin = document.getElementById("photoIn");
  if (pin && !pin.getAttribute("data-pu")) {
   var c = pin.cloneNode(true);
   c.setAttribute("data-pu", "1");
   pin.parentNode.replaceChild(c, pin);
   c.addEventListener("change", onPick);
  }
  var go = document.getElementById("go");
  if (go && !go.getAttribute("data-pu")) {
   var g = go.cloneNode(true);
   g.setAttribute("data-pu", "1");
   go.parentNode.replaceChild(g, go);
   g.addEventListener("click", gatedSubmit);
  }
  paint();
 }
 window.drawThumbs = paint;
 var origRender = window.render;
 if (typeof origRender === "function") {
  window.render = function () {
   var r = origRender.apply(this, arguments);
   setTimeout(hook, 0);
   return r;
  };
 }
 hook();
 setInterval(function () { hook(); layout(); }, 1500);
// --- layout (Mason, 2026-08-20) ---
 // Photos card is moved to the TOP of the form: adding an extra photo is the
 // most common quick action, so it should be the first thing under the header.
 // The notes card also gains an optional plant height in inches.
 function layout() {
  var wrap = document.querySelector(".wrap");
  if (!wrap) return;
  var pb = document.querySelector(".photo-btn");
  var th = document.getElementById("thumbs");
  if (pb && th && !document.getElementById("puCard")) {
   var card = document.createElement("div");
   card.className = "card";
   card.id = "puCard";
   var h2 = document.createElement("h2");
   h2.textContent = "Photos";
   card.appendChild(h2);
   var hint = document.createElement("p");
   hint.className = "hint";
   hint.textContent = "Uploads the moment you take it - wait for the green check.";
   card.appendChild(hint);
   card.appendChild(pb);
   card.appendChild(th);
   wrap.insertBefore(card, wrap.firstChild);
  }
  var note = document.getElementById("note");
  if (note && !document.getElementById("puHeight")) {
   var lab = document.createElement("label");
   lab.className = "fld";
   lab.setAttribute("for", "puHeight");
   lab.textContent = "Height in inches (optional)";
   var inp = document.createElement("input");
   inp.type = "number";
   inp.id = "puHeight";
   inp.step = "0.5";
   inp.min = "0";
   inp.setAttribute("inputmode", "decimal");
   inp.placeholder = "e.g. 14.5";
   note.parentNode.insertBefore(lab, note.nextSibling);
   lab.parentNode.insertBefore(inp, lab.nextSibling);
  }
  var heads = document.querySelectorAll(".card h2");
  for (var i = 0; i < heads.length; i++) {
   if (heads[i].textContent.indexOf("Notes") === 0) heads[i].textContent = "Notes & Height";
  }
 }
 function heightVal() {
  var el = document.getElementById("puHeight");
  if (!el) return null;
  var v = String(el.value || "").trim();
  if (v === "") return null;
  var n = Number(v);
  return (isFinite(n) && n >= 0) ? n : null;
 }
 // Outer fetch wrapper: photoup loads after tg-queue, so this runs FIRST and can
 // stamp the height into the rating payload before tg-queue queues it. Photo
 // uploads use XMLHttpRequest and are untouched by this.
 var PREV_FETCH = window.fetch;
 window.fetch = function (input, init) {
  try {
   var u = typeof input === "string" ? input : (input && input.url) || "";
   var mth = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
   if (mth === "POST" && u.indexOf("script.google.com/macros/") >= 0 && init && typeof init.body === "string") {
    var o = JSON.parse(init.body);
    if (o && typeof o === "object" && !o.stagePhoto && !o.photoFor) {
     var hv = heightVal();
     if (hv !== null) {
      o.heightIn = hv;
      var ni = {};
      for (var k in init) ni[k] = init[k];
      ni.body = JSON.stringify(o);
      init = ni;
     }
    }
   }
  } catch (e) {}
  return PREV_FETCH.call(window, input, init);
 };
 layout();
 // --- Bed 26 location fix (2026-08-20) ---
 // rate.html's embedded plant data says "Bed 25" for all 59 plants that BOTH
 // master_rows.json and the live map place in Bed 26. That sent raters back to
 // Bed 25 after submitting and, worse, wrote "Bed 25" into the sheet's Location
 // column. Mutating SKU[sku].loc fixes both at once, because the form's own
 // `rec` is the very same object.
 // Deliberately narrow: only a master value of exactly "Bed 26" is applied.
 // master_rows.json is itself stale elsewhere (it has NO Bed 37S rows, so it
 // would wrongly move GL-0697..0699), and the map still groups 54/55 under one
 // combined "Beds 54 & 55" key. Those two cases are left alone on purpose and
 // are tracked in the Project Hub for a proper data regeneration.
 function fixLoc() {
  var rec = null;
  try { rec = (typeof SKU !== "undefined" && SKU) ? SKU[CURSKU] : null; } catch (e) { return; }
  if (!rec) return;
  var x = new XMLHttpRequest();
  x.open("GET", "master_rows.json?cb=" + Date.now(), true);
  x.timeout = 15000;
  x.onload = function () {
   try {
    var a = JSON.parse(x.responseText);
    a = Array.isArray(a) ? a : (a.rows || []);
    for (var i = 1; i < a.length; i++) {
     if (String(a[i][0]) !== CURSKU) continue;
     var want = String(a[i][1]);
     if (want === "Bed 26" && String(rec.loc) !== want) {
      rec.loc = want;
      var meta = document.querySelector("header .meta");
      if (meta) meta.textContent = [want, rec.sup].filter(Boolean).join(" · ");
     }
     break;
    }
   } catch (e) {}
  };
  x.send();
 }
 fixLoc();
 window.PhotoUp = {
  version: PU_VERSION,
  endpointFound: !!EP,
  sku: CURSKU,
  pics: function () {
   return pics.map(function (p) { return { id: p.id, status: p.status }; });
  },
  retryAll: function () {
   pics.forEach(function (p) { if (p.status === "err") upload(p); });
  }
 };
})();
