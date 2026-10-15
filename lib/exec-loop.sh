# exec-loop.sh — ssh-remote-bridge 持久执行器（协议 v4）
#
# 由 lib/persist.mjs 引导写入远端 /tmp/.srb-exec.v4.$$.sh 后执行。
# 一条 SSH 长连接复用: 本地发命令帧 -> 远端 bash 循环执行 -> 回传 输出/退出码/cwd。
# 设计要点:
#   - 每个任务 setsid 独立会话: 可整组信号清理, 不污染循环进程
#   - cd / export 状态用状态文件承接: 跨命令保持（与旧 tmux 方案体验一致）
#   - 任务运行期间以 5ms 粒度轮询 stdin: 支持 X 中断帧（Ctrl+C）与完成检测
#   - 空闲时用阻塞 read: 新命令即时响应（实测 4-5ms 往返）
#
# Wire (本地 -> 远端):
#   <sendts>|C <token> <base64命令>   执行一条命令（继承上一次的 cd/env）
#   X <token>                         中断当前任务: SIGTERM 进程组, 2s 后升级 KILL
#   N <token>                         空操作（保活探测）
# Wire (远端 -> 本地):
#   T <token> read=<t>                任务已启动
#   P <token> <base64 cwd>            任务后的远程当前目录
#   O <token> <base64 输出>            stdout+stderr（base64 -w0, 单行）
#   D <token> <退出码>                 任务结束（终帧）
export LC_ALL=C
set +H 2>/dev/null
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" 2>/dev/null; fi

SRB_OUT="/tmp/.srb-exec.v4.out.$$"
SRB_CMD="/tmp/.srb-exec.v4.cmd.$$"
SRB_STATE="/tmp/.srb-exec.v4.state.$$"
SRB_PWD="/tmp/.srb-exec.v4.pwd.$$"
export SRB_OUT SRB_CMD SRB_STATE SRB_PWD

SETSID=""
command -v setsid >/dev/null 2>&1 && SETSID="setsid"

curpid=""
curtok=""
xat=""

# 任务体: 继承状态文件 -> 执行命令 -> 落盘新状态(cwd+env) -> 退出
srb_task() {
  . "$SRB_STATE" 2>/dev/null
  . "$SRB_CMD"
  ec=$?
  { printf 'cd %q\n' "$PWD"; export -p; } > "$SRB_STATE"
  printf '%s' "$PWD" > "$SRB_PWD"
  exit $ec
}
export -f srb_task

srb_done() {
  wait "$curpid" 2>/dev/null
  ec=$?
  curpid=""
  printf 'P %s %s\n' "$curtok" "$(/usr/bin/base64 -w0 < "$SRB_PWD" 2>/dev/null)"
  printf 'O %s %s\n' "$curtok" "$(/usr/bin/base64 -w0 < "$SRB_OUT" 2>/dev/null)"
  printf 'D %s %s\n' "$curtok" "$ec"
  curtok=""
  xat=""
}

srb_cleanup() {
  # 只清临时文件, 不杀任务: 断线时正在跑的任务按 tmux 旧例继续跑
  # （Ctrl+C 中断走 X 帧, 那条路会整组杀掉）
  /bin/rm -f "$SRB_OUT" "$SRB_CMD" "$SRB_STATE" "$SRB_PWD"
}
trap srb_cleanup EXIT HUP TERM INT

buf=""
while :; do
  if [ -n "$curpid" ]; then
    if IFS= read -r -t 0.005 line; then
      line="$buf$line"
      buf=""
    else
      buf="$buf$line"
      if ! kill -0 "$curpid" 2>/dev/null; then
        srb_done
      elif [ -n "$xat" ]; then
        now=${EPOCHREALTIME%.*}
        if [ "$now" -ge "$((xat + 2))" ] 2>/dev/null; then
          kill -KILL -"$curpid" 2>/dev/null
          kill -KILL "$curpid" 2>/dev/null
          xat=""
        fi
      fi
      continue
    fi
    if ! kill -0 "$curpid" 2>/dev/null; then
      srb_done
    fi
  else
    IFS= read -r line || break
  fi
  [ -n "$line" ] || continue
  rest=${line#*|}
  tok=${rest%% *}
  case "$tok" in
    C)
      rest=${rest#* }
      tok2=${rest%% *}
      b64=${rest#* }
      if [ -n "$curpid" ]; then
        # 上一个任务还在退出中（通常是刚被 X 杀掉）: 最多等 1 秒后强杀
        for _w in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
          kill -0 "$curpid" 2>/dev/null || break
          /bin/sleep 0.05
        done
        if kill -0 "$curpid" 2>/dev/null; then
          kill -KILL -"$curpid" 2>/dev/null
          kill -KILL "$curpid" 2>/dev/null
        fi
        srb_done
      fi
      printf '%s' "$b64" | /usr/bin/base64 -d > "$SRB_CMD"
      $SETSID /bin/bash -c 'srb_task' >"$SRB_OUT" 2>&1 </dev/null &
      curpid=$!
      curtok=$tok2
      xat=""
      printf 'T %s read=%s\n' "$tok2" "${EPOCHREALTIME:-0}"
      ;;
    X)
      rest=${rest#* }
      if [ -n "$curpid" ]; then
        kill -TERM -"$curpid" 2>/dev/null
        kill -TERM "$curpid" 2>/dev/null
        xat=${EPOCHREALTIME%.*}
      fi
      ;;
    N)
      rest=${rest#* }
      tok2=${rest%% *}
      printf 'D %s 0\n' "$tok2"
      ;;
    *)
      ;;
  esac
  line=""
done