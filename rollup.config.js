import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import livereload from "rollup-plugin-livereload";
import serve from "rollup-plugin-serve";

const isDevelopment = Boolean(process.env.ROLLUP_WATCH);

/**
 * Copies the locale dictionaries (`src/i18n/locales/`) next to the bundle (`dist/locales/`) so
 * i18n fetches the active one at runtime instead of bundling all of them - mirroring the
 * `new URL("locales/...", import.meta.url)` resolution in src/i18n/index.ts.
 */
function copyLocales() {
  const sourceDir = path.resolve("src/i18n/locales");
  const outputDir = path.resolve("dist", "locales");
  return {
    name: "copy-locales",
    buildStart() {
      for (const fileName of readdirSync(sourceDir)) {
        if (fileName.endsWith(".json")) {
          this.addWatchFile(path.join(sourceDir, fileName));
        }
      }
    },
    writeBundle() {
      mkdirSync(outputDir, { recursive: true });
      for (const fileName of readdirSync(sourceDir)) {
        if (fileName.endsWith(".json")) {
          copyFileSync(path.join(sourceDir, fileName), path.join(outputDir, fileName));
        }
      }
    },
  };
}

/**
 * Concatenates the per-surface stylesheets (`styles/`) into a single `dist/styles.css`, in
 * cascade order - tokens/reset first, then each surface. CSS is a static asset (Rollup does not
 * process it); this only assembles the parts, and the order is explicit because the cascade
 * depends on it. Each file is a verbatim slice, so the concatenation is byte-identical to the
 * former monolithic `base.css`.
 */
function bundleStyles() {
  const stylesDir = path.resolve("styles");
  const cascadeOrder = [
    "tokens.css",
    "reset.css",
    "frame.css",
    "confirm.css",
    "middlebar.css",
    "preview.css",
    "graph.css",
    "nodes.css",
    "params.css",
    "color.css",
    "curve.css",
    "graph-overlays.css",
    "timeline.css",
    "segmented.css",
    "switch.css",
    "modal.css",
    "tooltip.css",
  ];
  return {
    name: "bundle-styles",
    buildStart() {
      for (const fileName of cascadeOrder) {
        this.addWatchFile(path.join(stylesDir, fileName));
      }
    },
    writeBundle() {
      const combined = cascadeOrder
        .map((fileName) => readFileSync(path.join(stylesDir, fileName), "utf8"))
        .join("");
      mkdirSync("dist", { recursive: true });
      writeFileSync(path.resolve("dist", "styles.css"), combined);
    },
  };
}

export default {
  input: "src/main.ts",
  output: {
    dir: "dist",
    format: "es",
    sourcemap: true,
    entryFileNames: "main.js",
    chunkFileNames: "[name]-[hash].js",
  },
  plugins: [
    copyLocales(),
    bundleStyles(),
    nodeResolve({ browser: true }),
    typescript({ tsconfig: "./tsconfig.build.json" }),
    isDevelopment &&
      serve({
        contentBase: ["."],
        host: "0.0.0.0",
        port: 8006,
        historyApiFallback: false,
      }),
    isDevelopment && livereload({ watch: "dist" }),
  ],
};
