import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "dist/app.js",
});

function sourceForInline(path) {
  return readFileSync(path, "utf8")
    .replace(/^import .*$/gm, "")
    .replace(/^export /gm, "");
}

const html = readFileSync("index.html", "utf8");
const inlineJs = [
  sourceForInline("src/runtime.js"),
  sourceForInline("src/constants.js"),
  sourceForInline("src/state.js"),
  sourceForInline("src/ui.js"),
  sourceForInline("src/phase.js"),
  sourceForInline("src/quotes.js"),
  sourceForInline("src/sync.js"),
  sourceForInline("src/main.js"),
].join("\n\n");
const builtHtml = html.replace('<script src="/dist/app.js"></script>', `<script>\n${inlineJs}\n</script>`);

writeFileSync("dist/index.html", builtHtml);
