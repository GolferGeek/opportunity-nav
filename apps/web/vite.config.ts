import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.OPNAV_API ?? "http://127.0.0.1:4317";
export default defineConfig({
  plugins: [react()],
  server: { port: 5317, proxy: { "/api": api, "/a2a": api, "/mcp": api, "/.well-known": api } },
});
