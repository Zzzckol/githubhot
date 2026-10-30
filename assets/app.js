/* githubhot — 渲染逻辑（快照版，无后端） */

const CATS = {
  agent:    "Agent 与技能",
  model:    "模型与多媒体",
  devtool:  "开发工具",
  security: "安全",
  learn:    "学习资源",
  content:  "数据与内容"
};

const LANG_COLOR = {
  Python: "#3572A5",
  TypeScript: "#3178C6",
  JavaScript: "#F1E05A",
  Go: "#00ADD8",
  Rust: "#DEA584",
  Java: "#B07219",
  Kotlin: "#A97BFF"
};

/* 数据源：默认用管线抓的最新版；?auto=0 切到 40 条手写精选存档。
   两个版本用不同的 query 值切换 —— 只用 hash 切换的话，从 #/ 跳 #/ 地址没变，
   浏览器不会重新加载，点了就像没反应。 */
const HAS_AUTO = !!window.GH_DATA_AUTO;
const USE_AUTO = HAS_AUTO && !/[?&]auto=0\b/.test(location.search);
const BASE_DATA = USE_AUTO ? window.GH_DATA_AUTO : window.GH_DATA;

/* 历史归档：每天一份完整榜单（boards + history + 元数据合成），见 pipeline/archive.mjs */
const ARCHIVE = window.GH_ARCHIVE || null;

/* 当前正在看的数据。首页 / 历史日 会换掉它，所以要能重算。 */
let DATA = null;
let ITEMS = [];
let BY_ID = {};
let SORTED = [];
let IS_ARCHIVE = false;
let ARCHIVE_DAY = null;

function applyData(d) {
  DATA = d;
  ITEMS = DATA.items.map(function (it) {
    if (it.heat == null) {
      it.heat = (it.today || 0) + (it.week || 0) / 7 + (it.estimate || 0) * 0.2;
    }
    return it;
  });
  BY_ID = {};
  ITEMS.forEach(function (it) { BY_ID[it.id] = it; });
  SORTED = ITEMS.slice().sort(function (a, b) {
    // 有真实榜位就按榜位排，保证序号和名次一致
    if (a.rank != null && b.rank != null) return a.rank - b.rank;
    return b.heat - a.heat;
  });
}

