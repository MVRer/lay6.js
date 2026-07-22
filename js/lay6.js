/*
 * lay6.js — parser for ABACOM Sprint-Layout 6 (.lay6) board files.
 *
 * Runs as a plain <script> in the browser (exposes window.Lay6) and as a
 * CommonJS module in Node for the headless tests. No dependencies.
 *
 * All strings are kept as raw byte arrays; decoding to JS strings happens
 * separately (decodeStrings) so the UI can switch codepages without
 * reparsing the binary.
 *
 * Units: coordinates, sizes and widths are 1/10000 mm; angles are
 * 1/1000 degree.
 */
"use strict";

var Lay6 = (function () {

  var MAGIC = [0x06, 0x33, 0xaa, 0xff];

  var TYPE = {
    THT_PAD: 2,
    ZONE: 4,
    CIRCLE: 5,
    TRACK: 6,
    TEXT: 7,
    SMD_PAD: 8,
  };

  var TYPE_NAMES = {
    2: "THT pad",
    4: "zone",
    5: "circle",
    6: "track",
    7: "text",
    8: "SMD pad",
  };

  // layer ids 1..7
  var LAYERS = {
    1: { key: "C1", name: "Copper top" },
    2: { key: "S1", name: "Silkscreen top" },
    3: { key: "C2", name: "Copper bottom" },
    4: { key: "S2", name: "Silkscreen bottom" },
    5: { key: "I1", name: "Inner 1" },
    6: { key: "I2", name: "Inner 2" },
    7: { key: "O", name: "Outline" },
  };

  var COPPER_LAYERS = { 1: true, 3: true, 5: true, 6: true };

  // Painting order, first = bottom-most: copper layers, then silkscreen so
  // component outlines and labels stay legible, then the board outline.
  var LAYER_Z_ORDER = [3, 5, 6, 1, 4, 2, 7];

  // Painting order of object types inside one layer, first = bottom-most:
  // zones under tracks under pads so pads never vanish beneath a fill.
  var TYPE_Z = { 4: 0, 6: 1, 5: 2, 2: 3, 8: 3, 7: 4 };

  var BOARD_HEADER_SIZE = 0x216; // 534
  var OBJECT_RECORD_SIZE = 0x4d; // 77

  function Lay6Error(message, offset, context) {
    var e = Error.call(this, message);
    this.name = "Lay6Error";
    this.message = message;
    this.offset = offset;
    this.context = context || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, Lay6Error);
    else this.stack = e.stack;
  }
  Lay6Error.prototype = Object.create(Error.prototype);
  Lay6Error.prototype.constructor = Lay6Error;

  function hex(n) {
    return "0x" + n.toString(16);
  }

  function Reader(buffer) {
    this.dv = new DataView(buffer);
    this.u8 = new Uint8Array(buffer);
    this.pos = 0;
    this.length = buffer.byteLength;
  }
  Reader.prototype = {
    remaining: function () {
      return this.length - this.pos;
    },
    need: function (n, what) {
      if (this.pos + n > this.length) {
        throw new Lay6Error(
          "Truncated file: needed " + n + " more byte(s) for " + what +
            " at offset " + this.pos + " (" + hex(this.pos) + "), but the file is only " +
            this.length + " bytes long.",
          this.pos, what);
      }
    },
    byte: function (what) {
      this.need(1, what);
      return this.u8[this.pos++];
    },
    u16: function (what) {
      this.need(2, what);
      var v = this.dv.getUint16(this.pos, true);
      this.pos += 2;
      return v;
    },
    u32: function (what) {
      this.need(4, what);
      var v = this.dv.getUint32(this.pos, true);
      this.pos += 4;
      return v;
    },
    i32: function (what) {
      this.need(4, what);
      var v = this.dv.getInt32(this.pos, true);
      this.pos += 4;
      return v;
    },
    f32: function (what) {
      this.need(4, what);
      var v = this.dv.getFloat32(this.pos, true);
      this.pos += 4;
      return v;
    },
    f64: function (what) {
      this.need(8, what);
      var v = this.dv.getFloat64(this.pos, true);
      this.pos += 8;
      return v;
    },
    bytes: function (n, what) {
      this.need(n, what);
      var v = this.u8.slice(this.pos, this.pos + n);
      this.pos += n;
      return v;
    },
    skip: function (n, what) {
      this.need(n, what);
      this.pos += n;
    },
    // Delphi ShortString stored in a fixed slot: uint8 length + `cap` bytes.
    fixedStr: function (cap, what) {
      var len = this.byte(what + " length");
      var raw = this.bytes(cap, what);
      if (len > cap) len = cap;
      return raw.slice(0, len);
    },
    // uint32 length + that many ANSI bytes.
    varStr: function (what) {
      var at = this.pos;
      var len = this.u32(what + " length");
      if (len > this.remaining()) {
        throw new Lay6Error(
          "Implausible string length " + len + " for " + what + " at offset " + at +
            " (" + hex(at) + "): only " + this.remaining() + " byte(s) left in the file." +
            " The file is corrupt or not a Sprint-Layout 6 file.",
          at, what);
      }
      return this.bytes(len, what);
    },
  };

  /* ------------------------------------------------------------------ */

  function parseBoardHeader(r, index) {
    var what = "board " + (index + 1) + " header";
    var base = r.pos;
    r.need(BOARD_HEADER_SIZE, what);

    var b = {
      nameRaw: r.fixedStr(30, what + " name"), // 0x00
      name: "",
    };
    r.skip(4, what); // 0x1F pad
    b.sizeX = r.u32(what + " size_x"); // 0x23
    b.sizeY = r.u32(what + " size_y"); // 0x27
    b.groundPane = r.bytes(7, what + " ground pane"); // 0x2B
    // NOTE: grid is in MICROMETRES, unlike coordinates/sizes (1/10000 mm).
    // Divide by 1000 for mm — do not pass it through toMM().
    b.grid = r.f64(what + " grid"); // 0x32
    b.zoom = r.f64(what + " zoom"); // 0x3A
    b.viewportOffsetX = r.u32(what + " viewport offset x"); // 0x42
    b.viewportOffsetY = r.u32(what + " viewport offset y"); // 0x46
    b.activeLayer = r.byte(what + " active layer"); // 0x4A
    r.skip(3, what); // pad
    b.layerVisible = []; // 0x4E, layers 1..7
    for (var i = 0; i < 7; i++) b.layerVisible.push(r.byte(what + " layer visibility") !== 0);
    b.scannedCopyTop = r.byte(what + " scanned-copy flag"); // 0x55
    b.scannedCopyBottom = r.byte(what + " scanned-copy flag"); // 0x56
    b.scanPathARaw = r.fixedStr(200, what + " scan path A"); // 0x57
    b.scanPathBRaw = r.fixedStr(200, what + " scan path B"); // 0x120
    b.scanBlock = r.bytes(0x209 - 0x1e9, what + " scan dpi/shift block"); // 0x1E9, dpi x2 + shifts x4 + 2 unknown dwords
    b.centerX = r.i32(what + " center_x"); // 0x209
    b.centerY = r.i32(what + " center_y"); // 0x20D
    b.isMultilayer = r.byte(what + " multilayer flag") !== 0; // 0x211
    b.objectCount = r.u32(what + " object count"); // 0x212

    if (r.pos !== base + BOARD_HEADER_SIZE) {
      throw new Lay6Error(
        "Internal parser error: board header consumed " + (r.pos - base) +
          " bytes instead of " + BOARD_HEADER_SIZE + ".",
        r.pos, what);
    }

    if (b.objectCount * OBJECT_RECORD_SIZE > r.remaining()) {
      throw new Lay6Error(
        "Implausible object count " + b.objectCount + " in board " + (index + 1) +
          ": " + r.remaining() + " byte(s) remain, but " + b.objectCount +
          " objects need at least " + b.objectCount * OBJECT_RECORD_SIZE + ".",
        r.pos, what);
    }
    return b;
  }

  function parseObject(r, isChild, diagnostics, path) {
    var base = r.pos;
    var what = "object at offset " + base + " (" + hex(base) + ")";
    r.need(OBJECT_RECORD_SIZE, "object record of " + what);

    var dv = r.dv;
    var o = {
      offset: base,
      type: dv.getUint8(base + 0x00),
      x: dv.getFloat32(base + 0x01, true),
      y: dv.getFloat32(base + 0x05, true),
      out: dv.getFloat32(base + 0x09, true),
      in: dv.getFloat32(base + 0x0d, true),
      lineWidth: dv.getUint32(base + 0x11, true), // arc end angle when type == CIRCLE
      layer: dv.getUint8(base + 0x16),
      thtShape: dv.getUint8(base + 0x17), // 1 round, 2 octagon, 3 square
      componentId: dv.getUint16(base + 0x1c, true),
      startAngle: dv.getUint32(base + 0x1f, true), // unioned with th_style[4]
      thStyle: [
        dv.getUint8(base + 0x1f), dv.getUint8(base + 0x20),
        dv.getUint8(base + 0x21), dv.getUint8(base + 0x22),
      ],
      fill: dv.getUint8(base + 0x28) !== 0,
      groundDistance: dv.getUint32(base + 0x29, true),
      thermal: dv.getUint8(base + 0x32) !== 0,
      flipVertical: dv.getUint8(base + 0x33) !== 0,
      cutoff: dv.getUint8(base + 0x34) !== 0,
      rotation: dv.getUint32(base + 0x35, true),
      plated: dv.getUint8(base + 0x39) !== 0,
      soldermask: dv.getUint8(base + 0x3a) !== 0,
      isChild: !!isChild,
    };
    r.pos = base + OBJECT_RECORD_SIZE;

    if (!TYPE_NAMES[o.type]) {
      diagnostics.push({
        level: "warning",
        message: "Unknown object type " + o.type + " at offset " + base +
          " (" + hex(base) + "); reading it as a generic polygon object.",
      });
    }

    if (!isChild) {
      o.textRaw = r.varStr("text of " + what);
      o.markerRaw = r.varStr("marker of " + what);
      var groupCount = r.u32("group count of " + what);
      if (groupCount * 4 > r.remaining()) {
        throw new Lay6Error(
          "Implausible group count " + groupCount + " for " + what + ".",
          r.pos, what);
      }
      o.groups = [];
      for (var g = 0; g < groupCount; g++) o.groups.push(r.u32("group id of " + what));
    } else {
      o.textRaw = new Uint8Array(0);
      o.markerRaw = new Uint8Array(0);
      o.groups = [];
    }

    if (o.type === TYPE.CIRCLE) {
      // nothing more; lineWidth is the arc end angle, out/in the radii
    } else if (o.type === TYPE.TEXT) {
      var childCount = r.u32("child count of " + what);
      if (childCount * OBJECT_RECORD_SIZE > r.remaining()) {
        throw new Lay6Error(
          "Implausible child count " + childCount + " for " + what + ".",
          r.pos, what);
      }
      o.children = [];
      for (var c = 0; c < childCount; c++) {
        o.children.push(parseObject(r, true, diagnostics, path));
      }
      if (o.thtShape === 1) {
        o.component = {
          offX: r.f32("component offset x of " + what),
          offY: r.f32("component offset y of " + what),
          centerMode: r.byte("component center mode of " + what),
          rotation: r.f64("component rotation of " + what),
          packageRaw: r.varStr("component package of " + what),
          commentRaw: r.varStr("component comment of " + what),
          use: r.byte("component use flag of " + what),
        };
      }
    } else {
      var pointCount = r.u32("point count of " + what);
      if (pointCount * 8 > r.remaining()) {
        throw new Lay6Error(
          "Implausible point count " + pointCount + " for " + what + ": " +
            r.remaining() + " byte(s) remain but " + pointCount +
            " points need " + pointCount * 8 + ".",
          r.pos, what);
      }
      o.points = [];
      for (var p = 0; p < pointCount; p++) {
        o.points.push({
          x: r.f32("point x of " + what),
          y: r.f32("point y of " + what),
        });
      }
    }
    return o;
  }

  // Depth-first walk over objects including text children.
  function walkObjects(objects, fn) {
    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      fn(o);
      if (o.children) walkObjects(o.children, fn);
    }
  }

  function collectPads(objects) {
    var pads = [];
    walkObjects(objects, function (o) {
      if (o.type === TYPE.THT_PAD || o.type === TYPE.SMD_PAD) pads.push(o);
    });
    return pads;
  }

  function parseBoard(r, index, diagnostics) {
    var board = parseBoardHeader(r, index);
    board.objects = [];
    for (var i = 0; i < board.objectCount; i++) {
      board.objects.push(parseObject(r, false, diagnostics, [index, i]));
    }
    // One connection block per pad object (types 2 and 8), in document
    // order including pads inside components.
    var pads = collectPads(board.objects);
    for (var p = 0; p < pads.length; p++) {
      var what = "connection block " + (p + 1) + "/" + pads.length + " of board " + (index + 1);
      var count = r.u32("connection count of " + what);
      if (count * 4 > r.remaining()) {
        throw new Lay6Error("Implausible connection count " + count + " in " + what + ".", r.pos, what);
      }
      var ids = [];
      for (var c = 0; c < count; c++) ids.push(r.u32("connection id of " + what));
      pads[p].connections = ids;
    }
    return board;
  }

  // parse(buffer, { partial: true }) renders what it can: if a board or the
  // trailer fails to decode, the error is recorded as a diagnostic and the
  // boards parsed so far are returned, instead of throwing away the whole
  // file. Strict mode (the default) still throws on the first problem so the
  // full-consumption guarantee and the specific error messages are intact.
  function parse(buffer, opts) {
    opts = opts || {};
    var partial = !!opts.partial;
    if (buffer instanceof Uint8Array) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    var r = new Reader(buffer);
    var diagnostics = [];

    if (r.length < 8) {
      throw new Lay6Error(
        "File is only " + r.length + " byte(s) long — too small to be a Sprint-Layout 6 file" +
          " (the 4-byte signature and board count alone need 8).",
        0, "file header");
    }
    for (var m = 0; m < 4; m++) {
      if (r.u8[m] !== MAGIC[m]) {
        throw new Lay6Error(
          "Bad file signature: expected 06 33 AA FF but found " +
            Array.prototype.map.call(r.u8.slice(0, 4), function (b) {
              return (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
            }).join(" ") +
            " — this is not a Sprint-Layout 6 (.lay6) file.",
          0, "magic");
      }
    }
    r.pos = 4;

    var boardCount = r.u32("board count");
    if (boardCount === 0) {
      diagnostics.push({ level: "warning", message: "The file declares zero boards." });
    }
    if (boardCount > 255) {
      throw new Lay6Error(
        "Implausible board count " + boardCount + " — a Sprint-Layout 6 file holds at most" +
          " a handful of boards. The file is corrupt or not a .lay6 file.",
        4, "board count");
    }
    if (boardCount * BOARD_HEADER_SIZE > r.remaining()) {
      throw new Lay6Error(
        "Truncated file: " + boardCount + " board(s) declared but only " + r.remaining() +
          " byte(s) follow (each board header alone is " + BOARD_HEADER_SIZE + " bytes).",
        4, "board count");
    }

    var boards = [];
    var aborted = false;
    for (var i = 0; i < boardCount; i++) {
      try {
        boards.push(parseBoard(r, i, diagnostics));
      } catch (e) {
        if (!partial || !(e instanceof Lay6Error)) throw e;
        // The reader position is lost once a record desyncs, so later boards
        // can't be located — stop, but keep the boards already decoded.
        diagnostics.push({
          level: "error",
          message: "Board " + (i + 1) + " of " + boardCount + " could not be decoded: " +
            e.message + " Showing the " + boards.length + " board(s) that parsed cleanly.",
        });
        aborted = true;
        break;
      }
    }

    var trailer = null;
    if (!aborted) {
      try {
        trailer = {
          activeTab: r.u32("trailer active tab"),
          projectRaw: r.fixedStr(100, "trailer project name"),
          authorRaw: r.fixedStr(100, "trailer author"),
          companyRaw: r.fixedStr(100, "trailer company"),
          commentRaw: r.varStr("trailer comment"),
        };
      } catch (e) {
        if (!partial || !(e instanceof Lay6Error)) throw e;
        diagnostics.push({
          level: "error",
          message: "The file trailer could not be decoded: " + e.message,
        });
        aborted = true;
      }
    }
    if (!trailer) {
      trailer = {
        activeTab: 0, projectRaw: new Uint8Array(0), authorRaw: new Uint8Array(0),
        companyRaw: new Uint8Array(0), commentRaw: new Uint8Array(0),
      };
    }

    // Correctness check: a correct parse consumes the file to the last byte.
    // (Skipped when a partial parse already aborted with its own diagnostic.)
    if (!aborted && r.pos !== r.length) {
      diagnostics.push({
        level: "warning",
        message: "Parser consumed " + r.pos + " of " + r.length + " bytes; " +
          (r.length - r.pos) + " unexpected trailing byte(s) after the trailer." +
          " The render may be incomplete or the format assumption is off.",
      });
    }

    var doc = {
      boards: boards,
      trailer: trailer,
      diagnostics: diagnostics,
      byteLength: r.length,
      consumed: r.pos,
    };
    doc.detectedEncoding = detectEncoding(doc);
    decodeStrings(doc, doc.detectedEncoding);
    return doc;
  }

  /* ---------------------- string decoding --------------------------- */

  var decoderCache = {};
  function decodeBytes(raw, encoding) {
    if (!raw || raw.length === 0) return "";
    try {
      var d = decoderCache[encoding] ||
        (decoderCache[encoding] = new TextDecoder(encoding));
      return d.decode(raw);
    } catch (e) {
      // Fallback: byte-value passthrough (latin-1-ish) when the platform
      // lacks the requested codepage.
      var s = "";
      for (var i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
      return s;
    }
  }

  // Collect every raw ANSI byte array in the document so the codepage can
  // be sniffed before any decoding happens.
  function collectRawStrings(doc) {
    var raws = [];
    function add(r) { if (r && r.length) raws.push(r); }
    for (var i = 0; i < doc.boards.length; i++) {
      var b = doc.boards[i];
      add(b.nameRaw);
      walkObjects(b.objects, function (o) {
        add(o.textRaw);
        add(o.markerRaw);
        if (o.component) {
          add(o.component.packageRaw);
          add(o.component.commentRaw);
        }
      });
    }
    if (doc.trailer) {
      add(doc.trailer.projectRaw);
      add(doc.trailer.authorRaw);
      add(doc.trailer.companyRaw);
      add(doc.trailer.commentRaw);
    }
    return raws;
  }

  // Guess the ANSI codepage of the document's strings. Sprint-Layout stores
  // text in a Windows ANSI codepage with no marker, so a Cyrillic (CP1251)
  // board decoded as Latin (CP1252) turns into mojibake ("Плата" -> "Ïëàòà").
  // Heuristic: bytes 0xC0..0xFF are letters in CP1251; a string that is
  // mostly high bytes with few ASCII letters is far more likely Cyrillic
  // than accented Latin (which interleaves plenty of ASCII letters).
  function isCyrByte(c) {
    // CP1251 Cyrillic letters live in 0xC0..0xFF; a handful of named letters
    // (Ё ё Є І Ї Ў …) sit lower in the codepage.
    return (c >= 0xc0 && c <= 0xff) ||
      c === 0xa8 || c === 0xb8 || c === 0xaf || c === 0xb2 ||
      c === 0xa5 || c === 0xb4 || c === 0xba || c === 0xbf || c === 0xa1 || c === 0xa2;
  }

  function detectEncoding(doc) {
    var raws = collectRawStrings(doc);
    var totalCyr = 0, totalAscii = 0;
    // A file uses one ANSI codepage throughout, so a single string that is
    // clearly Cyrillic settles it. Per-string dominance avoids being drowned
    // out by ASCII component references (R1, C2 …) and cleanly separates real
    // Cyrillic ("Плата", a run of high bytes) from accented Latin ("Größe",
    // where high bytes are isolated among ASCII letters).
    for (var i = 0; i < raws.length; i++) {
      var r = raws[i];
      var cyr = 0, asciiAlpha = 0;
      for (var j = 0; j < r.length; j++) {
        var c = r[j];
        if (isCyrByte(c)) cyr++;
        else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) asciiAlpha++;
      }
      totalCyr += cyr;
      totalAscii += asciiAlpha;
      if (cyr >= 2 && cyr >= asciiAlpha) return "windows-1251";
    }
    // Fallback for Cyrillic scattered across many one-letter strings: only
    // when high bytes genuinely dominate, so accented-Latin boards (whose
    // high bytes are outnumbered by ASCII letters) stay on CP1252.
    if (totalCyr >= 4 && totalCyr >= totalAscii) return "windows-1251";
    return "windows-1252";
  }

  // Re-decode every string field in place with the given codepage.
  // Does not touch the binary structure, so switching encodings never
  // requires a reparse.
  function decodeStrings(doc, encoding) {
    doc.encoding = encoding;
    for (var i = 0; i < doc.boards.length; i++) {
      var b = doc.boards[i];
      b.name = decodeBytes(b.nameRaw, encoding);
      b.scanPathA = decodeBytes(b.scanPathARaw, encoding);
      b.scanPathB = decodeBytes(b.scanPathBRaw, encoding);
      walkObjects(b.objects, function (o) {
        o.text = decodeBytes(o.textRaw, encoding);
        o.marker = decodeBytes(o.markerRaw, encoding);
        if (o.component) {
          o.component.package = decodeBytes(o.component.packageRaw, encoding);
          o.component.comment = decodeBytes(o.component.commentRaw, encoding);
        }
      });
    }
    var t = doc.trailer;
    if (t) {
      t.project = decodeBytes(t.projectRaw, encoding);
      t.author = decodeBytes(t.authorRaw, encoding);
      t.company = decodeBytes(t.companyRaw, encoding);
      t.comment = decodeBytes(t.commentRaw, encoding);
    }
    return doc;
  }

  /* ------------------------- helpers -------------------------------- */

  function toMM(units) {
    return units / 10000;
  }
  function toDeg(milliDeg) {
    return milliDeg / 1000;
  }

  function histogram(board) {
    var h = {};
    walkObjects(board.objects, function (o) {
      var name = TYPE_NAMES[o.type] || ("type " + o.type);
      h[name] = (h[name] || 0) + 1;
    });
    return h;
  }

  function layerCounts(board) {
    var counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    walkObjects(board.objects, function (o) {
      if (counts[o.layer] !== undefined) counts[o.layer]++;
    });
    return counts;
  }

  return {
    parse: parse,
    decodeStrings: decodeStrings,
    detectEncoding: detectEncoding,
    decodeBytes: decodeBytes,
    walkObjects: walkObjects,
    collectPads: collectPads,
    histogram: histogram,
    layerCounts: layerCounts,
    toMM: toMM,
    toDeg: toDeg,
    Lay6Error: Lay6Error,
    TYPE: TYPE,
    TYPE_NAMES: TYPE_NAMES,
    LAYERS: LAYERS,
    COPPER_LAYERS: COPPER_LAYERS,
    LAYER_Z_ORDER: LAYER_Z_ORDER,
    TYPE_Z: TYPE_Z,
    BOARD_HEADER_SIZE: BOARD_HEADER_SIZE,
    OBJECT_RECORD_SIZE: OBJECT_RECORD_SIZE,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Lay6;
}
