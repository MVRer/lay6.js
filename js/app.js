/*
 * app.js — UI: file loading, tabs, view navigation, layer toggles,
 * measuring, exports. Everything runs locally via FileReader; no file
 * data ever leaves the machine.
 */
"use strict";

(function () {
  var canvas = document.getElementById("view");
  var ctx = canvas.getContext("2d");
  var els = {
    tabs: document.getElementById("tabs"),
    layers: document.getElementById("layers"),
    info: document.getElementById("info"),
    diag: document.getElementById("diag"),
    empty: document.getElementById("empty"),
    banner: document.getElementById("banner"),
    bannerMsg: document.querySelector("#banner .msg"),
    stCoords: document.getElementById("st-coords"),
    stHover: document.getElementById("st-hover"),
    tooltip: document.getElementById("tooltip"),
    ttTitle: document.querySelector("#tooltip .t-title"),
    ttSub: document.querySelector("#tooltip .t-sub"),
    selection: document.getElementById("selection"),
    stZoom: document.getElementById("st-zoom"),
    stSize: document.getElementById("st-size"),
    stMeasure: document.getElementById("st-measure"),
    dropOverlay: document.getElementById("drop-overlay"),
    fileInput: document.getElementById("file-input"),
    encoding: document.getElementById("encoding"),
  };

  var state = {
    tabs: [], // { id, doc, board, fileName, boardIndex, view, visible }
    active: -1,
    measureMode: false,
    measureA: null, // {x, y} in mm
    measureB: null,
    hover: null, // { o, members, labels } for the object under the cursor
    selected: null, // same shape, pinned by click
    nextId: 1,
  };

  var NET_HIGHLIGHT_CAP = 400;

  // Net context for an object: all electrically connected copper plus any
  // silkscreen labels sitting next to the net.
  function netInfoFor(board, o) {
    if (!o) return null;
    var conductive = (o.type === 2 || o.type === 6 || o.type === 8) &&
      Lay6.COPPER_LAYERS[o.layer];
    if (!conductive) return { o: o, members: [o], labels: [] };
    var nets = Lay6Render.buildNets(board);
    return {
      o: o,
      members: nets.members[o._netRoot] || [o],
      labels: nets.labels[o._netRoot] || [],
    };
  }

  function summarizeNet(info) {
    if (!info || info.members.length <= 1) return "";
    var tracks = 0, pads = 0, layers = {};
    info.members.forEach(function (m) {
      if (m.type === 6) tracks++;
      else pads++;
      layers[Lay6.LAYERS[m.layer] ? Lay6.LAYERS[m.layer].key : m.layer] = true;
    });
    var parts = [];
    if (tracks) parts.push(tracks + " track" + (tracks > 1 ? "s" : ""));
    if (pads) parts.push(pads + " pad" + (pads > 1 ? "s" : ""));
    var s = "Net: " + parts.join(", ") + " on " + Object.keys(layers).join("+");
    if (info.labels.length) s += " — " + info.labels.slice(0, 4).join(", ");
    return s;
  }

  function activeTab() {
    return state.active >= 0 ? state.tabs[state.active] : null;
  }

  /* ------------------------- notifications --------------------------- */

  function showBanner(message, kind) {
    els.banner.hidden = false;
    els.banner.classList.toggle("warn", kind === "warn");
    els.banner.classList.toggle("info", kind === "info");
    els.bannerMsg.textContent = message;
  }
  document.getElementById("banner-close").addEventListener("click", function () {
    els.banner.hidden = true;
  });

  /* --------------------------- file loading -------------------------- */

  function loadFiles(fileList) {
    Array.prototype.forEach.call(fileList, function (file) {
      var fr = new FileReader();
      fr.onload = function () {
        addDocument(fr.result, file.name);
      };
      fr.onerror = function () {
        showBanner("Could not read “" + file.name + "” from disk.");
      };
      fr.readAsArrayBuffer(file);
    });
  }

  function addDocument(buffer, fileName) {
    var doc, salvaged = false;
    try {
      doc = Lay6.parse(buffer);
    } catch (e) {
      // Strict parse failed. Try a best-effort partial parse so a file with
      // one bad board (or a format quirk this decoder doesn't handle yet)
      // still shows whatever decoded, with a diagnostic pinpointing the break.
      var msg = e && e.name === "Lay6Error" ? e.message : "Unexpected parser failure: " + e;
      try {
        doc = Lay6.parse(buffer, { partial: true });
      } catch (e2) {
        doc = null;
      }
      if (!doc || !doc.boards.length) {
        showBanner("“" + fileName + "”: " + msg);
        return;
      }
      salvaged = true;
    }
    // parse() already decoded with an auto-detected codepage. Honour that
    // (so Cyrillic boards are readable on load), and surface the choice by
    // syncing the encoding selector to it.
    var detected = doc.detectedEncoding || els.encoding.value;
    var autoSwitched = detected !== els.encoding.value;
    if (autoSwitched) els.encoding.value = detected;
    if (doc.encoding !== detected) Lay6.decodeStrings(doc, detected);
    if (doc.boards.length === 0) {
      showBanner("“" + fileName + "” parsed, but it contains no boards.", "warn");
      return;
    }
    if (autoSwitched && detected === "windows-1251") {
      showBanner("“" + fileName + "” looks like Cyrillic text — decoded as CP1251. " +
        "Use the encoding selector if that is wrong.", "info");
    }
    var firstNew = state.tabs.length;
    doc.boards.forEach(function (board, i) {
      var visible = {};
      for (var l = 1; l <= 7; l++) visible[l] = board.layerVisible[l - 1];
      state.tabs.push({
        id: state.nextId++,
        doc: doc,
        board: board,
        fileName: fileName,
        boardIndex: i,
        view: null, // fitted lazily on first activation
        visible: visible,
      });
    });
    if (salvaged) {
      showBanner("“" + fileName + "” only partially decoded — showing the " +
        doc.boards.length + " board(s) that parsed. See Diagnostics for where it broke.", "warn");
    } else if (doc.diagnostics.length) {
      showBanner("“" + fileName + "” loaded with " + doc.diagnostics.length +
        " warning(s) — see Diagnostics.", "warn");
    }
    activateTab(firstNew + Math.min(doc.trailer.activeTab || 0, doc.boards.length - 1));
  }

  var DEMO_B64 = "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";

  function loadDemo() {
    var bin = atob(DEMO_B64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    addDocument(u8.buffer, "demo.lay6");
  }

  /* ------------------------------ tabs ------------------------------- */

  function tabLabel(tab) {
    var name = (tab.board.name || "").trim();
    if (!name) name = tab.fileName + " #" + (tab.boardIndex + 1);
    return name;
  }

  function renderTabs() {
    els.tabs.innerHTML = "";
    state.tabs.forEach(function (tab, i) {
      var btn = document.createElement("button");
      btn.className = "tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(i === state.active));
      btn.title = tab.fileName + " — board " + (tab.boardIndex + 1);
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = tabLabel(tab);
      var close = document.createElement("span");
      close.className = "close";
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", "Close " + tabLabel(tab));
      close.tabIndex = 0;
      close.textContent = "×";
      close.addEventListener("click", function (e) {
        e.stopPropagation();
        closeTab(i);
      });
      close.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          closeTab(i);
        }
      });
      btn.appendChild(name);
      btn.appendChild(close);
      btn.addEventListener("click", function () {
        activateTab(i);
      });
      els.tabs.appendChild(btn);
    });
    if (!state.tabs.length) {
      var hint = document.createElement("span");
      hint.style.color = "var(--text-dim)";
      hint.textContent = "No boards open.";
      els.tabs.appendChild(hint);
    }
  }

  function activateTab(i) {
    state.active = Math.max(0, Math.min(i, state.tabs.length - 1));
    if (!state.tabs.length) state.active = -1;
    clearMeasure();
    state.hover = null;
    state.selected = null;
    var tab = activeTab();
    if (tab && !tab.view) fitView(tab);
    refreshSidebar();
    requestRender();
  }

  function closeTab(i) {
    state.tabs.splice(i, 1);
    if (state.active >= state.tabs.length) state.active = state.tabs.length - 1;
    else if (i < state.active) state.active--;
    activateTab(state.active);
  }

  /* --------------------------- sidebar ------------------------------- */

  function refreshSidebar() {
    renderTabs();
    renderLayerPanel();
    renderInfo();
    renderSelection();
    renderDiagnostics();
    els.empty.hidden = !!activeTab();
    var tab = activeTab();
    // Reflect the active board's (auto-detected) codepage in the selector so
    // the control never lies about what is on screen.
    if (tab && tab.doc.encoding) els.encoding.value = tab.doc.encoding;
    // A tooltip pinned to the previous board would otherwise linger.
    if (els.tooltip) els.tooltip.hidden = true;
    els.stHover.textContent = "";
    document.getElementById("btn-mirror").setAttribute("aria-pressed",
      String(!!(tab && tab.view && tab.view.mirror)));
    document.getElementById("btn-grid").setAttribute("aria-pressed",
      String(!!(tab && tab.view && tab.view.grid !== false)));
    document.getElementById("btn-thin").setAttribute("aria-pressed",
      String(!!(tab && tab.view && tab.view.thin)));
    updateRotAria();
    updateStatus(null);
  }

  function renderLayerPanel() {
    els.layers.innerHTML = "";
    var tab = activeTab();
    if (!tab) {
      els.layers.innerHTML = '<span style="color:var(--text-dim)">No board loaded.</span>';
      return;
    }
    var counts = Lay6.layerCounts(tab.board);
    for (var l = 1; l <= 7; l++) {
      (function (layer) {
        var meta = Lay6.LAYERS[layer];
        var row = document.createElement("label");
        row.className = "layer-row";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!tab.visible[layer];
        cb.addEventListener("change", function () {
          tab.visible[layer] = cb.checked;
          requestRender();
        });
        var sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = Lay6Render.COLORS.layers[layer];
        var name = document.createElement("span");
        name.textContent = meta.key + " · " + meta.name;
        var count = document.createElement("span");
        count.className = "count";
        count.textContent = counts[layer];
        row.appendChild(cb);
        row.appendChild(sw);
        row.appendChild(name);
        row.appendChild(count);
        els.layers.appendChild(row);
      })(l);
    }
  }

  function renderInfo() {
    var tab = activeTab();
    if (!tab) {
      els.info.innerHTML = '<span style="color:var(--text-dim)">No board loaded.</span>';
      return;
    }
    var b = tab.board;
    var h = Lay6.histogram(b);
    var total = 0;
    Object.keys(h).forEach(function (k) { total += h[k]; });
    var dl = document.createElement("dl");
    function row(dt, dd) {
      var t = document.createElement("dt");
      t.textContent = dt;
      var d = document.createElement("dd");
      d.textContent = dd;
      dl.appendChild(t);
      dl.appendChild(d);
    }
    row("File", tab.fileName);
    row("Size", Lay6.toMM(b.sizeX).toFixed(2) + " × " + Lay6.toMM(b.sizeY).toFixed(2) + " mm");
    // the grid field is stored in micrometres (e.g. 396.875 um = 1/64 inch)
    row("Grid", (b.grid / 1000).toFixed(4) + " mm");
    row("Objects", String(total));
    Object.keys(h).sort().forEach(function (k) {
      row("• " + k, String(h[k]));
    });
    if (tab.doc.trailer.project) row("Project", tab.doc.trailer.project);
    if (tab.doc.trailer.author) row("Author", tab.doc.trailer.author);
    els.info.innerHTML = "";
    els.info.appendChild(dl);
  }

  function renderSelection() {
    var el = els.selection;
    if (!el) return;
    var info = state.selected;
    if (!info) {
      el.innerHTML = '<span class="muted">Click an object to inspect it.</span>';
      return;
    }
    var o = info.o;
    var tab = activeTab();
    var H = tab ? Lay6.toMM(tab.board.sizeY) : 0;
    var mmv = Lay6.toMM;
    var dl = document.createElement("dl");
    function row(dt, dd) {
      var t = document.createElement("dt");
      t.textContent = dt;
      var d = document.createElement("dd");
      d.textContent = dd;
      dl.appendChild(t);
      dl.appendChild(d);
    }
    var layer = Lay6.LAYERS[o.layer];
    row("Object", Lay6.TYPE_NAMES[o.type] || "type " + o.type);
    row("Layer", layer ? layer.key + " " + layer.name : String(o.layer));
    var cx = mmv(o.x), cy = mmv(o.y) + H;
    if (o.type === 8 && o.points && o.points.length >= 3) {
      var sx = 0, sy = 0;
      o.points.forEach(function (p) { sx += mmv(p.x); sy += mmv(p.y); });
      cx = sx / o.points.length;
      cy = sy / o.points.length + H;
    }
    row("Position", cx.toFixed(3) + ", " + cy.toFixed(3) + " mm");
    if (o.type === 6) row("Width", mmv(o.lineWidth).toFixed(3) + " mm");
    if (o.type === 2) {
      row("Pad", (2 * mmv(o.out)).toFixed(2) + " mm " +
        (o.thtShape === 3 ? "square" : o.thtShape === 2 ? "octagon" : "round"));
      row("Drill", (2 * mmv(o.in)).toFixed(2) + " mm");
      row("Plated", o.plated ? "yes" : "no");
    }
    if (o.type === 8) row("Size", mmv(o.out).toFixed(2) + " x " + mmv(o.in).toFixed(2) + " mm");
    if (o.type === 4) row("Fill", o.fill ? "filled" : "outline only");
    if (o.type === 5) {
      row("Radii", mmv(o.out).toFixed(2) + " .. " + mmv(o.in).toFixed(2) + " mm");
      if (o.startAngle !== o.lineWidth) {
        row("Arc", Lay6.toDeg(o.startAngle).toFixed(1) + " to " + Lay6.toDeg(o.lineWidth).toFixed(1) + " deg");
      }
    }
    if (o.rotation) row("Rotation", Lay6.toDeg(o.rotation).toFixed(1) + " deg");
    if (o.type === 6 && o.points) row("Segments", String(o.points.length - 1));
    if (info.members.length > 1) {
      var tracks = 0, pads = 0;
      info.members.forEach(function (m) { m.type === 6 ? tracks++ : pads++; });
      row("Net", tracks + " tracks, " + pads + " pads");
      if (info.labels.length) row("Net labels", info.labels.slice(0, 6).join(", "));
    }
    if (o.groundDistance) row("Clearance", mmv(o.groundDistance).toFixed(2) + " mm");
    el.innerHTML = "";
    el.appendChild(dl);
  }

  function renderDiagnostics() {
    var tab = activeTab();
    els.diag.innerHTML = "";
    if (!tab) {
      els.diag.innerHTML = '<span style="color:var(--text-dim)">Nothing to report.</span>';
      return;
    }
    var doc = tab.doc;
    var ok = document.createElement("div");
    ok.className = "item " + (doc.consumed === doc.byteLength ? "ok" : "error");
    ok.textContent = doc.consumed === doc.byteLength
      ? "Parsed " + doc.byteLength + " bytes — consumed to the last byte."
      : "Consumed " + doc.consumed + " of " + doc.byteLength + " bytes!";
    els.diag.appendChild(ok);
    doc.diagnostics.forEach(function (d) {
      var item = document.createElement("div");
      item.className = "item";
      item.textContent = d.message;
      els.diag.appendChild(item);
    });
  }

  /* ---------------------------- viewport ----------------------------- */

  function cssSize() {
    return { w: canvas.clientWidth, h: canvas.clientHeight };
  }

  function boardWH(tab) {
    return {
      W: Lay6.toMM(tab.board.sizeX) || 1,
      H: Lay6.toMM(tab.board.sizeY) || 1,
    };
  }

  // The view transform, in one place so the canvas, SVG, hit-testing and the
  // measure overlay all agree. A point in "content space" is (fx, fy + H)
  // where fx/fy are file millimetres (file y runs -H..0). It is scaled (x
  // sign-flipped when mirrored), rotated by `rot` degrees, then translated by
  // (tx, ty) — identical to applyView / the SVG transform string.
  // uy is the base Y inversion (screen Y is down, board Y is up); ux adds the
  // horizontal mirror. Both match render.js applyView.
  function viewTrig(v) {
    var a = ((v.rot || 0) * Math.PI) / 180;
    return { cos: Math.cos(a), sin: Math.sin(a), ux: v.mirror ? -1 : 1, uy: -1 };
  }

  // content point -> screen pixels, without the (tx, ty) translation.
  function contentOffset(v, cx, cy) {
    var t = viewTrig(v);
    var sx = v.scale * t.ux * cx;
    var sy = v.scale * t.uy * cy;
    return { x: sx * t.cos - sy * t.sin, y: sx * t.sin + sy * t.cos };
  }

  // Position the board's centre at a given screen pixel by solving for tx/ty.
  function placeCenter(tab, sx, sy) {
    var v = tab.view, wh = boardWH(tab);
    var o = contentOffset(v, wh.W / 2, wh.H / 2);
    v.tx = sx - o.x;
    v.ty = sy - o.y;
  }

  function fitView(tab) {
    var s = cssSize();
    var wh = boardWH(tab);
    var rot = tab.view ? tab.view.rot || 0 : 0;
    var swap = rot % 180 !== 0; // 90/270 turn the board sideways
    var bw = swap ? wh.H : wh.W;
    var bh = swap ? wh.W : wh.H;
    var margin = 30;
    var scale = Math.min((s.w - 2 * margin) / bw, (s.h - 2 * margin) / bh);
    if (!isFinite(scale) || scale <= 0) scale = 5;
    tab.view = {
      scale: scale,
      tx: 0,
      ty: 0,
      mirror: tab.view ? tab.view.mirror : false,
      rot: rot,
      grid: tab.view ? tab.view.grid !== false : true,
    };
    placeCenter(tab, s.w / 2, s.h / 2);
  }

  function screenToMM(px, py) {
    var tab = activeTab();
    if (!tab || !tab.view) return null;
    var v = tab.view, t = viewTrig(v);
    var rx = px - v.tx, ry = py - v.ty;
    // un-rotate, then un-scale back to content space
    var sx = rx * t.cos + ry * t.sin;
    var sy = -rx * t.sin + ry * t.cos;
    return { x: (t.ux * sx) / v.scale, y: (t.uy * sy) / v.scale };
  }

  function mmToScreen(p) {
    var v = activeTab().view;
    var o = contentOffset(v, p.x, p.y);
    return { x: v.tx + o.x, y: v.ty + o.y };
  }

  function zoomAt(px, py, factor) {
    var tab = activeTab();
    if (!tab || !tab.view) return;
    var v = tab.view;
    var next = Math.min(Math.max(v.scale * factor, 0.05), 5000);
    factor = next / v.scale;
    v.tx = px - (px - v.tx) * factor;
    v.ty = py - (py - v.ty) * factor;
    v.scale = next;
    v.touched = true;
    requestRender();
  }

  /* ---------------------------- rendering ---------------------------- */

  var renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      draw();
    });
  }

  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    var s = cssSize();
    var w = Math.max(1, Math.round(s.w * dpr));
    var h = Math.max(1, Math.round(s.h * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw(skipOverlay) {
    resizeCanvas();
    var tab = activeTab();
    var dpr = window.devicePixelRatio || 1;
    if (!tab) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = Lay6Render.COLORS.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    var v = tab.view;
    Lay6Render.renderToCanvas(canvas, tab.board, {
      scale: v.scale, tx: v.tx, ty: v.ty, mirror: v.mirror, rot: v.rot || 0, dpr: dpr,
      grid: v.grid !== false, thin: !!v.thin,
    }, tab.visible);
    if (!skipOverlay) {
      var hv = { scale: v.scale, tx: v.tx, ty: v.ty, mirror: v.mirror, rot: v.rot || 0, dpr: dpr };
      [state.selected, state.hover].forEach(function (info, idx) {
        if (!info) return;
        if (idx === 1 && state.selected && info.o === state.selected.o) return;
        if (info.members.length <= NET_HIGHLIGHT_CAP) {
          info.members.forEach(function (m) {
            if (m !== info.o) Lay6Render.highlightObject(ctx, tab.board, m, hv, true);
          });
        }
        Lay6Render.highlightObject(ctx, tab.board, info.o, hv, false);
      });
      drawMeasureOverlay(dpr);
    }
    updateStatus();
  }

  function drawMeasureOverlay(dpr) {
    if (!state.measureA) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = Lay6Render.COLORS.measure;
    ctx.fillStyle = Lay6Render.COLORS.measure;
    var a = mmToScreen(state.measureA);
    ctx.beginPath();
    ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
    ctx.fill();
    if (state.measureB) {
      var b = mmToScreen(state.measureB);
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  /* --------------------------- status bar ---------------------------- */

  function updateStatus(cursorMM) {
    var tab = activeTab();
    if (cursorMM !== undefined && cursorMM !== null) {
      els.stCoords.textContent = "X: " + cursorMM.x.toFixed(3) + "  Y: " + cursorMM.y.toFixed(3) + " mm";
    } else if (cursorMM === null) {
      els.stCoords.textContent = "X: — Y: —";
    }
    els.stZoom.textContent = tab && tab.view ? (tab.view.scale).toFixed(1) + " px/mm" +
      (tab.view.mirror ? " · mirrored" : "") : "";
    els.stSize.textContent = tab
      ? Lay6.toMM(tab.board.sizeX).toFixed(1) + " × " + Lay6.toMM(tab.board.sizeY).toFixed(1) + " mm"
      : "";
    if (state.measureA && state.measureB) {
      var dx = state.measureB.x - state.measureA.x;
      var dy = state.measureB.y - state.measureA.y;
      els.stMeasure.textContent = "Δ " + Math.hypot(dx, dy).toFixed(3) + " mm  (dx " +
        dx.toFixed(3) + ", dy " + dy.toFixed(3) + ")";
    } else if (state.measureMode) {
      els.stMeasure.textContent = state.measureA
        ? "Measure: click the second point"
        : "Measure: click the first point";
    } else {
      els.stMeasure.textContent = "";
    }
  }

  /* ------------------------- pointer input --------------------------- */

  var pointers = new Map();
  var drag = null; // {startX, startY, tx, ty, moved}
  var pinch = null; // {dist, cx, cy}

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 1) {
      var tab = activeTab();
      drag = tab && tab.view
        ? { startX: e.offsetX, startY: e.offsetY, tx: tab.view.tx, ty: tab.view.ty, moved: false }
        : null;
    } else if (pointers.size === 2) {
      drag = null;
      var pts = Array.from(pointers.values());
      pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      };
    }
  });

  function describeObject(o) {
    var layer = Lay6.LAYERS[o.layer] ? Lay6.LAYERS[o.layer].key : "?";
    var name = Lay6.TYPE_NAMES[o.type] || ("type " + o.type);
    var mmv = Lay6.toMM;
    var detail = "";
    if (o.type === 6) detail = mmv(o.lineWidth).toFixed(2) + " mm wide";
    else if (o.type === 2) detail = "dia " + (2 * mmv(o.out)).toFixed(2) + " mm, drill " + (2 * mmv(o.in)).toFixed(2) + " mm";
    else if (o.type === 8) detail = mmv(o.out).toFixed(2) + " x " + mmv(o.in).toFixed(2) + " mm";
    else if (o.type === 4) detail = o.fill ? "filled" : "outline";
    else if (o.type === 5) detail = "r " + mmv(o.out).toFixed(2) + ".." + mmv(o.in).toFixed(2) + " mm";
    return layer + " " + name + (detail ? " — " + detail : "");
  }

  function updateHover(px, py) {
    var tab = activeTab();
    var obj = null;
    if (tab && tab.view && !drag && !pinch) {
      var w = screenToMM(px, py);
      if (w) {
        var H = Lay6.toMM(tab.board.sizeY);
        obj = Lay6Render.hitTest(tab.board, w.x, w.y - H, 4 / tab.view.scale, tab.visible);
      }
    }
    if ((state.hover ? state.hover.o : null) !== obj) {
      state.hover = obj ? netInfoFor(tab.board, obj) : null;
      requestRender();
    }
    var info = state.hover;
    els.stHover.textContent = info ? describeObject(info.o) : "";
    if (info) {
      els.ttTitle.textContent = describeObject(info.o);
      var sub = summarizeNet(info);
      els.ttSub.textContent = sub;
      els.ttSub.hidden = !sub;
      els.tooltip.hidden = false;
      var maxX = canvas.clientWidth - 270;
      els.tooltip.style.left = Math.min(px + 14, Math.max(maxX, 8)) + "px";
      els.tooltip.style.top = (py + 16) + "px";
    } else {
      els.tooltip.hidden = true;
    }
    canvas.style.cursor = state.measureMode ? "cell" : (info ? "pointer" : "crosshair");
  }

  canvas.addEventListener("pointermove", function (e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    var tab = activeTab();
    updateStatus(screenToMM(e.offsetX, e.offsetY));
    updateHover(e.offsetX, e.offsetY);
    if (!tab || !tab.view) return;
    if (pinch && pointers.size === 2) {
      var pts = Array.from(pointers.values());
      var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      var cx = (pts[0].x + pts[1].x) / 2;
      var cy = (pts[0].y + pts[1].y) / 2;
      if (pinch.dist > 0 && dist > 0) zoomAt(cx, cy, dist / pinch.dist);
      tab.view.tx += cx - pinch.cx;
      tab.view.ty += cy - pinch.cy;
      pinch = { dist: dist, cx: cx, cy: cy };
      requestRender();
      return;
    }
    if (drag) {
      var dx = e.offsetX - drag.startX;
      var dy = e.offsetY - drag.startY;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.moved) {
        tab.view.tx = drag.tx + dx;
        tab.view.ty = drag.ty + dy;
        tab.view.touched = true;
        requestRender();
      }
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved) {
      if (state.measureMode) {
        var p = screenToMM(e.offsetX, e.offsetY);
        if (p) {
          if (!state.measureA || (state.measureA && state.measureB)) {
            state.measureA = p;
            state.measureB = null;
          } else {
            state.measureB = p;
          }
          requestRender();
        }
      } else {
        // click selects the object (and its net) for the inspector
        var tab = activeTab();
        if (tab && tab.view) {
          var w = screenToMM(e.offsetX, e.offsetY);
          var H = Lay6.toMM(tab.board.sizeY);
          var obj = w && Lay6Render.hitTest(tab.board, w.x, w.y - H, 4 / tab.view.scale, tab.visible);
          state.selected = obj ? netInfoFor(tab.board, obj) : null;
          renderSelection();
          requestRender();
        }
      }
    }
    if (pointers.size === 0) drag = null;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", function () {
    updateStatus(null);
    if (state.hover) {
      state.hover = null;
      requestRender();
    }
    els.stHover.textContent = "";
  });

  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  canvas.addEventListener("dblclick", function () {
    var tab = activeTab();
    if (tab) {
      fitView(tab);
      requestRender();
    }
  });

  /* --------------------------- keyboard ------------------------------ */

  window.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    var tab = activeTab();
    var s = cssSize();
    switch (e.key) {
      case "f": case "F":
        if (tab) { fitView(tab); requestRender(); }
        break;
      case "x": case "X":
        toggleMirror();
        break;
      case "r": case "R":
        rotateView(e.shiftKey ? -90 : 90);
        break;
      case "m": case "M":
        toggleMeasure();
        break;
      case "+": case "=":
        zoomAt(s.w / 2, s.h / 2, 1.25);
        break;
      case "-": case "_":
        zoomAt(s.w / 2, s.h / 2, 0.8);
        break;
      case "ArrowLeft": if (tab && tab.view) { tab.view.tx += 40; tab.view.touched = true; requestRender(); } break;
      case "ArrowRight": if (tab && tab.view) { tab.view.tx -= 40; tab.view.touched = true; requestRender(); } break;
      case "ArrowUp": if (tab && tab.view) { tab.view.ty += 40; tab.view.touched = true; requestRender(); } break;
      case "ArrowDown": if (tab && tab.view) { tab.view.ty -= 40; tab.view.touched = true; requestRender(); } break;
      case "Escape":
        clearMeasure();
        setMeasureMode(false);
        state.selected = null;
        renderSelection();
        requestRender();
        break;
      case "g": case "G":
        toggleGrid();
        break;
      case "t": case "T":
        toggleTheme();
        break;
      case "w": case "W":
        toggleThin();
        break;
      default:
        if (/^[1-7]$/.test(e.key) && tab) {
          var layer = +e.key;
          tab.visible[layer] = !tab.visible[layer];
          renderLayerPanel();
          requestRender();
        }
        return;
    }
  });

  /* ---------------------------- toolbar ------------------------------ */

  document.getElementById("btn-open").addEventListener("click", function () {
    els.fileInput.click();
  });
  els.fileInput.addEventListener("change", function () {
    loadFiles(els.fileInput.files);
    els.fileInput.value = "";
  });
  document.getElementById("btn-demo").addEventListener("click", loadDemo);
  document.getElementById("btn-demo-2").addEventListener("click", loadDemo);
  document.getElementById("btn-fit").addEventListener("click", function () {
    var tab = activeTab();
    if (tab) { fitView(tab); requestRender(); }
  });

  // Drop any hover highlight/tooltip that belonged to the pre-transform
  // geometry so it never lingers in the wrong place.
  function clearHoverUI() {
    state.hover = null;
    els.tooltip.hidden = true;
    els.stHover.textContent = "";
  }

  function toggleMirror() {
    var tab = activeTab();
    if (!tab || !tab.view) return;
    var v = tab.view, wh = boardWH(tab);
    var sc = mmToScreen({ x: wh.W / 2, y: wh.H / 2 }); // keep centre fixed
    v.mirror = !v.mirror;
    placeCenter(tab, sc.x, sc.y);
    v.touched = true;
    document.getElementById("btn-mirror").setAttribute("aria-pressed", String(v.mirror));
    clearHoverUI();
    requestRender();
  }
  document.getElementById("btn-mirror").addEventListener("click", toggleMirror);

  // Rotate the view in 90° steps (delta = +90 CW / -90 CCW), pivoting about
  // the board centre so it stays put. Fixes boards that come in sideways or
  // upside down.
  function rotateView(delta) {
    var tab = activeTab();
    if (!tab || !tab.view) return;
    var v = tab.view, wh = boardWH(tab);
    var sc = mmToScreen({ x: wh.W / 2, y: wh.H / 2 });
    v.rot = (((v.rot || 0) + delta) % 360 + 360) % 360;
    placeCenter(tab, sc.x, sc.y);
    v.touched = true;
    updateRotAria();
    clearHoverUI();
    requestRender();
  }
  function updateRotAria() {
    var tab = activeTab();
    var rot = tab && tab.view ? tab.view.rot || 0 : 0;
    var btn = document.getElementById("btn-rotate");
    if (btn) {
      btn.setAttribute("aria-pressed", String(rot !== 0));
      btn.title = "Rotate 90° (R) — currently " + rot + "°";
    }
  }
  var rotBtn = document.getElementById("btn-rotate");
  if (rotBtn) rotBtn.addEventListener("click", function () { rotateView(90); });

  function toggleGrid() {
    var tab = activeTab();
    if (!tab || !tab.view) return;
    tab.view.grid = tab.view.grid === false;
    document.getElementById("btn-grid").setAttribute("aria-pressed", String(tab.view.grid !== false));
    requestRender();
  }
  document.getElementById("btn-grid").addEventListener("click", toggleGrid);

  // Skeleton mode: draw traces as thin centrelines and pads/zones as outlines,
  // so wide power traces stop reading as blobs and the routing is followable.
  function toggleThin() {
    var tab = activeTab();
    if (!tab || !tab.view) return;
    tab.view.thin = !tab.view.thin;
    document.getElementById("btn-thin").setAttribute("aria-pressed", String(!!tab.view.thin));
    requestRender();
  }
  document.getElementById("btn-thin").addEventListener("click", toggleThin);

  function applyTheme(name) {
    var t = Lay6Render.setTheme(name);
    try { localStorage.setItem("lay6-theme", t); } catch (e) { /* private mode */ }
    var btn = document.getElementById("btn-theme");
    if (btn) {
      // The button shows the theme you'd switch TO.
      btn.textContent = t === "light" ? "Dark" : "Light";
      btn.setAttribute("aria-pressed", String(t === "light"));
    }
    renderLayerPanel(); // swatches read the active palette
    requestRender();
  }
  function toggleTheme() {
    applyTheme(Lay6Render.getTheme() === "light" ? "dark" : "light");
  }
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  document.getElementById("btn-zoom-in").addEventListener("click", function () {
    var s = cssSize();
    zoomAt(s.w / 2, s.h / 2, 1.25);
  });
  document.getElementById("btn-zoom-out").addEventListener("click", function () {
    var s = cssSize();
    zoomAt(s.w / 2, s.h / 2, 0.8);
  });

  function setMeasureMode(on) {
    state.measureMode = on;
    document.getElementById("btn-measure").setAttribute("aria-pressed", String(on));
    canvas.style.cursor = on ? "cell" : "crosshair";
    updateStatus();
  }
  function toggleMeasure() {
    setMeasureMode(!state.measureMode);
    if (!state.measureMode) clearMeasure();
    requestRender();
  }
  function clearMeasure() {
    state.measureA = null;
    state.measureB = null;
  }
  document.getElementById("btn-measure").addEventListener("click", toggleMeasure);

  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function exportName(tab, ext) {
    var base = (tab.board.name || "board").trim().replace(/[^\w.-]+/g, "_") || "board";
    return base + "." + ext;
  }

  document.getElementById("btn-png").addEventListener("click", function () {
    var tab = activeTab();
    if (!tab) return;
    draw(true); // redraw without the measure overlay
    canvas.toBlob(function (blob) {
      if (blob) download(blob, exportName(tab, "png"));
      requestRender();
    }, "image/png");
  });

  document.getElementById("btn-svg").addEventListener("click", function () {
    var tab = activeTab();
    if (!tab) return;
    var s = cssSize();
    var svg = Lay6Render.renderToSVG(tab.board, tab.view, s.w, s.h, tab.visible);
    download(new Blob([svg], { type: "image/svg+xml" }), exportName(tab, "svg"));
  });

  els.encoding.addEventListener("change", function () {
    var enc = els.encoding.value;
    var docs = new Set();
    state.tabs.forEach(function (t) { docs.add(t.doc); });
    docs.forEach(function (d) {
      Lay6.decodeStrings(d, enc);
      // net labels cache decoded strings, so rebuild on demand
      d.boards.forEach(function (b) { delete b._nets; });
    });
    state.hover = null;
    state.selected = null;
    refreshSidebar();
    requestRender();
  });

  /* -------------------------- drag & drop ---------------------------- */

  var dragDepth = 0;
  window.addEventListener("dragenter", function (e) {
    e.preventDefault();
    dragDepth++;
    els.dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", function (e) {
    e.preventDefault();
  });
  window.addEventListener("dragleave", function (e) {
    e.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      els.dropOverlay.hidden = true;
    }
  });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  /* ----------------------------- boot -------------------------------- */

  // Keep the board centered on layout changes until the user starts
  // navigating on their own.
  function onViewportResize() {
    var tab = activeTab();
    if (tab && tab.view && !tab.view.touched) fitView(tab);
    requestRender();
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(onViewportResize).observe(canvas);
  }
  window.addEventListener("resize", onViewportResize);

  // Offline support on the hosted page; skipped on file:// where service
  // workers are unavailable.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* optional */ });
  }

  // Restore the saved board theme (default dark).
  var savedTheme = "dark";
  try { savedTheme = localStorage.getItem("lay6-theme") || "dark"; } catch (e) { /* private mode */ }
  applyTheme(savedTheme);

  refreshSidebar();
  requestRender();
})();
