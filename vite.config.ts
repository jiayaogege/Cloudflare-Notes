import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: "index.html"
    }
  },
  server: {
    port: 5173
  }
});
