import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";
import { spanish, translateFor } from "../web/src/lib/translations.ts";
import { summarize } from "../web/src/lib/group.ts";

const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test("translations preserve placeholders, literal values, and English fallback", () => {
  for (const [key, translated] of Object.entries(spanish)) {
    assert.ok(translated.trim(), key);
    assert.deepEqual(placeholders(translated), placeholders(key), key);
  }
  assert.equal(translateFor("es", "Open"), "Abrir");
  assert.equal(translateFor("es", "Open", undefined, "status"), "Abierta");
  assert.equal(translateFor("en", "Open", undefined, "status"), "Open");
  assert.equal(translateFor("es", "Read"), "Lectura");
  assert.equal(translateFor("es", "Read", undefined, "past"), "Leído");
  assert.equal(translateFor("es", "Close {name}", { name: "{count}<script>" }), "Cerrar {count}<script>");
  assert.equal(translateFor("en", "Close {name}", { name: "source.ts" }), "Close source.ts");
  assert.equal(translateFor("es", "Unrecognized provider detail"), "Unrecognized provider detail");
  for (const text of ["constructor", "__proto__", "toString"])
    assert.equal(translateFor("es", text), text);
});

test("tool activity summaries keep their language and count distinct files", () => {
  const english = (message, values, context) => translateFor("en", message, values, context);
  const spanish = (message, values, context) => translateFor("es", message, values, context);
  const tools = [
    { shape: "read", headline: "one.ts" },
    { shape: "read", headline: "one.ts" },
    { shape: "read", headline: "two.ts" },
    { shape: "command", headline: "npm test" },
  ];
  assert.equal(summarize(tools, english), "Read 2 files and ran 1 command");
  assert.equal(summarize(tools, spanish), "Leyó 2 archivos y ejecutó 1 comando");
  assert.equal(summarize([], english), "Worked");
  assert.equal(summarize([], spanish), "Trabajó");
});

test("every explicit UI translation has a Spanish entry", async () => {
  const root = fileURLToPath(new URL("../web/src", import.meta.url));
  async function files(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
  }
  const missing = [];
  for (const file of (await files(root)).filter(file => /\.tsx?$/.test(file) && !file.includes("/locales/"))) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const inspect = node => {
      if (ts.isCallExpression(node) && ["t", "translate"].includes(node.expression.getText(source))) {
        const message = node.arguments[0];
        const strings = expression => expression && ts.isStringLiteral(expression) ? [expression.text] : expression && ts.isConditionalExpression(expression) ? [...strings(expression.whenTrue), ...strings(expression.whenFalse)] : [];
        for (const key of strings(message)) {
          const context = node.arguments[2];
          const lookup = context && ts.isStringLiteral(context) ? `${context.text}:${key}` : key;
          if (!Object.hasOwn(spanish, lookup) && !Object.hasOwn(spanish, key) && !["GitHub", "Citropy", "Codex", "OpenCode", "Claude Code"].includes(key)) {
            missing.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${lookup}`);
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  assert.deepEqual(missing, []);
});
