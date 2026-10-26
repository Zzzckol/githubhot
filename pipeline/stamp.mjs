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

/* 用北京时间算日期：runner 在 UTC，直接取 toISOString 在北京 8 点前会差一天 */
const bj = new Date(Date.now() + 8 * 3600 * 1000);
const stamp = bj.toISOString().slice(0, 10).replace(/-/g, "");

const indexPath = path.join(ROOT, "index.html");
const before = fs.readFileSync(indexPath, "utf8");
const after = before.replace(/(assets\/[\w.]+\.js)\?v=[\w]*/g, "$1?v=" + stamp);

if (after !== before) {
  fs.writeFileSync(indexPath, after, "utf8");
  console.log("版本号 → " + stamp);
} else {
  console.log("版本号没变化（已经是 " + stamp + "）");
}
