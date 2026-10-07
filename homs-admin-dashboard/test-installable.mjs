// The dashboard installs to a home screen, and reopens on the right account.
// Run: node test-installable.mjs
//
// Phase 3 of CLIENT-MOBILE-APP-SCOPE.md. A manifest and an icon make it an app
// on a phone with no app store, no review and no release cycle per fix -- which
// is most of what "feels like an app" actually means.
//
// The part that needed thought is start_url. A static one opens the installed
// app with no locationId, and the fallback that would rescue it -- the id kept
// in localStorage from the first visit -- is exactly what an installed app on
// iOS may not share with the browser it was installed from. The reader taps
// their own icon and is told no location was specified. So the manifest is
// generated per account instead.
import assert from "node:assert";
import fs from "node:fs";
import { decodePng } from "./tools-make-icons.mjs";

const DEMO = "ZghxU8I60bEm39JUbtCm";
const worker = (await import("./src/index.js")).default;
const env = { ADMIN_KEY: "k", DASHBOARD_TENANTS: { get: async () => null } };

const getManifest = async (qs = "") => {
  const res = await worker.fetch(new Request(`https://d.dev/manifest.webmanifest${qs}`), env);
  return { status: res.status, type: res.headers.get("Content-Type"), body: await res.json() };
};

// ---- 1. it is a manifest a browser will accept ----------------------
{
  const m = await getManifest();
  assert.strictEqual(m.status, 200);
  assert.match(m.type, /application\/manifest\+json/,
    "served as a manifest -- a browser ignores one sent as text/plain, silently");
  assert.strictEqual(m.body.display, "standalone", "opens without browser chrome");
  assert.strictEqual(m.body.scope, "/");
  assert.ok(m.body.name && m.body.short_name, "a name for the installer and one for under the icon");
  assert.ok(m.body.theme_color && m.body.background_color);
  console.log("1) The manifest is served as one, and asks to open standalone");
}

// ---- 2. no login needed to read it ----------------------------------
// A browser fetches the manifest before anyone has signed in. Behind the API
// gate it would 401 and the app would simply not be installable, with nothing
// on screen to say why.
{
  const res = await worker.fetch(new Request("https://d.dev/manifest.webmanifest"), env);
  assert.strictEqual(res.status, 200, "no credentials, still served");
  console.log("2) It is readable without logging in, which is when a browser asks for it");
}

// ---- 3. it reopens on the account it was installed from -------------
{
  const scoped = await getManifest(`?locationId=${DEMO}`);
  assert.strictEqual(scoped.body.start_url, `/?locationId=${DEMO}`,
    "the installed icon opens that client's account, not a page asking which one");

  const bare = await getManifest();
  assert.strictEqual(bare.body.start_url, "/", "and without an account it falls back rather than inventing one");
  console.log("3) An installed icon reopens the account it was installed from");
}

// ---- 4. only something shaped like a locationId reaches start_url ---
// start_url is the one field here a browser will later navigate to, so what
// goes into it is checked rather than trusted.
{
  const rejected = [
    "https://evil.example/steal",
    "../../admin",
    'x" , "name": "Something Else',
    "a b",
    "x".repeat(65),
    "",
  ];
  for (const bad of rejected) {
    const m = await getManifest(`?locationId=${encodeURIComponent(bad)}`);
    assert.strictEqual(m.body.start_url, "/", `"${bad.slice(0, 24)}" must not reach start_url`);
    assert.strictEqual(m.body.name, "HOMS Admin Dashboard", "and must not have altered anything else");
  }
  // The real shape still passes, including ids with - and _.
  for (const ok of [DEMO, "a-b_c123"]) {
    assert.strictEqual((await getManifest(`?locationId=${ok}`)).body.start_url, `/?locationId=${ok}`);
  }
  console.log(`4) ${rejected.length} malformed ids are refused; a real one still works`);
}