/* 把归档里某一天拼成和 data.auto.js 同构的对象，后面的渲染逻辑不用改 */
function buildDay(date) {
  if (!ARCHIVE) return null;
  const day = ARCHIVE.days.filter(function (d) { return d.date === date; })[0];
  if (!day) return null;
  const items = day.entries.map(function (e) {
    const m = ARCHIVE.meta[e.id] || {};
    const it = {};
    for (const k in m) it[k] = m[k];
    it.id = e.id;
    it.rank = e.rank;
    it.stars = e.stars;
    it.today = e.today;
    it.week = e.week;
    it.estimate = e.estimate;
    it.prevRank = e.prevRank;
    it.rankDelta = e.rankDelta;
    it.newToBoard = e.newToBoard;
    it.streak = e.streak;
    it.zh = !!m.desc;
    return it;
  });
  return {
    snapshot: day.date,
    dateLabel: day.label,
    auto: true,
    archive: true,
    vs: day.vs,
    items: items,
  };
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(n) {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}
function short(n) {
  if (n == null) return "—";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 1 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}
function splitRepo(repo) {
  const p = repo.split("/");
  return { owner: p[0], name: p[1] };
}
function langDot(lang) {
  const c = LANG_COLOR[lang] || "#9aa0aa";
  return '<span class="dot" style="background:' + c + '"></span>';
}
function agoText(it) {
  const parts = [];
  if (it.today != null) parts.push('<span class="rise">今日 +' + num(it.today) + "</span>");
  if (it.week != null) parts.push('<span class="rise">本周 +' + num(it.week) + "</span>");
  if (!parts.length && it.estimate != null) {
    parts.push('<span class="est">日均 +' + num(it.estimate) + "</span>");
  }
  if (!parts.length) parts.push('<span class="pill">无增量数据</span>');
  return parts.join('<span style="color:#c8ccd4">·</span>');
}

/* 和昨天的榜单比：新上榜 / 名次升降 / 连续在榜 */
function rankTag(it) {
  if (it.newToBoard === true) return '<span class="tag new">新上榜</span>';
  if (it.rankDelta > 0) return '<span class="tag up">↑' + it.rankDelta + "</span>";
  if (it.rankDelta < 0) return '<span class="tag down">↓' + -it.rankDelta + "</span>";
  if (it.streak >= 3) return '<span class="tag same">连续 ' + it.streak + " 天</span>";
  return "";
}

/* 自动抓取的版本没有中文说明，回落到仓库原文 */
function descOf(it) { return it.desc || it.orig || "这个仓库没有写描述。"; }

/* ---------- 首页 ---------- */
let state = { cat: "all", q: "" };

function chipHTML(key, label, count) {
  const on = state.cat === key ? " on" : "";
  const extra = key === "new" ? " chip--new" : "";
  return '<button class="chip' + extra + on + '" data-cat="' + key + '">' + label +
    (count != null ? "<span>" + count + "</span>" : "") + "</button>";
}

function renderFeed() {
  const q = state.q.trim().toLowerCase();
  const list = SORTED.filter(function (it) {
    if (state.cat === "new") {
      if (it.newToBoard !== true) return false;
    } else if (state.cat !== "all" && it.cat !== state.cat) {
      return false;
    }
    if (!q) return true;
    return (it.repo + " " + it.desc + " " + it.why + " " + (it.orig || "") + " " + CATS[it.cat]).toLowerCase().indexOf(q) > -1;
  });

  const counts = {};
  ITEMS.forEach(function (it) { counts[it.cat] = (counts[it.cat] || 0) + 1; });
  const newCount = ITEMS.filter(function (it) { return it.newToBoard === true; }).length;

  const chips = [chipHTML("all", "全部", ITEMS.length)]
    .concat(newCount ? [chipHTML("new", "今日新进", newCount)] : [])
    .concat(Object.keys(CATS).map(function (k) { return chipHTML(k, CATS[k], counts[k] || 0); }))
    .join("");

  let html = "";
  list.forEach(function (it, i) {
    const r = splitRepo(it.repo);
    const lead = i === 0 ? " item--lead" : "";
    const rankNo = it.rank != null ? it.rank : i + 1;
    html +=
      '<article class="item' + lead + '">' +
        '<div class="item__num">' + String(rankNo).padStart(2, "0") + "</div>" +
        "<div>" +
          '<div class="item__meta">' +
            rankTag(it) +
            '<span class="lang">' + langDot(it.lang) + esc(it.lang) + "</span>" +
            '<span style="color:#c8ccd4">·</span>' +
            agoText(it) +
            '<span class="pill">' + CATS[it.cat] + "</span>" +
            (it.zh ? '<span class="pill zh">中文</span>' : "") +
            (it.official ? '<span class="pill">官方</span>' : "") +
          "</div>" +
          '<h2 class="item__title"><a href="#/p/' + it.id + '">' +
            esc(r.owner) + '<span class="slash">/</span>' + esc(r.name) +
          "</a></h2>" +
          '<p class="item__desc' + (it.desc ? "" : " raw") + '">' + esc(descOf(it)) + "</p>" +
          (it.why ? '<div class="item__why"><b>为什么值得看</b>' + esc(it.why) + "</div>" : "") +
          '<div class="item__stats">' +
            "<span>★ <span class='k'>" + short(it.stars) + "</span></span>" +
            "<span>⑂ <span class='k'>" + short(it.forks) + "</span></span>" +
            (it.ageDays ? "<span>上线 <span class='k'>" + it.ageDays + "</span> 天</span>" : "") +
            '<a class="go" href="https://github.com/' + it.repo + '" target="_blank" rel="noopener">查看仓库 →</a>' +
          "</div>" +
        "</div>" +
      "</article>";
  });

  if (!list.length) {
    html = '<div class="empty">没有匹配的项目。换个词试试，或者点「全部」。</div>';
  }

  const main = document.getElementById("feed");
  main.innerHTML = html;

  document.getElementById("chips").innerHTML = chips;
  const counter = document.getElementById("count");
  if (counter) counter.textContent = list.length + " 个项目";

  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (b) {
    b.addEventListener("click", function () {
      state.cat = b.getAttribute("data-cat");
      renderFeed();
    });
  });
}

