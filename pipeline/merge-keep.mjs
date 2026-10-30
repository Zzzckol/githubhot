#!/usr/bin/env node
/**
 * 把「对齐远端之前先存下来的原料」合回当前工作区。
 *
 * 什么时候用：远端有本机没有的提交，但那些提交里没有今天的数据。
 * 这时候不能做文本合并 —— data.auto.js / data.archive.js / history.json / meta.json
 * 都是每天整份重写的生成物，两边各一份不同内容，文本合并必然冲突
 * （2026-10-30 就是这么把带 <<<<<<< 的坏文件推上线的）。
 *
 * 做法：git reset --hard origin/main 对齐远端，然后本脚本把这几个文件按「条目」合回来，
 * 再由 archive.mjs / stamp.mjs 重算生成物。全程不碰冲突。
 *
 * 用法：
 *   node pipeline/merge-keep.mjs --keep <备份目录> [--today 2026-10-30]
 *
 * 备份目录里放的是 grab 出来的副本，文件名把 / 换成了 __：
 *   assets__data.auto.js  pipeline__zh.json  pipeline__history.json  pipeline__meta.json
 *
 * 只合不该丢的：
 *   - data.auto.js：今天刚抓的，整个覆盖（远端没有今天的数据，不存在覆盖别人）
 *   - pipeline/boards/<今天>.json：今天的榜单，归档靠它知道今天有哪 60 名
 *   - zh.json：手写文案，按条目合并，本地优先、远端多出来的也留
 *   - history.json：星数历史，按「仓库 + 日期」合并，同一天用本地刚抓的
 *   - meta.json：项目元数据，只增不减
 *
 * 2026-10-30：本机 update.mjs 里原本有一份一模一样的实现在 realignThenRebuild()，
 * 和这个是两份拷贝，改一边忘一边就会飘。现在本机也改成调这个脚本，只剩一份逻辑。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const KEEP = arg("keep", "");
if (!KEEP || !fs.existsSync(KEEP)) {
  console.error("✗ 没给 --keep 目录，或者目录不存在：" + KEEP);
  process.exit(2);
}

const keepPath = (rel) => path.join(KEEP, rel.replace(/[\\/]/g, "__"));

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1), "utf8");
}

function report(name, extra) {
  console.log(`  ${name}${extra ? "：" + extra : ""}`);
}

/* ---------- 1. data.auto.js：今天刚抓的，直接覆盖 ---------- */
const savedAuto = keepPath("assets/data.auto.js");
if (fs.existsSync(savedAuto)) {
  fs.copyFileSync(savedAuto, path.join(ROOT, "assets/data.auto.js"));
  const txt = fs.readFileSync(savedAuto, "utf8");
  const n = (txt.match(/"id":/g) || []).length;
  const snap = (txt.match(/"snapshot":\s*"([^"]+)"/) || [])[1] || "?";
  report("data.auto.js", `${n} 条，抓取于 ${snap}`);
} else {
  console.error("✗ 备份里没有 data.auto.js，今天的数据丢了，本次不该继续。");
  process.exit(1);
}

/* ---------- 1b. 今天的 board：归档靠它知道「今天有哪 60 名」 ---------- */
/* board 是 fetch.mjs 顺手写进 pipeline/boards/ 的。备份里有就放回去；
   万一抓取时没写成功，就按 data.auto.js 现补一份。
   少了它 archive.mjs 会以为今天没数据，页面看着更新了、往回翻却没有今天。 */
