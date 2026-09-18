import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          shiki: ["shiki"],
          xterm: [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-webgl",
            "@xterm/addon-web-links",
          ],
        },
      },
    },
  },
  server: {
    port: Number(process.env.CITROPY_UI_PORT ?? 5177),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.CITROPY_PORT ?? (process.env.CITROPY_DEVELOPMENT === "1" ? 4178 : 4177)}`,
      "/socket": {
        target: `ws://127.0.0.1:${process.env.CITROPY_PORT ?? (process.env.CITROPY_DEVELOPMENT === "1" ? 4178 : 4177)}`,
        ws: true,
      },
    },
  },
});
