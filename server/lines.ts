import type { Readable } from "node:stream";

export function onLines(stream: Readable, handle: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handle(line);
      index = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line) handle(line);
    buffer = "";
  });
}

export function onJson(stream: Readable, handle: (value: unknown) => void, onText?: (line: string) => void): void {
  onLines(stream, (line) => {
    if (line[0] !== "{" && line[0] !== "[") {
      onText?.(line);
      return;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      onText?.(line);
    }
  });
}
