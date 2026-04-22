import { defineConfig } from "vite";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 4096,
    manifest: "manifest.json",
  },
});
