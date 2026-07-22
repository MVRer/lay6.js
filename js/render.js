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
    bg: "#0e1013",
    board: "#161a20",
    hole: "#0b0d10",
    dimOutside: "rgba(14, 16, 19, 0.62)",
    measure: "#e2688b",
    // Bright colour used for traces, pads, arcs and outlines — the objects
    // that must stand out.
    layers: {
      1: "#5b9bff", // C1 copper top
      2: "#e6eaf0", // S1 silk top
      3: "#4bbd82", // C2 copper bottom
      4: "#c9ba6e", // S2 silk bottom
      5: "#e0824a", // I1
      6: "#b878cc", // I2
      7: "#e6bd4a", // O outline
    },
    // Muted copper-pour colour, drawn UNDER the bright objects so a filled
    // zone reads as a background wash and the tracks/pads on it stay legible.
    // Only copper layers can carry filled zones.
    pour: {
      1: "#254a80", // C1 pour
      3: "#1f5a42", // C2 pour
      5: "#6e4127", // I1 pour
      6: "#5a3d66", // I2 pour
    },
  };

  // The wash colour for a filled zone on a given layer; falls back to a
  // dimmed trace colour when no dedicated pour tone exists.
  function pourColor(layer) {
    return COLORS.pour[layer] || COLORS.layers[layer];
  }

  function mm(u) {
    return u / 10000;
  }
  // File y coordinates run downward from the board's bottom-left origin,
  // so board content spans -size_y..0. Geometry stays in file space; the
  // view transform shifts everything down by the board height (view.oy).
  // A sign flip here would mirror glyph strokes vertically.
  function fy(u) {
    return u / 10000;
  }
  function mapPoints(pts) {
    return pts.map(function (p) {
      return { x: mm(p.x), y: fy(p.y) };
    });
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
    var x = mm(o.x), y = fy(o.y), r = mm(o.out) + e;
    var rot = deg(o.rotation);
    if (o.thtShape === 3) return rotatedRect(x, y, r, r, rot);
    if (o.thtShape === 2) return octagonD(x, y, r, rot);
    return circleD(x, y, r);
  }

  // The pad's corner polygon (when present) is authoritative: the x/y
  // anchor of SMD pads in real files is frequently stale while the points
  // sit at the true position. Dilation for e > 0 on polygon pads is done
  // by the callers with an additional stroke.
  function smdPadD(o, e) {
    if (o.points && o.points.length >= 3) return polygonD(mapPoints(o.points));
    return rotatedRect(mm(o.x), fy(o.y), mm(o.out) / 2 + e, mm(o.in) / 2 + e, deg(o.rotation));
  }
  function smdIsPoly(o) {
    return !!(o.points && o.points.length >= 3);
  }

  // Circle object: annulus or partial arc band.
  // out = inner radius, in = outer radius, startAngle/lineWidth = start/end
  // angles in 1/1000 degree. Equal angles mean a full ring.
  function circleBandD(o, e) {
    e = e || 0;
    var cx = mm(o.x), cy = fy(o.y);
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
    var cx = mm(o.x), cy = fy(o.y);
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
    function typeZ(t) {
      return Lay6.TYPE_Z[t] !== undefined ? Lay6.TYPE_Z[t] : 2;
    }
    items.sort(function (a, b) {
      return (layerZ(a.o.layer) - layerZ(b.o.layer)) ||
        (typeZ(a.o.type) - typeZ(b.o.type)) ||
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

  // Adaptive board grid: the finest step of 0.1/0.5/1/5/10 mm that stays
  // at least ~11 screen pixels apart, with a stronger line every 5 steps.
  function drawGrid(ctx, board, view) {
    var steps = [0.1, 0.5, 1, 5, 10];
    var step = 10;
    for (var s = 0; s < steps.length; s++) {
      if (steps[s] * view.scale >= 11) {
        step = steps[s];
        break;
      }
    }
    var W = mm(board.sizeX), H = mm(board.sizeY);
    ctx.lineWidth = 1 / view.scale;
    var n, i, v;
    for (var pass = 0; pass < 2; pass++) {
      var major = pass === 1;
      ctx.strokeStyle = major ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.045)";
      ctx.beginPath();
      n = Math.floor(W / step);
      for (i = 0; i <= n; i++) {
        if ((i % 5 === 0) !== major) continue;
        v = i * step;
        ctx.moveTo(v, -H);
        ctx.lineTo(v, 0);
      }
      n = Math.floor(H / step);
      for (i = 0; i <= n; i++) {
        if ((i % 5 === 0) !== major) continue;
        v = -H + i * step;
        ctx.moveTo(0, v);
        ctx.lineTo(W, v);
      }
      ctx.stroke();
    }
  }

  // Current view state, tracked at the single applyView choke point so the
  // low-level drawers can honour the on-screen scale (for a device-pixel
  // stroke floor) and the mirror flag (to keep text readable) without every
  // caller threading them through.
  var viewScale = 1;
  var viewMirror = false;
  var svgMirror = false; // set per renderToSVG call (SVG has no live view state)
  var MIN_STROKE_PX = 1.1; // thinnest a trace/glyph is allowed to render

  function applyView(ctx, view) {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.mirror ? -view.scale : view.scale, view.scale);
    ctx.translate(0, view.oy || 0);
    viewScale = view.scale || 1;
    viewMirror = !!view.mirror;
  }

  function fillD(ctx, d, color) {
    ctx.fillStyle = color;
    ctx.fill(new Path2D(d), "evenodd");
  }

  // Keep a line at least MIN_STROKE_PX device pixels wide so hairline copper
  // and silkscreen glyph strokes stay visible at fit-to-board zoom.
  function strokeFloor(width) {
    return Math.max(width, MIN_STROKE_PX / viewScale, 0.02);
  }

  function strokePoly(ctx, o, color, width, closed) {
    if (!o.points || o.points.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeFloor(width);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(mm(o.points[0].x), fy(o.points[0].y));
    for (var i = 1; i < o.points.length; i++) ctx.lineTo(mm(o.points[i].x), fy(o.points[i].y));
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  // A text object's glyphs live in child track strokes; drawing the string
  // too would double-render. Components are the exception: their children are
  // pads/tracks and o.text is the reference designator, which we DO want.
  function textShouldDraw(o) {
    return !!(o.text) && (!(o.children && o.children.length) || !!o.component);
  }

  function drawText(ctx, o, color) {
    if (!textShouldDraw(o)) return;
    var lines = String(o.text).split(/\r\n|\r|\n/);
    var h = Math.max(mm(o.out), 0.4);
    ctx.save();
    ctx.translate(mm(o.x), fy(o.y));
    ctx.rotate(rad(-deg(o.rotation)));
    // The whole scene is x-flipped in mirror view; counter-flip here so
    // labels read forwards instead of backwards.
    if (viewMirror) ctx.scale(-1, 1);
    if (o.flipVertical) ctx.scale(-1, 1);
    ctx.fillStyle = color;
    ctx.font = h + "px system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, i * h * 1.2);
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
        if (!o.points || o.points.length < 3) break;
        if (o.fill) {
          // Muted wash so tracks/pads on the pour stay readable; a thin
          // bright edge keeps the zone boundary legible.
          fillD(ctx, polygonD(mapPoints(o.points)), pourColor(o.layer));
          strokePoly(ctx, o, color, Math.max(mm(o.lineWidth), 0.05), true);
        } else {
          strokePoly(ctx, o, color, mm(o.lineWidth), true);
        }
        break;
      case TYPE.TEXT:
        drawText(ctx, o, color);
        break;
      default:
        // Unknown object type read as a generic polygon: fill it when the
        // record asks for a fill, otherwise stroke it (closed if the outline
        // returns to its start) so it never silently disappears.
        if (o.points && o.points.length >= 3 && o.fill) {
          fillD(ctx, polygonD(mapPoints(o.points)), color);
        } else if (o.points && o.points.length) {
          strokePoly(ctx, o, color, mm(o.lineWidth), pointsClosed(o.points));
        }
    }
  }

  // True when a point list's first and last vertices coincide, i.e. it is an
  // already-closed outline.
  function pointsClosed(pts) {
    if (pts.length < 3) return false;
    var a = pts[0], b = pts[pts.length - 1];
    return a.x === b.x && a.y === b.y;
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
        var sd = smdPadD(o, e);
        fillD(ctx, sd, "#000");
        if (smdIsPoly(o) && e > 0) {
          ctx.strokeStyle = "#000";
          ctx.lineJoin = "round";
          ctx.lineWidth = 2 * e;
          ctx.stroke(new Path2D(sd));
        }
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

    view = {
      scale: view.scale, tx: view.tx, ty: view.ty,
      mirror: view.mirror, dpr: view.dpr, grid: view.grid,
      oy: mm(board.sizeY),
    };
    applyView(ctx, view);

    // board area (file space: y in -size_y..0)
    ctx.fillStyle = COLORS.board;
    ctx.fillRect(0, -mm(board.sizeY), mm(board.sizeX), mm(board.sizeY));

    if (view.grid) drawGrid(ctx, board, view);

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

    // fade everything parked outside the board outline so the board itself
    // stays the focus
    var W = mm(board.sizeX), H = mm(board.sizeY), B = 100000;
    ctx.fillStyle = COLORS.dimOutside;
    ctx.fill(new Path2D(
      "M " + -B + " " + -B + " L " + B + " " + -B + " L " + B + " " + B + " L " + -B + " " + B + " Z" +
      " M 0 " + fmt(-H) + " L " + fmt(W) + " " + fmt(-H) + " L " + fmt(W) + " 0 L 0 0 Z"
    ), "evenodd");

    // drill holes go through everything
    ctx.fillStyle = COLORS.hole;
    var items = buildRenderList(board);
    for (var di = 0; di < items.length; di++) {
      var o = items[di].o;
      if (o.type === TYPE.THT && visible[o.layer] && mm(o.in) > 0) {
        ctx.fill(new Path2D(circleD(mm(o.x), fy(o.y), mm(o.in))));
      }
    }
  }

  /* --------------------------- net tracing --------------------------- */

  var CONDUCTIVE = { 2: true, 6: true, 8: true };

  function padCenter(o) {
    if (o.type === TYPE.SMD && smdIsPoly(o)) {
      var sx = 0, sy = 0;
      for (var i = 0; i < o.points.length; i++) {
        sx += mm(o.points[i].x);
        sy += mm(o.points[i].y);
      }
      return { x: sx / o.points.length, y: sy / o.points.length };
    }
    return { x: mm(o.x), y: mm(o.y) };
  }

  function padRadius(o) {
    if (o.type === TYPE.THT) return mm(o.out);
    if (o.type === TYPE.SMD) {
      if (smdIsPoly(o)) {
        var c = padCenter(o), r = 0;
        for (var i = 0; i < o.points.length; i++) {
          r = Math.max(r, Math.hypot(mm(o.points[i].x) - c.x, mm(o.points[i].y) - c.y));
        }
        return r;
      }
      return Math.hypot(mm(o.out), mm(o.in)) / 2;
    }
    return 0;
  }

  function trackMinDist(o, px, py) {
    var best = Infinity;
    for (var s = 0; s + 1 < o.points.length; s++) {
      best = Math.min(best, distToSegment(px, py,
        mm(o.points[s].x), mm(o.points[s].y),
        mm(o.points[s + 1].x), mm(o.points[s + 1].y)));
    }
    return best;
  }

  // Distance between two segments, approximated by endpoint-to-segment
  // checks; good enough for touch detection at PCB scales.
  function segSegDist(ax, ay, bx, by, cx2, cy2, dx2, dy2) {
    return Math.min(
      distToSegment(ax, ay, cx2, cy2, dx2, dy2),
      distToSegment(bx, by, cx2, cy2, dx2, dy2),
      distToSegment(cx2, cy2, ax, ay, bx, by),
      distToSegment(dx2, dy2, ax, ay, bx, by));
  }

  function padPoly(o) {
    return o.type === TYPE.SMD && smdIsPoly(o) ? o.points : null;
  }

  function trackTouchesPoly(t, poly, halfW, eps) {
    var i, j;
    for (i = 0; i < t.points.length; i++) {
      if (pointInPolygon(mm(t.points[i].x), mm(t.points[i].y), poly)) return true;
    }
    for (i = 0; i + 1 < t.points.length; i++) {
      for (j = 0; j < poly.length; j++) {
        var k = (j + 1) % poly.length;
        if (segSegDist(
          mm(t.points[i].x), mm(t.points[i].y), mm(t.points[i + 1].x), mm(t.points[i + 1].y),
          mm(poly[j].x), mm(poly[j].y), mm(poly[k].x), mm(poly[k].y)) <= halfW + eps) return true;
      }
    }
    return false;
  }

  function conductorsTouch(a, b) {
    // THT pads are plated through, so they join nets across copper layers.
    if (a.layer !== b.layer && a.type !== TYPE.THT && b.type !== TYPE.THT) return false;
    var eps = 0.05;
    var i, j, k, l;
    var aTrack = a.type === TYPE.TRACK, bTrack = b.type === TYPE.TRACK;
    if (aTrack && bTrack) {
      if (!a.points || !b.points || !a.points.length || !b.points.length) return false;
      var th = mm(a.lineWidth) / 2 + mm(b.lineWidth) / 2 + eps;
      for (i = 0; i < a.points.length; i++) {
        if (trackMinDist(b, mm(a.points[i].x), mm(a.points[i].y)) <= th) return true;
      }
      for (j = 0; j < b.points.length; j++) {
        if (trackMinDist(a, mm(b.points[j].x), mm(b.points[j].y)) <= th) return true;
      }
      return false;
    }
    if (aTrack || bTrack) {
      var t = aTrack ? a : b, p = aTrack ? b : a;
      if (!t.points || !t.points.length) return false;
      var poly = padPoly(p);
      if (poly) return trackTouchesPoly(t, poly, mm(t.lineWidth) / 2, eps);
      var c = padCenter(p);
      return trackMinDist(t, c.x, c.y) <= mm(t.lineWidth) / 2 + padRadius(p) + eps;
    }
    // pad vs pad: use true polygon edges when available so long pads at
    // fine pitch don't get bridged by their circumscribed radius
    var pa = padPoly(a), pb = padPoly(b);
    var ca = padCenter(a), cb = padCenter(b);
    if (pa && pb) {
      if (pointInPolygon(cb.x, cb.y, pa) || pointInPolygon(ca.x, ca.y, pb)) return true;
      for (i = 0; i < pa.length; i++) {
        j = (i + 1) % pa.length;
        for (k = 0; k < pb.length; k++) {
          l = (k + 1) % pb.length;
          if (segSegDist(
            mm(pa[i].x), mm(pa[i].y), mm(pa[j].x), mm(pa[j].y),
            mm(pb[k].x), mm(pb[k].y), mm(pb[l].x), mm(pb[l].y)) <= eps) return true;
        }
      }
      return false;
    }
    if (pa || pb) {
      var poly2 = pa || pb;
      var oc = pa ? cb : ca;
      var or2 = padRadius(pa ? b : a);
      if (pointInPolygon(oc.x, oc.y, poly2)) return true;
      for (i = 0; i < poly2.length; i++) {
        j = (i + 1) % poly2.length;
        if (distToSegment(oc.x, oc.y, mm(poly2[i].x), mm(poly2[i].y),
            mm(poly2[j].x), mm(poly2[j].y)) <= or2 + eps) return true;
      }
      return false;
    }
    return Math.hypot(ca.x - cb.x, ca.y - cb.y) <= padRadius(a) + padRadius(b) + eps;
  }

  // Group all copper tracks/pads into electrically connected nets by
  // geometric contact, and attach nearby silkscreen labels to each net.
  // Approximate by nature (documented in the README): zones are excluded.
  function buildNets(board) {
    if (board._nets) return board._nets;
    var cond = [];
    var items = buildRenderList(board);
    for (var i = 0; i < items.length; i++) {
      var o = items[i].o;
      if (CONDUCTIVE[o.type] && Lay6.COPPER_LAYERS[o.layer]) cond.push(o);
    }
    var parent = [];
    for (i = 0; i < cond.length; i++) parent.push(i);
    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }
    for (i = 0; i < cond.length; i++) {
      for (var j = i + 1; j < cond.length; j++) {
        if (find(i) !== find(j) && conductorsTouch(cond[i], cond[j])) {
          parent[find(i)] = find(j);
        }
      }
    }
    var members = {};
    for (i = 0; i < cond.length; i++) {
      var root = find(i);
      cond[i]._netRoot = root;
      (members[root] || (members[root] = [])).push(cond[i]);
    }
    // nearby text labels: a label names a net when its anchor sits close
    // to one of the net's pads or track endpoints
    var texts = [];
    Lay6.walkObjects(board.objects, function (o) {
      if (o.type === TYPE.TEXT && o.text) {
        texts.push({ x: mm(o.x), y: fy(o.y), text: o.text });
      }
    });
    var labels = {};
    Object.keys(members).forEach(function (root) {
      var found = [];
      for (var t = 0; t < texts.length; t++) {
        var best = Infinity;
        var net = members[root];
        for (var m = 0; m < net.length; m++) {
          var o = net[m];
          if (o.type === TYPE.TRACK) {
            var pts = o.points || [];
            for (var e = 0; e < pts.length; e += Math.max(1, pts.length - 1)) {
              best = Math.min(best,
                Math.hypot(texts[t].x - mm(pts[e].x), texts[t].y - mm(pts[e].y)));
            }
          } else {
            var c = padCenter(o);
            best = Math.min(best, Math.hypot(texts[t].x - c.x, texts[t].y - c.y));
          }
        }
        if (best < 2.0) found.push({ text: texts[t].text, d: best });
      }
      found.sort(function (a, b) { return a.d - b.d; });
      var uniq = [];
      found.forEach(function (f) {
        if (uniq.indexOf(f.text) === -1) uniq.push(f.text);
      });
      labels[root] = uniq;
    });
    board._nets = { members: members, labels: labels };
    return board._nets;
  }

  /* -------------------- hover highlight & hit test ------------------- */

  var HL_FILL = "rgba(255, 214, 106, 0.4)";
  var HL_STROKE = "#ffd76a";
  var HL_FILL_SOFT = "rgba(255, 214, 106, 0.18)";
  var HL_STROKE_SOFT = "rgba(255, 214, 106, 0.6)";

  // Draw a halo around one object on top of the finished render.
  // soft = true renders the dimmer style used for other net members.
  function highlightObject(ctx, board, o, view, soft) {
    view = {
      scale: view.scale, tx: view.tx, ty: view.ty,
      mirror: view.mirror, dpr: view.dpr,
      oy: mm(board.sizeY),
    };
    ctx.save();
    applyView(ctx, view);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    var fill = soft ? HL_FILL_SOFT : HL_FILL;
    var stroke = soft ? HL_STROKE_SOFT : HL_STROKE;
    function outline(d) {
      var p = new Path2D(d);
      ctx.fillStyle = fill;
      ctx.fill(p, "evenodd");
      ctx.strokeStyle = stroke;
      ctx.lineWidth = (soft ? 1.25 : 2) / view.scale;
      ctx.stroke(p);
    }
    switch (o.type) {
      case TYPE.THT:
        outline(thtPadD(o, 0));
        break;
      case TYPE.SMD:
        outline(smdPadD(o, 0));
        break;
      case TYPE.CIRCLE:
        var d = circleBandD(o, 0);
        if (d) outline(d);
        break;
      case TYPE.TRACK:
      default:
        if (o.points && o.points.length) {
          strokePoly(ctx, o, soft ? "rgba(255, 214, 106, 0.3)" : "rgba(255, 214, 106, 0.55)",
            mm(o.lineWidth) + (soft ? 2.5 : 4) / view.scale, false);
          strokePoly(ctx, o, stroke, Math.max(mm(o.lineWidth) * 0.4, 1 / view.scale), false);
        }
        break;
      case TYPE.ZONE:
        if (o.points && o.points.length >= 2) {
          strokePoly(ctx, o, stroke, Math.max(mm(o.lineWidth), 2 / view.scale), true);
        }
        break;
    }
    ctx.restore();
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var qx = ax + t * dx, qy = ay + t * dy;
    return Math.hypot(px - qx, py - qy);
  }

  function pointInPolygon(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = mm(pts[i].x), yi = mm(pts[i].y);
      var xj = mm(pts[j].x), yj = mm(pts[j].y);
      if ((yi > py) !== (yj > py) &&
          px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Find the topmost visible object at file coordinates (fx, fyv) in mm.
  function hitTest(board, fx, fyv, tol, visible) {
    var items = buildRenderList(board);
    for (var i = items.length - 1; i >= 0; i--) {
      var o = items[i].o;
      if (!visible[o.layer]) continue;
      if (o.type === TYPE.TEXT) continue; // children are hit individually
      var dx, dy, d;
      if (o.type === TYPE.THT) {
        if (Math.hypot(fx - mm(o.x), fyv - mm(o.y)) <= mm(o.out) + tol) return o;
      } else if (o.type === TYPE.SMD) {
        if (smdIsPoly(o)) {
          if (pointInPolygon(fx, fyv, o.points)) return o;
          continue;
        }
        dx = fx - mm(o.x);
        dy = fyv - mm(o.y);
        var r = rad(-deg(o.rotation));
        var lx = dx * Math.cos(r) + dy * Math.sin(r);
        var ly = -dx * Math.sin(r) + dy * Math.cos(r);
        if (Math.abs(lx) <= mm(o.out) / 2 + tol && Math.abs(ly) <= mm(o.in) / 2 + tol) return o;
      } else if (o.type === TYPE.CIRCLE) {
        d = Math.hypot(fx - mm(o.x), fyv - mm(o.y));
        if (d >= mm(o.out) - tol && d <= mm(o.in) + tol) return o;
      } else if (o.type === TYPE.ZONE) {
        if (!o.points || o.points.length < 3) continue;
        if (o.fill && pointInPolygon(fx, fyv, o.points)) return o;
        if (!o.fill) {
          for (var z = 0; z < o.points.length; z++) {
            var zn = o.points[(z + 1) % o.points.length];
            if (distToSegment(fx, fyv, mm(o.points[z].x), mm(o.points[z].y),
                mm(zn.x), mm(zn.y)) <= mm(o.lineWidth) / 2 + tol) return o;
          }
        }
      } else if (o.points && o.points.length) {
        var half = mm(o.lineWidth) / 2 + tol;
        for (var s = 0; s + 1 < o.points.length; s++) {
          if (distToSegment(fx, fyv, mm(o.points[s].x), mm(o.points[s].y),
              mm(o.points[s + 1].x), mm(o.points[s + 1].y)) <= half) return o;
        }
      }
    }
    return null;
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
        return '<path d="' + polylineD(mapPoints(o.points)) +
          '" fill="none" stroke="' + color + '" stroke-width="' + fmt(Math.max(mm(o.lineWidth), 0.02)) +
          '" stroke-linecap="round" stroke-linejoin="round"/>';
      case TYPE.ZONE:
        if (!o.points || o.points.length < 3) return "";
        var zd = polygonD(mapPoints(o.points));
        if (o.fill) return '<path d="' + zd + '" fill="' + pourColor(o.layer) +
          '" stroke="' + color + '" stroke-width="' + fmt(Math.max(mm(o.lineWidth), 0.05)) +
          '" stroke-linejoin="round"/>';
        return '<path d="' + zd + '" fill="none" stroke="' + color +
          '" stroke-width="' + fmt(Math.max(mm(o.lineWidth), 0.02)) + '" stroke-linejoin="round"/>';
      case TYPE.TEXT:
        if (!textShouldDraw(o)) return "";
        var h = Math.max(mm(o.out), 0.4);
        // Counter-flip glyphs in mirror view so labels stay readable; a flip
        // plus a mirror cancel out, matching the canvas.
        var flip = (svgMirror ? 1 : 0) ^ (o.flipVertical ? 1 : 0);
        var tf = "translate(" + fmt(mm(o.x)) + " " + fmt(fy(o.y)) + ") rotate(" + fmt(-deg(o.rotation)) + ")" +
          (flip ? " scale(-1 1)" : "");
        var lines = String(o.text).split(/\r\n|\r|\n/);
        var spans = lines.map(function (ln, i) {
          return '<tspan x="0" dy="' + (i === 0 ? "0" : fmt(h * 1.2)) + '">' + esc(ln) + "</tspan>";
        }).join("");
        return '<text transform="' + tf + '" font-size="' + fmt(h) +
          '" font-family="sans-serif" fill="' + color + '">' + spans + "</text>";
      default:
        if (o.points && o.points.length >= 3 && o.fill) {
          return '<path d="' + polygonD(mapPoints(o.points)) + '" fill="' + color + '"/>';
        }
        if (o.points && o.points.length) {
          var dd = pointsClosed(o.points) ? polygonD(mapPoints(o.points)) : polylineD(mapPoints(o.points));
          return '<path d="' + dd + '" fill="none" stroke="' + color +
            '" stroke-width="' + fmt(Math.max(mm(o.lineWidth), 0.02)) + '" stroke-linejoin="round"/>';
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
        return '<path d="' + smdPadD(o, e) + '" fill="black"' +
          (smdIsPoly(o) && e > 0
            ? ' stroke="black" stroke-width="' + fmt(2 * e) + '" stroke-linejoin="round"'
            : "") + '/>';
      case TYPE.TRACK:
        if (!o.points || !o.points.length) return "";
        return '<path d="' + polylineD(mapPoints(o.points)) +
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
    svgMirror = !!view.mirror;
    var maskId = 0;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + widthPx + '" height="' + heightPx +
      '" viewBox="0 0 ' + widthPx + " " + heightPx + '">');
    parts.push('<rect width="100%" height="100%" fill="' + COLORS.bg + '"/>');
    var tf = "translate(" + fmt(view.tx) + " " + fmt(view.ty) + ") scale(" +
      fmt(view.mirror ? -view.scale : view.scale) + " " + fmt(view.scale) +
      ") translate(0 " + fmt(mm(board.sizeY)) + ")";
    parts.push('<g transform="' + tf + '">');
    parts.push('<rect x="0" y="' + fmt(-mm(board.sizeY)) + '" width="' + fmt(mm(board.sizeX)) +
      '" height="' + fmt(mm(board.sizeY)) + '" fill="' + COLORS.board + '"/>');

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
        parts.push('<circle cx="' + fmt(mm(od.x)) + '" cy="' + fmt(fy(od.y)) + '" r="' + fmt(mm(od.in)) +
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
    buildNets: buildNets,
    highlightObject: highlightObject,
    hitTest: hitTest,
    mm: mm,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Lay6Render;
}
