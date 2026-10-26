# -*- coding: utf-8 -*-
"""githubhot 常驻日更。

开机由启动文件夹里的「githubhot-日更.cmd」拉起（走 pythonw，无窗口）。
每 30 分钟醒一次，发现 pipeline/boards/<今天>.json 不存在就跑一次 update.mjs；
抓到了就继续睡，失败了 20 分钟后重试。

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

CHECK_SEC = 30 * 60      # 每 30 分钟检查一次
RETRY_SEC = 20 * 60      # 抓取失败后的重试间隔
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
        board = ROOT / "pipeline" / "boards" / f"{day}.json"
        if board.exists():
            time.sleep(CHECK_SEC)
            continue

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

        if r.returncode == 0:
            tail = " | ".join((r.stdout or "").strip().splitlines()[-4:])
            log(f"抓取成功。{tail}")
            time.sleep(CHECK_SEC)
        else:
            err = " | ".join((r.stderr or "").strip().splitlines()[-3:])
            log(f"抓取失败（退出码 {r.returncode}），20 分钟后再试。{err}")
            time.sleep(RETRY_SEC)


if __name__ == "__main__":
    sys.exit(main())
