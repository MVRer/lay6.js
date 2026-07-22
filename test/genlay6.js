/*
 * Synthetic .lay6 generator for tests and demo fixtures.
 * Produces byte-exact files matching the layout js/lay6.js parses, so
 * fixtures can live in the repo without shipping anyone's real designs.
 */
"use strict";

var BOARD_HEADER_SIZE = 0x216;
var OBJECT_RECORD_SIZE = 0x4d;

function Writer() {
  this.chunks = [];
  this.length = 0;
}
Writer.prototype = {
  push: function (u8) {
    this.chunks.push(u8);
    this.length += u8.length;
  },
  byte: function (v) {
    this.push(new Uint8Array([v & 0xff]));
  },
  bytes: function (arr) {
    this.push(Uint8Array.from(arr));
  },
  u16: function (v) {
    var b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  },
  u32: function (v) {
    var b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  },
  i32: function (v) {
    var b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v | 0, true);
    this.push(b);
  },
  f32: function (v) {
    var b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.push(b);
  },
  f64: function (v) {
    var b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.push(b);
  },
  zeros: function (n) {
    this.push(new Uint8Array(n));
  },
  // uint8 length + fixed `cap` bytes
  fixedStr: function (bytes, cap) {
    bytes = toBytes(bytes);
    if (bytes.length > cap) throw new Error("fixedStr overflow");
    this.byte(bytes.length);
    var slot = new Uint8Array(cap);
    slot.set(bytes);
    this.push(slot);
  },
  // uint32 length + bytes
  varStr: function (bytes) {
    bytes = toBytes(bytes);
    this.u32(bytes.length);
    this.push(bytes);
  },
  finish: function () {
    var out = new Uint8Array(this.length);
    var off = 0;
    for (var i = 0; i < this.chunks.length; i++) {
      out.set(this.chunks[i], off);
      off += this.chunks[i].length;
    }
    return out;
  },
};

// Accepts a plain ASCII string or an array/Uint8Array of raw ANSI bytes
// (pass raw bytes for non-ASCII text so tests control the codepage).
function toBytes(v) {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  var out = new Uint8Array(v.length);
  for (var i = 0; i < v.length; i++) {
    var c = v.charCodeAt(i);
    if (c > 0xff) throw new Error("non-ANSI char in generator string; pass raw bytes instead");
    out[i] = c;
  }
  return out;
}

function writeObjectRecord(w, o) {
  var rec = new Uint8Array(OBJECT_RECORD_SIZE);
  var dv = new DataView(rec.buffer);
  dv.setUint8(0x00, o.type);
  dv.setFloat32(0x01, o.x || 0, true);
  // The format stores y downward from the board's bottom-left origin, so
  // board content spans -size_y..0. Object specs here use positive mm
  // measured up from the bottom edge; the writer flips the sign.
  dv.setFloat32(0x05, -(o.y || 0), true);
  dv.setFloat32(0x09, o.out || 0, true);
  dv.setFloat32(0x0d, o.in || 0, true);
  dv.setUint32(0x11, o.lineWidth || 0, true);
  dv.setUint8(0x16, o.layer || 1);
  dv.setUint8(0x17, o.thtShape || 0);
  dv.setUint16(0x1c, o.componentId || 0, true);
  dv.setUint32(0x1f, o.startAngle || 0, true);
  dv.setUint8(0x28, o.fill ? 1 : 0);
  dv.setUint32(0x29, o.groundDistance || 0, true);
  dv.setUint8(0x32, o.thermal ? 1 : 0);
  dv.setUint8(0x33, o.flipVertical ? 1 : 0);
  dv.setUint8(0x34, o.cutoff ? 1 : 0);
  dv.setUint32(0x35, o.rotation || 0, true);
  dv.setUint8(0x39, o.plated ? 1 : 0);
  dv.setUint8(0x3a, o.soldermask ? 1 : 0);
  w.push(rec);
}

function writeObject(w, o, isChild) {
  writeObjectRecord(w, o);
  if (!isChild) {
    w.varStr(o.text);
    w.varStr(o.marker);
    var groups = o.groups || [];
    w.u32(groups.length);
    for (var g = 0; g < groups.length; g++) w.u32(groups[g]);
  }
  if (o.type === 5) {
    // circle: nothing more
  } else if (o.type === 7) {
    var children = o.children || [];
    w.u32(children.length);
    for (var c = 0; c < children.length; c++) writeObject(w, children[c], true);
    if ((o.thtShape || 0) === 1) {
      var comp = o.component || {};
      w.f32(comp.offX || 0);
      w.f32(comp.offY || 0);
      w.byte(comp.centerMode || 0);
      w.f64(comp.rotation || 0);
      w.varStr(comp.package);
      w.varStr(comp.comment);
      w.byte(comp.use || 0);
    }
  } else {
    var points = o.points || [];
    w.u32(points.length);
    for (var p = 0; p < points.length; p++) {
      w.f32(points[p].x);
      w.f32(-points[p].y);
    }
  }
}

