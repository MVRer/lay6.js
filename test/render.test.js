"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

// render.js expects the Lay6 global the browser gets from a script tag.
global.Lay6 = require("../js/lay6.js");
const Lay6Render = require("../js/render.js");
const gen = require("./genlay6.js");

const ALL_VISIBLE = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true };
const VIEW = { scale: 10, tx: 0, ty: 0, mirror: false };

function demoDoc() {
  return Lay6.parse(gen.fixtures()["simple.lay6"]);
}

test("render list sorts by layer z-order first, then type", () => {
  const board = demoDoc().boards[0];
  const items = Lay6Render.buildRenderList(board);
  const zOf = (l) => Lay6.LAYER_Z_ORDER.indexOf(l);
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1].o, cur = items[i].o;
    assert.ok(zOf(prev.layer) <= zOf(cur.layer), `layer order at ${i}`);
    const tz = (t) => (Lay6.TYPE_Z[t] !== undefined ? Lay6.TYPE_Z[t] : 2);
    if (prev.layer === cur.layer) {
      assert.ok(tz(prev.type) <= tz(cur.type), `type order within layer at ${i}`);
    }
  }
  // zones must come before pads on the same layer so pads stay visible
  const layer1 = items.filter((i) => i.o.layer === 1).map((i) => i.o.type);
  assert.ok(layer1.indexOf(4) < layer1.indexOf(2), "zone before THT pad");
});

test("SVG export emits a clearance mask with thermal spokes", () => {
  const board = demoDoc().boards[0];
  const svg = Lay6Render.renderToSVG(board, VIEW, 800, 600, ALL_VISIBLE);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<mask id="clr1"/); // filled zone on copper → mask
  assert.match(svg, /mask="url\(#clr1\)"/);
  // thermal pad contributes 4 white spoke strokes to the mask
  const spokes = svg.match(/stroke="white"/g) || [];
  assert.ok(spokes.length >= 4, "at least 4 thermal spokes, got " + spokes.length);
  // black punches for pads/tracks with ground distance
  assert.ok((svg.match(/fill="black"/g) || []).length >= 2, "clearance punches present");
});

test("SVG export honours layer visibility", () => {
  const board = demoDoc().boards[0];
  const only7 = { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false, 7: true };
  const svg = Lay6Render.renderToSVG(board, VIEW, 800, 600, only7);
  assert.ok(!svg.includes("<mask"), "no copper => no clearance mask");
  assert.ok(svg.includes(Lay6Render.COLORS.layers[7]), "outline color present");
  assert.ok(!svg.includes(Lay6Render.COLORS.layers[1]), "copper color absent");
});

test("SVG export: outline-only zone strokes instead of filling", () => {
  const board = demoDoc().boards[0];
  const svg = Lay6Render.renderToSVG(board, VIEW, 800, 600, ALL_VISIBLE);
  const c2 = Lay6Render.COLORS.layers[3];
  const strokedZone = new RegExp('fill="none" stroke="' + c2 + '"');
  assert.match(svg, strokedZone);
});

test("SVG export: full ring and partial arc band paths", () => {
  const doc = demoDoc();
  const circles = [];
  Lay6.walkObjects(doc.boards[0].objects, (o) => {
    if (o.type === 5) circles.push(o);
  });
  const svg = Lay6Render.renderToSVG(doc.boards[0], VIEW, 800, 600, ALL_VISIBLE);
  // both circles render as filled paths with arc commands, never strokes
  // scaled by the bogus "line width" (which is really the end angle)
  assert.ok(!svg.includes('stroke-width="' + (270000 / 10000) + '"'),
    "arc end angle must not leak into a stroke width");
  const evenodd = (svg.match(/fill-rule="evenodd"/g) || []).length;
  assert.ok(evenodd >= 1, "full ring uses even-odd annulus");
});

test("SMD pads render from their corner polygon, not the stale anchor", () => {
  // Real files often carry a bogus x/y anchor on SMD pads while the point
  // list holds the true rectangle.
  const buf = gen.generate({
    boards: [{
      name: "smd", sizeX: 300000, sizeY: 300000,
      objects: [{
        type: 8, layer: 1, x: 5000000, y: 5000000, out: 15000, in: 40000,
        points: [
          { x: 100000, y: 100000 }, { x: 115000, y: 100000 },
          { x: 115000, y: 140000 }, { x: 100000, y: 140000 },
        ],
        connections: [],
      }],
    }],
    trailer: {},
  });
  const board = Lay6.parse(buf).boards[0];
  const svg = Lay6Render.renderToSVG(board, VIEW, 800, 600, ALL_VISIBLE);
  assert.ok(svg.includes("M 10 -10"), "pad drawn at its polygon corners");
  assert.ok(!svg.includes("M 500"), "stale anchor position not drawn");
  // hit test agrees with the polygon, not the anchor
  const hitPoly = Lay6Render.hitTest(board, 10.7, -12, 0.1, ALL_VISIBLE);
  assert.equal(hitPoly && hitPoly.type, 8);
  assert.equal(Lay6Render.hitTest(board, 500, -500, 0.1, ALL_VISIBLE), null);
});