function boardHTML(title, sub, rows, valueKey) {
  const body = rows.map(function (it, i) {
    const r = splitRepo(it.repo);
    return '<a class="board__row" href="#/p/' + it.id + '">' +
      '<span class="n">' + String(i + 1).padStart(2, "0") + "</span>" +
      '<span class="nm">' + esc(r.owner) + "/" + esc(r.name) + "</span>" +
      '<span class="v">+' + num(it[valueKey]) + "</span>" +
      "</a>";
  }).join("");
  return '<div class="board"><div class="board__head"><h3>' + title +
    "</h3><span>" + sub + '</span></div>' + body + "</div>";
}

function renderSide() {
  const hasToday = ITEMS.some(function (i) { return i.today != null; });
  const hasWeek = ITEMS.some(function (i) { return i.week != null; });

  const first = hasToday
    ? { t: "今日涨星", s: "按今日新增 ★ 排", k: "today",
        rows: ITEMS.filter(function (i) { return i.today != null; })
          .sort(function (a, b) { return b.today - a.today; }).slice(0, 8) }
    : hasWeek
    ? { t: "本周涨星", s: "按本周新增 ★ 排", k: "week",
        rows: ITEMS.filter(function (i) { return i.week != null; })
          .sort(function (a, b) { return b.week - a.week; }).slice(0, 8) }
    : { t: "终生日均", s: "还没有增量，先按平均速度", k: "estimate",
        rows: ITEMS.filter(function (i) { return i.estimate != null; })
          .sort(function (a, b) { return b.estimate - a.estimate; }).slice(0, 8) };

  const catCount = {};
  ITEMS.forEach(function (it) { catCount[it.cat] = (catCount[it.cat] || 0) + 1; });
  /* 某天可能一个「学习资源」都没有，count 就是 undefined。
     2026-10-30 页面上那一栏就是这么显示成 "学习资源 undefined" 的，所以统一兜成 0。 */
  const catOf = function (k) { return catCount[k] || 0; };
  const catRows = Object.keys(CATS).sort(function (a, b) { return catOf(b) - catOf(a); })
    .map(function (k) {
      return '<div class="board__row"><span class="n"></span><span class="nm">' + CATS[k] +
        '</span><span class="v mut">' + catOf(k) + "</span></div>";
    }).join("");

  /* 今日新进：昨天不在榜的，按今日涨星排 */
  const newcomers = ITEMS.filter(function (i) { return i.newToBoard === true; })
    .sort(function (a, b) { return (b.today || 0) - (a.today || 0); });

  const newBlock = newcomers.length
    ? '<div class="board board--new"><div class="board__head"><h3>今日新进 ' + newcomers.length +
      '</h3><span>昨天不在榜</span></div>' +
      newcomers.slice(0, 8).map(function (it, i) {
        const r = splitRepo(it.repo);
        return '<a class="board__row" href="#/p/' + it.id + '">' +
          '<span class="n">' + String(i + 1).padStart(2, "0") + "</span>" +
          '<span class="nm">' + esc(r.owner) + "/" + esc(r.name) + "</span>" +
          '<span class="v">' + (it.today != null ? "+" + num(it.today) : short(it.stars)) + "</span>" +
          "</a>";
      }).join("") +
      (newcomers.length > 8 ? '<div class="board__more">还有 ' + (newcomers.length - 8) + " 个，点上面的「今日新进」看全部</div>" : "") +
      "</div>"
    : "";

  const note = USE_AUTO
    ? "<b>这份是自动抓的</b><br>每天跑一次「更新.bat」抓 GitHub 接口。" +
      (newcomers.length ? "标「新上榜」的是昨天不在这 60 名里的，↑↓ 是和昨天的名次差。" : "") +
      "想看出每天的变化，就点「今日新进」。"
    : "<b>手写精选存档</b><br>2026-10-22 15:40 的快照，固定不变。想看每天的变化，切回今日自动版。";

  document.getElementById("side").innerHTML =
    newBlock +
    boardHTML(first.t, first.s, first.rows, first.k) +
    '<div class="board"><div class="board__head"><h3>分类</h3><span>共 ' + ITEMS.length + "</span></div>" + catRows + "</div>" +
    '<div class="sidenote">' + note + "</div>";
}

