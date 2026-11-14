import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { transform as transformCss } from "lightningcss";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import livereload from "rollup-plugin-livereload";
import serve from "rollup-plugin-serve";

const isDevelopment = Boolean(process.env.ROLLUP_WATCH);

/**
 * Copies every `.json` file from `sourceDir` next to the bundle (`dist/<outputName>/`) so runtime
 * code can `fetch` one via `new URL("<outputName>/...", import.meta.url)` instead of bundling all
 * of them as modules. Shared by the locale dictionaries (`src/i18n/locales/`) and the bundled
 * project presets (`src/persistence/presets/`).
 */
function copyJsonAssets(sourceDir, outputName) {
  const resolvedSourceDir = path.resolve(sourceDir);
  const outputDir = path.resolve("dist", outputName);
  return {
    name: `copy-${outputName}`,
    buildStart() {
      for (const fileName of readdirSync(resolvedSourceDir)) {
        if (fileName.endsWith(".json")) {
          this.addWatchFile(path.join(resolvedSourceDir, fileName));
        }
      }
    },
    writeBundle() {
      mkdirSync(outputDir, { recursive: true });
      for (const fileName of readdirSync(resolvedSourceDir)) {
        if (fileName.endsWith(".json")) {
          copyFileSync(path.join(resolvedSourceDir, fileName), path.join(outputDir, fileName));
        }
      }
    },
  };
}

/**
 * Concatenates the per-surface stylesheets (`styles/`) into a single `dist/styles.css`, in
 * cascade order - tokens/reset first, then each surface. CSS is a static asset (Rollup does not
 * process it); this only assembles the parts, and the order is explicit because the cascade
 * depends on it. Production builds minify the result, and watch builds keep it readable.
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
    "unsupported.css",
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
      const output = isDevelopment
        ? combined
        : transformCss({ filename: "styles.css", code: Buffer.from(combined), minify: true }).code;
      mkdirSync("dist", { recursive: true });
      writeFileSync(path.resolve("dist", "styles.css"), output);
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
    copyJsonAssets("src/i18n/locales", "locales"),
    copyJsonAssets("src/persistence/presets", "presets"),
    bundleStyles(),
    nodeResolve({ browser: true }),
    typescript({ tsconfig: "./tsconfig.build.json" }),
    !isDevelopment && terser({ module: true }),
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
