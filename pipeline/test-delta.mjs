/**
 * 增量算法测试 —— 不联网，纯逻辑验证
 * 跑：node pipeline/test-delta.mjs
 */
import { dailyDelta, weekDelta, dayDiff } from "./lib/delta.mjs";

const TODAY = "2026-10-22";
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`); }
}

console.log("dayDiff");
check("同一天 = 0", dayDiff("2026-10-22", "2026-10-22"), 0);
check("跨一天 = 1", dayDiff("2026-10-21", "2026-10-22"), 1);
check("跨七天 = 7", dayDiff("2026-10-15", "2026-10-22"), 7);
check("跨月 = 9", dayDiff("2026-09-30", "2026-10-09"), 9);

console.log("\ndailyDelta");
check("无历史 → null", dailyDelta([], 5000, TODAY), null);
check("只有今天的记录 → null",
  dailyDelta([{ d: TODAY, s: 5000 }], 5000, TODAY), null);
check("昨天 1000 今天 1200 → 200",
  dailyDelta([{ d: "2026-10-21", s: 1000 }], 1200, TODAY), 200);
check("三天前 1000 今天 1600 → 日均 200",
  dailyDelta([{ d: "2026-10-19", s: 1000 }], 1600, TODAY), 200);
check("掉星 → null",
  dailyDelta([{ d: "2026-10-21", s: 2000 }], 1500, TODAY), null);
check("星数没变 → 0",
  dailyDelta([{ d: "2026-10-21", s: 2000 }], 2000, TODAY), 0);
check("20 天前的旧记录不参与 → null",
  dailyDelta([{ d: "2026-10-02", s: 1000 }], 9000, TODAY), null);
check("多条记录取最近的那条",
  dailyDelta([
    { d: "2026-10-10", s: 100 },
    { d: "2026-10-21", s: 1000 }
  ], 1300, TODAY), 300);

console.log("\nweekDelta");
check("无历史 → null", weekDelta([], 5000, TODAY), null);
check("七天前 1000 今天 1700 → 700",
  weekDelta([{ d: "2026-10-15", s: 1000 }], 1700, TODAY), 700);
check("三天前的不算周增 → null",
  weekDelta([{ d: "2026-10-19", s: 1000 }], 1700, TODAY), null);
check("20 天前的不算周增 → null",
  weekDelta([{ d: "2026-10-02", s: 1000 }], 9000, TODAY), null);
check("在 5~9 天范围内取最接近 7 天的",
  weekDelta([
    { d: "2026-10-17", s: 1000 },  // 5 天前
    { d: "2026-10-15", s: 1000 }   // 7 天前，应该用这条
  ], 1500, TODAY), 500);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
