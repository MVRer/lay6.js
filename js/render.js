/*
 * render.js — canvas and SVG rendering for parsed .lay6 boards.
 *
 * Geometry is generated as SVG path data and shared between the canvas
 * renderer (via Path2D) and the SVG exporter, so both outputs stay in sync.
 *
 * Coordinates are converted to millimetres; the screen is y-down like the
 * Sprint-Layout editor. File angles are counter-clockwise in board space,
 * which maps to negative canvas angles.
 */
"use strict";

var Lay6Render = (function () {
  var TYPE = { THT: 2, ZONE: 4, CIRCLE: 5, TRACK: 6, TEXT: 7, SMD: 8 };

  var COLORS = {
    bg: "#10141b",
    board: "#171e28",
    hole: "#10141b",
    measure: "#ff5f8f",
    layers: {
      1: "#3d7bfd", // C1 copper top
      2: "#e8edf6", // S1 silk top
      3: "#37a75c", // C2 copper bottom
      4: "#c8b25a", // S2 silk bottom
      5: "#c2703f", // I1
      6: "#a44ab8", // I2
      7: "#e8c15a", // O outline
    },
  };

  function mm(u) {
    return u / 10000;
  }
  function deg(md) {
    return md / 1000;
  }
  function rad(d) {
    return (d * Math.PI) / 180;
  }
  function fmt(n) {
    return +n.toFixed(5);
  }

  // Point on a circle at file-angle `a` degrees (CCW in board space, y-down screen).
  function polar(cx, cy, r, a) {
    return { x: cx + r * Math.cos(rad(a)), y: cy - r * Math.sin(rad(a)) };
  }

  /* --------------------- path-data generators (mm) ------------------- */

  function circleD(cx, cy, r) {
    return "M " + fmt(cx - r) + " " + fmt(cy) +
      " A " + fmt(r) + " " + fmt(r) + " 0 1 0 " + fmt(cx + r) + " " + fmt(cy) +
      " A " + fmt(r) + " " + fmt(r) + " 0 1 0 " + fmt(cx - r) + " " + fmt(cy) + " Z";
  }

  function polygonD(pts) {
    var d = "M " + fmt(pts[0].x) + " " + fmt(pts[0].y);
    for (var i = 1; i < pts.length; i++) d += " L " + fmt(pts[i].x) + " " + fmt(pts[i].y);
    return d + " Z";
  }

  function polylineD(pts) {
    var d = "M " + fmt(pts[0].x) + " " + fmt(pts[0].y);
    for (var i = 1; i < pts.length; i++) d += " L " + fmt(pts[i].x) + " " + fmt(pts[i].y);
    return d;
  }

  function rotatedRect(cx, cy, halfW, halfH, rotDeg) {
    var c = Math.cos(rad(-rotDeg));
    var s = Math.sin(rad(-rotDeg));
    var pts = [
      [-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH],
    ].map(function (p) {
      return { x: cx + p[0] * c - p[1] * s, y: cy + p[0] * s + p[1] * c };
    });
    return polygonD(pts);
  }

  function octagonD(cx, cy, r, rotDeg) {
    // r is half the flat-to-flat width; circumradius reaches the corners.
    var R = r / Math.cos(Math.PI / 8);
    var pts = [];
    for (var i = 0; i < 8; i++) {
      pts.push(polar(cx, cy, R, rotDeg + 22.5 + i * 45));
    }
    return polygonD(pts);
  }

  // THT pad body, dilated by `e` mm (used for clearance punching).
  function thtPadD(o, e) {
    var x = mm(o.x), y = mm(o.y), r = mm(o.out) + e;
    var rot = deg(o.rotation);
    if (o.thtShape === 3) return rotatedRect(x, y, r, r, rot);
    if (o.thtShape === 2) return octagonD(x, y, r, rot);
    return circleD(x, y, r);
  }

  function smdPadD(o, e) {
    return rotatedRect(mm(o.x), mm(o.y), mm(o.out) / 2 + e, mm(o.in) / 2 + e, deg(o.rotation));
  }

  // Circle object: annulus or partial arc band.
  // out = inner radius, in = outer radius, startAngle/lineWidth = start/end
  // angles in 1/1000 degree. Equal angles mean a full ring.
  function circleBandD(o, e) {
    e = e || 0;
    var cx = mm(o.x), cy = mm(o.y);
    var ri = Math.max(0, mm(o.out) - e);
    var ro = mm(o.in) + e;
    if (ro <= 0) return null;
    var a0 = deg(o.startAngle);
    var a1 = deg(o.lineWidth);
    var sweep = ((a1 - a0) % 360 + 360) % 360;
    if (sweep === 0) {
      // full ring: even-odd of two circles (or a disc when ri == 0)
      if (ri <= 0) return circleD(cx, cy, ro);
      return circleD(cx, cy, ro) + " " + circleD(cx, cy, ri);
    }
    var large = sweep > 180 ? 1 : 0;
    var o0 = polar(cx, cy, ro, a0), o1 = polar(cx, cy, ro, a1);
    var d = "M " + fmt(o0.x) + " " + fmt(o0.y) +
      " A " + fmt(ro) + " " + fmt(ro) + " 0 " + large + " 0 " + fmt(o1.x) + " " + fmt(o1.y);
    if (ri > 0) {
      var i0 = polar(cx, cy, ri, a0), i1 = polar(cx, cy, ri, a1);
      d += " L " + fmt(i1.x) + " " + fmt(i1.y) +
        " A " + fmt(ri) + " " + fmt(ri) + " 0 " + large + " 1 " + fmt(i0.x) + " " + fmt(i0.y);
    } else {
      d += " L " + fmt(cx) + " " + fmt(cy);
    }
    return d + " Z";
  }

  // Thermal spokes: four strokes at 45° offsets from the pad rotation.
  function thermalSpokes(o) {
    var cx = mm(o.x), cy = mm(o.y);
    var reach = (o.type === TYPE.SMD ? Math.max(mm(o.out), mm(o.in)) / 2 : mm(o.out)) +
      mm(o.groundDistance) + 0.05;
    var width = Math.max(0.15, (o.type === TYPE.SMD ? Math.min(mm(o.out), mm(o.in)) / 2 : mm(o.out)) * 0.45);
    var spokes = [];
    for (var i = 0; i < 4; i++) {
      var p = polar(cx, cy, reach, deg(o.rotation) + 45 + i * 90);
      spokes.push({ d: "M " + fmt(cx) + " " + fmt(cy) + " L " + fmt(p.x) + " " + fmt(p.y), width: width });
    }
    return spokes;
  }

  /* ----------------------- render list ------------------------------ */

  function layerZ(layer) {
    var z = Lay6.LAYER_Z_ORDER.indexOf(layer);
    return z === -1 ? 99 : z;
  }

  // Flatten a board into drawable items. Text objects with children act as
  // component containers: their children are emitted as standalone items on
  // their own layers, and the container's label is drawn as text.
  function buildRenderList(board) {
    if (board._renderList) return board._renderList;
    var items = [];
    var n = 0;
    (function emit(objects) {
      for (var i = 0; i < objects.length; i++) {
        var o = objects[i];
        items.push({ o: o, seq: n++ });
        if (o.children && o.children.length) emit(o.children);
      }
    })(board.objects);
    items.sort(function (a, b) {
      return (layerZ(a.o.layer) - layerZ(b.o.layer)) ||
        ((Lay6.TYPE_Z[a.o.type] || 2) - (Lay6.TYPE_Z[b.o.type] || 2)) ||
        (a.seq - b.seq);
    });
    board._renderList = items;
    return items;
  }

  function itemsByLayer(board) {
    var by = {};
    var items = buildRenderList(board);
    for (var i = 0; i < items.length; i++) {
      var l = items[i].o.layer;
      (by[l] || (by[l] = [])).push(items[i].o);
    }
    return by;
  }

  /* ----------------------- canvas rendering ------------------------- */

  var offscreen = null;
  function getOffscreen(w, h) {
    if (!offscreen) offscreen = document.createElement("canvas");
    if (offscreen.width !== w || offscreen.height !== h) {
      offscreen.width = w;
      offscreen.height = h;
    }
    return offscreen;
  }

  function applyView(ctx, view) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.mirror ? -view.scale : view.scale, view.scale);
  }

  function fillD(ctx, d, color) {
    ctx.fillStyle = color;
    ctx.fill(new Path2D(d), "evenodd");
  }

  function strokePoly(ctx, o, color, width, closed) {
    if (!o.points || o.points.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(width, 0.02);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(mm(o.points[0].x), mm(o.points[0].y));
    for (var i = 1; i < o.points.length; i++) ctx.lineTo(mm(o.points[i].x), mm(o.points[i].y));
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  function drawText(ctx, o, color) {
    var text = o.text || "";
    if (!text) return;
    var h = Math.max(mm(o.out), 0.4);
    ctx.save();
    ctx.translate(mm(o.x), mm(o.y));
    ctx.rotate(rad(-deg(o.rotation)));
    if (o.flipVertical) ctx.scale(-1, 1);
    ctx.fillStyle = color;
    ctx.font = h + "px system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function drawObject(ctx, o, color) {
    switch (o.type) {
      case TYPE.THT:
        fillD(ctx, thtPadD(o, 0), color);
        break;
      case TYPE.SMD:
        fillD(ctx, smdPadD(o, 0), color);
        break;
      case TYPE.CIRCLE:
        var d = circleBandD(o, 0);
        if (d) fillD(ctx, d, color);
        break;
      case TYPE.TRACK:
        strokePoly(ctx, o, color, mm(o.lineWidth), false);
        break;
      case TYPE.ZONE:
        if (!o.points || o.points.length < 2) break;
        if (o.fill) {
          fillD(ctx, polygonD(o.points.map(function (p) { return { x: mm(p.x), y: mm(p.y) }; })), color);
        } else {
          strokePoly(ctx, o, color, mm(o.lineWidth), true);
        }
        break;
      case TYPE.TEXT:
        drawText(ctx, o, color);
        break;
      default:
        if (o.points && o.points.length) strokePoly(ctx, o, color, mm(o.lineWidth), false);
    }
  }

  // Clearance punch shape for an object sitting on a filled zone.
  function punchObject(ctx, o) {
    var e = mm(o.groundDistance);
    if (e <= 0 && !o.cutoff) return false;
    if (e <= 0) e = 0.3; // cutoff with no distance still isolates
    switch (o.type) {
      case TYPE.THT:
        fillD(ctx, thtPadD(o, e), "#000");
        return true;
      case TYPE.SMD:
        fillD(ctx, smdPadD(o, e), "#000");
        return true;
      case TYPE.TRACK:
        strokePoly(ctx, o, "#000", mm(o.lineWidth) + 2 * e, false);
        return true;
      case TYPE.CIRCLE:
        var d = circleBandD(o, e);
        if (d) fillD(ctx, d, "#000");
        return true;
    }
    return false;
  }

  function renderLayerWithZones(mainCtx, objs, color, view, canvasW, canvasH) {
    var os = getOffscreen(canvasW, canvasH);
    var ctx = os.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvasW, canvasH);
    applyView(ctx, view);

    var zones = [], rest = [];
    for (var i = 0; i < objs.length; i++) {
      (objs[i].type === TYPE.ZONE ? zones : rest).push(objs[i]);
    }

    // 1. zone fills and outlines
    for (i = 0; i < zones.length; i++) drawObject(ctx, zones[i], color);

    // 2. clearance: erase ground_distance around same-layer objects
    ctx.globalCompositeOperation = "destination-out";
    for (i = 0; i < rest.length; i++) punchObject(ctx, rest[i]);

    // 3. thermal relief spokes reconnect pads that asked for them
    ctx.globalCompositeOperation = "source-over";
    for (i = 0; i < rest.length; i++) {
      var o = rest[i];
      if ((o.type === TYPE.THT || o.type === TYPE.SMD) &&
          o.thermal && !o.cutoff && mm(o.groundDistance) > 0) {
        var spokes = thermalSpokes(o);
        ctx.strokeStyle = color;
        ctx.lineCap = "butt";
        for (var s = 0; s < spokes.length; s++) {
          ctx.lineWidth = spokes[s].width;
          ctx.stroke(new Path2D(spokes[s].d));
        }
      }
    }

    // 4. the objects themselves on top of the relieved zone
    for (i = 0; i < rest.length; i++) drawObject(ctx, rest[i], color);

    mainCtx.save();
    mainCtx.setTransform(1, 0, 0, 1, 0, 0);
    mainCtx.drawImage(os, 0, 0);
    mainCtx.restore();
  }

  /**
   * Render a board to a canvas.
   * view: { scale: px per mm, tx, ty: px, mirror: bool, dpr }
   * visible: { 1..7: bool }
   */
  function renderToCanvas(canvas, board, view, visible) {
    var ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!board) return;

    applyView(ctx, view);

    // board area
    ctx.fillStyle = COLORS.board;
    ctx.fillRect(0, 0, mm(board.sizeX), mm(board.sizeY));

    var by = itemsByLayer(board);
    for (var zi = 0; zi < Lay6.LAYER_Z_ORDER.length; zi++) {
      var layer = Lay6.LAYER_Z_ORDER[zi];
      if (!visible[layer]) continue;
      var objs = by[layer];
      if (!objs || !objs.length) continue;
      var color = COLORS.layers[layer];
      var hasFilledZone = Lay6.COPPER_LAYERS[layer] &&
        objs.some(function (o) { return o.type === TYPE.ZONE && o.fill; });
      if (hasFilledZone) {
        renderLayerWithZones(ctx, objs, color, view, canvas.width, canvas.height);
        applyView(ctx, view); // renderLayerWithZones resets the transform
      } else {
        for (var i = 0; i < objs.length; i++) drawObject(ctx, objs[i], color);
      }
    }

    // drill holes go through everything
    ctx.fillStyle = COLORS.hole;
    var items = buildRenderList(board);
    for (var di = 0; di < items.length; di++) {
      var o = items[di].o;
      if (o.type === TYPE.THT && visible[o.layer] && mm(o.in) > 0) {
        ctx.fill(new Path2D(circleD(mm(o.x), mm(o.y), mm(o.in))));
      }
    }
  }

  /* ------------------------- SVG export ------------------------------ */

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function svgObject(o, color) {
    switch (o.type) {
      case TYPE.THT:
        return '<path d="' + thtPadD(o, 0) + '" fill="' + color + '" fill-rule="evenodd"/>';
      case TYPE.SMD:
        return '<path d="' + smdPadD(o, 0) + '" fill="' + color + '"/>';
      case TYPE.CIRCLE:
        var d = circleBandD(o, 0);
        return d ? '<path d="' + d + '" fill="' + color + '" fill-rule="evenodd"/>' : "";
      case TYPE.TRACK:
        if (!o.points || !o.points.length) return "";
        return '<path d="' + polylineD(o.points.map(function (p) { return { x: mm(p.x), y: mm(p.y) }; })) +
          '" fill="none" stroke="' + color + '" stroke-width="' + fmt(Math.max(mm(o.lineWidth), 0.02)) +
          '" stroke-linecap="round" stroke-linejoin="round"/>';
      case TYPE.ZONE:
        if (!o.points || o.points.length < 2) return "";
        var zd = polygonD(o.points.map(function (p) { return { x: mm(p.x), y: mm(p.y) }; }));
        if (o.fill) return '<path d="' + zd + '" fill="' + color + '"/>';
        return '<path d="' + zd + '" fill="none" stroke="' + color +
          '" stroke-width="' + fmt(Math.max(mm(o.lineWidth), 0.02)) + '" stroke-linejoin="round"/>';
      case TYPE.TEXT:
        if (!o.text) return "";
        var h = Math.max(mm(o.out), 0.4);
        var tf = "translate(" + fmt(mm(o.x)) + " " + fmt(mm(o.y)) + ") rotate(" + fmt(-deg(o.rotation)) + ")" +
          (o.flipVertical ? " scale(-1 1)" : "");
        return '<text transform="' + tf + '" font-size="' + fmt(h) +
          '" font-family="sans-serif" fill="' + color + '">' + esc(o.text) + "</text>";
      default:
        if (o.points && o.points.length) {
          return '<path d="' + polylineD(o.points.map(function (p) { return { x: mm(p.x), y: mm(p.y) }; })) +
            '" fill="none" stroke="' + color + '" stroke-width="' + fmt(Math.max(mm(o.lineWidth), 0.02)) + '"/>';
        }
        return "";
    }
  }

  function svgPunch(o) {
    var e = mm(o.groundDistance);
    if (e <= 0 && !o.cutoff) return "";
    if (e <= 0) e = 0.3;
    switch (o.type) {
      case TYPE.THT:
        return '<path d="' + thtPadD(o, e) + '" fill="black" fill-rule="evenodd"/>';
      case TYPE.SMD:
        return '<path d="' + smdPadD(o, e) + '" fill="black"/>';
      case TYPE.TRACK:
        if (!o.points || !o.points.length) return "";
        return '<path d="' + polylineD(o.points.map(function (p) { return { x: mm(p.x), y: mm(p.y) }; })) +
          '" fill="none" stroke="black" stroke-width="' + fmt(mm(o.lineWidth) + 2 * e) +
          '" stroke-linecap="round" stroke-linejoin="round"/>';
      case TYPE.CIRCLE:
        var d = circleBandD(o, e);
        return d ? '<path d="' + d + '" fill="black" fill-rule="evenodd"/>' : "";
    }
    return "";
  }

  /**
   * Export the current view as a standalone SVG document (same transform
   * as the canvas: pixels, y-down, optional mirror).
   */
  function renderToSVG(board, view, widthPx, heightPx, visible) {
    var maskId = 0;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + widthPx + '" height="' + heightPx +
      '" viewBox="0 0 ' + widthPx + " " + heightPx + '">');
    parts.push('<rect width="100%" height="100%" fill="' + COLORS.bg + '"/>');
    var tf = "translate(" + fmt(view.tx) + " " + fmt(view.ty) + ") scale(" +
      fmt(view.mirror ? -view.scale : view.scale) + " " + fmt(view.scale) + ")";
    parts.push('<g transform="' + tf + '">');
    parts.push('<rect x="0" y="0" width="' + fmt(mm(board.sizeX)) + '" height="' + fmt(mm(board.sizeY)) +
      '" fill="' + COLORS.board + '"/>');

    var by = itemsByLayer(board);
    var defs = [];
    for (var zi = 0; zi < Lay6.LAYER_Z_ORDER.length; zi++) {
      var layer = Lay6.LAYER_Z_ORDER[zi];
      if (!visible[layer]) continue;
      var objs = by[layer];
      if (!objs || !objs.length) continue;
      var color = COLORS.layers[layer];
      var zones = [], rest = [];
      for (var i = 0; i < objs.length; i++) (objs[i].type === TYPE.ZONE ? zones : rest).push(objs[i]);
      var hasFilledZone = Lay6.COPPER_LAYERS[layer] &&
        zones.some(function (o) { return o.fill; });

      if (hasFilledZone) {
        // mask: white = keep zone, black = clearance, white spokes reconnect
        var id = "clr" + (++maskId);
        var m = ['<mask id="' + id + '" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000">'];
        m.push('<rect x="-100000" y="-100000" width="200000" height="200000" fill="white"/>');
        for (i = 0; i < rest.length; i++) m.push(svgPunch(rest[i]));
        for (i = 0; i < rest.length; i++) {
          var o = rest[i];
          if ((o.type === TYPE.THT || o.type === TYPE.SMD) &&
              o.thermal && !o.cutoff && mm(o.groundDistance) > 0) {
            var spokes = thermalSpokes(o);
            for (var s = 0; s < spokes.length; s++) {
              m.push('<path d="' + spokes[s].d + '" fill="none" stroke="white" stroke-width="' +
                fmt(spokes[s].width) + '"/>');
            }
          }
        }
        m.push("</mask>");
        defs.push(m.join(""));
        parts.push('<g mask="url(#' + id + ')">');
        for (i = 0; i < zones.length; i++) parts.push(svgObject(zones[i], color));
        parts.push("</g>");
        for (i = 0; i < rest.length; i++) parts.push(svgObject(rest[i], color));
      } else {
        for (i = 0; i < objs.length; i++) parts.push(svgObject(objs[i], color));
      }
    }

    // drills
    var items = buildRenderList(board);
    for (var di = 0; di < items.length; di++) {
      var od = items[di].o;
      if (od.type === TYPE.THT && visible[od.layer] && mm(od.in) > 0) {
        parts.push('<circle cx="' + fmt(mm(od.x)) + '" cy="' + fmt(mm(od.y)) + '" r="' + fmt(mm(od.in)) +
          '" fill="' + COLORS.hole + '"/>');
      }
    }

    parts.push("</g>");
    if (defs.length) parts.splice(1, 0, "<defs>" + defs.join("") + "</defs>");
    parts.push("</svg>");
    return parts.join("\n");
  }

  return {
    COLORS: COLORS,
    renderToCanvas: renderToCanvas,
    renderToSVG: renderToSVG,
    buildRenderList: buildRenderList,
    mm: mm,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Lay6Render;
}
