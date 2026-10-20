// Bundle the bot into one ESM file (no runtime transpiler, so the jail can forbid every subprocess).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/bot.ts"], outfile: "dist/bot.mjs", bundle: true, platform: "node", format: "esm", target: "node22",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "eof", logLevel: "warning",
});
copyFileSync("node_modules/@resvg/resvg-wasm/index_bg.wasm", "dist/resvg.wasm");
console.log("built dist/bot.mjs + dist/resvg.wasm");
