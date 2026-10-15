# latency.py — 持久执行器延迟诊断客户端（本地单调时钟打点，无时钟斜偏问题）
#
# 凭据不在本文件里: 从项目根的 servers.json 读。找不到就报错退出。
#   python latency.py                       # 用 default:true 那台
#   SRB_TEST_SERVER=<名字> python latency.py  # 指定某台
import subprocess, threading, time, base64, sys, os, json, pathlib

FWD = pathlib.Path(__file__).resolve().parent.parent


def load_conn():
    cfg_path = os.environ.get("SRB_CONFIG") or (FWD / "servers.json")
    if not pathlib.Path(cfg_path).exists():
        sys.exit(f"no servers.json at {cfg_path} — create one first (see README)")
    cfg = json.loads(pathlib.Path(cfg_path).read_text(encoding="utf-8"))
    servers = cfg.get("servers") or {}
    want = os.environ.get("SRB_TEST_SERVER")
    name = want or next((n for n, s in servers.items() if s.get("default")), None) or next(iter(servers), None)
    if not name:
        sys.exit(f"{cfg_path} has no server entries")
    if want and name not in servers:
        sys.exit(f"SRB_TEST_SERVER={want!r} not found. available: {', '.join(servers) or '(none)'}")
    s = servers[name]
    return name, cfg.get("plink"), s


SRV, CFG_PLINK, S = load_conn()
PLINK = os.environ.get("SRB_PLINK") or CFG_PLINK or "plink.exe"
HOST = S["host"]
HOSTKEY = S.get("hostkey", "")
PORT = str(S.get("port", 22))
USER = S["user"]
PASSWORD = S.get("password", "")
SCRIPT = "/tmp/.srb-exec3.sh"

if not HOSTKEY:
    sys.exit("server has no hostkey in servers.json — plink would refuse the connection")
if not PASSWORD and not S.get("keyFile"):
    sys.exit("server has neither password nor keyFile in servers.json")

CMDS = [
    ("echo WARMUP", 0),                                    # 0 含握手
    ("echo PING", 0),                                      # 1 紧接着
    ("echo PING2", 0),                                     # 2 紧接着
    ('S=$EPOCHREALTIME; sleep 0.3; E=$EPOCHREALTIME; printf "INBAND %s %s\\n" "$S" "$E"', 0),  # 3 服务器侧自计时
    ("seq 1 2000", 0),                                     # 4 大输出 ~14KB
    ("echo AFTERIDLE", 10),                                # 5 空闲10秒后再发
    ("cat /proc/loadavg; nproc", 0),                       # 6 服务器负载
]


def spawn(client):
    args = [client, "-ssh", "-batch", "-hostkey", HOSTKEY,
            "-P", PORT, "-l", USER]
    if PASSWORD:
        args += ["-pw", PASSWORD]
    args += [HOST, "bash " + SCRIPT]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)


def main():
    client = sys.argv[1] if len(sys.argv) > 1 else PLINK
    p = spawn(client)
    lines = []
    lock = threading.Lock()

    def reader():
        for raw in iter(p.stdout.readline, b""):
            with lock:
                lines.append((time.monotonic(), raw.decode("utf-8", "replace").rstrip()))
    threading.Thread(target=reader, daemon=True).start()

    t0 = time.monotonic()
    recs = []
    for i, (cmd, idle) in enumerate(CMDS):
        if idle:
            time.sleep(idle)
        tok = "t%d" % i
        b64 = base64.b64encode(cmd.encode()).decode()
        sendts = time.time()
        tsend = time.monotonic()
        p.stdin.write(("%s|C %s %s\n" % (sendts, tok, b64)).encode())
        p.stdin.flush()
        rec = {"i": i, "cmd": cmd, "tsend": tsend, "sendts": sendts}
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            with lock:
                snap = list(lines)
            done = [l for l in snap if l[1].startswith("D %s " % tok)]
            if done:
                rec["tD"] = done[0][0]
                for pre in ("T", "O", "Z"):
                    hit = [l for l in snap if l[1].startswith("%s %s " % (pre, tok))]
                    if hit:
                        rec["t" + pre] = hit[0][0]
                        rec[pre + "line"] = hit[0][1]
                break
            time.sleep(0.001)
        else:
            rec["tD"] = None
        recs.append(rec)

    base = recs[0]["tsend"] if recs else 0.0
    print("== 本地单调时钟（秒，相对首条命令发送时刻）==")
    print("%-3s %-34s %8s %8s %8s %8s %8s %9s" %
          ("#", "cmd", "send", "T到", "O到", "D到", "Z到", "总耗时"))
    for r in recs:
        if r.get("tD") is None:
            print("%-3d %-34s TIMEOUT" % (r["i"], r["cmd"][:34]))
            continue
        f = lambda k: ("%8.3f" % (r[k] - base)) if r.get(k) else "      -"
        print("%-3d %-34s %s %s %s %s %s %9.3f" %
              (r["i"], r["cmd"][:34], f("tsend"), f("tT"), f("tO"), f("tD"), f("tZ"),
               r["tD"] - r["tsend"]))

    print("\n== 服务器侧（T/Z 行内容，同一服务器时钟，差值有效）==")
    for r in recs:
        if "Tline" in r:
            print("cmd%-2d %s" % (r["i"], r["Tline"]))
        if "Zline" in r:
            print("      %s" % r["Zline"])
            # 解析 post 与 Z，算 printf+base64 的服务器侧耗时
            try:
                post = float([x for x in r["Tline"].split() if x.startswith("post=")][0][5:])
                z = float(r["Zline"].split()[2])
                print("      => 服务器侧 printf+base64 耗时: %.3f s" % (z - post))
            except Exception as e:
                print("      (parse fail: %s)" % e)

    print("\n== 服务器侧 read 相对本地 sendts 的偏移（含时钟斜偏+单向传输）==")
    for r in recs:
        if "Tline" in r:
            try:
                rd = float([x for x in r["Tline"].split() if x.startswith("read=")][0][5:])
                sd = float([x for x in r["Tline"].split() if x.startswith("send=")][0][5:])
                print("cmd%-2d read-sendts = %+.3f s (本地sendts=%.3f)" % (r["i"], rd - sd, sd))
            except Exception:
                pass

    print("\n== INBAND / 负载 输出 ==")
    for r in recs:
        if "Oline" in r:
            try:
                dec = base64.b64decode(r["Oline"].split(" ", 2)[2]).decode("utf-8", "replace")
                if "INBAND" in dec or "loadavg" in dec:
                    print("cmd%-2d %s" % (r["i"], dec.replace("\n", " | ")[:200]))
            except Exception:
                pass

    try:
        p.stdin.close()
    except Exception:
        pass
    try:
        p.wait(timeout=5)
    except Exception:
        p.kill()


if __name__ == "__main__":
    main()
