#!/usr/bin/env node
/**
 * githubhot 文案层
 *
 * 干什么：把抓来的英文描述，变成中文的「一句话说明」和「为什么值得看」。
 * 排序不归它管 —— 排序永远由真实数据决定，否则就变成模型的嘴了。
 *
 * 需要一个 OpenAI 兼容接口。DeepSeek 最便宜，也可以用任何兼容服务：
 *   LLM_API_KEY   必填
 *   LLM_BASE_URL  默认 https://api.deepseek.com/v1
 *   LLM_MODEL     默认 deepseek-chat
 *
 * 用法：
 *   node pipeline/enrich.mjs                                   # 补全 assets/data.auto.js
 *   node pipeline/enrich.mjs --in assets/data.auto.js --var GH_DATA_AUTO
 *   node pipeline/enrich.mjs --only 10                         # 只跑前 10 条试水
 *   node pipeline/enrich.mjs --overwrite                       # 连已有的中文也重写
 *
 * 成本参考：60 条大约 8 次调用，DeepSeek 一次几分钱，一轮下来几毛。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ARGS = process.argv.slice(2);
function arg(name, fallback) {
  const i = ARGS.indexOf("--" + name);
  return i > -1 && ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : fallback;
}
const IN = path.resolve(ROOT, arg("in", "assets/data.auto.js"));
const VAR = arg("var", "GH_DATA_AUTO");
const ONLY = Number(arg("only", 0)) || 0;
const OVERWRITE = ARGS.includes("--overwrite");
const LOCAL_ONLY = ARGS.includes("--local-only");
const BATCH = 6;

const BASE = (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/$/, "");
const KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "deepseek-chat";
const CACHE_DIR = path.resolve(ROOT, "pipeline/cache/enrich");

/* 人工文案库：优先于模型，命中就不花钱 */
const LOCAL_FILE = path.resolve(ROOT, "pipeline/zh.json");
function loadLocal() {
  if (!fs.existsSync(LOCAL_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")).items || {};
  } catch (e) {
    console.warn("  pipeline/zh.json 解析失败，忽略本地库：" + e.message);
    return {};
  }
}
const LOCAL = loadLocal();

/* 读回已生成的 data.auto.js */
function loadItems() {
  const src = fs.readFileSync(IN, "utf8");
  const m = src.match(new RegExp("window\\." + VAR + "\\s*=\\s*(\\{[\\s\\S]*\\});"));
  if (!m) throw new Error("在 " + IN + " 里找不到 window." + VAR);
  return { data: JSON.parse(m[1]), src };
}

const SYSTEM = `你是"GitHub 热门项目日报"的编辑。读者是中文开发者，也包括不写代码的产品和运营。

写的时候守这几条：
1. 说人话。不堆术语。不用"赋能""抓手""闭环""生态位""护城河""重新定义"这类词。
2. 不用三段式排比，不用"不仅…而且…"的句式，不用"让我们一起"这类腔调。
3. desc：一句话说清这项目是干什么的，40 字以内，让不懂技术的也能看懂。不要重复仓库名。
4. why：说清为什么今天值得看一眼，60-100 字。必须落在给定的事实上（多少星、上线多久、涨得快不快、是不是官方出的）。不要写"引领行业""开启新纪元"这种空话。
5. 允许有判断，也允许泼冷水：如果看着像套壳、纯营销、或者名不副实，就在 why 里直说。
6. 不要编造事实。给定的描述里没提到的功能、公司、数字，一律不许写。

只输出 JSON，格式：
{"items":[{"id":"仓库标识","desc":"…","why":"…"}]}`;

function extractJSON(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s > -1 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

async function callModel(batch) {
  const payload = batch.map((it) => ({
    id: it.id,
    repo: it.repo,
    desc_en: it.orig || "(没有写描述)",
    lang: it.lang,
    stars: it.stars,
    forks: it.forks,
    age_days: it.ageDays,
    official_org: !!it.official,
    today_stars: it.today,
    week_stars: it.week,
    daily_avg_lifetime: it.today == null ? it.estimate : null,
    topics: it.topics || []
  }));

  const res = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + KEY
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content:
            "给下面这些项目写中文条目。today_stars 为 null 表示还没有真实日增，用 daily_avg_lifetime（终生平均）描述时要说明这是平均值，别假装是今天涨的。\n\n" +
            JSON.stringify(payload, null, 1)
        }
      ]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || "";
  return extractJSON(text).items || [];
}

const cacheKey = (it) =>
  crypto.createHash("sha1").update(it.repo + "|" + (it.orig || "")).digest("hex").slice(0, 16);

function writeBack(data) {
  const payload =
    "// 由 pipeline/fetch.mjs 生成、pipeline/enrich.mjs 补中文，请勿手改\n" +
    `// 更新时间 ${new Date().toISOString()}\n` +
    `window.${VAR} = ` +
    JSON.stringify(data, null, 2) +
    ";\n";
  fs.writeFileSync(IN, payload, "utf8");
}

