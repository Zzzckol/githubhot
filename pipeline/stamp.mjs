#!/usr/bin/env node
/**
 * 刷新 index.html 里 assets/*.js?v= 的版本号（北京时间当天日期）。
 *
 * 不刷这个，页面上的 data.auto.js 会被浏览器/CDN 一直拿旧的缓存，
 * 表现就是「云端明明更新了，页面上日期还是前几天」。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 用北京时间算，精确到分钟。
   只用日期（YYYYMMDD）的话，同一天里跑第二次版本号不变，
   浏览器和 GitHub Pages 的 CDN 会继续吃旧缓存 —— 数据更新了但页面还是上午那份。 */
const bj = new Date(Date.now() + 8 * 3600 * 1000);
const stamp = bj.toISOString().slice(0, 16).replace(/[-:T]/g, ""); // 202610260759

const indexPath = path.join(ROOT, "index.html");
const before = fs.readFileSync(indexPath, "utf8");
const after = before.replace(/(assets\/[\w.]+\.js)\?v=[\w]*/g, "$1?v=" + stamp);

if (after !== before) {
  fs.writeFileSync(indexPath, after, "utf8");
  console.log("版本号 → " + stamp);
} else {
  console.log("版本号没变化（已经是 " + stamp + "）");
}
