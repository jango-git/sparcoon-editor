// Flags CSS custom properties that are declared but never referenced. A "use" is any
// occurrence outside the `--name:` declaration itself, so TS reads via getPropertyValue()
// count too. Vendored/generated directories are skipped since they are not our stylesheet.
// Use counts apply a trailing (?![\w-]) word boundary so --accent does not match
// --accent-hue, then subtract declaration-site matches so declaring alone isn't a "use".
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const skippedDirectories = new Set(["node_modules", "dist", ".git", ".tscache"]);

function walk(directory, extensions, results = []) {
  for (const entry of readdirSync(directory)) {
    if (skippedDirectories.has(entry)) continue;
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) walk(fullPath, extensions, results);
    else if (extensions.has(extname(fullPath))) results.push(fullPath);
  }
  return results;
}

const declarationFiles = walk(join(root, "styles"), new Set([".css"]));

const declarationPattern = /(--[a-z0-9-]+)\s*:/gi;
const declarations = new Map();
for (const file of declarationFiles) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, index) => {
      for (const match of text.matchAll(declarationPattern)) {
        const name = match[1];
        if (!declarations.has(name)) declarations.set(name, []);
        declarations.get(name).push({ file: relative(root, file), line: index + 1 });
      }
    });
}

const usageFiles = [
  ...walk(join(root, "styles"), new Set([".css"])),
  ...walk(join(root, "src"), new Set([".ts", ".tsx", ".js", ".mjs"])),
  join(root, "index.html"),
];
const corpus = usageFiles
  .map((file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const dead = [];
for (const [name, locations] of declarations) {
  const total = (corpus.match(new RegExp(escape(name) + "(?![\\w-])", "g")) ?? []).length;
  const declared = (corpus.match(new RegExp(escape(name) + "\\s*:", "g")) ?? []).length;
  if (total - declared <= 0) dead.push({ name, locations });
}

if (dead.length === 0) {
  console.log(`check-dead-css-tokens: ${declarations.size} custom properties, none dead.`);
  process.exit(0);
}

console.error(
  `check-dead-css-tokens: ${dead.length} DEAD custom propert${dead.length === 1 ? "y" : "ies"} (declared, never used):\n`,
);
for (const { name, locations } of dead) {
  console.error(`  ${name}`);
  for (const location of locations)
    console.error(`    declared at ${location.file}:${location.line}`);
}
console.error("\nRemove them, or reference them where intended.");
process.exit(1);
