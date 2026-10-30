#!/usr/bin/env node
/**
 * 生成历史归档 assets/data.archive.js
 *
 * boards/ 里每天只有「谁在榜、第几名」，history.json 里只有「每天多少星」。
 * 这个脚本把两者合起来，再配上累积下来的项目元数据（desc/why/语言/分类），
 * 拼成前端能直接渲染的「每一天的完整榜单」——休假回来能往回翻。
 *
 * 顺带维护 pipeline/meta.json：只增不减，越跑越全。
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dailyDelta, weekDelta } from "./lib/delta.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOARDS = path.join(ROOT, "pipeline/boards");
const HISTORY = path.join(ROOT, "pipeline/history.json");
const META = path.join(ROOT, "pipeline/meta.json");
const ZH = path.join(ROOT, "pipeline/zh.json");
const OUT = path.join(ROOT, "assets/data.archive.js");
const KEEP_DAYS = 120; // 归档只留最近 120 天，更老的还在 pipeline/boards/ 里没丢

const idOf = (repo) => String(repo).toLowerCase().replace(/\//g, "-");

/* data.js / data.auto.js 是浏览器脚本，用 vm 取全局 */
function loadGlobal(file, name) {
  if (!fs.existsSync(file)) return null;
  try {
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { timeout: 10000 });
    return ctx.window[name] || null;
  } catch (e) {
    console.warn(`  读取 ${path.basename(file)} 失败：${e.message}`);
    return null;
  }
}

function labelOf(d) {
  const [y, m, dd] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  return `${y}年${m}月${dd}日 星期${"日一二三四五六"[dt.getUTCDay()]}`;
}

/* ---------- 输入 ---------- */
if (!fs.existsSync(BOARDS)) {
  console.error("没有 pipeline/boards/，先跑一次抓取");
  process.exit(1);
}

const boards = fs
  .readdirSync(BOARDS)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(BOARDS, f), "utf8"));
      return { d: f.slice(0, 10), ids: Array.isArray(j.ids) ? j.ids : [], repos: j.repos || {} };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => (a.d < b.d ? -1 : 1));

const history = fs.existsSync(HISTORY)
  ? JSON.parse(fs.readFileSync(HISTORY, "utf8"))
  : { repos: {} };

/* 老存档没有 repos 字段，用 id 反推仓库全名（id = repo 小写、斜杠换横线） */
const repoOfId = {};
for (const repo of Object.keys(history.repos)) repoOfId[idOf(repo)] = repo;

let metaDoc = { items: {} };
if (fs.existsSync(META)) {
  try {
    metaDoc = JSON.parse(fs.readFileSync(META, "utf8"));
  } catch {
    /* 坏了就当空的 */
  }
}
const meta = metaDoc.items || Object.create(null);

/* 元数据只增不减：新值非空就覆盖，空了保留旧的 */
function absorb(it) {
  if (!it || !it.id) return;
  /* id 一律按小写归档：抓取脚本生成的就是小写，可手写的老存档里是
     「DietrichGebert-ponytail」这种原样大小写，两种写法会各占一个键，
     同一个仓库在元数据里变成两条，还多占体积。统一压成小写。 */
  const id = String(it.id).toLowerCase();
  const cur = meta[id] || {};
  const pick = (k) => (it[k] !== undefined && it[k] !== null && it[k] !== "" ? it[k] : cur[k]);
  meta[id] = {
    repo: pick("repo"),
    cat: pick("cat"),
    lang: pick("lang"),
    created: pick("created"),
    forks: pick("forks"),
    orig: pick("orig"),
    desc: pick("desc"),
    why: pick("why"),
    official: pick("official"),
  };
}

const auto = loadGlobal(path.join(ROOT, "assets/data.auto.js"), "GH_DATA_AUTO");
const hand = loadGlobal(path.join(ROOT, "assets/data.js"), "GH_DATA");
if (hand) hand.items.forEach(absorb);
if (auto) auto.items.forEach(absorb);

/* zh.json 里有些项目已经掉出当前榜单，靠 history 反查仓库名补上 */
let zhAdded = 0;
if (fs.existsSync(ZH)) {
  try {
    const zh = JSON.parse(fs.readFileSync(ZH, "utf8")).items || {};
    for (const [rawId, v] of Object.entries(zh)) {
      const id = rawId.toLowerCase();
      if (!meta[id]) {
        const repo = repoOfId[id];
        if (!repo) continue; // 连仓库名都不知道，补了也没法显示
        meta[id] = { repo, desc: v.desc, why: v.why };
        zhAdded++;
      } else {
        if (!meta[id].desc && v.desc) meta[id].desc = v.desc;
        if (!meta[id].why && v.why) meta[id].why = v.why;
      }
    }
  } catch {
    /* zh.json 坏了不影响归档 */
  }
}