const TODAY = arg("today", "");
if (TODAY) {
  const boardRel = `pipeline/boards/${TODAY}.json`;
  const boardPath = path.join(ROOT, boardRel);
  const savedBoard = keepPath(boardRel);
  if (fs.existsSync(savedBoard)) {
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    fs.copyFileSync(savedBoard, boardPath);
    report("board", `${TODAY} 已放回`);
  } else if (!fs.existsSync(boardPath)) {
    try {
      const src = fs.readFileSync(path.join(ROOT, "assets/data.auto.js"), "utf8");
      const m = src.match(/window\.GH_DATA_AUTO\s*=\s*(\{[\s\S]*\});/);
      const data = m ? JSON.parse(m[1]) : null;
      if (data && Array.isArray(data.items) && data.items.length) {
        const repos = {};
        for (const it of data.items) if (it.id && it.repo) repos[it.id] = it.repo;
        fs.mkdirSync(path.dirname(boardPath), { recursive: true });
        fs.writeFileSync(
          boardPath,
          JSON.stringify({ date: TODAY, ids: data.items.map((i) => i.id), repos }, null, 1),
          "utf8",
        );
        report("board", `${TODAY} 备份里没有，已按抓取结果补一份`);
      }
    } catch (e) {
      console.warn(`  board｜${TODAY} 补不出来，归档里可能少这一天`);
    }
  }
}

/* ---------- 2. zh.json：手写文案，按条目合并 ---------- */
{
  const saved = keepPath("pipeline/zh.json");
  const target = path.join(ROOT, "pipeline/zh.json");
  const local = fs.existsSync(saved) ? readJson(saved) : null;
  if (local && local.items) {
    const remote = readJson(target) || { items: {} };
    const out = { ...remote };
    out.items = { ...(remote.items || {}), ...local.items };
    if (local._note) out._note = local._note;
    out._updated = local._updated || out._updated;
    writeJson(target, out);
    const added = Object.keys(local.items).filter((k) => !(remote.items || {})[k]).length;
    report("zh.json", `合并后 ${Object.keys(out.items).length} 条（本地新增 ${added} 条）`);
  } else {
    report("zh.json", "没有备份或格式不对，保持远端版本");
  }
}

/* ---------- 3. history.json：按「仓库 + 日期」合并，同一天用本地 ---------- */
{
  const saved = keepPath("pipeline/history.json");
  const target = path.join(ROOT, "pipeline/history.json");
  const local = fs.existsSync(saved) ? readJson(saved) : null;
  if (local && local.repos) {
    const remote = readJson(target) || { repos: {} };
    const out = { version: remote.version || local.version, repos: {} };
    const repos = new Set([...Object.keys(remote.repos || {}), ...Object.keys(local.repos || {})]);
    for (const repo of repos) {
      const byDay = new Map();
      for (const r of (remote.repos || {})[repo] || []) if (r && r.d) byDay.set(r.d, r);
      // 本地是今天刚抓的，同一天覆盖远端那条
      for (const r of (local.repos || {})[repo] || []) if (r && r.d) byDay.set(r.d, r);
      out.repos[repo] = [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
    }
    writeJson(target, out);
    report("history.json", `${Object.keys(out.repos).length} 个仓库`);
  } else {
    report("history.json", "没有备份或格式不对，保持远端版本");
  }
}

/* ---------- 4. meta.json：项目元数据，只增不减 ---------- */
{
  const saved = keepPath("pipeline/meta.json");
  const target = path.join(ROOT, "pipeline/meta.json");
  const local = fs.existsSync(saved) ? readJson(saved) : null;
  if (local && local.items) {
    const remote = readJson(target) || { items: {} };
    const out = { ...remote };
    out.items = { ...(remote.items || {}) };
    let filled = 0;
    for (const [id, v] of Object.entries(local.items)) {
      if (!out.items[id]) {
        out.items[id] = v;
        continue;
      }
      const merged = { ...out.items[id] };
      for (const [k, val] of Object.entries(v || {})) {
        if (val === undefined || val === null || val === "") continue;
        if (merged[k] === undefined || merged[k] === null || merged[k] === "") {
          merged[k] = val;
          filled++;
        }
      }
      out.items[id] = merged;
    }
    out._updated = local._updated || out._updated;
    out._note = remote._note || local._note;
    writeJson(target, out);
    report("meta.json", `${Object.keys(out.items).length} 条（补了 ${filled} 个空字段）`);
  } else {
    report("meta.json", "没有备份或格式不对，保持远端版本");
  }
}

console.log("原料已合回，接下来按远端的底子重算归档和版本号。");
