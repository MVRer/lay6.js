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
    if (prev.layer === cur.layer) {
      assert.ok((Lay6.TYPE_Z[prev.type] || 2) <= (Lay6.TYPE_Z[cur.type] || 2),
        `type order within layer at ${i}`);
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

test("SVG export: mirrored view flips the x scale", () => {
  const board = demoDoc().boards[0];
  const svg = Lay6Render.renderToSVG(board, { scale: 10, tx: 500, ty: 0, mirror: true }, 800, 600, ALL_VISIBLE);
  assert.match(svg, /scale\(-10 10\)/);
});
