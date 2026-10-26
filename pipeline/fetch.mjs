#!/usr/bin/env node
/**
 * githubhot 数据管线
 *
 * 做什么：
 *   1. 用 GitHub Search API 抓三类候选项目（新星 / 站稳的新项目 / 今年的热门）
 *   2. 和本地历史快照对比，算出每个项目「每天涨多少星」
 *   3. 按日增排序，输出成前端能直接读的 data.js
 *   4. 把今天的星数存进 history.json，明天才能算出增量
 *
 * 不需要登录也能跑（搜索额度 10 次/分钟，本脚本只调用 3 次）。
 * 如果设了环境变量 GITHUB_TOKEN，额度变成 30 次/分钟，更宽松。
 *
 * 用法：
 *   node pipeline/fetch.mjs                    # 输出到 assets/data.js
 *   node pipeline/fetch.mjs --out x.js         # 输出到指定文件
 *   node pipeline/fetch.mjs --dry              # 只打印统计，不写文件
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dailyDelta, weekDelta, dayDiff, DAY } from "./lib/delta.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ARGS = process.argv.slice(2);
function arg(name, fallback) {
  const i = ARGS.indexOf("--" + name);
  return i > -1 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
}
const DRY = ARGS.includes("--dry");
const FORCE = ARGS.includes("--force");
const OUT = path.resolve(ROOT, arg("out", "assets/data.js"));
const VAR = arg("var", "GH_DATA");
const HISTORY = path.resolve(ROOT, arg("history", "pipeline/history.json"));
const CACHE_DIR = path.resolve(ROOT, "pipeline/cache");
const BOARDS = path.resolve(ROOT, "pipeline/boards");

/** 读出所有早于今天的榜单，最近的排在最前 */
function loadBoards(beforeDate) {
  if (!fs.existsSync(BOARDS)) return [];
  return fs
    .readdirSync(BOARDS)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => {
      const d = f.slice(0, 10);
      if (d >= beforeDate) return null;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(BOARDS, f), "utf8"));
        return { d, ids: Array.isArray(j.ids) ? j.ids : [] };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.d < b.d ? 1 : -1));
}

/* 每日榜单存档：ids 是排名顺序，repos 是 id → 仓库全名。
   存 repos 是为了日后回看历史时能从 history.json 里查到那天的星数
   （老存档没有这个字段，归档脚本按 id 反推兜底）。 */
function saveBoard(date, items) {
  fs.mkdirSync(BOARDS, { recursive: true });
  const repos = {};
  for (const it of items) repos[it.id] = it.repo;
  fs.writeFileSync(
    path.join(BOARDS, date + ".json"),
    JSON.stringify({ date, ids: items.map((i) => i.id), repos }, null, 1),
    "utf8"
  );
}
const TOKEN = process.env.GITHUB_TOKEN || "";

