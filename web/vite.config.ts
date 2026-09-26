import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockApi } from "./mock/server.ts";

// `npm run dev`: in-memory mock API (mock/server.ts).
// `npm run dev:real`: no mock; /api is proxied to API_URL (default http://localhost:3000).
export default defineConfig(({ mode }) => ({
  plugins: mode === "real" ? [react()] : [react(), mockApi()],
  server: mode === "real" ? { proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" } } : undefined,
}));