/* ---------- 详情 ---------- */
function renderDetail(id) {
  const it = BY_ID[id];
  if (!it) { location.hash = "#/"; return; }
  const r = splitRepo(it.repo);
  const related = SORTED.filter(function (x) { return x.cat === it.cat && x.id !== it.id; }).slice(0, 4);

  document.getElementById("app").innerHTML =
    '<div class="detail">' +
      '<a class="back" href="#/">← 回到今天</a>' +
      "<h1>" + esc(r.owner) + '<span class="slash">/</span>' + esc(r.name) + "</h1>" +
      '<div class="item__meta" style="margin-top:14px">' +
        '<span class="lang">' + langDot(it.lang) + esc(it.lang) + "</span>" +
        '<span style="color:#c8ccd4">·</span>' +
        '<span class="pill">' + CATS[it.cat] + "</span>" +
        (it.zh ? '<span class="pill zh">中文</span>' : "") +
        '<span style="color:#c8ccd4">·</span>' +
        "<span>" + esc(it.repo) + "</span>" +
      "</div>" +
      '<p class="detail__desc' + (it.desc ? "" : " raw") + '">' + esc(descOf(it)) + "</p>" +

      (function () {
        if (it.rank == null) return "";
        if (it.newToBoard === true) {
          return '<div class="ranknote new">昨天不在榜 · 今天第 ' + it.rank + " 名</div>";
        }
        if (it.prevRank == null) return "";
        const d = it.rankDelta;
        const move = d > 0 ? "（↑" + d + "）" : d < 0 ? "（↓" + -d + "）" : "（不变）";
        return '<div class="ranknote">昨天第 ' + it.prevRank + " 名 → 今天第 " + it.rank + " 名" +
          move + (it.streak > 1 ? " · 连续 " + it.streak + " 天在榜" : "") + "</div>";
      })() +

      '<div class="kv">' +
        '<div class="kv__cell"><div class="t">总星数</div><div class="v">' + short(it.stars) + "</div></div>" +
        (it.today != null
          ? '<div class="kv__cell"><div class="t">今日新增</div><div class="v g">+' + num(it.today) + "</div></div>"
          : '<div class="kv__cell"><div class="t">终生日均</div><div class="v g">' + (it.estimate != null ? "+" + num(it.estimate) : "—") + "</div></div>") +
        (it.week != null
          ? '<div class="kv__cell"><div class="t">本周新增</div><div class="v g">+' + num(it.week) + "</div></div>"
          : '<div class="kv__cell"><div class="t">上线天数</div><div class="v">' + (it.ageDays != null ? it.ageDays + " 天" : "—") + "</div></div>") +
        '<div class="kv__cell"><div class="t">Fork</div><div class="v">' + short(it.forks) + "</div></div>" +
      "</div>" +

      (it.why ? '<div class="block"><h2>为什么值得看</h2><p>' + esc(it.why) + "</p></div>" : "") +

      (it.orig && it.desc ? '<div class="block"><h2>仓库原始描述</h2><div class="quote">' + esc(it.orig) + "</div></div>" : "") +

      '<div class="actions">' +
        '<a class="btn" href="https://github.com/' + it.repo + '" target="_blank" rel="noopener">打开 GitHub 仓库 ↗</a>' +
        '<a class="btn ghost" href="#/">返回列表</a>' +
      "</div>" +

      (related.length ? '<div class="related"><h3>同类项目</h3>' +
        related.map(function (x) {
          return '<a href="#/p/' + x.id + '"><span class="nm">' + esc(x.repo) + '</span><span class="d">' +
            esc(descOf(x)) + "</span></a>";
        }).join("") + "</div>" : "") +
    "</div>";
  window.scrollTo(0, 0);
}