const now = new Date();
const todayISO = now.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(now.getTime() - n * DAY).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* 1. 候选池：三个搜索，覆盖「刚冒出来」「站稳了」「今年最热」          */
/* ------------------------------------------------------------------ */
const QUERIES = [
  { id: "new", q: `created:>${daysAgo(14)} stars:>50`, label: "近两周新建" },
  { id: "rising", q: `created:>${daysAgo(120)} stars:>800`, label: "近四个月站稳" },
  { id: "year", q: `created:>${daysAgo(365)} stars:>3000`, label: "今年最热" }
];

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "githubhot-pipeline",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(query, attempt = 1) {
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(query) +
    "&sort=stars&order=desc&per_page=100";
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 403 || res.status === 429) {
    if (attempt > 3) throw new Error("rate limited, giving up: " + query);
    const wait = Number(res.headers.get("retry-after") || 20) * 1000;
    console.warn(`  限流，${wait / 1000}s 后重试（第 ${attempt} 次）`);
    await sleep(wait);
    return search(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${query}`);
  const json = await res.json();
  return json.items || [];
}

/* ------------------------------------------------------------------ */
/* 2. 分类                                                             */
/*    强特征一票定音（10 分），弱特征只做累加（1 分）。                */
/*    否则描述里冒出 cli/sdk/api 几个泛词，就会盖过真正的关键特征。     */
/* ------------------------------------------------------------------ */
const CAT_RULES = [
  {
    cat: "security",
    strong: ["vulnerability", "exploit", "pentest", "malware", "cve-",
      "reverse engineering", "red team", "漏洞", "逆向", "渗透"],
    weak: ["security", "audit", "forensics", "ctf", "hacking", "扫描", "安全"]
  },
  {
    cat: "model",
    strong: ["tts", "ocr", "diffusion", "inference", "quantization",
      "voice clone", "text-to-video", "text-to-image", "多模态", "语音"],
    weak: ["speech", "voice", "model", "training", "finetune", "llama",
      "transformer", "vision", "asr", "audio", "video"]
  },
  {
    cat: "learn",
    strong: ["awesome-", "tutorial", "introduction to", "cheatsheet",
      "handbook", "指南", "教程", "入门", "从零"],
    weak: ["awesome", "guide", "learning", "course", "book", "interview",
      "roadmap", "curated", "笔记", "合集", "知识", "清单"]
  },
  {
    cat: "content",
    strong: ["iptv", "dataset", "scraper", "crawler", "news aggregation",
      "aggregator", "数据集", "爬虫"],
    weak: ["news", "rss", "search engine", "ebook", "pdf", "channels",
      "新闻", "资讯", "频道"]
  },
  {
    cat: "agent",
    strong: ["agent skill", "agentic", "mcp server", "subagent", "智能体",
      "提示词"],
    weak: ["agent", "agents", "llm", "gpt", "claude", "codex", "copilot",
      "mcp", "prompt", "rag", "skill", "skills", "harness", "chatbot", "插件"]
  },
  {
    cat: "devtool",
    strong: ["self-hosted", "open-source alternative", "photo editor",
      "code editor", "operating system"],
    weak: ["database", "postgres", "sql", "api", "framework", "react", "vue",
      "nextjs", "nodejs", "cli", "sdk", "library", "backend", "server",
      "docker", "kubernetes", "editor", "ide", "compiler", "gui", "desktop",
      "launcher", "terminal", "debloat", "home screen", "桌面", "启动器",
      "编辑器", "客户端", "命令行"]
  }
];

const CAT_LABEL = {
  agent: "Agent 与技能",
  model: "模型与多媒体",
  devtool: "开发工具",
  security: "安全",
  learn: "学习资源",
  content: "数据与内容"
};

const HAS_ZH = /[\u4e00-\u9fa5]/;

function classify(repo) {
  const topics = (repo.topics || []).join(" ").toLowerCase();
  const desc = (repo.description || "").toLowerCase();
  const name = (repo.name || "").toLowerCase();
  const hay = topics + " " + desc + " " + name;

  let best = null;
  let bestScore = 0;
  for (const rule of CAT_RULES) {
    let score = 0;
    for (const w of rule.strong) if (hay.includes(w)) score += 10;
    for (const w of rule.weak) if (hay.includes(w)) score += 1;
    if (score > bestScore) { bestScore = score; best = rule.cat; }
  }
  return best || "devtool";
}

/* ------------------------------------------------------------------ */
/* 3. 历史：算每日增量                                                 */
/* ------------------------------------------------------------------ */
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY, "utf8"));
  } catch {
    return { version: 1, repos: {} };
  }
}

/* 增量计算见 lib/delta.mjs（有独立测试 pipeline/test-delta.mjs） */

/* ------------------------------------------------------------------ */
/* 4. 主流程                                                           */
/* ------------------------------------------------------------------ */
async function main() {
  console.log(`githubhot 抓取 · ${todayISO}${TOKEN ? " · 已带 token" : " · 未登录"}`);

  const seen = new Map();
  for (const item of QUERIES) {
    process.stdout.write(`  搜索「${item.label}」... `);
    const cacheFile = path.join(CACHE_DIR, `${todayISO}-${item.id}.json`);
    try {
      let list;
      if (!FORCE && fs.existsSync(cacheFile)) {
        list = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        console.log(`${list.length} 条（缓存）`);
      } else {
        list = await search(item.q);
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(list), "utf8");
        console.log(`${list.length} 条`);
      }
      for (const r of list) {
        if (seen.has(r.full_name)) continue;
        r.__source = item.id;
        seen.set(r.full_name, r);
      }
    } catch (e) {
      console.log("失败：" + e.message);
    }
    if (!fs.existsSync(cacheFile)) await sleep(2500); // 缓存命中就不用限速
  }

  const history = loadHistory();
  const candidates = [];

  for (const [fullName, r] of seen) {
    const recs = history.repos[fullName] || [];
    const stars = r.stargazers_count;
    const isNew = recs.length === 0;
    const today = dailyDelta(recs, stars, todayISO);
    const week = weekDelta(recs, stars, todayISO);
    const ageDays = Math.max(1, dayDiff(r.created_at.slice(0, 10), todayISO));
    // 没有历史时，用「一生平均日增」当近似值，标注为估算
    const estimate = Math.round(stars / ageDays);

    candidates.push({
      repo: fullName,
      id: fullName.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
      stars,
      forks: r.forks_count,
      lang: r.language || "未知",
      orig: (r.description || "").trim(),
      topics: (r.topics || []).slice(0, 6),
      created: r.created_at.slice(0, 10),
      ageDays,
      pushed: r.pushed_at ? r.pushed_at.slice(0, 10) : null,
      official: r.owner && r.owner.type === "Organization",
      cat: classify(r),
      today,
      week,
      isNew,
      estimate,
      score: today != null ? today : estimate * 0.35
    });
  }

  // 排序：有真实日增的排前面，其余按估算
  candidates.sort((a, b) => b.score - a.score);

  const withDelta = candidates.filter((c) => c.today != null).length;
  const newcomers = candidates.filter((c) => c.isNew).length;
  console.log(
    `\n  候选 ${candidates.length} 个｜有真实日增 ${withDelta} 个｜首次入池 ${newcomers} 个`
  );

  // 写历史：今天每个见过的项目记一条
  const keepFrom = daysAgo(45);
  for (const c of candidates) {
    const recs = history.repos[c.repo] || (history.repos[c.repo] = []);
    const idx = recs.findIndex((x) => x.d === todayISO);
    if (idx > -1) recs[idx].s = c.stars;
    else recs.push({ d: todayISO, s: c.stars });
    history.repos[c.repo] = recs.filter((x) => x.d >= keepFrom).slice(-45);
  }
  // 清掉长期没再出现的仓库，防止文件无限长大
  for (const k of Object.keys(history.repos)) {
    if (!history.repos[k].length) delete history.repos[k];
  }

  const top = candidates.slice(0, 60);

  /* 榜单存档：每天存一份「今天这 60 个是谁、什么名次」。
     有了它才能算出「昨天在不在这榜上」「名次升了几位」「连续几天在榜」。 */
  const boards = loadBoards(todayISO);
  const prev = boards[0] || null;
  const prevRankOf = new Map(prev ? prev.ids.map((id, i) => [id, i + 1]) : []);

  function streakOf(id) {
    let n = 1; // 今天在榜
    for (const b of boards) {
      if (b.ids.includes(id)) n++;
      else break;
    }
    return n;
  }

  const items = top.map((c, idx) => {
    const rank = idx + 1;
    const prevRank = prevRankOf.has(c.id) ? prevRankOf.get(c.id) : null;
    return {
      id: c.id,
      repo: c.repo,
      cat: c.cat,
      rank,
      prevRank,
      rankDelta: prevRank != null ? prevRank - rank : null, // 正数=名次上升
      newToBoard: prev ? prevRank == null : null, // null = 没有更早的榜单可比，别瞎标
      streak: boards.length ? streakOf(c.id) : 1,
      today: c.today,
      week: c.week,
      stars: c.stars,
      forks: c.forks,
      lang: c.lang,
      orig: c.orig,
      desc: null,   // 中文说明：留给文案层填，没填时前端回落显示 orig
      why: null,    // 推荐理由：同上
      created: c.created,
      ageDays: c.ageDays,
      estimate: c.today == null ? c.estimate : null,
      isNew: c.isNew,      // 仓库本身是新建的
      official: c.official,
      zh: HAS_ZH.test(c.orig),
      topics: c.topics
    };
  });

  const dateLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${
    "日一二三四五六"[now.getDay()]
  }`;

  const payload =
    "// 由 pipeline/fetch.mjs 自动生成，请勿手改\n" +
    `// 生成时间 ${now.toISOString()}\n` +
    `window.${VAR} = ` +
    JSON.stringify(
      {
        snapshot: now.toISOString(),
        dateLabel,
        auto: true,
        // 这次是拿哪一天的榜在对比。中间断过几天时，页面上要如实说出来
        vs: prev ? prev.d : null,
        items,
      },
      null,
      2
    ) +
    ";\n";

  if (DRY) {
    console.log("\n  [dry] 前 5 条预览:");
    items.slice(0, 5).forEach((i) =>
      console.log(`   ${i.repo} ★${i.stars} 日增=${i.today ?? "—"} 估算=${i.estimate ?? "—"} ${i.cat}`)
    );
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, payload, "utf8");
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 1), "utf8");
  saveBoard(todayISO, items);

  console.log(`\n  已写 ${path.relative(ROOT, OUT)}  (${items.length} 条)`);
  console.log(`  已写 ${path.relative(ROOT, HISTORY)}  (追踪 ${Object.keys(history.repos).length} 个仓库)`);
  console.log(`  已写 pipeline/boards/${todayISO}.json  (今日榜单存档)`);

  if (prev) {
    const newCount = items.filter((i) => i.newToBoard).length;
    const dropped = prev.ids.filter((id) => !items.some((i) => i.id === id));
    console.log(`\n  对比 ${prev.d}：新上榜 ${newCount} 个｜跌出 ${dropped.length} 个`);
    if (dropped.length) {
      console.log(`  跌出：${dropped.slice(0, 6).join("、")}${dropped.length > 6 ? " 等" : ""}`);
    }
  } else {
    console.log("\n  没有更早的榜单可比，明早再跑一次就能标出「新上榜」了");
  }
  console.log("\n  分类分布:");
  const dist = {};
  items.forEach((i) => (dist[CAT_LABEL[i.cat]] = (dist[CAT_LABEL[i.cat]] || 0) + 1));
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${k}: ${v}`));
}

main().catch((e) => {
  console.error("失败：" + e.message);
  process.exit(1);
});
