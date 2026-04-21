import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://tech-dashboard.pages.dev",
  output: "static",
  // "ignore" accepts both /foo and /foo/ — safer for preview + Cloudflare Pages.
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
  vite: {
    resolve: {
      preserveSymlinks: true,
    },
    build: {
      rollupOptions: {
        // Pagefind is generated after Astro build (see package.json build script);
        // reference is resolved at runtime from /pagefind/.
        external: ["/pagefind/pagefind.js"],
      },
    },
  },
});
