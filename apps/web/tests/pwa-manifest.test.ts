import { describe, expect, it } from "vitest";
import { pwaManifest } from "../app/pwa/manifest";

// Asserts the Phase 1.5 DoD manifest invariants in .claude/roadmap.md.
// Anything that loosens these is a contract change — update the roadmap in
// the same commit.
describe("pwa manifest", () => {
  it("declares the DoD-required identity fields", () => {
    expect(pwaManifest.name).toBe("dbboard-web");
    expect(pwaManifest.short_name).toBe("dbboard");
    expect(pwaManifest.start_url).toBe("/");
    expect(pwaManifest.display).toBe("standalone");
    expect(pwaManifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(pwaManifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("ships both 192x192 and 512x512 icons", () => {
    const sizes = pwaManifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("ships a maskable 512x512 icon for Android adaptive shapes", () => {
    const maskable = pwaManifest.icons.find((icon) => icon.purpose === "maskable");
    expect(maskable).toBeDefined();
    expect(maskable?.sizes).toBe("512x512");
    expect(maskable?.type).toBe("image/png");
  });

  it("points every icon at /icons/* so Nuxt static serving resolves them", () => {
    for (const icon of pwaManifest.icons) {
      expect(icon.src).toMatch(/^\/icons\/.+\.png$/);
    }
  });
});
