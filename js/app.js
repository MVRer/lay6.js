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
    nextId: 1,
  };

  function activeTab() {
    return state.active >= 0 ? state.tabs[state.active] : null;
  }

  /* ------------------------- notifications --------------------------- */

  function showBanner(message, kind) {
    els.banner.hidden = false;
    els.banner.classList.toggle("warn", kind === "warn");
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
    var doc;
    try {
      doc = Lay6.parse(buffer);
    } catch (e) {
      var msg = e && e.name === "Lay6Error" ? e.message : "Unexpected parser failure: " + e;
      showBanner("“" + fileName + "”: " + msg);
      return;
    }
    Lay6.decodeStrings(doc, els.encoding.value);
    if (doc.boards.length === 0) {
      showBanner("“" + fileName + "” parsed, but it contains no boards.", "warn");
      return;
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
    if (doc.diagnostics.length) {
      showBanner("“" + fileName + "” loaded with " + doc.diagnostics.length +
        " warning(s) — see Diagnostics.", "warn");
    }
    activateTab(firstNew + Math.min(doc.trailer.activeTab || 0, doc.boards.length - 1));
  }

  var DEMO_B64 = "BjOq/wEAAAAKZGVtbyBib2FyZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACChBwDgkwQAAAAAAAAAAFK4HoXrUfQ/AAAAAAAA8D8AAAAAAAAAAAEAAAABAQEAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJDQAwDwSQIAAAsAAAAEAAAAAAAAAIAAAAAAAAAAANAHAAAAAQAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAQJxGAECcxgB8kkgAQJzGAHySSABQQ8gAQJxGAFBDyAQAAAAAAAAAgAAAAAAAAAAA3AUAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAEpkgAQBzHAJzgSABAHMcAUMNIALgIyAIAQJxHAECcxwDAWkYAgLtFAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAAoA8AAAAAAAAAAQAAAAAAAAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAuAhIAECcxwDAWkYAgLtFAAAAAAABAwAAAAAAAAAAAAAAAAAAAAAAoA8AAAAAAAAAAAABMHUAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAgAAAAAAAAAAAiBMAAAABAAAAAAAAAAAAAAAAAAAAAAAAoA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAABAnEcAQJzHAECcRwBAHMgAYGpIAEAcyAUAUMNIANhWyABAnEYAYOpGAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQBQw0gA2FbIAAD6RQCAO0awHgQAAAEAAAAAAAAAAJBfAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAEAcRwDofcgAQJxGAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJg6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAABsYXk2LmpzAAAAAAAAAAAAAAAABwDIr0gAYGrIAGBqRgAAAAAAAAAAAAIBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAUjEAAAAAAAAAAAMAAAACAASmSADofcgAQBxGAECcRQAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIABTNSADofcgAAHpGAKAMRgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJBfAQAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAIAAAAAAAAAAALgLAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAABKZIAOh9yAAUzUgA6H3IAAAAAAAAAAABAAAAAAAAAAAGAAAAUi0xMG1tCQAAAGRlbW8gcGFydAEIAOh9SABAnMcAQJxGAEAcRgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAALgLAAAAAAAAAAAAAMivAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAIAAAAAAAAAAANAHAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAAAAAAAAAAgAAk9EgAAACAACT0SAB8ksgAAAAAAHySyAAAAAAAAACAAQAAAAQAAAAAAAAAAQAAAAIAAAAAAAAAAAAAAAAAAAAEZGVtbwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAV0ZXN0cwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARAAAAc3ludGhldGljIGZpeHR1cmU=";

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
    renderDiagnostics();
    els.empty.hidden = !!activeTab();
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
    row("Grid", b.grid.toFixed(4) + " mm");
    row("Objects", String(total));
    Object.keys(h).sort().forEach(function (k) {
      row("• " + k, String(h[k]));
    });
    if (tab.doc.trailer.project) row("Project", tab.doc.trailer.project);
    if (tab.doc.trailer.author) row("Author", tab.doc.trailer.author);
    els.info.innerHTML = "";
    els.info.appendChild(dl);
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

  function fitView(tab) {
    var s = cssSize();
    var bw = Lay6.toMM(tab.board.sizeX) || 1;
    var bh = Lay6.toMM(tab.board.sizeY) || 1;
    var margin = 30;
    var scale = Math.min((s.w - 2 * margin) / bw, (s.h - 2 * margin) / bh);
    if (!isFinite(scale) || scale <= 0) scale = 5;
    var mirror = tab.view ? tab.view.mirror : false;
    tab.view = {
      scale: scale,
      tx: (s.w - scale * bw * (mirror ? -1 : 1)) / 2 - (mirror ? scale * bw : 0),
      ty: (s.h - scale * bh) / 2,
      mirror: mirror,
    };
    // center regardless of mirror: screen x of board center must be s.w/2
    var cx = bw / 2;
    tab.view.tx = s.w / 2 - tab.view.scale * (mirror ? -cx : cx);
  }

  function screenToMM(px, py) {
    var tab = activeTab();
    if (!tab || !tab.view) return null;
    var v = tab.view;
    var x = (px - v.tx) / v.scale;
    if (v.mirror) x = -x;
    return { x: x, y: (py - v.ty) / v.scale };
  }

  function mmToScreen(p) {
    var v = activeTab().view;
    return {
      x: v.tx + v.scale * (v.mirror ? -p.x : p.x),
      y: v.ty + v.scale * p.y,
    };
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
      scale: v.scale, tx: v.tx, ty: v.ty, mirror: v.mirror, dpr: dpr,
    }, tab.visible);
    if (!skipOverlay) drawMeasureOverlay(dpr);
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

  canvas.addEventListener("pointermove", function (e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    var tab = activeTab();
    updateStatus(screenToMM(e.offsetX, e.offsetY));
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
        requestRender();
      }
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && state.measureMode) {
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
    }
    if (pointers.size === 0) drag = null;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", function () {
    updateStatus(null);
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
      case "m": case "M":
        toggleMeasure();
        break;
      case "+": case "=":
        zoomAt(s.w / 2, s.h / 2, 1.25);
        break;
      case "-": case "_":
        zoomAt(s.w / 2, s.h / 2, 0.8);
        break;
      case "ArrowLeft": if (tab && tab.view) { tab.view.tx += 40; requestRender(); } break;
      case "ArrowRight": if (tab && tab.view) { tab.view.tx -= 40; requestRender(); } break;
      case "ArrowUp": if (tab && tab.view) { tab.view.ty += 40; requestRender(); } break;
      case "ArrowDown": if (tab && tab.view) { tab.view.ty -= 40; requestRender(); } break;
      case "Escape":
        clearMeasure();
        setMeasureMode(false);
        requestRender();
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

  function toggleMirror() {
    var tab = activeTab();
    if (!tab || !tab.view) return;
    var v = tab.view;
    var cx = Lay6.toMM(tab.board.sizeX) / 2;
    var screenCX = v.tx + v.scale * (v.mirror ? -cx : cx);
    v.mirror = !v.mirror;
    v.tx = screenCX - v.scale * (v.mirror ? -cx : cx);
    document.getElementById("btn-mirror").setAttribute("aria-pressed", String(v.mirror));
    requestRender();
  }
  document.getElementById("btn-mirror").addEventListener("click", toggleMirror);

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
    docs.forEach(function (d) { Lay6.decodeStrings(d, enc); });
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

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () {
      requestRender();
    }).observe(canvas);
  }
  window.addEventListener("resize", requestRender);

  // Offline support on the hosted page; skipped on file:// where service
  // workers are unavailable.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* optional */ });
  }

  refreshSidebar();
  requestRender();
})();
