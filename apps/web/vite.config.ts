import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const e2eStatePath = fileURLToPath(new URL("./.wrangler/test-state-v4", import.meta.url));
  return {
    plugins: [
      react(),
      cloudflare(mode === "e2e" ? { persistState: { path: e2eStatePath } } : undefined),
    ],
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
  };
});
