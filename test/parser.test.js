"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Lay6 = require("../js/lay6.js");
const gen = require("./genlay6.js");

const FIXTURE_DIR = path.join(__dirname, "fixtures");

// Prefer the committed fixture files; fall back to in-memory generation so
// the suite also runs on a fresh checkout before `node test/make-fixtures.js`.
function fixture(name) {
  const p = path.join(FIXTURE_DIR, name);
  if (fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
  return gen.fixtures()[name];
}

test("committed fixtures are byte-identical to the generator output", () => {
  const generated = gen.fixtures();
  for (const name of Object.keys(generated)) {
    const p = path.join(FIXTURE_DIR, name);
    if (!fs.existsSync(p)) continue;
    assert.deepEqual(new Uint8Array(fs.readFileSync(p)), generated[name], name);
  }
});

test("simple fixture: consumes the buffer to the last byte", () => {
  const buf = fixture("simple.lay6");
  const doc = Lay6.parse(buf);
  assert.equal(doc.consumed, doc.byteLength);
  assert.equal(doc.byteLength, buf.byteLength);
  assert.deepEqual(doc.diagnostics, []);
});

test("simple fixture: board dimensions and header fields", () => {
  const doc = Lay6.parse(fixture("simple.lay6"));
  assert.equal(doc.boards.length, 1);
  const b = doc.boards[0];
  assert.equal(b.name, "demo board");
  assert.equal(Lay6.toMM(b.sizeX), 50);
  assert.equal(Lay6.toMM(b.sizeY), 30);
  assert.equal(b.grid, 1.27);
  assert.equal(b.activeLayer, 1);
  // layer_visible[7] must survive the parse (bug 6)
  assert.deepEqual(b.layerVisible, [true, true, true, false, false, false, true]);
  assert.equal(b.isMultilayer, false);
  assert.equal(Lay6.toMM(b.centerX), 25);
  assert.equal(Lay6.toMM(b.centerY), 15);
});

test("simple fixture: object type histogram (flattened over children)", () => {
  const doc = Lay6.parse(fixture("simple.lay6"));
  const h = Lay6.histogram(doc.boards[0]);
  assert.deepEqual(h, {
    "THT pad": 3, // 2 top-level + 1 component child
    "SMD pad": 2, // 1 top-level + 1 component child
    "zone": 2,
    "circle": 2,
    "track": 3, // 2 top-level + 1 component child
    "text": 2, // free text + component container
  });
});

test("simple fixture: circle fields keep angle/radius semantics", () => {
  const doc = Lay6.parse(fixture("simple.lay6"));
  const circles = [];
  Lay6.walkObjects(doc.boards[0].objects, (o) => {
    if (o.type === Lay6.TYPE.CIRCLE) circles.push(o);
  });
  assert.equal(circles.length, 2);
  const arc = circles.find((c) => c.startAngle !== c.lineWidth);
  // For circles, lineWidth is the arc END angle, not a stroke width.
  assert.equal(Lay6.toDeg(arc.startAngle), 90);
  assert.equal(Lay6.toDeg(arc.lineWidth), 270);
  assert.equal(Lay6.toMM(arc.out), 0.8); // inner radius
  assert.equal(Lay6.toMM(arc.in), 1.2); // outer radius
});

test("simple fixture: rotation, thermal, cutoff and fill flags survive", () => {
  const doc = Lay6.parse(fixture("simple.lay6"));
  const b = doc.boards[0];
  const squarePad = b.objects.find((o) => o.type === 2 && o.thtShape === 3);
  assert.equal(Lay6.toDeg(squarePad.rotation), 30);
  assert.equal(squarePad.cutoff, true);
  const roundPad = b.objects.find((o) => o.type === 2 && o.thtShape === 1);
  assert.equal(roundPad.thermal, true);
  assert.equal(Lay6.toMM(roundPad.groundDistance), 0.4);
  const zones = b.objects.filter((o) => o.type === 4);
  assert.deepEqual(zones.map((z) => z.fill), [true, false]);
  const smd = b.objects.find((o) => o.type === 8 && !o.isChild);
  assert.equal(Lay6.toDeg(smd.rotation), 45);
});

test("simple fixture: component children skip the varstr tail, record parses", () => {
  const doc = Lay6.parse(fixture("simple.lay6"));
  const comp = doc.boards[0].objects.find((o) => o.type === 7 && o.thtShape === 1);
  assert.ok(comp, "component object present");
  assert.equal(comp.text, "R1");
  assert.equal(comp.children.length, 3);
  assert.ok(comp.children.every((c) => c.isChild));
  assert.ok(comp.children.every((c) => c.text === "" && c.groups.length === 0));
  assert.equal(comp.component.package, "R-10mm");
  assert.equal(comp.component.comment, "demo part");
  assert.equal(comp.component.use, 1);
});

test("simple fixture: one connection block per pad, document order", () => {
  const doc = Lay6.parse(fixture("simple.lay6"));
  const pads = Lay6.collectPads(doc.boards[0].objects);
  assert.equal(pads.length, 5);
  assert.ok(pads.every((p) => Array.isArray(p.connections)));
  assert.deepEqual(pads[0].connections, [4]); // thermal THT pad
});

test("simple fixture: trailer round-trips", () => {
  const doc = Lay6.parse(fixture("simple.lay6"));
  assert.equal(doc.trailer.activeTab, 0);
  assert.equal(doc.trailer.project, "demo");
  assert.equal(doc.trailer.author, "tests");
  assert.equal(doc.trailer.comment, "synthetic fixture");
});

test("multi fixture: two boards, full consumption, per-board histograms", () => {
  const buf = fixture("multi.lay6");
  const doc = Lay6.parse(buf);
  assert.equal(doc.consumed, buf.byteLength);
  assert.equal(doc.boards.length, 2);
  assert.equal(doc.trailer.activeTab, 1);
  assert.equal(Lay6.toMM(doc.boards[1].sizeX), 20);
  assert.equal(Lay6.toMM(doc.boards[1].sizeY), 10);
  assert.deepEqual(Lay6.histogram(doc.boards[1]), { track: 1, "THT pad": 1 });
});

test("encoding: re-decode without reparsing fixes Cyrillic names", () => {
  const doc = Lay6.parse(fixture("multi.lay6"));
  const before = doc.boards[1].name; // decoded as windows-1252 by default
  assert.notEqual(before, "Плата");
  Lay6.decodeStrings(doc, "windows-1251");
  assert.equal(doc.boards[1].name, "Плата");
  Lay6.decodeStrings(doc, "windows-1252");
  assert.equal(doc.boards[1].name, before);
});

test("empty fixture: zero objects still parses to the last byte", () => {
  const buf = fixture("empty.lay6");
  const doc = Lay6.parse(buf);
  assert.equal(doc.consumed, buf.byteLength);
  assert.equal(doc.boards[0].objects.length, 0);
});

/* --------------------------- failure modes ------------------------- */

test("bad magic produces a specific signature error", () => {
  const buf = fixture("simple.lay6").slice();
  buf[0] = 0x50;
  assert.throws(() => Lay6.parse(buf), (e) => {
    assert.ok(e instanceof Lay6.Lay6Error);
    assert.match(e.message, /signature/i);
    assert.match(e.message, /06 33 AA FF/);
    return true;
  });
});

test("tiny file produces a too-small error, not a magic error", () => {
  assert.throws(() => Lay6.parse(new Uint8Array([0x06, 0x33, 0xaa])), (e) => {
    assert.match(e.message, /too small/i);
    return true;
  });
});

test("truncation anywhere in the file names what was being read", () => {
  const full = fixture("simple.lay6");
  // Chop at several structurally interesting places plus a sweep.
  const cuts = [6, 100, Lay6.BOARD_HEADER_SIZE + 8 + 20, full.byteLength - 3, full.byteLength - 60];
  for (let i = 8; i < full.byteLength - 1; i += 97) cuts.push(i);
  for (const cut of cuts) {
    assert.throws(() => Lay6.parse(full.slice(0, cut)), (e) => {
      assert.ok(e instanceof Lay6.Lay6Error, `cut at ${cut} throws Lay6Error`);
      assert.match(e.message, /Truncated|Implausible|too small/i, `cut at ${cut}: ${e.message}`);
      return true;
    });
  }
});

test("absurd board count is rejected with a specific message", () => {
  const buf = fixture("simple.lay6").slice();
  new DataView(buf.buffer).setUint32(4, 0xfffffff0, true);
  assert.throws(() => Lay6.parse(buf), /board count/i);
});

test("absurd object count is rejected with a specific message", () => {
  const buf = fixture("simple.lay6").slice();
  new DataView(buf.buffer).setUint32(8 + 0x212, 0x7fffffff, true);
  assert.throws(() => Lay6.parse(buf), /object count/i);
});

test("absurd point count is rejected with a specific message", () => {
  // zone is the first object: record starts right after the board header,
  // its varstr tail is 12 bytes (two empty strings + group count).
  const buf = fixture("simple.lay6").slice();
  const pointCountAt = 8 + Lay6.BOARD_HEADER_SIZE + Lay6.OBJECT_RECORD_SIZE + 12;
  new DataView(buf.buffer).setUint32(pointCountAt, 0x7fffffff, true);
  assert.throws(() => Lay6.parse(buf), /point count/i);
});

test("trailing garbage surfaces as a diagnostic, not a silent pass", () => {
  const base = fixture("simple.lay6");
  const buf = new Uint8Array(base.byteLength + 16);
  buf.set(base);
  const doc = Lay6.parse(buf);
  assert.equal(doc.consumed, base.byteLength);
  assert.equal(doc.diagnostics.length, 1);
  assert.match(doc.diagnostics[0].message, /16 unexpected trailing byte/);
});

test("unknown object type parses as generic polygon and warns", () => {
  const buf = gen.generate({
    boards: [{
      name: "x", sizeX: 10000, sizeY: 10000,
      objects: [{ type: 3, layer: 1, points: [{ x: 1, y: 2 }] }],
    }],
    trailer: {},
  });
  const doc = Lay6.parse(buf);
  assert.equal(doc.consumed, buf.byteLength);
  assert.ok(doc.diagnostics.some((d) => /unknown object type 3/i.test(d.message)));
  assert.equal(doc.boards[0].objects[0].points.length, 1);
});

test("generator sanity: sizes are deterministic", () => {
  const a = gen.fixtures();
  const b = gen.fixtures();
  for (const name of Object.keys(a)) {
    assert.deepEqual(a[name], b[name], name);
  }
});
