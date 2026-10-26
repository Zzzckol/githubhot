/**
 * 增量计算 —— 整个产品最核心的一段逻辑
 * 单独抽出来是为了能脱离网络单独测
 */

export const DAY = 86400000;

export function dayDiff(from, to) {
  return Math.round(
    (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / DAY
  );
}

/**
 * 每日新增星数
 * @param records 历史记录 [{d:'2026-10-20', s:1234}, ...]，按日期升序
 * @param stars   今天看到的星数
 * @param todayISO 今天日期
 * @param maxGap  超过这么多天的旧记录不再用于计算（避免算成「平均」）
 */
export function dailyDelta(records, stars, todayISO, maxGap = 14) {
  if (!records || !records.length) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.d >= todayISO) continue;
    const gap = dayDiff(r.d, todayISO);
    if (gap <= 0 || gap > maxGap) continue;
    const diff = stars - r.s;
    if (diff < 0) return null; // 掉星，不算「涨」
    return Math.round(diff / gap);
  }
  return null;
}

/**
 * 7 天新增星数：找 5~9 天前里最接近 7 天的那条记录
 */
export function weekDelta(records, stars, todayISO) {
  if (!records || !records.length) return null;
  let best = null;
  for (const r of records) {
    if (r.d >= todayISO) continue;
    const gap = dayDiff(r.d, todayISO);
    if (gap < 5 || gap > 9) continue;
    if (!best || Math.abs(gap - 7) < Math.abs(dayDiff(best.d, todayISO) - 7)) {
      best = r;
    }
  }
  if (!best) return null;
  const diff = stars - best.s;
  return diff > 0 ? diff : null;
}
