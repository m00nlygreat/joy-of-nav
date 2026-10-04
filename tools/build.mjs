import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--project", resolve(root, "tsconfig.json")], { stdio: "inherit" });
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });

await build({
  entryPoints: {
    "background": resolve(root, "src/extension/background.ts"),
    "content": resolve(root, "src/extension/content.ts"),
    "popup": resolve(root, "src/extension/popup.ts"),
    "settings": resolve(root, "src/extension/settings-page.ts"),
  },
  outdir: resolve(dist, "extension"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  sourcemap: false,
});

await build({
  entryPoints: [resolve(root, "src/core/index.ts")],
  outdir: resolve(dist, "core"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["es2022"],
});

console.log("Built Chrome extension in dist/ (load this folder as an unpacked extension).");
