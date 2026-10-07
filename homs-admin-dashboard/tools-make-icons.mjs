// Builds the home-screen icons from the source artwork.
//
// Run: node tools-make-icons.mjs <source.png> [public-dir]
//
// Decoder, resampler and encoder are all here because the repo has no image
// tooling and adding one to resize a square three times is a poor trade: zlib is
// built into Node, and PNG is a header, a deflated block of scanlines and a
// footer. The decoder handles 8-bit truecolour-with-alpha, non-interlaced,
// which is what the artwork is; anything else is refused loudly rather than
// decoded into noise.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// ---- PNG in ------------------------------------------------------------
export function decodePng(buf) {
  if (buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");

  let width = 0, height = 0, bitDepth = 0, colourType = 0, interlace = 0;
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString("ascii");
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colourType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth ${bitDepth}, colourType ${colourType}, interlace ${interlace}) -- expected 8-bit RGBA, non-interlaced`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each line names its own, and Paeth and
  // Average both read the line above, which is why this cannot be done in
  // parallel or skipped.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;          // left
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;             // above
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0; // above-left
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, rgba: out };
}

// ---- resample ----------------------------------------------------------
// Box average over each target pixel's footprint. Alpha is premultiplied first:
// averaging colour and alpha separately draws a halo of whatever the
// transparent pixels happened to be, which on this artwork would be a white
// fringe around the circle.
// What transparent pixels become. White, because the artwork is a cut-out and
// was drawn to be read on a light surface.
const BG = [255, 255, 255];

function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = src.width / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < src.height; sy++) {
        for (let sx = x0; sx < x1 && sx < src.width; sx++) {
          const i = (sy * src.width + sx) * 4;
          const al = src.rgba[i + 3] / 255;
          r += src.rgba[i] * al; g += src.rgba[i + 1] * al; b += src.rgba[i + 2] * al;
          a += src.rgba[i + 3];
          n++;
        }
      }
      const i = (y * size + x) * 4;
      const alpha = (a / n) / 255;
      // Composited onto an opaque background rather than left transparent.
      //
      // The artwork is a teal disc and a keyhole CUT OUT of it -- 56% of the
      // source is fully transparent, including the keyhole itself. Shipped that
      // way, iOS composites alpha onto BLACK, so the home screen would show a
      // teal circle on a black square with a black keyhole. Android would show
      // the launcher's plate through the keyhole, whatever colour that is.
      //
      // On white it reads as it was drawn: teal disc, white keyhole.
      out[i] = Math.round((r / n) + BG[0] * (1 - alpha));
      out[i + 1] = Math.round((g / n) + BG[1] * (1 - alpha));
      out[i + 2] = Math.round((b / n) + BG[2] * (1 - alpha));
      out[i + 3] = 255;
    }
  }
  return out;
}

// ---- PNG out -----------------------------------------------------------
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- build -------------------------------------------------------------
// Only when run directly. The decoder is exported because the icon test reads
// the alpha channel of what this produced, and a second decoder written to
// check the first one would agree with it about the wrong things.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const SOURCE = process.argv[2];
  const OUT = path.join(process.argv[3] || "./public", "icons");
  if (!SOURCE) throw new Error("usage: node tools-make-icons.mjs <source.png> [public-dir]");

  const src = decodePng(fs.readFileSync(SOURCE));
  console.log(`source ${src.width}x${src.height}`);

  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
    const buf = encodePng(size, resize(src, size));
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log(`${name.padEnd(22)} ${size}x${size}  ${String(buf.length).padStart(6)} bytes`);
  }
}
