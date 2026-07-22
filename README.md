# lay6.js

A static, browser-only viewer for `.lay6` PCB files (the format written by
Sprint-Layout 6). Open the page, drop a file, look at your board.

**Live viewer:** https://mvrer.github.io/lay6.js/

> **Your files never leave your machine.** There is no server, no upload, no
> analytics and no external requests. Files are read with the browser's
> `FileReader` API and parsed entirely in local JavaScript. The page also works
> offline once cached, and straight from `file://` if you just open
> `index.html` from a checkout.

> **Unofficial.** This project is not affiliated with, endorsed by or connected
> to ABACOM in any way. It reads files produced by their layout software based
> on independent format research. It is **not suitable as a manufacturing
> reference** — copper zone fills, clearances and thermal reliefs are
> approximated for on-screen viewing only.

## Features

- Drag-and-drop or file picker; multi-board files open as tabs
- Canvas rendering with wheel zoom, drag pan, pinch zoom, fit-to-board and a
  mirrored view for looking at the bottom side
- Per-layer visibility toggles with object counts; the visibility flags saved
  in the file are applied on load
- Copper zones with clearance (ground distance) subtracted around same-layer
  pads and tracks, thermal-relief spokes and cutoff isolation
- Arcs and annular rings rendered from their true start/end angles
- Pad, SMD and text rotation
- Live cursor position in mm and a two-click measuring tool
- Export the current view to PNG or SVG
- Text encoding selector (CP1252 / CP1251 / CP1250) that re-decodes names and
  labels instantly, without reparsing the file
- Specific error messages for bad signatures, truncated files and implausible
  counts — never a silent blank canvas
- Keyboard driving: `F` fit, `X` mirror, `M` measure, `+`/`−` zoom, arrows pan,
  `1`–`7` toggle layers, `Esc` cancel

## Correctness

The parser treats full-buffer consumption as a hard invariant: after reading
the trailer it checks that the read position equals the file size, and any
mismatch is surfaced in the Diagnostics panel. If a board renders, every byte
of the file was accounted for.

Documented assumptions where the format research is ambiguous:

- angles (arc start/end, rotation) are stored in 1/1000 degree
- coordinates and widths are stored in 1/10000 mm
- the y origin is the board's bottom-left corner, so board content spans
  `-size_y..0`; the viewer shifts by the board height when drawing
- text objects carry their glyph strokes as child track objects; the
  string itself is only drawn (approximated with a browser font) when a
  text object has no children
- connection blocks follow the board's objects, one per THT/SMD pad in
  document order, including pads inside components

Note: designs made for the classic single-sided toner-transfer workflow are
often drawn as seen from the copper side, so their text appears mirrored.
That is faithful to the file — use the Mirror view to read it.

## Running locally

No build step, no dependencies. Either:

- open `index.html` directly from the checkout, or
- serve the directory with any static file server.

## Tests

```
npm test                     # runs node --test test/*.test.js (needs Node 18+)
node test/make-fixtures.js   # regenerates the committed fixtures
```

Fixtures are produced by a small synthetic `.lay6` generator
(`test/genlay6.js`), so the repository never has to contain anyone's real
design files. The suite asserts full-buffer consumption, board dimensions,
object-type histograms, string re-decoding, and that each failure mode
(bad magic, truncation, absurd counts) yields its specific error.

## Contributing

To keep commit messages free of tool-generated attribution trailers, enable
the bundled hook once per clone:

```
git config core.hooksPath .githooks
```

## Credits

The binary layout of the `.lay6` format was understood with the help of the
independent reverse-engineering research published at
[sergey-raevskiy/xlay](https://github.com/sergey-raevskiy/xlay), used strictly
as a research reference — no code or headers from that repository are included
here.

## License

[MIT](LICENSE)
