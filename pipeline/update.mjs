#!/usr/bin/env node
/**
 * 一键更新：抓最新数据 → 回填中文文案 → 刷新缓存版本号 → 提交并推送
 *
 * 用法：双击根目录的「更新.bat」，或者 node pipeline/update.mjs
 *
 * 它不做的：改配色、改页面结构、叫模型写文案（文案走本地库，免费）。
 *
 * 2026-10-29 修：这台机器 PATH 里没有 git，原来 publish() 里 spawnSync("git") 直接失败，
 * 只 warn 一句就正常退出，于是每天抓完本地、线上永远是旧的，日志还写着「抓取成功」。
 * 现在改成：自己找 git（含 WorkBuddy 自带的 PortableGit）、找不到或推不上去就退出码 1，
 * 并且推送完回头核验远端 HEAD，核验不过也算失败。只有真推上去了才写「今日已同步」标记。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const OUT = path.join(ROOT, "pipeline", "out");
const MARK_DIR = path.join(OUT, "pushed");

function run(args) {
  const r = spawnSync(NODE, args, { cwd: ROOT, stdio: "inherit" });
  return r.status === 0;
}

console.log("======================================");
console.log(" githubhot 更新");
console.log("======================================\n");

console.log("── 1/5  抓取 GitHub 最新数据 ──────────\n");
if (process.env.GITHUBHOT_SKIP_FETCH) {
  console.log("带了 GITHUBHOT_SKIP_FETCH，跳过抓取，直接用本地已经有数据。");
} else if (!run(["pipeline/fetch.mjs", "--out", "assets/data.auto.js", "--var", "GH_DATA_AUTO"])) {
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
const published = publish();

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
if (published) {
  console.log(" 完成。已推到线上，约 1 分钟后生效（Ctrl+R 刷新）");
} else {
  console.log(" ✗ 数据抓到了、但没推上去，线上还是旧的");
}
console.log("======================================");
if (miss) {
  console.log(`\n提示：${total} 条里有 ${miss} 条没有中文文案，页面上会显示英文。`);
  console.log("把它们补进 pipeline/zh.json 就行，格式 {desc, why}。");
} else {
  console.log(`\n${total} 条全部有中文文案。`);
}

if (!published) process.exitCode = 1;

/**
 * 本地跑完直接推上 GitHub，不然只改了本地文件，线上（zzzckol.github.io）永远是旧的。
 *
 * 返回 true 只有一种情况：远端确实已经有今天这份数据了。
 * 任何一步没成，都返回 false，让上层（auto-daily.pyw）知道这不是成功。
 */
