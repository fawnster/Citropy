if (process.argv.includes("--computer-indicator")) await import("./computer-indicator-host.mjs");
else await import("./main.mjs");
