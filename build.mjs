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
// manifest/icons were missing too, and so was sw.js: the app never had an
// offline mode in production until this copy.
// index.json is the build script's source list, not needed at runtime.
cpSync("demos", "dist/demos", { recursive: true, filter: (src) => !src.endsWith("index.json") });
// The service worker, with every bundled demo listed for precaching so the
// app works offline.
{
  const map = JSON.parse(readFileSync("demos/map.json", "utf8"));
  const demos = [...new Set(Object.values(map).flat())].map((f) => "/" + f);
  writeFileSync("dist/sw.js", readFileSync("sw.js", "utf8").replace("/*__DEMOS__*/", demos.map((d) => JSON.stringify(d)).join(",")));
}
for (const f of ["manifest.json", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
  if (existsSync(f)) cpSync(f, "dist/" + f);
}