/* ---------- 关于 ---------- */
function renderAbout() {
  document.getElementById("app").innerHTML =
    '<div class="about">' +
      "<h1>这是什么</h1>" +
      "<p>githubhot 是一个 GitHub 热门项目的聚合站。每天看看有什么新东西冒出来，比自己在 Trending 页面上刷半天要省事——因为每一条都写了「为什么值得看」，而不是只丢一个仓库名给你。</p>" +
      "<p>产品形态参考了 aihot.news。它把「同一件事的十篇报道合成一条」做得很干净，这里换成了「同一个项目的各种指标按热度排」，外加一层「今天和昨天比有什么变化」。</p>" +

      "<h2>两个版本</h2>" +
      "<p><b>今日自动版</b>（默认）：<code>pipeline/fetch.mjs</code> 抓的 60 个项目，每天跑一次「更新.bat」刷新。指标全是真的，能算出今日涨星和名次变化。</p>" +
      "<p><b>手写精选存档</b>：40 个，2026-10-22 15:40 的快照，固定不变。当初拿来定产品形态，现在留着做对照。</p>" +

      "<h2>这些推荐理由可信到什么程度</h2>" +
      "<p>全部逐条手写，没有一句是机器批量生成的。但写的时候我手上只有三样东西：仓库自己写的一句话描述、topics 标签，以及星数 / 上线天数 / 是否官方账号这些公开指标。<b>除了明确写了「试过」的，我没有把项目跑起来。</b></p>" +
      "<p>所以页面上看到的话，可信度分三档：</p>" +
      "<ul>" +
      "<li><b>数字</b>——星数、fork、上线天数、今日涨星、名次变化。来自 GitHub 接口，是真的，可以自己核。</li>" +
      "<li><b>转述</b>——「45 种图型」「支持导入 drawio」这类。来自仓库 README，一般准，但可能落后于代码。</li>" +
      "<li><b>判断</b>——「值得试」「这个方向对」「别接生产」。这是看法，会错。</li>" +
      "</ul>" +
      "<p>错了就改，举个例子：<code>diagram-design</code> 这条我一开始写「比 Mermaid 好看不止一点」，读了它 README 才发现作者自己说「仓库里反复改的文档还是该用 Mermaid」——那句已经换掉了。所有文案在 <code>pipeline/zh.json</code>，改一行重跑就生效。</p>" +

      "<h2>每天的变化怎么来的</h2>" +
      "<p>光存星数不够，还得知道「每天谁在榜、第几名」。所以每天把当天这 60 个的 id 按名次存一份到 <code>pipeline/boards/</code>，第二天拿今天的榜和昨天的榜逐条比，就有了「新上榜」「↑4」「↓2」「连续 3 天在榜」。</p>" +
      "<p><b>新上榜不等于新项目。</b>它只说明昨天不在这 60 个里——可能是刚发布，也可能是老项目昨天没挤进来。老项目突然回榜往往更值得看，一般是发了大版本。</p>" +

      "<h2>还缺什么</h2>" +
      "<ol>" +
      "<li><b>本周涨星</b>：要 5~9 天前的快照才能算，跑够一周自动出来</li>" +
      "<li><b>事件聚簇</b>：同一波热潮下的几个项目该归成一组，现在只能靠分类标签粗分</li>" +
      "<li><b>分类准确率约八成</b>：错的主要是没写描述的项目，和「AI 助手」这种跨界的</li>" +
      "<li><b>断一天就缺一天</b>：没跑更新的那天，榜位对比会永久缺失。GitHub 接口拿不到历史星数，补不回来</li>" +
      "</ol>" +

      "<h2>数据来源</h2>" +
      "<p>项目、星数、Fork、语言、创建时间：GitHub 官方搜索接口。中文说明与推荐理由：逐条手写，存在 <code>pipeline/zh.json</code>；本地库没覆盖的新项目才用模型兜底。</p>" +

      "<h2>名字</h2>" +
      "<p>githubhot 是临时名。参考的 aihot 在它自己的 README 里明确写了「请不要使用 AIHOT 的名字和 Logo」——所以这里只借了它的产品思路，没有碰它的任何视觉资产。</p>" +

      '<div style="margin-top:36px"><a class="btn ghost" href="#/">← 回到今天</a></div>' +
    "</div>";
  window.scrollTo(0, 0);
}

