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
 *
 * 2026-10-30 再修：早上自动跑的时候，工作流 01:33 刚推过一次，本地 08:36 又抓了一遍，
 * rebase --autostash 弹回暂存内容时撞车，冲突标记留在文件里，但 rebase 退出码是 0，
 * 于是带 <<<<<<< 的 data.auto.js 和 index.html 被推上线，整站 JS 全挂、页面回落成 10-22 的存档。
 * 现在提交前有两道闸：暂存区不许有冲突标记、几个 .js 必须能通过 node --check。
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

  // 远端可能被工作流或另一台机器推过（比如 Actions 自己提交了 data: xxx），
  // 本地落后时直接 push 会被当成「非快进」拒掉，所以先 rebase 追上。
  const behindRun = git(["rev-list", "--count", "HEAD..origin/main"]);
  const behind = behindRun.status === 0 ? parseInt(behindRun.stdout.trim(), 10) || 0 : 0;
  if (behind > 0) {
    /* 关键判断：远端是不是已经有今天这份数据了？
       Actions 的定时任务和本机日更会抢同一天，谁先推上去另一个就没必要再抓再推——
       硬推就是两边都改同样的几个文件，必然冲突。2026-10-30 早上就是这么撞的：
       01:33 Actions 推了 6ae2a75，08:36 本机也抓了一遍，rebase 撞车，坏文件上了线。
       既然远端已经有了，本地这些改动直接丢掉、对齐远端，这才是最安全的做法。
       两道判断取其一即可：boards 里有今天的文件，或 data.auto.js 里的快照是今天的。 */
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const boardRun = git(["cat-file", "-e", `origin/main:pipeline/boards/${today}.json`]);
    const dataRun = git(["show", `origin/main:assets/data.auto.js`]);
    const dataTxt = dataRun.status === 0 ? dataRun.stdout || "" : "";
    const todayCn = `${today.slice(0, 4)}年${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日`;
    const remoteHasToday =
      boardRun.status === 0 || dataTxt.includes(today) || dataTxt.includes(todayCn);
    if (remoteHasToday) {
      console.log(`远端已经有今天（${today}）的数据了（Actions 抢先跑完的），本地这份丢掉，直接对齐远端。`);

      /* 只有 zh.json 是手写的、丢了可惜，先留着，其余生成物一律以远端为准。
         对齐完如果 zh.json 真多了条目，下面照常走提交推送，把文案补上去。 */
      const zhPath = path.join(ROOT, "pipeline/zh.json");
      let zhSaved = null;
      try {
        if (fs.existsSync(zhPath)) zhSaved = fs.readFileSync(zhPath, "utf8");
      } catch (e) {
        /* 读不出来就算了 */
      }

      const hard = git(["reset", "--hard", "origin/main"]);
      if (hard.status !== 0) {
        console.error("✗ 对齐远端失败，本次不推送。");
        console.error((hard.stderr || "").trim().split("\n").slice(-3).join("\n"));
        return false;
      }

      if (zhSaved) {
        try {
          if (fs.readFileSync(zhPath, "utf8") !== zhSaved) {
            fs.writeFileSync(zhPath, zhSaved, "utf8");
            console.log("本地 zh.json 比远端多，跟着这次一起补上去。");
          }
        } catch (e) {
          /* 比对失败就当没差别 */
        }
      }

      const sha = git(["rev-parse", "HEAD"]);
      console.log(`已对齐远端 main = ${(sha.stdout || "").trim().slice(0, 7)}`);
      // 不 return，继续往下走：zh.json 若真有新增就顺便提交推送，没有就走「没有新改动」
    } else {
      console.log(`本地落后远端 ${behind} 个提交，先追上去…`);
      const rebase = git(["rebase", "--autostash", "origin/main"]);
      if (rebase.status !== 0) {
        git(["rebase", "--abort"]);
        console.error("✗ 追远端时冲突了，已回退。线上不会变，手动处理一下再重试。");
        console.error((rebase.stderr || "").trim().split("\n").slice(-4).join("\n"));
        return false;
      }
      console.log("已追平远端。");
    }

    /* rebase --autostash 有个坑：rebase 本身能成功，但把之前暂存的内容弹回来时
       如果撞车，冲突标记就留在工作区里，而 rebase 的退出码依然是 0。
       2026-10-30 就是这么把带 <<<<<<< 的 data.auto.js 推上线的。所以这里单独查一遍。 */
    const rebaseMarks = findConflictMarkers(git, { worktree: true });
    if (rebaseMarks.length) {
      console.error("✗ 追远端后工作区出现冲突标记（autostash 弹回时撞了），本次不推送。");
      for (const line of rebaseMarks) console.error(`  ${line}`);
      console.error("  处理方式：git checkout -- . 丢掉工作区改动，或手动解冲突后重跑。");
      return false;
    }
  }

  // 有改动就先提交
  const st = git(["status", "--porcelain"]);
  if (st.status !== 0) {
    console.error("✗ git status 读不出来，放弃推送。");
    return false;
  }
  if (st.stdout.trim()) {
    git(["add", "-A"]);

    /* 提交前两道闸，任何一道不过就整批放弃，宁可今天不更新也不能推坏文件上线 */

    // 闸一：暂存内容里不能有 git 冲突标记
    const marks = findConflictMarkers(git);
    if (marks.length) {
      git(["reset", "-q"]);
      console.error("✗ 暂存的文件里有 git 冲突标记，已撤销暂存，本次不推送。");
      for (const line of marks) console.error(`  ${line}`);
      console.error("  大概率是 rebase 撞车留下的。手动看一眼再重跑。");
      return false;
    }

    // 闸二：几个 .js 必须是能解析的，语法坏了一样白推
    const bad = brokenScripts();
    if (bad.length) {
      git(["reset", "-q"]);
      console.error("✗ 这些文件语法不通过，已撤销暂存，本次不推送：");
      for (const line of bad) console.error(`  ${line}`);
      return false;
    }

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
 * 找出带 git 冲突标记的文件，返回「文件:行号:内容」列表（最多 10 条）。
 *
 * 默认查暂存区（--cached），传 { worktree: true } 就查工作区。
 * 注意 --cached 必须排在所有非选项参数前面：放后面 git 会直接报
 * fatal: option '--cached' must come before non-option arguments 并以 128 退出，
 * 守卫就永远查不出东西，等于没写（2026-10-30 实测踩过一次）。
 * 命中时 git grep 退出码 0，没命中是 1。
 */
function findConflictMarkers(git, opts = {}) {
  const args = ["grep", "-n", "-E", "^(<<<<<<< |>>>>>>> |^=======$)"];
  if (!opts.worktree) args.splice(1, 0, "--cached");
  const r = git(args);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split("\n").filter(Boolean).slice(0, 10);
}

/**
 * 用 node --check 验几个脚本能不能解析。
 * 冲突标记清干净了也可能因为别的原语法错，多一道保险。
 */
function brokenScripts() {
  const files = [
    "assets/data.auto.js",
    "assets/data.archive.js",
    "assets/data.js",
    "assets/app.js",
  ];
  const bad = [];
  for (const f of files) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const r = spawnSync(NODE, ["--check", full], { encoding: "utf8" });
    if (r.status !== 0) {
      const why = (r.stderr || "").trim().split("\n").find((l) => l.trim().startsWith("SyntaxError")) || "解析失败";
      bad.push(`${f} —— ${why.trim()}`);
    }
  }
  return bad;
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
