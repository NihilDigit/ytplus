import { mkdirSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const VERSION = "0.2.0";
const srcDir = resolve(import.meta.dir, "../src");
const outDir = resolve(import.meta.dir, "../dist");
const outFile = resolve(outDir, "ytplus.user.js");
const legacyOutFile = resolve(outDir, "ytpremiumplus.user.js");
const devLoaderFile = resolve(outDir, "ytplus.dev.user.js");
const legacyDevLoaderFile = resolve(outDir, "ytpremiumplus.dev.user.js");
const fileUrl = `file:///${outFile.replace(/\\/g, "/")}`;

function createHeader(extraLines: string[] = []): string {
  const lines = [
    "// ==UserScript==",
    "// @name         YT+",
    "// @name:zh-CN   YT+",
    "// @name:en      YT+",
    "// @namespace    https://github.com/NihilDigit/ytplus",
    "// @homepageURL  https://github.com/NihilDigit/ytplus",
    "// @supportURL   https://github.com/NihilDigit/ytplus/issues",
    `// @version      ${VERSION}`,
    "// @description  YouTube 字幕组式分批 LLM 翻译、标题简介本地化、三级字幕源瀑布流、SponsorBlock 自动跳过与平板触屏增强",
    "// @description:zh-CN YouTube 字幕组式分批 LLM 翻译、标题简介本地化、三级字幕源瀑布流、SponsorBlock 自动跳过与平板触屏增强",
    "// @description:en Fansub-grade batched LLM subtitle & metadata translation, 3-tier caption waterfall, SponsorBlock auto-skip, and tablet touch gestures for YouTube",
    "// @author       NihilDigit",
    "// @license      MIT",
    "// @match        https://www.youtube.com/*",
    "// @match        https://m.youtube.com/*",
    "// @run-at       document-start",
    "// @grant        GM_xmlhttpRequest",
    "// @grant        GM_getValue",
    "// @grant        GM_setValue",
    "// @grant        unsafeWindow",
    "// @connect      *",
    "// @connect      localhost",
    "// @connect      127.0.0.1",
    ...extraLines,
    "// ==/UserScript==",
  ];
  return lines.join("\n");
}

async function buildOnce(): Promise<boolean> {
  const entrypoint = resolve(srcDir, "index.ts");

  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "iife",
    minify: false,
  });

  if (!result.success) {
    console.error("[build] Failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    return false;
  }

  const body = await result.outputs[0].text();
  mkdirSync(outDir, { recursive: true });

  // 1. Full standalone userscript
  const fullScript = `${createHeader()}\n\n${body}`;
  writeFileSync(outFile, fullScript, "utf8");
  writeFileSync(legacyOutFile, fullScript, "utf8");

  // 2. Lightweight @require file:// loader for Tampermonkey instant local hot-reload
  const devHeader = createHeader([`// @require      ${fileUrl}`]);
  const devContent = `${devHeader}\n// Dev loader: actual bundle is loaded via @require from ${fileUrl}\n`;
  writeFileSync(devLoaderFile, devContent, "utf8");
  writeFileSync(legacyDevLoaderFile, devContent, "utf8");

  console.log(
    `[build] Built -> ${outFile} (${(body.length / 1024).toFixed(1)} KB) & ${devLoaderFile}`,
  );
  return true;
}

const args = new Set(process.argv.slice(2));
const isWatch = args.has("--watch") || args.has("--dev");
const isServe = args.has("--serve") || args.has("--dev");

await buildOnce();

if (isServe) {
  const port = Number(process.env.PORT || 43210);
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (
        url.pathname === "/ytplus.user.js" ||
        url.pathname === "/ytpremiumplus.user.js" ||
        url.pathname === "/"
      ) {
        return new Response(Bun.file(outFile), {
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  console.log(`[serve] Local Userscript URL: http://127.0.0.1:${port}/ytplus.user.js`);
}

if (isWatch) {
  console.log(`[watch] Watching ${srcDir} for changes...`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(srcDir, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void buildOnce();
    }, 80);
  });
}
