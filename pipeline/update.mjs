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

console.log("── 1/5  抓取 GitHub 最新数据 ──────────\n");
if (!run(["pipeline/fetch.mjs", "--out", "assets/data.auto.js", "--var", "GH_DATA_AUTO"])) {
  console.error("\n✗ 抓取失败。先确认能不能打开 api.github.com，再重试。");
  console.error("  已有数据没有被破坏，页面还能看。");
  process.exit(1);
}

console.log("\n── 2/5  回填中文文案 ──────────────────\n");
if (!run(["pipeline/enrich.mjs", "--local-only"])) {
  console.error("\n✗ 文案层失败，但数据已经更新了，页面上新项目会显示英文原文。");
}

console.log("\n── 3/5  生成历史归档 ──────────────────\n");
if (!run(["pipeline/archive.mjs"])) {
  console.error("\n✗ 归档生成失败，页面上的「往回看」会缺今天这一天。");
}

console.log("\n── 4/5  刷新缓存版本号 ────────────────\n");
if (!run(["pipeline/stamp.mjs"])) {
  console.error("\n✗ 版本号没刷新，浏览器可能拿旧缓存。");
}

console.log("\n── 5/5  发布到线上（提交并推送）──────\n");
publish();

/**
 * 本地跑完直接推上 GitHub，不然只改了本地文件，线上（zzzckol.github.io）永远是旧的。
 * 2026-10-28 之前没有这一步，连着两天本地抓完、线上没动。
 * Actions 里跑会跳过，交给工作流自己提交；想只更新不推就加 --no-push。
 */
function publish() {
  if (process.env.GITHUB_ACTIONS || process.env.CI) {
    console.log("在 CI 里跑，交给工作流自己提交，跳过。");
    return;
  }
  if (process.argv.includes("--no-push")) {
    console.log("带了 --no-push，只更新本地文件，不推送。");
    return;
  }

  const git = (args) =>
    spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

  const st = git(["status", "--porcelain"]);
  if (st.status !== 0) {
    console.warn("✗ 这里不是 git 仓库（或 git 不可用），只更新了本地文件，线上不会变。");
    return;
  }
  if (!st.stdout.trim()) {
    console.log("没有文件变化，不用提交。");
    return;
  }

  git(["add", "-A"]);

  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const commit = git(["commit", "-q", "-m", `data: ${day}`]);
  if (commit.status !== 0) {
    console.warn("✗ 提交失败，线上不会变。手动 git status 看一眼。");
    return;
  }
  console.log(`已提交：data: ${day}`);

  // Actions 可能比本地先跑过并推了，先 rebase 再推，避免 non-fast-forward
  git(["pull", "--rebase", "--autostash", "--quiet"]);

  const push = git(["push", "origin", "HEAD"]);
  if (push.status !== 0) {
    console.warn("✗ 推送失败，线上还是旧数据。查一下网络或权限，然后手动 git push。");
    return;
  }
  console.log("已推送。GitHub Pages 大约 30~60 秒生效。");
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
