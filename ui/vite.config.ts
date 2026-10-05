import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.HARNESS_API ?? "http://localhost:8300";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: { "/api": api, "/v1": api },
  },
});