/* ---------- 组装每一天 ---------- */
const autoDate = auto && auto.snapshot
  ? new Date(new Date(auto.snapshot).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  : null;

function streakAt(idx, id) {
  let n = 1;
  for (let j = idx - 1; j >= 0; j--) {
    if (boards[j].ids.includes(id)) n++;
    else break;
  }
  return n;
}

const days = boards.map((b, i) => {
  const prevBoard = i > 0 ? boards[i - 1] : null;
  const prevRankOf = new Map(prevBoard ? prevBoard.ids.map((id, k) => [id, k + 1]) : []);

  let entries;
  if (autoDate === b.d && auto) {
    /* 最新一天直接用抓取结果，字段最全也最准 */
    entries = auto.items.map((it) => ({
      id: it.id,
      rank: it.rank,
      stars: it.stars ?? null,
      today: it.today ?? null,
      week: it.week ?? null,
      estimate: it.estimate ?? null,
      prevRank: it.prevRank ?? null,
      rankDelta: it.rankDelta ?? null,
      newToBoard: it.newToBoard ?? null,
      streak: it.streak ?? 1,
    }));
  } else {
    /* 历史天：星数从 history 查，名次变化和连续在榜按 board 顺序重算 */
    entries = b.ids.map((id, k) => {
      const repo = b.repos[id] || repoOfId[id] || meta[id]?.repo || null;
      const recs = repo ? history.repos[repo] || [] : [];
      const rec = recs.find((r) => r.d === b.d);
      const stars = rec ? rec.s : null;
      const prevRank = prevRankOf.has(id) ? prevRankOf.get(id) : null;
      return {
        id,
        rank: k + 1,
        stars,
        today: stars != null ? dailyDelta(recs, stars, b.d, 14) : null,
        week: stars != null ? weekDelta(recs, stars, b.d) : null,
        estimate: null,
        prevRank,
        rankDelta: prevRank != null ? prevRank - (k + 1) : null,
        newToBoard: prevBoard ? prevRank == null : null,
        streak: prevBoard ? streakAt(i, id) : 1,
      };
    });
  }

  return {
    date: b.d,
    label: labelOf(b.d),
    vs: prevBoard ? prevBoard.d : null, // 对比的是哪一天（中间断过就是断档那天）
    entries,
  };
});

const kept = days.slice(-KEEP_DAYS);

/* 清掉空字段，省体积 */
const metaOut = {};
for (const [rawId, m] of Object.entries(meta)) {
  if (!m || !m.repo) continue;
  const id = String(rawId).toLowerCase();
  const dst = (metaOut[id] = metaOut[id] || {});
  /* 老数据里同一仓库大小写两种写法各占一条，统一压成小写后合并，
     先到的填值、后到的只补空位，谁也不覆盖谁。 */
  for (const k of ["repo", "cat", "lang", "created", "forks", "orig", "desc", "why", "official"]) {
    if (dst[k] === undefined && m[k] !== undefined && m[k] !== null && m[k] !== "") dst[k] = m[k];
  }
}

/* ---------- 输出 ---------- */
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const payload =
  "// 由 pipeline/archive.mjs 生成，请勿手改\n" +
  `// 生成时间 ${new Date().toISOString()}｜${kept.length} 天｜${Object.keys(metaOut).length} 个项目\n` +
  "window.GH_ARCHIVE = " +
  JSON.stringify({ updated: today, days: kept, meta: metaOut }) +
  ";\n";

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, payload, "utf8");

fs.mkdirSync(path.dirname(META), { recursive: true });
fs.writeFileSync(
  META,
  JSON.stringify({ _note: "项目元数据累积库，归档脚本自己维护，只增不减", _updated: today, items: metaOut }, null, 1),
  "utf8"
);

const kb = (Buffer.byteLength(payload, "utf8") / 1024).toFixed(0);
console.log("githubhot 历史归档");
console.log(`  天数 ${kept.length}｜项目元数据 ${Object.keys(metaOut).length}（本次从 zh 库补 ${zhAdded}）`);
console.log(`  已写 assets/data.archive.js  (${kb} KB)`);
if (kept.length) {
  console.log(`  范围 ${kept[0].date} → ${kept[kept.length - 1].date}`);
  const gapDay = kept.filter((d) => d.vs && Math.round((new Date(d.date) - new Date(d.vs)) / 86400000) > 1);
  if (gapDay.length) {
    console.log(`  断档 ${gapDay.length} 处：${gapDay.map((d) => d.date + "（对比 " + d.vs + "）").join("、")}`);
  }
}
