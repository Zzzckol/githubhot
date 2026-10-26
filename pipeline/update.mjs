#!/usr/bin/env node
/**
 * 一键更新：抓最新数据 → 回填中文文案 → 刷新浏览器缓存版本号
 *
 * 用法：双击根目录的「更新.bat」，或者 node pipeline/update.mjs
 *
 * 它不做的：改配色、改页面结构、叫模型写文案（文案走本地库，免费）。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

function run(args) {
  const r = spawnSync(NODE, args, { cwd: ROOT, stdio: "inherit" });
  return r.status === 0;
}

console.log("======================================");
console.log(" githubhot 更新");
console.log("======================================\n");

console.log("── 1/3  抓取 GitHub 最新数据 ──────────\n");
if (!run(["pipeline/fetch.mjs", "--out", "assets/data.auto.js", "--var", "GH_DATA_AUTO"])) {
  console.error("\n✗ 抓取失败。先确认能不能打开 api.github.com，再重试。");
  console.error("  已有数据没有被破坏，页面还能看。");
  process.exit(1);
}

console.log("\n── 2/3  回填中文文案 ──────────────────\n");
if (!run(["pipeline/enrich.mjs", "--local-only"])) {
  console.error("\n✗ 文案层失败，但数据已经更新了，页面上新项目会显示英文原文。");
}

console.log("\n── 3/3  刷新缓存版本号 ────────────────\n");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const indexPath = path.join(ROOT, "index.html");
const before = fs.readFileSync(indexPath, "utf8");
const after = before.replace(/(assets\/[\w.]+\.js)\?v=[\w]*/g, "$1?v=" + stamp);
if (after !== before) {
  fs.writeFileSync(indexPath, after, "utf8");
  console.log("  版本号 → " + stamp);
} else {
  console.log("  版本号没变化（已经是 " + stamp + "）");
}

/* 顺手报一下本地库覆盖率，新项目多了就知道该补文案了 */
let miss = 0;
let total = 0;
try {
  const src = fs.readFileSync(path.join(ROOT, "assets/data.auto.js"), "utf8");
  const m = src.match(/window\.GH_DATA_AUTO\s*=\s*(\{[\s\S]*\});/);
  const data = JSON.parse(m[1]);
  total = data.items.length;
  miss = data.items.filter((i) => !i.desc || !i.why).length;
} catch (e) {
  /* 读不出来就算了，不影响更新 */
}

console.log("\n======================================");
console.log(" 完成。现在去刷新页面（或者按 Ctrl+R）");
console.log("======================================");
if (miss) {
  console.log(`\n提示：${total} 条里有 ${miss} 条没有中文文案，页面上会显示英文。`);
  console.log("把它们补进 pipeline/zh.json 就行，格式 {desc, why}。");
} else {
  console.log(`\n${total} 条全部有中文文案。`);
}
