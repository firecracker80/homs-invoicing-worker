// Generates the home-screen icons for the dashboard.
//
// Written rather than drawn because the repo has no image tooling and adding a
// dependency to produce three flat shapes would be a poor trade. zlib is built
// into Node, and a PNG is a header, one deflated block of scanlines and a
// footer -- so the whole encoder is about thirty lines below.
//
// Run: node make-icons.mjs <public-dir>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.join(process.argv[2], "icons");
const ACCENT = [0x2f, 0x6f, 0xed]; // --accent, so the icon matches the app
const WHITE = [0xff, 0xff, 0xff];

// ---- the smallest PNG writer that produces a valid file ---------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 bits per channel
  ihdr[9] = 6;   // truecolour with alpha
  // Each scanline is prefixed with its filter type; 0 means "none", which costs
  // a little size and saves implementing five filters nobody would read.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the mark ---------------------------------------------------------
// A house, because the app is about managing them, and because a letter at
// 48px on a home screen is a letter and not a brand.
//
// Drawn with coverage sampling rather than nearest-pixel: a roof is a diagonal,
// and a diagonal without anti-aliasing is a staircase at every size.
function drawIcon(size, { inset = 0 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const S = 4; // samples per axis
  const r = size * 0.22; // corner radius of the tile

  // Geometry in unit space, then scaled -- `inset` shrinks the mark for the
  // maskable icon, whose outer ~10% a launcher is free to crop into a circle.
  const u = (v) => size * (0.5 + (v - 0.5) * (1 - inset * 2));
  const roofApex = [u(0.5), u(0.26)];
  const roofLeft = [u(0.17), u(0.52)];
  const roofRight = [u(0.83), u(0.52)];
  const body = { x0: u(0.28), y0: u(0.50), x1: u(0.72), y1: u(0.78) };
  const door = { x0: u(0.44), y0: u(0.60), x1: u(0.56), y1: u(0.78) };

  const inTriangle = (px, py, [ax, ay], [bx, by], [cx, cy]) => {
    const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
    const d1 = d(px, py, ax, ay, bx, by);
    const d2 = d(px, py, bx, by, cx, cy);
    const d3 = d(px, py, cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const inRect = (px, py, b) => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1;

  const inTile = (px, py) => {
    const cx = Math.min(Math.max(px, r), size - r);
    const cy = Math.min(Math.max(py, r), size - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0, mark = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          if (inTile(px, py)) tile++;
          const onHouse = inTriangle(px, py, roofApex, roofLeft, roofRight) || inRect(px, py, body);
          if (onHouse && !inRect(px, py, door)) mark++;
        }
      }
      const total = S * S;
      const tileA = tile / total;
      const markA = mark / total;
      const i = (y * size + x) * 4;
      // The mark sits on the tile, so it is only as opaque as the tile beneath.
      const a = tileA;
      const blend = (c) => Math.round(ACCENT[c] * (1 - markA) + WHITE[c] * markA);
      rgba[i] = blend(0);
      rgba[i + 1] = blend(1);
      rgba[i + 2] = blend(2);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
const files = [
  // Maskable: a launcher may crop the outer edge into whatever shape it likes,
  // so the house is pulled in to survive it.
  ["icon-192.png", drawIcon(192, { inset: 0.08 })],
  ["icon-512.png", drawIcon(512, { inset: 0.08 })],
  // iOS does not mask, and squares its own corners. Full bleed.
  ["apple-touch-icon.png", drawIcon(180)],
];
for (const [name, buf] of files) {
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`${name.padEnd(22)} ${String(buf.length).padStart(6)} bytes`);
}
