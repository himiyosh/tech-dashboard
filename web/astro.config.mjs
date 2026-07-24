import { defineConfig } from "astro/config";

function buildPhaseTelemetry() {
  let startedAt = 0;
  const report = (phase, details = "") => {
    const elapsedSeconds = startedAt > 0
      ? Math.round((Date.now() - startedAt) / 1000)
      : 0;
    const rssMiB = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(
      `ASTRO: phase=${phase} elapsed=${elapsedSeconds}s rss=${rssMiB}MiB${details ? ` ${details}` : ""}`,
    );
  };

  return {
    name: "tech-dashboard-build-telemetry",
    hooks: {
      "astro:build:start": () => {
        startedAt = Date.now();
        report("start");
      },
      "astro:routes:resolved": ({ routes }) => {
        report("routes-resolved", `definitions=${routes.length}`);
      },
      "astro:build:setup": ({ pages, target }) => {
        report("setup", `target=${target} components=${pages.size}`);
      },
      "astro:build:generated": () => {
        report("generated");
      },
      "astro:build:done": ({ pages }) => {
        report("done", `pages=${pages.length}`);
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  site: "https://techdb.studio344.net",
  output: "static",
  // "ignore" accepts both /foo and /foo/ — safer for preview + Cloudflare Pages.
  trailingSlash: "ignore",
  build: {
    format: "directory",
    // Rendering is dominated by thousands of independent static files. Two
    // concurrent pages overlap filesystem waits without approaching the
    // memory pressure observed at higher fan-out.
    concurrency: 2,
  },
  integrations: [buildPhaseTelemetry()],
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
