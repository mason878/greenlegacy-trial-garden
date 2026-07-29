/* freshness.js — Green Legacy Trial Garden map
 * Cycle-aware ("this week") data-collection indicators.
 * Version 20260729a
 *
 * Loads AFTER index.html's inline script and overrides/wraps its globals:
 *   bedFill(locs)  -> colors beds by THIS WEEK's progress only
 *   renderPlan()   -> draws stale/partial overlay marks + header summary
 *   openBed()      -> per-plant freshness + missing-photo marks in the panel
 *
 * A "cycle" is one ISO week (Mon-Sun). Previous ratings stay fully visible;
 * they are just visually demoted so an un-rated bed can never look done.
 * Nothing here writes data. Safe to remove: the map reverts to lifetime mode.
 */
(function () {
  "use strict";

  var TGF_VERSION = "20260729a";
  var C_NONE = "#ffffff";
  var C_PART = "#cfe0cf";
  var C_ALL = "#7faa80";

  if (!document.getElementById("plan")) return; // map page only

  /* ---------- ISO week helpers ---------- */

  function isoInfo(d) {
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    var y = t.getUTCFullYear();
    var yStart = new Date(Date.UTC(y, 0, 1));
    var w = Math.ceil(((t - yStart) / 86400000 + 1) / 7);
    return { y: y, w: w, key: y + "-W" + (w < 10 ? "0" + w : w) };
  }

  // Rating dates arrive either as full ISO timestamps ("2026-07-28T17:29:32Z")
  // or date-only strings from paper loads. Date-only must be parsed as LOCAL,
  // otherwise UTC midnight rolls back a day in US time zones.
  function toDate(v) {
    if (v instanceof Date) return v;
    var s = String(v || "");
    var m = s.match(/^(\d{4})-(\d\d)-(\d\d)$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function keyOf(v) {
    var d = toDate(v);
    return d ? isoInfo(d).key : null;
  }

  function wkNum(key) { return parseInt(String(key).slice(6), 10); }
  function wkLabel(key) { return key ? "Wk " + wkNum(key) : ""; }

  var CURRENT_KEY = isoInfo(new Date()).key;
  var selected = CURRENT_KEY; // which cycle the map is showing

  function isCurrent() { return selected === CURRENT_KEY; }

  /* ---------- per-SKU state (cached per render pass) ---------- */

  var cache = {}, cacheTag = "";

  function tag() {
    var n = 0;
    try { for (var k in RATINGS) n += RATINGS[k].length; } catch (e) {}
    return selected + "|" + n;
  }

  function fresh() {
    var t = tag();
    if (t !== cacheTag) { cache = {}; cacheTag = t; }
  }

  function scored(r) { return r && r.avg !== null && r.avg !== undefined && r.avg !== ""; }

  // { cur:bool, curPhoto:bool, curAvg:num|null, lastKey:str|null, lastAvg:num|null }
  function state(sku) {
    fresh();
    if (cache[sku]) return cache[sku];
    var out = { cur: false, curPhoto: false, curAvg: null, lastKey: null, lastAvg: null };
    var rows = [];
    try { rows = (typeof RATINGS !== "undefined" && RATINGS[sku]) || []; } catch (e) {}
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], k = keyOf(r.date);
      if (k === selected) {
        if (scored(r)) {
          if (!out.cur) { out.cur = true; out.curAvg = Number(r.avg); }
        }
        if (r.photos && r.photos.length) out.curPhoto = true;
      }
      if (scored(r) && !out.lastKey) { out.lastKey = k; out.lastAvg = Number(r.avg); }
    }
    cache[sku] = out;
    return out;
  }

  function bedStats(locs) {
    var sk = [];
    try { sk = skusFor(locs) || []; } catch (e) {}
    var n = 0, ph = 0, hist = 0, lastKey = null;
    for (var i = 0; i < sk.length; i++) {
      var s = state(sk[i].sku);
      if (s.cur) { n++; if (s.curPhoto) ph++; }
      if (s.lastKey) {
        hist++;
        if (!lastKey || s.lastKey > lastKey) lastKey = s.lastKey;
      }
    }
    return { total: sk.length, cur: n, photos: ph, hist: hist, lastKey: lastKey };
  }

  /* ---------- 1. bed fill = this cycle only ---------- */

  if (typeof window.bedFill === "function") {
    window.bedFill = function (locs) {
      var b = bedStats(locs);
      if (!b.total || b.cur === 0) return C_NONE;
      return b.cur === b.total ? C_ALL : C_PART;
    };
  }

  /* ---------- 2. map overlay: stale dot + partial fraction ---------- */

  var SVGNS = "http://www.w3.org/2000/svg";
  function mk(t, a) {
    var e = document.createElementNS(SVGNS, t);
    for (var k in a) e.setAttribute(k, a[k]);
    return e;
  }

  function overlay() {
    var svg = document.getElementById("plan");
    if (!svg) return;
    var old = svg.querySelectorAll(".tgfOv");
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);

    var beds = [];
    try { beds = beds.concat(RECTS || []); } catch (e) {}
    try { beds = beds.concat(ISLES || []); } catch (e) {}

    beds.forEach(function (b) {
      if (!b || b.struct || b.inactive || b.osu || !b.locs) return;
      if (b.rot) return; // rotated shapes: skip rather than mis-place a mark
      var st = bedStats(b.locs);
      if (!st.total) return;
      var g = mk("g", { "class": "tgfOv", "pointer-events": "none" });

      if (st.cur === 0 && st.hist > 0) {
        // rated in an earlier cycle, nothing yet this one
        g.appendChild(mk("circle", {
          cx: b.x + b.w - 5, cy: b.y + 5, r: 3.2,
          fill: "#9aa39a", stroke: "#fff", "stroke-width": 1
        }));
        var ti = mk("title", {});
        ti.textContent = b.name + " — last rated " + wkLabel(st.lastKey) + ", not yet this week";
        g.appendChild(ti);
      } else if (st.cur > 0 && st.cur < st.total) {
        // partial: progress bar along the bottom edge. Beds are mostly narrow
        // and tall (20-40px wide), so a bar reads better than text.
        var bw = Math.max(b.w - 4, 6), bh = 4, by = b.y + b.h - bh - 2;
        g.appendChild(mk("rect", {
          x: b.x + 2, y: by, width: bw, height: bh, rx: 2,
          fill: "#ffffff", stroke: "#8aa88f", "stroke-width": 0.6, opacity: 0.9
        }));
        g.appendChild(mk("rect", {
          x: b.x + 2, y: by, width: Math.max(bw * (st.cur / st.total), 1.5),
          height: bh, rx: 2, fill: "#2f7a3e"
        }));
        var tf = mk("title", {});
        tf.textContent = b.name + " — " + st.cur + " of " + st.total +
          " rated " + wkLabel(selected);
        g.appendChild(tf);
      }

      if (st.cur > 0 && st.photos < st.cur) {
        // scores landed this week without photos on some plants
        g.appendChild(mk("circle", {
          cx: b.x + 5, cy: b.y + 5, r: 3.2,
          fill: "#c0392b", stroke: "#fff", "stroke-width": 1
        }));
        var t2 = mk("title", {});
        t2.textContent = b.name + " — " + (st.cur - st.photos) + " of " +
          st.cur + " rated this week have no photo";
        g.appendChild(t2);
      }

      if (g.childNodes.length) svg.appendChild(g);
    });
  }

  /* ---------- 3. header summary + cycle picker ---------- */

  function weeksPresent() {
    var seen = {};
    try {
      for (var k in RATINGS) {
        var rows = RATINGS[k];
        for (var i = 0; i < rows.length; i++) {
          var key = keyOf(rows[i].date);
          if (key) seen[key] = 1;
        }
      }
    } catch (e) {}
    seen[CURRENT_KEY] = 1;
    return Object.keys(seen).sort().reverse();
  }

  function buildPicker() {
    var bar = document.querySelector(".bar");
    if (!bar || document.getElementById("tgfWeek")) return;
    var sel = document.createElement("select");
    sel.id = "tgfWeek";
    sel.className = "tgfSel";
    sel.title = "Which collection cycle the map is showing";
    sel.addEventListener("change", function () {
      selected = sel.value;
      cacheTag = "";
      try { renderPlan(); } catch (e) {}
      decorate(true);
    });
    bar.appendChild(sel);
    fillPicker();
  }

  function fillPicker() {
    var sel = document.getElementById("tgfWeek");
    if (!sel) return;
    var weeks = weeksPresent();
    var want = weeks.join(",");
    if (sel.getAttribute("data-weeks") === want) { sel.value = selected; return; }
    sel.setAttribute("data-weeks", want);
    sel.innerHTML = "";
    weeks.forEach(function (k) {
      var o = document.createElement("option");
      o.value = k;
      o.textContent = wkLabel(k) + (k === CURRENT_KEY ? " (this week)" : "");
      sel.appendChild(o);
    });
    sel.value = selected;
  }

  function updateHeader() {
    var c = document.getElementById("count");
    if (!c) return;
    var total = 0, rated = 0, photos = 0;
    try {
      for (var b in BEDS) {
        var pl = BEDS[b];
        for (var i = 0; i < pl.length; i++) {
          total++;
          var s = state(pl[i].sku);
          if (s.cur) { rated++; if (s.curPhoto) photos++; }
        }
      }
    } catch (e) { return; }
    var miss = rated - photos;
    c.innerHTML = "<b>" + wkLabel(selected) + "</b> " +
      (isCurrent() ? "" : "(past) ") + rated + " / " + total + " rated" +
      (miss > 0 ? ' <span class="tgfMiss">· ' + miss + " no photo</span>" : "");
    fillPicker();
  }

  function fixLegend() {
    var lg = document.querySelector(".legend");
    if (!lg || lg.getAttribute("data-tgf")) return;
    lg.setAttribute("data-tgf", "1");
    lg.innerHTML =
      '<span><i style="background:' + C_NONE + '"></i>none this week</span>' +
      '<span><i style="background:' + C_PART + '"></i>partly rated</span>' +
      '<span><i style="background:' + C_ALL + '"></i>all rated</span>' +
      '<span><i class="tgfDotL tgfDotGrey"></i>rated an earlier week</span>' +
      '<span><i class="tgfDotL tgfDotRed"></i>photo missing</span>' +
      '<span style="margin-left:auto"><i style="background:repeating-linear-gradient(45deg,#cdd8c4,#cdd8c4 2px,#fff 2px,#fff 5px)"></i>show bed</span>';
  }

  /* ---------- 4. panel / list rows ---------- */

  function skuOfRow(el) {
    var oc = el.getAttribute("onclick") || "";
    var m = oc.match(/openSku\(\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  }

  function decorateRow(row) {
    var sku = skuOfRow(row);
    if (!sku) return;
    var s = state(sku);
    var sig = selected + "|" + (s.cur ? "c" : "") + (s.curPhoto ? "p" : "") +
      "|" + (s.lastKey || "") + "|" + (s.lastAvg === null ? "" : s.lastAvg);
    if (row.getAttribute("data-tgf") === sig) return;
    row.setAttribute("data-tgf", sig);

    var oldm = row.querySelectorAll(".tgfMark");
    for (var i = 0; i < oldm.length; i++) oldm[i].parentNode.removeChild(oldm[i]);

    var badge = row.querySelector(".badge");
    var nm = row.querySelector(".nm") || row;

    if (s.cur) {
      row.classList.remove("tgfStale");
      if (badge) badge.classList.remove("tgfDim");
      var ok = document.createElement("span");
      ok.className = "tgfMark tgfOk";
      ok.textContent = "✓ this week";
      nm.appendChild(ok);
      if (!s.curPhoto) {
        var np = document.createElement("span");
        np.className = "tgfMark tgfNoPhoto";
        np.textContent = "no photo";
        np.title = "Scores saved this week but no photo attached — worth a retake";
        nm.appendChild(np);
      }
    } else if (s.lastKey) {
      row.classList.add("tgfStale");
      if (badge) badge.classList.add("tgfDim");
      var st = document.createElement("span");
      st.className = "tgfMark tgfOld";
      st.textContent = "last " + wkLabel(s.lastKey);
      st.title = "Score shown is from " + wkLabel(s.lastKey) + " — not rated this week";
      nm.appendChild(st);
    } else {
      row.classList.remove("tgfStale");
      if (badge) badge.classList.remove("tgfDim");
    }
  }

  function decorateHead() {
    var ph = document.querySelector("#panel .phead .st");
    if (!ph) return;
    var rows = document.querySelectorAll("#panel .skurow");
    if (!rows.length) return;
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var sku = skuOfRow(rows[i]);
      if (sku && state(sku).cur) n++;
    }
    var txt = n + " / " + rows.length + " rated " + wkLabel(selected);
    var host = ph.querySelector(".tgfHead");
    if (!host) {
      host = document.createElement("span");
      host.className = "tgfHead";
      ph.appendChild(host);
    }
    host.textContent = " · " + txt;
    host.className = "tgfHead" + (n === 0 ? " tgfHeadNone" : (n === rows.length ? " tgfHeadAll" : ""));
  }

  function decorate(force) {
    try {
      if (force) {
        var rs = document.querySelectorAll(".skurow[data-tgf]");
        for (var i = 0; i < rs.length; i++) rs[i].removeAttribute("data-tgf");
      }
      var rows = document.querySelectorAll(".skurow");
      for (var j = 0; j < rows.length; j++) decorateRow(rows[j]);
      decorateHead();
    } catch (e) {}
  }

  /* ---------- 5. styles ---------- */

  function styles() {
    if (document.getElementById("tgfCss")) return;
    var s = document.createElement("style");
    s.id = "tgfCss";
    s.textContent =
      ".tgfMark{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:8px;" +
      "font-size:10px;font-weight:600;line-height:1.5;vertical-align:middle;white-space:nowrap}" +
      ".tgfOk{background:#e3f0e4;color:#2f5136}" +
      ".tgfOld{background:#eceae4;color:#7a7466}" +
      ".tgfNoPhoto{background:#fbe4e1;color:#a5301f}" +
      ".tgfDim{opacity:.42;filter:grayscale(.55)}" +
      ".tgfStale .nm b{color:#6d6a62}" +
      ".tgfSel{margin-left:8px;font:inherit;font-size:12px;padding:3px 6px;border:1px solid #cdd8c4;" +
      "border-radius:8px;background:#fff;color:#2f5136}" +
      ".tgfMiss{color:#ffc0b3;font-weight:700}" + // sits on the dark header pill
      ".tgfDotL{border-radius:50%!important}" +
      ".tgfDotGrey{background:#9aa39a}" +
      ".tgfDotRed{background:#c0392b}" +
      // panel header sits on a dark green bar — light text only
      ".tgfHead{color:#e6efe2;font-weight:700}" +
      ".tgfHeadNone{color:#ffc0b3}" +
      ".tgfHeadAll{color:#b9e6c2}" +
      ".tgfFrac{font-weight:700}";
    document.head.appendChild(s);
  }

  /* ---------- 6. wire up ---------- */

  var origRender = window.renderPlan;
  if (typeof origRender === "function") {
    window.renderPlan = function () {
      var r = origRender.apply(this, arguments);
      try { overlay(); } catch (e) {}
      try { updateHeader(); } catch (e) {}
      try { decorate(true); } catch (e) {}
      return r;
    };
  }

  var origOpen = window.openBed;
  if (typeof origOpen === "function") {
    window.openBed = function () {
      var r = origOpen.apply(this, arguments);
      setTimeout(function () { decorate(true); }, 30);
      return r;
    };
  }

  styles();
  fixLegend();
  buildPicker();
  try { if (typeof renderPlan === "function") renderPlan(); } catch (e) {}
  setInterval(function () { decorate(false); }, 1500);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { cacheTag = ""; decorate(true); }
  });

  window.TGFresh = {
    version: TGF_VERSION,
    currentKey: CURRENT_KEY,
    get selected() { return selected; },
    setWeek: function (k) {
      selected = k; cacheTag = "";
      var sel = document.getElementById("tgfWeek");
      if (sel) sel.value = k;
      try { renderPlan(); } catch (e) {}
      decorate(true);
    },
    state: state,
    bedStats: bedStats,
    weeks: weeksPresent
  };
})();
