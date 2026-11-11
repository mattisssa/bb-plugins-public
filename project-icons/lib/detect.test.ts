import { test } from "node:test";
import assert from "node:assert/strict";
import { isIconShaped, pickEmoji, pngDimensions, rankIconCandidates, startsWithEmoji } from "./detect.ts";

test("startsWithEmoji detects a leading emoji marker", () => {
  assert.equal(startsWithEmoji("🧪 playground"), true);
  assert.equal(startsWithEmoji("📣 newsletter"), true);
  assert.equal(startsWithEmoji("chat-bot"), false);
  assert.equal(startsWithEmoji("  Shop"), false);
  assert.equal(startsWithEmoji("2048"), false); // digits are not emoji
});

test("pickEmoji is deterministic and comes from the curated set", () => {
  const a = pickEmoji("proj_aaaaaaaaaa");
  assert.equal(pickEmoji("proj_aaaaaaaaaa"), a);
  assert.notEqual(pickEmoji("proj_bbbbbbbbbb"), pickEmoji("proj_cccccccccc"));
  assert.ok(/\p{Extended_Pictographic}/u.test(a));
});

test("rankIconCandidates prefers an iOS AppIcon over PWA icons over favicons", () => {
  const ranked = rankIconCandidates([
    "public/assets/favicon.ico",
    "public/assets/icon-192.png",
    "MyApp/Resources/Assets.xcassets/AppIcon.appiconset/Logo.png",
    "public/assets/apple-touch-icon.png",
    "public/assets/icon-512.png",
    "public/assets/icon-maskable-512.png",
  ]);
  assert.equal(ranked[0], "MyApp/Resources/Assets.xcassets/AppIcon.appiconset/Logo.png");
  assert.equal(ranked[1], "public/assets/icon-512.png");
  assert.equal(ranked.at(-1), "public/assets/favicon.ico");
});

test("rankIconCandidates picks a PWA icon set in the right order", () => {
  const ranked = rankIconCandidates([
    "public/assets/favicon.ico",
    "public/assets/apple-touch-icon.png",
    "public/assets/icon-192.png",
    "public/assets/favicon-96.png",
    "public/assets/icon-maskable-512.png",
    "public/assets/favicon.svg",
    "public/assets/icon-512.png",
    "src/components/Button.tsx",
  ]);
  assert.equal(ranked[0], "public/assets/icon-512.png");
  assert.ok(!ranked.includes("src/components/Button.tsx"));
});

test("rankIconCandidates ignores documentation images and deep paths", () => {
  const ranked = rankIconCandidates([
    "references/images/architecture/16-section-logo.webp",
    "resources/icon.png",
  ]);
  assert.deepEqual(ranked, ["resources/icon.png"]);
});

test("rankIconCandidates skips build output and package checkouts", () => {
  const ranked = rankIconCandidates([
    "build/DerivedData/SourcePackages/checkouts/Splash/Images/Logo.png",
    "Resources/App.icon/Assets/tIcon.svg",
  ]);
  assert.deepEqual(ranked, ["Resources/App.icon/Assets/tIcon.svg"]);
});

test("pngDimensions reads IHDR and isIconShaped rejects banners", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 4000);
  new DataView(png.buffer).setUint32(20, 1000);
  assert.deepEqual(pngDimensions(png), { width: 4000, height: 1000 });
  assert.equal(isIconShaped({ width: 4000, height: 1000 }), false);
  assert.equal(isIconShaped({ width: 512, height: 512 }), true);
  assert.equal(isIconShaped({ width: 180, height: 200 }), true);
  assert.equal(pngDimensions(new Uint8Array([1, 2, 3])), null);
  assert.equal(isIconShaped(null), true);
});

test("rankIconCandidates returns an empty list when nothing looks like an icon", () => {
  assert.deepEqual(rankIconCandidates(["README.md", "src/index.ts", "assets/photo.jpg"]), []);
});
