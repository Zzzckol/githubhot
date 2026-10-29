# -*- coding: utf-8 -*-
"""githubhot 常驻日更。

开机由启动文件夹里的「githubhot-daily.cmd」拉起（走 pythonw，无窗口）。
每 30 分钟醒一次：
  - 如果「今天已经抓到并推送成功」，就继续睡；
  - 否则跑一次 update.mjs：抓得到但推不上去，20 分钟后再试。
判断依据是 pipeline/out/pushed/<今天>.txt —— 这个标记由 update.mjs 在
「推送完并核验远端 HEAD 一致」之后才写。只有它存在，才算今天真的更新完了。

2026-10-29 修：原来只看 boards/<今天>.json 存不存在、以及 update.mjs 的退出码，
但 git 不在 PATH 时 publish() 只 warn 一句就正常退出，于是「本地抓到了、线上没变」
被判成成功，从此不再重试 —— 这是连续几天页面不动、日志却全绿的原因。

日志：pipeline/out/auto.log
"""

from __future__ import annotations

import datetime
import glob
import os
import pathlib
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "pipeline" / "out"
OUT.mkdir(parents=True, exist_ok=True)
LOG = OUT / "auto.log"
PIDFILE = OUT / "auto.pid"
PUSH_DIR = OUT / "pushed"

CHECK_SEC = 30 * 60      # 每 30 分钟检查一次
RETRY_SEC = 20 * 60      # 抓取/推送失败后的重试间隔
MAX_LOG = 200 * 1024     # 日志超过 200 KB 就砍掉前一半
LOCK_PORT = 52913        # 单实例锁，占个本地端口
CREATE_NO_WINDOW = 0x08000000


def log(msg: str) -> None:
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        if LOG.exists() and LOG.stat().st_size > MAX_LOG:
            data = LOG.read_text("utf-8", errors="ignore")
            LOG.write_text(data[len(data) // 2:], "utf-8")
    except Exception:
        pass
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def find_node() -> str | None:
    for c in sorted(
        glob.glob(r"C:\Users\Administrator\.workbuddy\binaries\node\versions\*\node.exe"),
        reverse=True,
    ):
        if os.path.isfile(c):
            return c
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        for name in ("node.exe", "node"):
            f = os.path.join(folder, name)
            if os.path.isfile(f):
                return f
    return None


def today_str() -> str:
    return datetime.date.today().isoformat()


def pushed_marker(day: str) -> pathlib.Path:
    return PUSH_DIR / f"{day}.txt"


def main() -> int:
    # 单实例：端口被占说明已经有一个在跑
    try:
        lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        lock.bind(("127.0.0.1", LOCK_PORT))
        lock.listen(1)
    except OSError:
        log("已有一个日更进程在跑，本次启动退出")
        return 0

    node = find_node()
    if not node:
        log("找不到 node.exe，日更起不来。检查 .workbuddy\\binaries\\node 是否还在")
        return 1

    PIDFILE.write_text(str(os.getpid()), "utf-8")
    log(f"日更已启动 pid={os.getpid()} node={node}")

    while True:
        day = today_str()

        # 只有「抓到了并且确认推上去了」才算今天完事
        if pushed_marker(day).exists():
            time.sleep(CHECK_SEC)
            continue

        board = ROOT / "pipeline" / "boards" / f"{day}.json"
        if board.exists():
            log(f"{day} 的榜单本地已有，但还没确认推到线上，重跑一次推送")
        else:
            log(f"{day} 还没有榜单存档，开始抓取")

        try:
            r = subprocess.run(
                [node, "pipeline/update.mjs"],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=900,
                creationflags=CREATE_NO_WINDOW,
            )
        except subprocess.TimeoutExpired:
            log("抓取超时（15 分钟没跑完），20 分钟后再试")
            time.sleep(RETRY_SEC)
            continue
        except Exception as e:
            log(f"抓取异常：{e!r}，20 分钟后再试")
            time.sleep(RETRY_SEC)
            continue

        if r.returncode == 0 and pushed_marker(day).exists():
            tail = " | ".join((r.stdout or "").strip().splitlines()[-4:])
            log(f"已更新并推送成功。{tail}")
            time.sleep(CHECK_SEC)
        else:
            # 抓到了但没推上去，或者干脆失败了：都要重试，不能装成功
            err = " | ".join((r.stderr or "").strip().splitlines()[-3:])
            tail = " | ".join((r.stdout or "").strip().splitlines()[-3:])
            log(
                f"这次没同步成功（退出码 {r.returncode}），20 分钟后再试。"
                f"{tail}{(' | ' + err) if err else ''}"
            )
            time.sleep(RETRY_SEC)


if __name__ == "__main__":
    sys.exit(main())
