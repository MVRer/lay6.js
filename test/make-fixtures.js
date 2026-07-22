// Regenerates the committed .lay6 fixtures from the synthetic generator:
//   node test/make-fixtures.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const gen = require("./genlay6.js");

const dir = path.join(__dirname, "fixtures");
fs.mkdirSync(dir, { recursive: true });

const files = gen.fixtures();
for (const name of Object.keys(files)) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, files[name]);
  console.log("wrote", p, files[name].byteLength, "bytes");
}