function collectPads(objects, out) {
  out = out || [];
  for (var i = 0; i < objects.length; i++) {
    var o = objects[i];
    if (o.type === 2 || o.type === 8) out.push(o);
    if (o.children) collectPads(o.children, out);
  }
  return out;
}

function writeBoard(w, b) {
  var start = w.length;
  w.fixedStr(b.name, 30); // 0x00
  w.zeros(4); // 0x1F
  w.u32(b.sizeX); // 0x23
  w.u32(b.sizeY); // 0x27
  w.bytes(b.groundPane || [0, 0, 0, 0, 0, 0, 0]); // 0x2B
  w.f64(b.grid != null ? b.grid : 1.27); // 0x32
  w.f64(b.zoom != null ? b.zoom : 1.0); // 0x3A
  w.u32(b.viewportOffsetX || 0); // 0x42
  w.u32(b.viewportOffsetY || 0); // 0x46
  w.byte(b.activeLayer != null ? b.activeLayer : 1); // 0x4A
  w.zeros(3);
  var vis = b.layerVisible || [1, 1, 1, 1, 1, 1, 1]; // 0x4E
  for (var i = 0; i < 7; i++) w.byte(vis[i] ? 1 : 0);
  w.byte(b.scannedCopyTop || 0); // 0x55
  w.byte(b.scannedCopyBottom || 0); // 0x56
  w.fixedStr(b.scanPathA || "", 200); // 0x57
  w.fixedStr(b.scanPathB || "", 200); // 0x120
  w.zeros(0x209 - 0x1e9); // 0x1E9 dpi/shift/unknown block
  w.i32(b.centerX || 0); // 0x209
  w.i32(b.centerY || 0); // 0x20D
  w.byte(b.isMultilayer ? 1 : 0); // 0x211
  var objects = b.objects || [];
  w.u32(objects.length); // 0x212
  if (w.length - start !== BOARD_HEADER_SIZE) {
    throw new Error("board header is " + (w.length - start) + " bytes, want " + BOARD_HEADER_SIZE);
  }
  for (var o = 0; o < objects.length; o++) writeObject(w, objects[o], false);
  var pads = collectPads(objects);
  for (var p = 0; p < pads.length; p++) {
    var conns = pads[p].connections || [];
    w.u32(conns.length);
    for (var c = 0; c < conns.length; c++) w.u32(conns[c]);
  }
}

function generate(doc) {
  var w = new Writer();
  w.bytes([0x06, 0x33, 0xaa, 0xff]);
  var boards = doc.boards || [];
  w.u32(boards.length);
  for (var i = 0; i < boards.length; i++) writeBoard(w, boards[i]);
  var t = doc.trailer || {};
  w.u32(t.activeTab || 0);
  w.fixedStr(t.project || "", 100);
  w.fixedStr(t.author || "", 100);
  w.fixedStr(t.company || "", 100);
  w.varStr(t.comment);
  return w.finish();
}

/* ------------------------- stock fixtures -------------------------- */

