import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Desktop ADR-0041 leaves one consequence behind for everything built after
// it: "colours introduced later must read from the active theme, not
// hard-coded RGB". On the web that decays quietly — a literal renders fine in
// whichever theme the author happened to be using, and only looks wrong to
// someone else. So the rule is checked here rather than trusted.
//
// This test reads source files off disk rather than inspecting a rendered
// page: happy-dom does not apply stylesheets, and the point is to catch the
// literal at the place it was written.

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "app");
const shellFile = join(appDir, "app.vue");

function vueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...vueFiles(full));
    else if (entry.name.endsWith(".vue")) out.push(full);
  }
  return out.sort();
}

function styleBlocks(source: string): string {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The custom properties declared inside one selector's block.
 *
 * Two things here are deliberate, and both were learned by watching this test
 * pass over a file that was demonstrably broken:
 *
 *  - Comments are stripped first. The shell documents its own three selectors
 *    in a comment above them, so a plain search found the *prose* mention and
 *    then walked forward to the next `{` — which belonged to a different rule.
 *    All three sets ended up reading the light block, so "dark matches light"
 *    was comparing the light block with itself and could never fail.
 *  - The selector must be followed by `{`, and the block is brace-matched
 *    rather than sliced to the next `}`. That keeps `:root` from matching
 *    `:root[data-theme="dark"]` and survives nesting inside `@media`.
 *
 * A check that can pass by reading the wrong bytes is worse than no check: it
 * spends the reader's trust without earning it.
 */
function declaredIn(source: string, selector: string): Set<string> {
  const rule = new RegExp(`${escapeForRegExp(selector)}\\s*\\{`);
  const found = rule.exec(stripComments(source));
  if (!found) throw new Error(`selector not found: ${selector}`);

  const css = stripComments(source);
  const open = found.index + found[0].length - 1;

  let depth = 0;
  let close = -1;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`unbalanced braces after ${selector}`);

  const body = css.slice(open + 1, close);
  return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

const shell = readFileSync(shellFile, "utf8");
const light = declaredIn(shell, ":root");
const dark = declaredIn(shell, ':root[data-theme="dark"]');
const autoDark = declaredIn(shell, ':root:not([data-theme="light"])');

describe("theme tokens", () => {
  it("declares a light palette", () => {
    // Guards against the check silently passing on an empty set if the
    // selector is ever renamed.
    expect(light.size).toBeGreaterThan(8);
  });

  // The defect this slice exists to fix: `color-scheme: light dark` told the
  // UA to paint a dark canvas, while every custom property stayed light-only.
  it("declares the same tokens for dark as for light", () => {
    expect([...dark].sort()).toEqual([...light].sort());
  });

  // An explicit choice and the media query must produce the same palette,
  // otherwise "auto on a dark OS" and "dark" are two different themes.
  it("the media-query fallback covers the same tokens as the explicit choice", () => {
    expect([...autoDark].sort()).toEqual([...dark].sort());
  });

  it("every token used anywhere is defined by the shell", () => {
    const unknown: string[] = [];
    for (const file of vueFiles(appDir)) {
      const css = styleBlocks(readFileSync(file, "utf8"));
      for (const match of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
        const token = match[1]!;
        if (!light.has(token)) unknown.push(`${relative(appDir, file)}: ${token}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  // `var(--border, #e3e6ea)` looks defensive but is the opposite: if the token
  // ever fails to resolve, the fallback pins one theme's colour in place and
  // nothing looks broken enough to notice.
  it("no token is used with a hard-coded fallback", () => {
    const withFallback: string[] = [];
    for (const file of vueFiles(appDir)) {
      const css = styleBlocks(readFileSync(file, "utf8"));
      for (const match of css.matchAll(/var\(--[a-z0-9-]+\s*,[^)]*\)/g)) {
        withFallback.push(`${relative(appDir, file)}: ${match[0]}`);
      }
    }
    expect(withFallback).toEqual([]);
  });

  it("no colour literal outside the shell's palette", () => {
    const literals: string[] = [];
    for (const file of vueFiles(appDir)) {
      // The shell is where the palette is defined; every other file consumes it.
      const css = file === shellFile ? styleBlocks(shell).split("body {")[1] : "";
      const body = file === shellFile ? (css ?? "") : styleBlocks(readFileSync(file, "utf8"));
      for (const match of body.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)) {
        literals.push(`${relative(appDir, file)}: ${match[0]}`);
      }
    }
    expect(literals).toEqual([]);
  });
});
