import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
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
  sourceForInline("src/plan.js"),
  sourceForInline("src/quotes.js"),
  sourceForInline("src/sync.js"),
  sourceForInline("src/workout.js"),
  sourceForInline("src/nutrition.js"),
  sourceForInline("src/settings.js"),
  sourceForInline("src/chat.js"),
  sourceForInline("src/main.js"),
].join("\n\n");
const builtHtml = html.replace('<script src="/dist/app.js"></script>', `<script>\n${inlineJs}\n</script>`);

writeFileSync("dist/index.html", builtHtml);

// Vercel serves ONLY dist/ (vercel.json outputDirectory). Static files the page
// asks for must be copied in, or they 404 in production: the bundled form
// demos (demos/map.json + images) never loaded for this reason, and the
// manifest/icons were missing too. sw.js is deliberately NOT copied yet: its
// PRECACHE lists /dist/app.js, which does not exist at the production root.
cpSync("demos", "dist/demos", { recursive: true });
for (const f of ["manifest.json", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
  if (existsSync(f)) cpSync(f, "dist/" + f);
}
