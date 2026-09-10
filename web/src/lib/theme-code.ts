import type { ThemeRegistrationRaw } from "shiki/core";

function build(name: string, type: "dark" | "light", palette: Record<string, string>): ThemeRegistrationRaw {
  const get = (key: string) => palette[key] ?? palette.text ?? "#000";
  return {
    name,
    type,
    colors: { "editor.background": "#00000000", "editor.foreground": get("text") },
    settings: [
      { settings: { foreground: get("text"), background: "#00000000" } },
      { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: get("comment"), fontStyle: "italic" } },
      {
        scope: ["keyword", "storage", "storage.type", "keyword.control", "keyword.operator.new", "keyword.operator.expression"],
        settings: { foreground: get("keyword") },
      },
      { scope: ["string", "string.quoted", "punctuation.definition.string"], settings: { foreground: get("string") } },
      { scope: ["constant.numeric", "constant.language", "constant.character", "keyword.other.unit"], settings: { foreground: get("number") } },
      {
        scope: ["entity.name.function", "support.function", "meta.function-call.generic", "variable.function"],
        settings: { foreground: get("func") },
      },
      {
        scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "storage.type.class"],
        settings: { foreground: get("type") },
      },
      { scope: ["variable", "meta.definition.variable", "variable.other.readwrite"], settings: { foreground: get("text") } },
      { scope: ["variable.parameter", "meta.parameter"], settings: { foreground: get("param") } },
      {
        scope: ["variable.other.property", "support.variable.property", "meta.object-literal.key", "entity.name.tag.yaml", "support.type.property-name"],
        settings: { foreground: get("prop") },
      },
      { scope: ["entity.name.tag", "punctuation.definition.tag"], settings: { foreground: get("tag") } },
      { scope: ["entity.other.attribute-name"], settings: { foreground: get("attr") } },
      { scope: ["keyword.operator", "punctuation", "meta.brace"], settings: { foreground: get("punct") } },
      { scope: ["string.regexp", "constant.character.escape"], settings: { foreground: get("regex") } },
      { scope: ["markup.inserted", "markup.inserted.diff"], settings: { foreground: get("add") } },
      { scope: ["markup.deleted", "markup.deleted.diff"], settings: { foreground: get("del") } },
      { scope: ["markup.heading", "entity.name.section"], settings: { foreground: get("func"), fontStyle: "bold" } },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
      { scope: ["invalid", "invalid.illegal"], settings: { foreground: get("tag") } },
    ],
  };
}

export const citropyDark = build("citropy-dark", "dark", {
  text: "#dfe3ee",
  comment: "#525a6b",
  keyword: "#a78bfa",
  string: "#7bd88f",
  number: "#ffab70",
  func: "#7d9cff",
  type: "#5fd7d0",
  param: "#c0c7d8",
  prop: "#9bb4ff",
  tag: "#f4657a",
  attr: "#ffc453",
  punct: "#818999",
  regex: "#3ecf8e",
  add: "#3ecf8e",
  del: "#f4657a",
});

export const citropyLight = build("citropy-light", "light", {
  text: "#1a1d26",
  comment: "#8a91a0",
  keyword: "#7c3aed",
  string: "#15803d",
  number: "#b45309",
  func: "#2563eb",
  type: "#0f766e",
  param: "#3f4657",
  prop: "#1d4ed8",
  tag: "#be123c",
  attr: "#a16207",
  punct: "#6b7280",
  regex: "#15803d",
  add: "#15803d",
  del: "#be123c",
});