/* ---------- 首页整页 ---------- */
function shortDate(d) {
  const p = String(d).split("-");
  return Number(p[1]) + "月" + Number(p[2]) + "日";
}

/* 对比的是哪一天。中间断过档（比如休假那几天没跑）就如实说出来，别假装是「昨天」 */
function vsLabel() {
  const vs = DATA && DATA.vs;
  if (!vs) return "对比上一次";
  let extra = "";
  const cur = DATA.snapshot ? String(DATA.snapshot).slice(0, 10) : null;
  if (cur) {
    const gap = Math.round(
      (new Date(cur + "T00:00:00Z") - new Date(vs + "T00:00:00Z")) / 86400000
    );
    if (gap > 1) extra = "（中间空了 " + (gap - 1) + " 天）";
  }
  return "对比 " + shortDate(vs) + extra;
}

function deltaHTML() {
  if (!USE_AUTO) return "";
  if (!ITEMS.some(function (i) { return i.newToBoard != null; })) return "";
  const n = ITEMS.filter(function (i) { return i.newToBoard === true; }).length;
  const up = ITEMS.filter(function (i) { return i.rankDelta > 0; }).length;
  const down = ITEMS.filter(function (i) { return i.rankDelta < 0; }).length;
  const stay = ITEMS.length - n;
  if (!n && !up && !down) {
    return '<div class="delta">' + vsLabel() + "：榜单没变，没有项目进出。<span class=\"bar\"></span></div>";
  }
  return '<div class="delta">' +
    vsLabel() + "：<b>" + n + "</b> 个新上榜，" + stay + " 个还在榜" +
    (up ? '，<b class="up">' + up + "</b> 个名次上升" : "") +
    (down ? '，<b class="down">' + down + "</b> 个下滑" : "") +
    (n ? '<button class="delta__btn" data-cat="new">只看新进 →</button>' : "") +
    '<span class="bar"></span></div>';
}

/* 日期切换：看历史时给前后天和「回到最新」，看最新时列最近几天 */
function dateNavHTML() {
  if (!USE_AUTO) return "";   // 手写存档是固定 40 条，跟日期无关，不显示
  if (!ARCHIVE || !ARCHIVE.days || !ARCHIVE.days.length) return "";
  const days = ARCHIVE.days;

  if (IS_ARCHIVE) {
    const idx = days.map(function (d) { return d.date; }).indexOf(ARCHIVE_DAY);
    const prev = idx > 0 ? days[idx - 1] : null;
    const next = idx >= 0 && idx < days.length - 1 ? days[idx + 1] : null;
    return '<div class="daynav">' +
      (prev
        ? '<a class="daynav__step" href="#/d/' + prev.date + '">← ' + shortDate(prev.date) + "</a>"
        : '<span class="daynav__step off">已是最早</span>') +
      '<a class="daynav__home" href="#/">回到最新</a>' +
      (next
        ? '<a class="daynav__step" href="#/d/' + next.date + '">' + shortDate(next.date) + " →</a>"
        : '<span class="daynav__step off">已是最新</span>') +
      "</div>";
  }

  const hist = days.slice(0, -1).slice(-7).reverse();
  if (!hist.length) return "";
  return '<div class="daynav"><span class="daynav__label">往回看</span>' +
    hist.map(function (d) {
      return '<a class="daychip" href="#/d/' + d.date + '">' + shortDate(d.date) + "</a>";
    }).join("") +
    "</div>";
}