// A small but representative board: every object type, a component,
// a filled zone with pads (thermal / cutoff) inside, arcs, rotation.
function demoBoard() {
  var mm = 10000; // file units per mm
  return {
    name: "demo board",
    sizeX: 50 * mm,
    sizeY: 30 * mm,
    grid: 1.27,
    zoom: 1,
    activeLayer: 1,
    layerVisible: [1, 1, 1, 0, 0, 0, 1], // S2, I1, I2 hidden on load
    centerX: 25 * mm,
    centerY: 15 * mm,
    isMultilayer: false,
    objects: [
      { // filled copper zone on top copper
        type: 4, layer: 1, fill: true, lineWidth: 0.2 * mm,
        x: 0, y: 0,
        points: [
          { x: 2 * mm, y: 2 * mm }, { x: 30 * mm, y: 2 * mm },
          { x: 30 * mm, y: 20 * mm }, { x: 2 * mm, y: 20 * mm },
        ],
        text: "", marker: "",
      },
      { // outline-only zone on bottom copper
        type: 4, layer: 3, fill: false, lineWidth: 0.15 * mm,
        points: [
          { x: 34 * mm, y: 4 * mm }, { x: 46 * mm, y: 4 * mm }, { x: 40 * mm, y: 14 * mm },
        ],
      },
      { // THT pad, round, thermal relief inside the zone
        type: 2, layer: 1, thtShape: 1,
        x: 8 * mm, y: 8 * mm, out: 1.4 * mm, in: 0.6 * mm,
        groundDistance: 0.4 * mm, thermal: true, plated: true, soldermask: true,
        connections: [4],
      },
      { // THT pad, square, rotated 30 deg, cut off from the zone
        type: 2, layer: 1, thtShape: 3,
        x: 14 * mm, y: 8 * mm, out: 1.4 * mm, in: 0.6 * mm,
        groundDistance: 0.4 * mm, cutoff: true, rotation: 30000, plated: true,
        connections: [],
      },
      { // track through the zone
        type: 6, layer: 1, lineWidth: 0.5 * mm, groundDistance: 0.4 * mm,
        points: [
          { x: 8 * mm, y: 8 * mm }, { x: 8 * mm, y: 16 * mm }, { x: 24 * mm, y: 16 * mm },
        ],
      },
      { // full annulus: inner r 2mm, outer r 3mm (start == end angle)
        type: 5, layer: 2,
        x: 40 * mm, y: 22 * mm, out: 2 * mm, in: 3 * mm,
        startAngle: 0, lineWidth: 0,
      },
      { // 90..270 degree arc band
        type: 5, layer: 1,
        x: 40 * mm, y: 22 * mm, out: 0.8 * mm, in: 1.2 * mm,
        startAngle: 90000, lineWidth: 270000,
      },
      { // free text on silkscreen, rotated
        type: 7, layer: 2, x: 4 * mm, y: 26 * mm, out: 2 * mm,
        rotation: 15000, text: "lay6.js", children: [],
      },
      { // component: text label + THT pad + SMD pad + track children
        type: 7, layer: 2, thtShape: 1,
        x: 36 * mm, y: 24 * mm, out: 1.5 * mm, text: "R1",
        children: [
          { type: 2, layer: 1, thtShape: 1, x: 34 * mm, y: 26 * mm, out: 1 * mm, in: 0.5 * mm, plated: true, connections: [2] },
          { type: 8, layer: 1, x: 42 * mm, y: 26 * mm, out: 1.6 * mm, in: 0.9 * mm, rotation: 90000, soldermask: true, connections: [] },
          { type: 6, layer: 1, lineWidth: 0.3 * mm, points: [{ x: 34 * mm, y: 26 * mm }, { x: 42 * mm, y: 26 * mm }] },
        ],
        component: {
          offX: 0, offY: 0, centerMode: 1, rotation: 0,
          package: "R-10mm", comment: "demo part", use: 1,
        },
      },
      { // SMD pad, rotated 45 deg
        type: 8, layer: 1, x: 26 * mm, y: 8 * mm,
        out: 2 * mm, in: 1 * mm, rotation: 45000, soldermask: true,
        groundDistance: 0.3 * mm,
        connections: [],
      },
      { // board outline
        type: 6, layer: 7, lineWidth: 0.2 * mm,
        points: [
          { x: 0, y: 0 }, { x: 50 * mm, y: 0 }, { x: 50 * mm, y: 30 * mm },
          { x: 0, y: 30 * mm }, { x: 0, y: 0 },
        ],
      },
    ],
  };
}

// "Плата" (board) in windows-1251 bytes, for the encoding-selector test.
var CP1251_NAME = [0xcf, 0xeb, 0xe0, 0xf2, 0xe0];

function fixtures() {
  return {
    "simple.lay6": generate({
      boards: [demoBoard()],
      trailer: { activeTab: 0, project: "demo", author: "tests", company: "", comment: "synthetic fixture" },
    }),
    "multi.lay6": generate({
      boards: [
        demoBoard(),
        {
          name: CP1251_NAME,
          sizeX: 20 * 10000,
          sizeY: 10 * 10000,
          layerVisible: [1, 1, 1, 1, 1, 1, 1],
          objects: [
            { type: 6, layer: 3, lineWidth: 4000, points: [{ x: 10000, y: 10000 }, { x: 190000, y: 90000 }] },
            { type: 2, layer: 3, thtShape: 2, x: 100000, y: 50000, out: 12000, in: 5000, plated: true, connections: [0] },
          ],
        },
      ],
      trailer: { activeTab: 1, project: "multi", author: "tests", company: "acme", comment: "" },
    }),
    "empty.lay6": generate({
      boards: [{ name: "empty", sizeX: 100000, sizeY: 80000, objects: [] }],
      trailer: { activeTab: 0, comment: "" },
    }),
  };
}

module.exports = {
  Writer: Writer,
  generate: generate,
  demoBoard: demoBoard,
  fixtures: fixtures,
  CP1251_NAME: CP1251_NAME,
};
