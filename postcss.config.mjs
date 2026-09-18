import { sep } from "node:path";

const pixels = /(-?(?:\d+\.?\d*|\.\d+))px\b/g;
const appStyles = `${sep}web${sep}src${sep}styles${sep}`;

export function scaleValue(value) {
  return value.replace(pixels, (match, number) =>
    Number(number) === 0 ? match : `round(${number}px * var(--ui-scale), 1px)`,
  );
}

export function scaleContainerQuery(params) {
  return params.replace(pixels, (_, number) => `${Number(number) / 16}rem`);
}

export function scalePixels() {
  return {
    postcssPlugin: "scale-pixels",
    Once(root) {
      if (!root.source?.input.file?.includes(appStyles)) return;
      root.walkDecls((declaration) => {
        if (!declaration.value.includes("url(")) declaration.value = scaleValue(declaration.value);
      });
      root.walkAtRules("container", (rule) => {
        rule.params = scaleContainerQuery(rule.params);
      });
    },
  };
}
scalePixels.postcss = true;

export default { plugins: [scalePixels()] };