async function main() {
  const { data } = loadItems();
  let all = data.items;

  // 第一步：本地人工库先填，这一层不花钱、不需要 key。
  // 本地库是权威：内容不一致就以本地库为准，这样改了 zh.json 重跑就生效，
  // 不用 --overwrite（那个会把模型生成的一起重写）。
  let fromLocal = 0;
  if (!OVERWRITE) {
    for (const it of all) {
      const z = LOCAL[it.id];
      if (!z || !z.desc || !z.why) continue;
      if (it.desc === z.desc && it.why === z.why) continue;
      it.desc = z.desc;
      it.why = z.why;
      fromLocal++;
    }
  }

  let todo = all.filter((it) => OVERWRITE || !it.desc || !it.why);
  if (ONLY) todo = todo.slice(0, ONLY);

  console.log("githubhot 文案层");
  const localHas = all.filter((it) => LOCAL[it.id] && LOCAL[it.id].desc).length;
  console.log(
    `  条目 ${all.length} 条｜本地库覆盖 ${localHas} 条（免费）｜本次新填 ${fromLocal} 条｜还需模型写 ${todo.length} 条\n`
  );

  if (!todo.length) {
    writeBack(data);
    console.log(`  已写回 ${path.relative(ROOT, IN)}，全部来自本地库，没有调用任何模型。`);
    console.log("\n  看效果：打开 index.html，点日期那行的「看自动抓取版」");
    return;
  }

  if (LOCAL_ONLY) {
    writeBack(data);
    console.log(`  仅本地库模式：填了 ${fromLocal} 条，剩下 ${todo.length} 条没文案，页面会回落显示英文原文。`);
    return;
  }

  if (!KEY) {
    console.error(
      (OVERWRITE
        ? `--overwrite 会忽略本地库、全部重写，那就必须调模型，但没配密钥。\n\n`
        : `还有 ${todo.length} 条没有文案，本地库里也没有。两条路：\n\n`) +
        "  A. 把它们的 id 加进 pipeline/zh.json 自己写（格式 {desc, why}），然后重跑本命令 —— 免费\n" +
        "  B. 配一个 OpenAI 兼容的模型接口（DeepSeek 最便宜），让模型批量写：\n" +
        "       PowerShell:  $env:LLM_API_KEY=\"sk-xxxx\"\n" +
        "       bash:        export LLM_API_KEY=sk-xxxx\n" +
        "     默认打 https://api.deepseek.com/v1 的 deepseek-chat。换服务商再设 LLM_BASE_URL 和 LLM_MODEL。\n\n" +
        "配好之后重跑：node pipeline/enrich.mjs"
    );
    process.exit(2);
  }

  console.log(`  模型：${MODEL} @ ${BASE}`);

  const written = new Map();
  let failed = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const label = `  [${i + 1}-${Math.min(i + BATCH, todo.length)}/${todo.length}]`;
    process.stdout.write(label + " 请求中... ");

    try {
      const out = await callModel(batch);
      let ok = 0;
      for (const row of out) {
        if (!row.id || !row.desc || !row.why) continue;
        written.set(row.id, { desc: row.desc.trim(), why: row.why.trim() });
        ok++;
      }
      console.log(`拿到 ${ok} 条`);
      if (ok < batch.length) failed += batch.length - ok;
    } catch (e) {
      console.log("失败：" + e.message);
      failed += batch.length;
      await new Promise((r) => setTimeout(r, 3000));
    }

    // 每条单独落盘缓存，中断了下次不用重写
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    for (const it of batch) {
      const w = written.get(it.id);
      if (w) fs.writeFileSync(path.join(CACHE_DIR, cacheKey(it) + ".json"), JSON.stringify(w), "utf8");
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  // 已写过但本次没在批次里的，从缓存补
  for (const it of all) {
    if (written.has(it.id)) continue;
    const f = path.join(CACHE_DIR, cacheKey(it) + ".json");
    if (fs.existsSync(f)) {
      const c = JSON.parse(fs.readFileSync(f, "utf8"));
      if (OVERWRITE || !it.desc) written.set(it.id, c);
    }
  }

  let filled = 0;
  for (const it of all) {
    const w = written.get(it.id);
    if (!w) continue;
    it.desc = w.desc;
    it.why = w.why;
    filled++;
  }

  writeBack(data);

  console.log(`\n  已写回 ${path.relative(ROOT, IN)}，本次补了 ${filled} 条`);
  if (failed) console.log(`  有 ${failed} 条没拿到，重跑一次会自动补（已成功的会跳过）`);
  console.log("\n  看效果：打开 index.html，点日期那行的「看自动抓取版」");
}

main().catch((e) => {
  console.error("失败：" + e.message);
  process.exit(1);
});
