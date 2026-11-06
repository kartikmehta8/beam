import { build } from "esbuild";
import {
  cpSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

const domain =
  process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const origin = new URL(
  process.env.SITE_URL ||
    (domain ? `https://${domain}` : "http://127.0.0.1:18789"),
);
if (
  !["https:", "http:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
) {
  throw new Error(
    "SITE_URL must be an HTTP(S) origin without credentials, path, query or fragment.",
  );
}

rmSync("dist", { recursive: true, force: true });
cpSync("public", "dist", { recursive: true });
for (const file of [
  "index.html",
  "download/index.html",
  "privacy.html",
  "robots.txt",
  "sitemap.xml",
]) {
  const destination = path.join("dist", file);
  writeFileSync(
    destination,
    readFileSync(destination, "utf8").replaceAll("__SITE_URL__", origin.origin),
  );
}

await build({
  entryPoints: { interactions: "src/interactions.jsx" },
  outdir: "dist/assets",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});

const sources = [
  "dist/index.html",
  "dist/download/index.html",
  "dist/privacy.html",
  "src/interactions.jsx",
  "src/FeatureJourney.jsx",
  "src/ProductPreview.jsx",
];
const names = new Set([
  "x",
  "scan",
  "loader-2",
  "check",
  "copy",
  "refresh",
  "shield-check",
  "alert-triangle",
  "shield-x",
  "player-pause",
  "player-play",
  "player-stop",
  "circle-check",
  "download",
  "fingerprint",
  "arrows-horizontal",
  "link",
]);
for (const file of sources) {
  for (const match of readFileSync(file, "utf8").matchAll(
    /(?:icons\.svg#|icon:\s*['"]|<Icon\s+name=['"])([a-z0-9-]+)(?=['"`])/g,
  ))
    names.add(match[1]);
}
const symbols = [...names].sort().map((name) => {
  const body = readFileSync(
    path.join("node_modules/@tabler/icons/icons/outline", name + ".svg"),
    "utf8",
  )
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  return `<symbol id="${name}" viewBox="0 0 24 24">${body}</symbol>`;
});
writeFileSync(
  "dist/assets/icons.svg",
  '<svg xmlns="http://www.w3.org/2000/svg">' + symbols.join("") + "</svg>",
);
copyFileSync("src/react-bits/LICENSE.md", "dist/assets/react-bits-license.txt");
const gsapPackage = JSON.parse(
  readFileSync("node_modules/gsap/package.json", "utf8"),
);
writeFileSync(
  "dist/assets/gsap-license.txt",
  `GSAP ${gsapPackage.version}\n${gsapPackage.license}\n`,
);
console.log(
  `Built ${names.size} icons, ${statSync("dist/assets/interactions.js").size} byte interaction bundle for ${origin.origin}.`,
);