// ---- 5. the icons it names actually exist ---------------------------
// A manifest pointing at a missing icon is installable and then blank on the
// home screen, which is worse than not offering it.
{
  const m = await getManifest();
  assert.ok(m.body.icons.length >= 2, "a small one and a large one");
  for (const icon of m.body.icons) {
    const file = `./public${icon.src}`;
    assert.ok(fs.existsSync(file), `${icon.src} is named by the manifest but not in public/`);

    const buf = fs.readFileSync(file);
    assert.strictEqual(buf.slice(0, 8).toString("hex"), "89504e470d0a1a0a", `${icon.src} is a real PNG`);
    const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    assert.strictEqual(`${w}x${h}`, icon.sizes, `${icon.src} is the size it claims`);
    assert.strictEqual(icon.purpose, "any",
      "not maskable: the artwork is a disc with its own margin, and maskable invites Android to crop into it");

    // Opaque, and opaque in the right colour. The source is a cut-out -- the
    // background AND the keyhole are transparent, 56% of the artwork -- and iOS
    // composites transparency onto BLACK, which would put a teal disc on a
    // black square with a black keyhole.
    //
    // Alpha alone is not enough to catch that: flattening onto black is also
    // fully opaque, and also wrong.
    const img = decodePng(buf);
    const at = (fx, fy) => {
      const i = (Math.round(h * fy) * w + Math.round(w * fx)) * 4;
      return { r: img.rgba[i], g: img.rgba[i + 1], b: img.rgba[i + 2], a: img.rgba[i + 3] };
    };
    const light = (p) => p.r > 235 && p.g > 235 && p.b > 235;

    const corner = at(0.02, 0.02);
    assert.strictEqual(corner.a, 255, `${icon.src} has an opaque corner, or iOS fills it with black`);
    assert.ok(light(corner), `${icon.src} corner is light, not black: got rgb(${corner.r},${corner.g},${corner.b})`);

    const keyhole = at(0.5, 0.38);
    assert.strictEqual(keyhole.a, 255);
    assert.ok(light(keyhole), `${icon.src} keyhole reads white, not black: got rgb(${keyhole.r},${keyhole.g},${keyhole.b})`);

    // And the disc is still the brand teal rather than anything the resampler
    // averaged into existence. Sampled left of the keyhole, well inside the disc.
    const disc = at(0.3, 0.5);
    assert.ok(disc.g > 100 && disc.g > disc.r && disc.b > disc.r,
      `${icon.src} disc is teal: got rgb(${disc.r},${disc.g},${disc.b})`);
  }

  // iOS ignores the manifest and reads a link tag instead.
  const html = fs.readFileSync("./public/index.html", "utf8");
  const apple = html.match(/rel="apple-touch-icon" href="([^"]+)"/);
  assert.ok(apple, "iOS needs its own icon link, which the manifest does not provide");
  assert.ok(fs.existsSync(`./public${apple[1]}`), `${apple?.[1]} is linked but missing`);
  console.log("5) Every icon the manifest and iOS name exists, is a real PNG, and is the size it claims");
}

// ---- 6. the page points the manifest at its own account -------------
// The Worker can only scope the manifest if the page asks it to.
{
  const html = fs.readFileSync("./public/index.html", "utf8");
  const app = fs.readFileSync("./public/app.js", "utf8");

  assert.match(html, /<link rel="manifest" id="manifestLink"/, "the link is there to be rewritten");
  assert.match(app, /manifestLink/);
  assert.match(app, /manifest\.webmanifest\?locationId=\$\{encodeURIComponent\(id\)\}/,
    "and is rewritten with this account's id, encoded");
  assert.match(app, /pointManifestAtAccount\(\);/, "and that actually runs on load");

  // iOS full-screen and the notch.
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes/);
  const css = fs.readFileSync("./public/styles.css", "utf8");
  assert.match(css, /env\(safe-area-inset-top\)/,
    "viewport-fit=cover without safe-area padding puts the brand under the camera");
  console.log("6) The page points the manifest at its own account and handles the notch");
}

console.log("\nPASS — installable, opens standalone on the right account, with icons that exist.");
