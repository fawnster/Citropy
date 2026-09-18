import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { chromium } from "playwright";
import { scaleContainerQuery, scalePixels, scaleValue } from "../postcss.config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const styles = `${root}web/src/styles/`;
const source = `${root}web/src/`;

test("pixel lengths scale to whole pixels and container queries follow the scale", () => {
  assert.equal(scaleValue("4px"), "round(4px * var(--ui-scale), 1px)");
  assert.equal(scaleValue("0px"), "0px");
  assert.equal(scaleValue("calc(100% - 24px)"), "calc(100% - round(24px * var(--ui-scale), 1px))");
  assert.equal(scaleValue("0 -1.5px 11px/1.6"), "0 round(-1.5px * var(--ui-scale), 1px) round(11px * var(--ui-scale), 1px)/1.6");
  assert.equal(scaleContainerQuery("application (max-width: 720px)"), "application (max-width: 45rem)");
});

test("the interface is never scaled with zoom, which draws equal sizes unequally", () => {
  for (const file of readdirSync(styles))
    assert.doesNotMatch(readFileSync(styles + file, "utf8"), /\bzoom\s*:/, file);
});

test("every fixed icon size has a scaled CSS size", () => {
  const css = readFileSync(styles + "base.css", "utf8");
  const sizes = new Set(["16", "13", "24"]);
  for (const file of readdirSync(source, { recursive: true }).filter((file) => file.endsWith(".tsx"))) {
    const code = readFileSync(source + file, "utf8");
    for (const [, size, dimension] of code.matchAll(/\bsize=\{(\d+)\}|\bwidth=[{"](\d+)[}"]\s+height=[{"]\2[}"]/g)) sizes.add(size ?? dimension);
  }
  for (const size of sizes)
    assert.ok(css.includes(`:where(svg, img)[width="${size}"] { width: ${size}px; height: ${size}px; }`), `no scaled rule for icon size ${size}`);
});

test("working indicator cells render the same whole-pixel size at every UI scale", async () => {
  const from = styles + "conversation.css";
  const { css } = await postcss([scalePixels()]).process(readFileSync(from, "utf8"), { from });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (let scale = 90; scale <= 150; scale += 5) {
      await page.setContent(`<style>${css}</style><div style="--ui-scale: ${scale / 100}"><div class="working-grid">${"<i></i>".repeat(9)}</div></div>`);
      const cells = await page.$$eval(".working-grid i", (nodes) => nodes.map((node) => node.getBoundingClientRect()));
      const sizes = new Set(cells.map((cell) => `${cell.width}x${cell.height}`));
      assert.equal(sizes.size, 1, `cells differ at ${scale}%: ${[...sizes].join(", ")}`);
      for (const cell of cells) assert.ok(Number.isInteger(cell.left) && Number.isInteger(cell.top), `cell off the pixel grid at ${scale}%`);
    }
  } finally {
    await browser.close();
  }
});
