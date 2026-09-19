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

test("the macOS title bar inset keeps its fixed clearance while the gap scales", async () => {
  const from = styles + "app.css";
  const { css } = await postcss([scalePixels()]).process(readFileSync(from, "utf8"), { from });
  assert.ok(
    css.includes("calc(round(76px * var(--ui-scale), 1px) / var(--ui-scale) + round(6px * var(--ui-scale), 1px))"),
    "the title bar padding no longer cancels the scale for its fixed part",
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const scale of [90, 100, 120, 150]) {
      for (const width of [1200, 720 * (scale / 100) - 1]) {
        await page.setContent(`<style>${css}</style><div id="root" style="container: application / inline-size; width: ${width}px"><div class="shell" data-sidebar="false"><div class="topbar-left" id="pane"></div></div></div>`);
        await page.evaluate((value) => {
          document.documentElement.dataset.platform = "darwin";
          document.documentElement.style.setProperty("--ui-scale", String(value));
        }, scale / 100);
        const computed = await page.$eval("#pane", (element) => {
          const style = getComputedStyle(element);
          return { padding: parseFloat(style.paddingLeft), width: parseFloat(style.width) };
        });
        const expectedPadding = 76 + 6 * (scale / 100);
        const expectedWidth = 76 + 186 * (scale / 100);
        assert.ok(Math.abs(computed.padding - expectedPadding) < 1.5, `padding ${computed.padding} at ${scale}% and ${width}px`);
        if (width === 1200) assert.ok(Math.abs(computed.width - expectedWidth) < 1.5, `width ${computed.width} at ${scale}%`);
      }
    }
  } finally {
    await browser.close();
  }
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