test("hitTest finds tracks by segment distance and respects visibility", () => {
  const board = demoDoc().boards[0];
  // demo track runs from (8,8) to (8,16) to (24,16) bottom-up mm => file y negative
  const hit = Lay6Render.hitTest(board, 16, -16, 0.3, ALL_VISIBLE);
  assert.equal(hit && hit.type, 6);
  const none = Lay6Render.hitTest(board, 16, -16, 0.3,
    { 1: false, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true });
  assert.ok(!none || none.layer !== 1, "hidden layer is not hit");
});

test("SVG export: base Y is inverted; mirror flips X too", () => {
  const board = demoDoc().boards[0];
  // Y is always negated (board Y up -> screen Y down); mirror negates X as well.
  const plain = Lay6Render.renderToSVG(board, { scale: 10, tx: 0, ty: 0, mirror: false }, 800, 600, ALL_VISIBLE);
  assert.match(plain, /scale\(10 -10\)/);
  const mirrored = Lay6Render.renderToSVG(board, { scale: 10, tx: 500, ty: 0, mirror: true }, 800, 600, ALL_VISIBLE);
  assert.match(mirrored, /scale\(-10 -10\)/);
});

test("SVG export applies a rotation transform when the view is rotated", () => {
  const board = demoDoc().boards[0];
  // Check the view's own group transform, not text-element rotations.
  const plain = Lay6Render.renderToSVG(board, VIEW, 800, 600, ALL_VISIBLE);
  assert.match(plain, /<g transform="translate\([^)]*\) scale\(/, "no view rotation at rot 0");
  const rotated = Lay6Render.renderToSVG(board, { scale: 10, tx: 0, ty: 0, mirror: false, rot: 90 }, 800, 600, ALL_VISIBLE);
  assert.match(rotated, /<g transform="translate\([^)]*\) rotate\(90\) scale\(/, "rotate composes between translate and scale");
});

test("filled copper zone renders in the muted pour colour, distinct from traces", () => {
  const board = demoDoc().boards[0];
  const svg = Lay6Render.renderToSVG(board, VIEW, 800, 600, ALL_VISIBLE);
  const trace = Lay6Render.COLORS.layers[1];
  const pour = Lay6Render.COLORS.pour[1];
  assert.ok(pour && pour !== trace, "copper pour colour differs from the trace colour");
  // the filled top-copper zone paints with the pour fill and a bright edge
  assert.match(svg, new RegExp('fill="' + pour + '" stroke="' + trace + '"'));
});

test("component reference designator is drawn even though it has children", () => {
  // The demo's R1 component owns child pads/tracks AND a label; the label
  // must still render (it is not a glyph-stroke container).
  const board = demoDoc().boards[0];
  const svg = Lay6Render.renderToSVG(board, VIEW, 800, 600, ALL_VISIBLE);
  assert.match(svg, /<text[^>]*>(?:<tspan[^>]*>)?R1/);
});

test("multi-line text emits one tspan per line; mirror keeps it readable", () => {
  const buf = gen.generate({
    boards: [{
      name: "t", sizeX: 100000, sizeY: 100000,
      objects: [{ type: 7, layer: 2, x: 10000, y: 50000, out: 20000, text: "AA\nBB", children: [] }],
    }],
    trailer: {},
  });
  const board = Lay6.parse(buf).boards[0];
  const plain = Lay6Render.renderToSVG(board, VIEW, 400, 400, ALL_VISIBLE);
  assert.equal((plain.match(/<tspan/g) || []).length, 2, "two lines => two tspans");
  const mirrored = Lay6Render.renderToSVG(board, { scale: 5, tx: 0, ty: 0, mirror: true }, 400, 400, ALL_VISIBLE);
  // Y is always counter-flipped; mirror adds the X counter-flip => scale(-1 -1).
  assert.match(mirrored, /<text[^>]*scale\(-1 -1\)/, "mirror counter-flips the glyphs");
});

test("unknown object type with a closed filled outline is filled, not a hairline", () => {
  const buf = gen.generate({
    boards: [{
      name: "x", sizeX: 100000, sizeY: 100000,
      objects: [{
        type: 9, layer: 1, fill: true,
        points: [{ x: 10000, y: 10000 }, { x: 40000, y: 10000 }, { x: 40000, y: 40000 }],
      }],
    }],
    trailer: {},
  });
  const board = Lay6.parse(buf).boards[0];
  const svg = Lay6Render.renderToSVG(board, VIEW, 400, 400, ALL_VISIBLE);
  const c = Lay6Render.COLORS.layers[1];
  assert.match(svg, new RegExp('fill="' + c + '"[^>]*/>'), "generic filled polygon is painted");
});