function renderHome() {
  document.getElementById("app").innerHTML =
    '<div class="masthead wrap">' +
      "<h1>每天值得打开一次的 GitHub 热门清单</h1>" +
      "<p>不列仓库名，也不给一堆数字让你自己判断。每条都说清楚它是干什么的、为什么今天值得你看一眼。</p>" +
      '<div class="dateline"><span class="nodot">' + DATA.dateLabel + '</span><span>·</span><span id="count">' +
      ITEMS.length + " 个项目</span><span>·</span><span>" +
      (IS_ARCHIVE ? "历史榜单" : USE_AUTO ? "自动抓取" : "手写存档") + "</span>" +
      (!IS_ARCHIVE && HAS_AUTO
        ? '<a class="switch" href="' + (USE_AUTO ? "?auto=0" : "?auto=1") + '#/" title="' +
          (USE_AUTO ? "切到 40 条手写精选存档" : "回到今天自动抓取的完整清单") + '">' +
          (USE_AUTO ? "手写精选 40 条 →" : "← 今日自动版") + "</a>"
        : "") +
      '<span class="bar"></span></div>' +
      dateNavHTML() +
      deltaHTML() +
    "</div>" +
    '<div class="filters"><div class="filters__in wrap">' +
      '<div class="chips" id="chips"></div>' +
      '<div class="search">' +
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#8d94a1" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14" stroke-linecap="round"/></svg>' +
        '<input id="q" type="search" placeholder="搜索项目、关键词  /" autocomplete="off">' +
      "</div>" +
    "</div></div>" +
    '<div class="layout wrap">' +
      '<main class="feed" id="feed"></main>' +
      '<aside class="side"><div class="side__inner" id="side"></div></aside>' +
    "</div>";

  renderFeed();
  renderSide();

  const deltaBtn = document.querySelector(".delta__btn");
  if (deltaBtn) {
    deltaBtn.addEventListener("click", function () {
      state.cat = "new";
      renderFeed();
      const feed = document.getElementById("feed");
      if (feed) feed.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const q = document.getElementById("q");
  q.value = state.q;
  q.addEventListener("input", function () {
    state.q = q.value;
    renderFeed();
  });
}

/* ---------- 路由 ---------- */
function updateFooter() {
  const foot = document.getElementById("footNote");
  if (!foot) return;
  foot.textContent =
    "githubhot · 数据 " + (DATA.dateLabel || "—") +
    (IS_ARCHIVE
      ? " · 历史榜单，看的是归档"
      : USE_AUTO
        ? " · 双击「更新.bat」刷新到最新"
        : " · 手写存档，固定不变");
}

function route() {
  const h = location.hash || "#/";
  const dm = h.match(/^#\/d\/(\d{4}-\d{2}-\d{2})$/);
  const pm = h.match(/^#\/p\/(.+)$/);

  document.querySelectorAll(".nav a").forEach(function (a) {
    a.classList.remove("on");
    if (a.getAttribute("href") === (pm ? "" : h)) a.classList.add("on");
  });

  /* 历史某一天：#/d/2026-10-23 */
  if (dm) {
    const day = buildDay(dm[1]);
    if (day) {
      IS_ARCHIVE = true;
      ARCHIVE_DAY = dm[1];
      applyData(day);
      renderHome();
      updateFooter();
      window.scrollTo(0, 0);
      return;
    }
    location.hash = "#/";   // 没有这一天，回首页
    return;
  }

  /* 详情页：沿用当前这份数据，从历史页点进来就还是历史那天的条目 */
  if (pm) {
    renderDetail(pm[1]);
    return;
  }

  IS_ARCHIVE = false;
  ARCHIVE_DAY = null;
  applyData(BASE_DATA);

  if (h === "#/about") renderAbout();
  else renderHome();
  updateFooter();
}

document.addEventListener("keydown", function (e) {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
    const q = document.getElementById("q");
    if (q) { e.preventDefault(); q.focus(); }
  }
});

/* 先铺一份数据，保证直接进 #/p/xxx 时 BY_ID 不是空的 */
applyData(BASE_DATA);
window.addEventListener("hashchange", route);
route();
