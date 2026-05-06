import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  // Load env files from the project root (where .env lives), not frontend/.env.
  envDir: "..",
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        ws: true,
      },
      "/health": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../frontend-dist",
    emptyOutDir: true,
  },
});