function publish() {
  if (process.env.GITHUB_ACTIONS || process.env.CI) {
    console.log("在 CI 里跑，交给工作流自己提交，跳过。");
    return true;
  }
  if (process.argv.includes("--no-push")) {
    console.log("带了 --no-push，只更新本地文件，不推送。");
    return true;
  }

  const gitPath = findGit();
  if (!gitPath) {
    console.error("✗ 找不到 git.exe，推不上去，线上不会变。");
    console.error("  装一个 Git，或把路径写进环境变量 GITHUBHOT_GIT 再重试。");
    return false;
  }
  console.log(`用这个 git：${gitPath}`);

  const git = (args) => spawnSync(gitPath, args, { cwd: ROOT, encoding: "utf8" });

  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) {
    console.error("✗ 这个目录不是 git 仓库，推不上去，线上不会变。");
    return false;
  }

  // 先把远端最新状态拉下来，避免基于过期信息判断「有没有东西要推」
  const fetched = git(["fetch", "origin", "main"]);
  if (fetched.status !== 0) {
    console.error("✗ 拉取远端失败，大概率是网络或 SSH 权限。线上不会变。");
    console.error((fetched.stderr || "").trim().split("\n").slice(-3).join("\n"));
    return false;
  }

  // 有改动就先提交
  const st = git(["status", "--porcelain"]);
  if (st.status !== 0) {
    console.error("✗ git status 读不出来，放弃推送。");
    return false;
  }
  if (st.stdout.trim()) {
    git(["add", "-A"]);
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const commit = git(["commit", "-q", "-m", `data: ${day}`]);
    if (commit.status !== 0) {
      console.error("✗ 提交失败，线上不会变。手动 git status 看一眼。");
      console.error((commit.stderr || "").trim().split("\n").slice(-3).join("\n"));
      return false;
    }
    console.log(`已提交：data: ${day}`);
  } else {
    console.log("本地没有新改动。");
  }

  // 如果上次推送失败过，本地会领先远端若干提交，这里一并推上去
  const aheadRun = git(["rev-list", "--count", "origin/main..HEAD"]);
  const ahead = aheadRun.status === 0 ? parseInt(aheadRun.stdout.trim(), 10) || 0 : 0;
  if (ahead === 0) {
    console.log("远端已经是这个版本，没有要推的提交。");
  } else {
    console.log(`本地领先远端 ${ahead} 个提交，开始推送…`);
    const push = git(["push", "origin", "HEAD:main"]);
    if (push.status !== 0) {
      console.error("✗ 推送失败，线上还是旧数据。");
      console.error((push.stderr || "").trim().split("\n").slice(-4).join("\n"));
      return false;
    }
  }

  // 核验：推完再问一次远端，确认远端 main 真的等于本地 HEAD
  const remote = git(["ls-remote", "origin", "refs/heads/main"]);
  const local = git(["rev-parse", "HEAD"]);
  if (remote.status !== 0 || local.status !== 0) {
    console.error("✗ 推送后核验失败，无法确认线上是否已更新。");
    return false;
  }
  const remoteSha = (remote.stdout.trim().split(/\s+/)[0] || "").trim();
  const localSha = local.stdout.trim();
  if (remoteSha !== localSha) {
    console.error(`✗ 核验不通过：远端 ${remoteSha.slice(0, 7)}，本地 ${localSha.slice(0, 7)}。线上可能还是旧的。`);
    return false;
  }
  console.log(`✓ 核验通过：远端 main = ${remoteSha.slice(0, 7)}`);

  markPushed();
  console.log("已推送。GitHub Pages 大约 30~60 秒生效。");
  return true;
}

/** 写「今天已经同步过」标记，auto-daily.pyw 靠它决定要不要重试 */
function markPushed() {
  try {
    fs.mkdirSync(MARK_DIR, { recursive: true });
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(MARK_DIR, `${day}.txt`),
      `${new Date().toISOString()}\n`,
      "utf8",
    );
  } catch (e) {
    console.warn("（标记文件没写成功，不影响本次推送）");
  }
}

/**
 * 找 git.exe。
 * 这台机器 PATH 上没有 git，但 WorkBuddy 自带了一份 PortableGit，优先用它。
 */
function findGit() {
  const cands = [];
  if (process.env.GITHUBHOT_GIT) cands.push(process.env.GITHUBHOT_GIT);

  // WorkBuddy 自带的 PortableGit：versions/<版本号>/cmd/git.exe
  const pgRoot = path.join(os.homedir(), ".workbuddy", "binaries", "PortableGit", "versions");
  try {
    if (fs.existsSync(pgRoot)) {
      for (const v of fs.readdirSync(pgRoot).sort().reverse()) {
        cands.push(path.join(pgRoot, v, "cmd", "git.exe"));
        cands.push(path.join(pgRoot, v, "bin", "git.exe"));
      }
    }
  } catch (e) {
    /* 忽略，继续找别的 */
  }

  cands.push(
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "/usr/bin/git",
    "/usr/local/bin/git",
  );

  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) {
        const ok = spawnSync(c, ["--version"], { encoding: "utf8" });
        if (ok.status === 0) return c;
      }
    } catch (e) {
      /* 试下一个 */
    }
  }

  // 最后再试 PATH
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "git";
  return null;
}
