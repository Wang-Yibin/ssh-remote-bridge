/**
 * lib/engine.mjs — ssh-remote-bridge 核心引擎（多服务器）
 *
 * 被 CLI (remote-shell.mjs) 和 MCP server (mcp/server.mjs) 共用。
 * 职责:
 *   - servers.json 配置加载（可插拔: 加服务器只改配置）
 *   - 命令执行: 两条通道
 *       a) persist 长连接（默认）: 首次握手 ~5.6s, 之后每条命令 4-35ms
 *       b) tmux 会话（兜底/兼容）: base64 -> tmux send-keys -> 哨兵检测 -> 回传
 *   - 挂载/卸载: net use (SSHFS-Win) + 符号链接
 *   - 文件读写: 经执行通道 base64 传输
 *   - 主机密钥获取 (trust_host)
 *
 * 零第三方依赖, 只用 Node 内置模块 + 系统 plink。
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getRemoteExec, closeAllRemoteExecs, StartError } from './persist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = process.env.SRB_CONFIG || path.join(ROOT, 'servers.json');

/**
 * 找不到 plink 时的候选位置（按顺序探测第一个存在的）。
 * 这里刻意**不写任何机器专属的绝对路径** —— 那样会让包不可移植，
 * 也会把某台机器的目录结构固化进代码。查找顺序:
 *   1)环境变量 SRB_PLINK
 *   2)servers.json 里的 plink 字段
 *   3) 包内 bin\plink.exe
 *   4) PuTTY 默认安装位置 / PATH 上的 plink
 */
const PLINK_FALLBACKS = [
  'bin\\plink.exe',
  'C:\\Program Files\\PuTTY\\plink.exe',
  'C:\\Program Files (x86)\\PuTTY\\plink.exe',
  'plink.exe',
];
/** 探测一个能用的 plink（找不到返回最后一个候选，让错误信息可读） */
function probePlink() {
  for (const c of PLINK_FALLBACKS) {
    try {
      if (c === 'plink.exe') return c; // PATH 上的，靠系统解析，先给机会
      if (fs.existsSync(path.isAbsolute(c) ? c : path.join(ROOT, c))) return c;
    } catch (_) {}
  }
  return 'plink.exe';
}
/** 保留旧名以兼容外部引用；值是探测出来的，不是硬编码路径 */
export const DEFAULT_PLINK = probePlink();

// ---------------------------------------------------------------- 配置

export function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    throw new Error(`cannot read config ${CONFIG_PATH}: ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config ${CONFIG_PATH} is not valid JSON: ${e.message}`);
  }
  if (!cfg.servers || typeof cfg.servers !== 'object' || Object.keys(cfg.servers).length === 0) {
    throw new Error(`config ${CONFIG_PATH} must contain a non-empty "servers" object`);
  }
  return cfg;
}

/**
 * 解析 plink 路径。便携模式支持:
 *   - 相对路径 (如 "bin\\plink.exe") 相对包根目录解析
 *   - 配置/环境的绝对路径不存在时, 回退到包内 bin\\plink.exe
 */
export function plinkPath(cfg) {
  const p = process.env.SRB_PLINK || (cfg && cfg.plink) || DEFAULT_PLINK;
  const bundled = path.join(ROOT, 'bin', 'plink.exe');
  if (path.isAbsolute(p)) {
    if (fs.existsSync(p)) return p;
    if (fs.existsSync(bundled)) return bundled;
    return p;
  }
  const abs = path.resolve(ROOT, p);
  if (fs.existsSync(abs)) return abs;
  if (fs.existsSync(bundled)) return bundled;
  return p;
}

/** 列出服务器 (不含密码) */
export function listServers() {
  const cfg = loadConfig();
  return Object.entries(cfg.servers).map(([name, s]) => normalize(name, s));
}

/** 取单个服务器; name 为空时取 default:true 或第一个 */
export function getServer(name) {
  const cfg = loadConfig();
  let sname = name;
  if (!sname) {
    sname = Object.keys(cfg.servers).find((k) => cfg.servers[k].default) || Object.keys(cfg.servers)[0];
  }
  const s = cfg.servers[sname];
  if (!s) {
    throw new Error(`server "${sname}" not found. available: ${Object.keys(cfg.servers).join(', ')}`);
  }
  return normalize(sname, s);
}

function normalize(name, s) {
  if (!s.host) throw new Error(`server "${name}" missing "host"`);
  if (!s.user) throw new Error(`server "${name}" missing "user"`);
  return {
    name,
    host: s.host,
    port: s.port || 22,
    user: s.user,
    password: s.password || null,
    hostkey: s.hostkey || null,
    keyFile: s.keyFile || null,
    mount: s.mount || null,
    drive: s.drive || null,
    remote: s.remote || `/home/${s.user}`,
    tmuxSession: s.tmuxSession || 'srb-ai',
    default: !!s.default,
    note: s.note || '',
  };
}

// ---------------------------------------------------------------- 进程执行

/** 执行本地命令, 输出强制净化为 ASCII (net use 等中文输出会乱码) */
export function runCapture(file, args, { timeoutMs = 60000, input } = {}) {
  const r = spawnSync(file, args, {
    encoding: 'buffer',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    input,
  });
  const dec = (b) => (b ? Buffer.from(b).toString('latin1').replace(/[^\x20-\x7E\n\r]/g, '?') : '');
  return {
    status: r.status,
    stdout: dec(r.stdout),
    stderr: dec(r.stderr),
    error: r.error ? `${r.error.code || ''} ${r.error.message || ''}`.trim() : null,
  };
}

function plinkArgs(srv, remoteCmd, tty = false) {
  const cfg = loadConfig();
  const a = ['-ssh', '-batch', '-P', String(srv.port), '-l', srv.user];
  if (srv.hostkey) a.push('-hostkey', srv.hostkey);
  if (srv.keyFile) a.push('-i', srv.keyFile);
  else if (srv.password) a.push('-pw', srv.password);
  if (tty) a.unshift('-t');
  a.push(srv.host, remoteCmd);
  void cfg;
  return a;
}

function plinkRun(srv, remoteCmd, { timeoutMs = 60000, tty = false } = {}) {
  const cfg = loadConfig();
  const r = spawnSync(plinkPath(cfg), plinkArgs(srv, remoteCmd, tty), {
    encoding: 'buffer',
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  const out = r.stdout ? Buffer.from(r.stdout).toString('utf8') : '';
  const err = r.stderr ? Buffer.from(r.stderr).toString('utf8') : '';
  const timedOut = !!(r.error && /ETIMEDOUT|timed out/i.test(String(r.error.message || '') + String(r.error.code || '')));
  return {
    out,
    err,
    status: r.status,
    timedOut,
    spawnFailed: !r.status && !timedOut && !!r.error,
    spawnError: r.error ? `${r.error.code || ''} ${r.error.message || ''}`.trim() : null,
  };
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------- tmux 会话

const tmuxPathCache = new Map();

/** 解析远程 tmux 路径 (非交互 shell PATH 可能不全) */
function resolveTmux(srv) {
  if (tmuxPathCache.has(srv.name)) return tmuxPathCache.get(srv.name);
  const r = plinkRun(srv, 'command -v tmux 2>/dev/null || echo /usr/bin/tmux', { timeoutMs: 20000 });
  const lines = r.out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const p = lines.length ? lines[lines.length - 1] : '/usr/bin/tmux';
  tmuxPathCache.set(srv.name, p);
  return p;
}

/** 确保远程 tmux 会话存在 */
export function ensureSession(srv) {
  const tmux = resolveTmux(srv);
  plinkRun(
    srv,
    `${tmux} has-session -t ${shq(srv.tmuxSession)} 2>/dev/null || ${tmux} new-session -d -s ${shq(srv.tmuxSession)}; ` +
      `${tmux} set-option -t ${shq(srv.tmuxSession)} history-limit 50000 2>/dev/null; true`,
    { timeoutMs: 30000 }
  );
}

export function sessionAlive(srv) {
  const tmux = resolveTmux(srv);
  const r = plinkRun(srv, `${tmux} has-session -t ${shq(srv.tmuxSession)} 2>/dev/null && echo SRB_ALIVE || echo SRB_DEAD`, { timeoutMs: 25000 });
  return r.out.includes('SRB_ALIVE');
}

// ---------------------------------------------------------------- 命令执行引擎

/**
 * 构造远程执行脚本 (与已验证的协议一致):
 *   base64 解码后 eval -> 输出重定向文件 -> 退出码哨兵 + 完成哨兵
 * script 为多行时每行会作为独立键入行 (pty 单行有长度限制, 自动分片见 writeFileRemote)
 */
export function buildRemoteCommand(srv, script, { timeout = 120, headBytes = 30000 } = {}) {
  const token = crypto.randomBytes(3).toString('hex');
  const outFile = `/tmp/.srb_${token}.out`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const tmux = resolveTmux(srv);
  const keyLine =
    `OUT=${outFile}; { eval "$(echo ${b64} | base64 -d)"; } > "$OUT" 2>&1; ` +
    `echo "SRBEXIT_${token}=$?"; echo "SRBDONE_${token}"`;
  const remote = [
    `${tmux} send-keys -t ${shq(srv.tmuxSession)} ${shq(keyLine)} Enter`,
    `FOUND=0`,
    `for _i in $(/usr/bin/seq 1 ${timeout}); do`,
    `  /bin/sleep 1`,
    `  if ${tmux} capture-pane -t ${shq(srv.tmuxSession)} -p -S -300 2>/dev/null | /usr/bin/grep -q "SRBDONE_${token}"; then FOUND=1; break; fi`,
    `done`,
    `echo "__SRB_BEGIN__"`,
    // 把"哨兵是否等到"回传到 stdout: 只 capture-pane 是不够的, 本地 parseResult 读的是 plink 输出
    `echo "SRBDONE_${token}=$FOUND"`,
    `${tmux} capture-pane -t ${shq(srv.tmuxSession)} -p -S -300 2>/dev/null | /usr/bin/grep "SRBEXIT_${token}=" | /usr/bin/tail -1`,
    `echo "__SRB_OUT__"`,
    `/usr/bin/head -c ${headBytes} "${outFile}" 2>/dev/null`,
    `echo ""`,
    `echo "__SRB_END__"`,
    `/bin/rm -f "${outFile}"`,
  ].join('\n');
  return { remote, token };
}

export function parseResult(out, token) {
  // 哨兵状态由远端脚本回传到 stdout: SRBDONE_<token>=1 表示等到了, =0 表示超时
  const done = out.includes(`SRBDONE_${token}=1`);
  let exitCode = null;
  const m = out.match(new RegExp(`SRBEXIT_${token}=(-?\\d+)`));
  if (m) exitCode = Number(m[1]);
  const o1 = out.indexOf('__SRB_OUT__');
  const o2 = out.lastIndexOf('__SRB_END__');
  let output = o1 >= 0 && o2 > o1 ? out.slice(o1 + 11, o2) : '';
  if (output.length > 30000) output = `...[truncated, kept last 30000 chars]...\n` + output.slice(-30000);
  return { done, exitCode, output };
}

/**
 * 在服务器上执行一条命令 (经 tmux 会话)
 * @returns {{ok, done, timedOut, spawnFailed, exitCode, output, duration, error}}
 */
export function execOn(srv, cmd, { timeout = 120, headBytes = 30000 } = {}) {
  const t0 = Date.now();
  try {
    ensureSession(srv);
  } catch (e) {
    return { ok: false, done: false, timedOut: false, spawnFailed: true, exitCode: null, output: '', duration: 0, error: `ensureSession: ${e.message}` };
  }
  const { remote, token } = buildRemoteCommand(srv, cmd, { timeout, headBytes });
  const r = plinkRun(srv, remote, { timeoutMs: (timeout + 30) * 1000 });
  const duration = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.spawnFailed) {
    return { ok: false, done: false, timedOut: false, spawnFailed: true, exitCode: null, output: '', duration, error: `plink spawn failed: ${r.spawnError}` };
  }
  if (r.timedOut) {
    return { ok: false, done: false, timedOut: true, spawnFailed: false, exitCode: null, output: '', duration, error: `connection timed out after ${timeout + 30}s` };
  }
  const parsed = parseResult(r.out, token);
  return {
    ok: parsed.done && parsed.exitCode === 0,
    done: parsed.done,
    timedOut: false,
    spawnFailed: false,
    exitCode: parsed.exitCode,
    output: parsed.output,
    duration: Number(duration),
    error: parsed.done ? null : `sentinel not seen within ${timeout}s (command may still be running on the server)`,
  };
}

// ---------------------------------------------------------------- 持久执行器（长连接, 默认通道）

let persistBroken = false; // 本进程内 persist 起不来过 -> 不再重试, 全程走 tmux
let persistStartError = null; // persist 侧的真因(认证失败/hostkey 不匹配), 供回落失败时拼接

export function persistEnabled() {
  return (process.env.SRB_TRANSPORT || 'persist').toLowerCase() !== 'tmux';
}

export function persistStatus() {
  return { enabled: persistEnabled(), broken: persistBroken };
}

export function markPersistBroken() {
  persistBroken = true;
}

export function closeAllPersist() {
  closeAllRemoteExecs();
}

function connFor(cfg, srv) {
  return {
    plink: plinkPath(cfg),
    host: srv.host,
    port: srv.port,
    user: srv.user,
    password: srv.password,
    hostkey: srv.hostkey,
    keyFile: srv.keyFile,
  };
}

/** 取（或建）某服务器的长连接执行器实例（CLI 中断/SIGINT 用） */
export function getExecFor(srv) {
  const cfg = loadConfig();
  return getRemoteExec(srv.name, connFor(cfg, srv));
}

/**
 * 经持久长连接执行命令（自动建连; 同连接内串行）。
 * 返回形状与 execOn 一致（外加 cwd/via/interrupted）。
 *   startFailed=true: 连接从未建立（可回落 tmux 通道）
 *   lost=true:        曾正常后断线（不回落; 下次调用自动重连）
 */
export async function execOnPersist(srv, cmd, { timeout = 120 } = {}) {
  const cfg = loadConfig();
  const rex = getRemoteExec(srv.name, connFor(cfg, srv));
  const t0 = Date.now();
  try {
    const r = await rex.exec(cmd, { timeout });
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      done: true,
      timedOut: !!r.timedOut,
      spawnFailed: false,
      startFailed: false,
      lost: false,
      aborted: false,
      exitCode: r.exitCode,
      output: r.output,
      cwd: r.cwd,
      duration: r.duration,
      error: r.error,
      interrupted: !!r.interrupted,
      via: 'persist',
    };
  } catch (e) {
    const duration = (Date.now() - t0) / 1000;
    const aborted = !!(e && e.aborted);
    if (e instanceof StartError && !aborted) {
      return { ok: false, done: false, timedOut: false, spawnFailed: true, startFailed: true, lost: false, aborted: false, exitCode: null, output: '', cwd: null, duration, error: e.message, via: 'persist' };
    }
    return { ok: false, done: false, timedOut: false, spawnFailed: true, startFailed: false, lost: true, aborted, exitCode: null, output: '', cwd: null, duration, error: e.message, via: 'persist' };
  }
}

/**
 * 智能执行: 优先 persist 长连接;
 * 连接从未建立成功 -> 标记 broken 并回落旧 tmux 通道（本进程内不再重试 persist）。
 * 曾正常后断线 -> 不回落（避免命令重跑）, 下次调用会自动重连。
 */
export async function execOnSmart(srv, cmd, opts = {}) {
  if (persistEnabled() && !persistBroken) {
    const r = await execOnPersist(srv, cmd, opts);
    if (r.aborted) return r;
    if (r.startFailed) {
      persistBroken = true;
      if (process.env.SRB_DEBUG) console.error(`[ssh-remote] persist channel unavailable (${r.error}); falling back to tmux for this process`);
      // 记下persist 侧的真因: 认证失败/hostkey 不匹配这类问题会被 tmux 回落路径
      // 完全盖住 (tmux 只报 "spawn failed: EBUSY" 之类), 不保留就等于信息丢失。
      persistStartError = { server: srv.name, error: r.error, at: Date.now() };
    } else {
      return r;
    }
  }
  const t = await execOn(srv, cmd, opts);
  // 回落路径也失败, 且persist 侧确实失败过 -> 两段原因都报出来, 否则用户/AI 只会
  // 看到次生错误 (通道不可用), 而看不到真正的原因 (密码错 / hostkey 不匹配)
  if (t.spawnFailed && persistStartError && persistStartError.server === srv.name) {
    t.error = `long-connection channel failed first:\n  ${persistStartError.error}\n` + `then the fallback channel failed too:\n  ${t.error}`;
    if (/access denied|authentication|permission denied|password/i.test(persistStartError.error)) {
      t.error +=
        '\n\nThe most likely cause is a WRONG PASSWORD (or wrong user). ' +
        'Fix it with configure_server (pass the same name/host/user + the correct password).';
    }
  }
  return t;
}

/** 长连接通道状态（MCP server_status 用） */
export function persistChannelStatus(srv) {
  if (!persistEnabled()) return { enabled: false, broken: persistBroken, alive: false };
  const cfg = loadConfig();
  const rex = getRemoteExec(srv.name, connFor(cfg, srv));
  return {
    enabled: true,
    broken: persistBroken,
    alive: rex.alive,
    pending: rex.pending.size,
    curToken: rex.curToken,
  };
}

// ---------------------------------------------------------------- 文件读写 (经执行通道, base64 分片)

/** 读远程文件 (文本或 base64) */
export function readFileRemote(srv, remotePath, maxBytes = 65536) {
  const r = execOn(srv, `/usr/bin/head -c ${maxBytes} ${shq(remotePath)} | base64`, { timeout: 60, headBytes: maxBytes * 2 + 1024 });
  if (!r.done || r.exitCode !== 0) {
    return { ok: false, error: r.output || r.error || `read failed (exit ${r.exitCode})` };
  }
  const b64 = r.output.replace(/\s+/g, '');
  let buf = null;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch (_) {}
  if (!buf || buf.length === 0) return { ok: false, error: 'empty or undecodable content' };
  const text = buf.toString('utf8');
  const isText = !/�/.test(text);
  return { ok: true, size: buf.length, isText, text: isText ? text : null, base64: isText ? null : buf.toString('base64') };
}

/** 写远程文件 (自动 base64 分片, 每片 <1500 字符避开 pty 行限制) */
export function writeFileRemote(srv, remotePath, content, { append = false } = {}) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const b64 = buf.toString('base64');
  const CHUNK = 1200;
  const parts = [];
  for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));
  if (parts.length === 0) parts.push('');
  const token = crypto.randomBytes(3).toString('hex');
  const tmp = `/tmp/.srb_w_${token}.b64`;
  const lines = [
    `OUT=/tmp/.srb_${token}.out`,
    `{ /bin/rm -f ${tmp}`,
    ...parts.map((p) => `echo ${shq(p)} >> ${tmp}`),
    `base64 -d ${tmp} ${append ? '>>' : '>'} ${shq(remotePath)}`,
    `/bin/rm -f ${tmp}`,
    `} > "$OUT" 2>&1`,
    `echo "SRBEXIT_${token}=$?"`,
    `echo "SRBDONE_${token}"`,
  ];
  const tmux = resolveTmux(srv);
  const keyLine = lines.join('\n');
  const remote = [
    `${tmux} send-keys -t ${shq(srv.tmuxSession)} ${shq(keyLine)} Enter`,
    `FOUND=0`,
    `for _i in $(/usr/bin/seq 1 120); do`,
    `  /bin/sleep 1`,
    `  if ${tmux} capture-pane -t ${shq(srv.tmuxSession)} -p -S -300 2>/dev/null | /usr/bin/grep -q "SRBDONE_${token}"; then FOUND=1; break; fi`,
    `done`,
    // 回传: 哨兵是否等到 + 写入的真实退出码 (从面板里 grep 出来)
    `echo "SRBSTATUS_${token}=$FOUND"`,
    `${tmux} capture-pane -t ${shq(srv.tmuxSession)} -p -S -300 2>/dev/null | /usr/bin/grep "SRBEXIT_${token}=" | /usr/bin/tail -1`,
    `echo "__SRB_OUT__"`,
    `/usr/bin/head -c 4000 "/tmp/.srb_${token}.out" 2>/dev/null`,
    `echo "__SRB_END__"`,
    `/bin/rm -f "/tmp/.srb_${token}.out"`,
  ].join('\n');
  const r = plinkRun(srv, remote, { timeoutMs: 150000 });
  const st = r.out.match(new RegExp(`SRBSTATUS_${token}=(-?\\d+)`));
  const found = !!st && Number(st[1]) === 1;
  const m = r.out.match(new RegExp(`SRBEXIT_${token}=(-?\\d+)`));
  const o1 = r.out.indexOf('__SRB_OUT__');
  const o2 = r.out.lastIndexOf('__SRB_END__');
  const output = o1 >= 0 && o2 > o1 ? r.out.slice(o1 + 11, o2) : '';
  const exitCode = m ? Number(m[1]) : null;
  return { ok: found && exitCode === 0, exitCode, output, chunks: parts.length, bytes: buf.length };
}

// ---------------------------------------------------------------- 文件读写 (persist 优先, tmux 兜底)

/** 读远程文件（优先长连接; 管道退出码用 pipefail 捕捉 head 失败） */
export async function readFileRemoteSmart(srv, remotePath, maxBytes = 65536) {
  if (persistEnabled() && !persistBroken) {
    const r = await execOnPersist(
      srv,
      `set -o pipefail 2>/dev/null; /usr/bin/head -c ${maxBytes} ${shq(remotePath)} | /usr/bin/base64 -w0`,
      { timeout: 60 }
    );
    if (!r.startFailed) {
      if (r.done && r.exitCode === 0) {
        const b64 = r.output.replace(/\s+/g, '');
        let buf = null;
        try {
          buf = Buffer.from(b64, 'base64');
        } catch (_) {}
        if (!buf || buf.length === 0) return { ok: false, error: 'empty or undecodable content' };
        const text = buf.toString('utf8');
        const isText = !/�/.test(text);
        return { ok: true, size: buf.length, isText, text: isText ? text : null, base64: isText ? null : buf.toString('base64') };
      }
      return { ok: false, error: r.output || r.error || `read failed (exit ${r.exitCode})` };
    }
    persistBroken = true;
  }
  return readFileRemote(srv, remotePath, maxBytes);
}

/**
 * 写远程文件（优先长连接; 整内容一条 heredoc 原子写入, 无需分片）。
 * heredoc 定界符含下划线（base64 字母表外）, 不可能与内容撞行。
 */
export async function writeFileRemoteSmart(srv, remotePath, content, { append = false } = {}) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const b64 = buf.toString('base64');
  if (persistEnabled() && !persistBroken) {
    const delim = `__SRB_EOF_${crypto.randomBytes(5).toString('hex')}__`;
    const pathB64 = Buffer.from(String(remotePath), 'utf8').toString('base64');
    const cmd = [
      `T=$(printf %s ${shq(pathB64)} | /usr/bin/base64 -d)`,
      `/usr/bin/base64 -d ${append ? '>>' : '>'} "$T" <<'${delim}'`,
      b64,
      delim,
    ].join('\n');
    const r = await execOnPersist(srv, cmd, { timeout: 180 });
    if (!r.startFailed) {
      return { ok: r.done && r.exitCode === 0, exitCode: r.exitCode, output: r.output, chunks: 1, bytes: buf.length };
    }
    persistBroken = true;
  }
  return writeFileRemote(srv, remotePath, content, { append });
}

// ---------------------------------------------------------------- 服务器配置写入（供 AI 首次接入用）

/** 新建配置时 plink 路径怎么填: 包内有就写相对路径（可整包搬走），否则退回探测结果 */
function plinkForNewConfig() {
  if (fs.existsSync(path.join(ROOT, 'bin', 'plink.exe'))) return 'bin\\plink.exe';
  return DEFAULT_PLINK;
}

/** 读配置; 文件不存在/损坏时返回空壳（不抛） */
function readConfigLenient() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') throw new Error('not an object');
    if (!j.servers || typeof j.servers !== 'object') j.servers = {};
    if (!j.plink) j.plink = plinkForNewConfig();
    return j;
  } catch (_) {
    return { plink: plinkForNewConfig(), servers: {} };
  }
}

/**
 * 写入/更新 servers.json 里的一台服务器。
 * 供 MCP configure_server 工具使用 —— AI 先向用户问清信息, 再调这个落盘。
 * 已存在的条目只覆盖传入字段; 密码明文落盘（servers.json 本来就是这个设计）,
 * 返回值里一律不回显密码。
 * @returns {{ok, file, name, created, hostkeyFetched, warnings}}
 */
export async function saveServer(spec = {}) {
  const warnings = [];
  const name = String(spec.name || 'myserver').trim();
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) {
    throw new Error(`invalid server name "${name}": use 1-32 chars of letters/digits/._- only`);
  }
  const host = String(spec.host || '').trim();
  if (!host || /\s/.test(host)) throw new Error('host (IP or hostname) is required and must not contain spaces');
  const port = Number(spec.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${spec.port}`);

  const user = String(spec.user || '').trim();
  if (!user || /\s/.test(user)) throw new Error('user (login name) is required and must not contain spaces');

  const password = spec.password ? String(spec.password) : null;
  const keyFile = spec.keyFile ? String(spec.keyFile) : null;
  if (!password && !keyFile) {
    throw new Error('need one of password / keyFile — without it plink would hang waiting for an interactive password prompt');
  }

  const cfg = readConfigLenient();
  const existed = !!cfg.servers[name];
  const prev = cfg.servers[name] || {};

  // 主机密钥: 用户没给就现场取（trust_host 同一条路径）
  let hostkey = spec.hostkey ? String(spec.hostkey).trim() : prev.hostkey || null;
  let hostkeyFetched = false;
  if (!hostkey) {
    try {
      const k = await fetchHostKeyAsync(host, port);
      if (k.ok && k.fingerprints.length) {
        hostkey = k.fingerprints[0];
        hostkeyFetched = true;
      } else {
        warnings.push(
          'could not fetch the SSH host key automatically. Ask the user for the fingerprint, or ask them to run ' +
            `\`plink -ssh -batch -P ${port} ${host} exit\` and paste the SHA256:... line plink prints, then call ` +
            'configure_server again with hostkey set.'
        );
      }
    } catch (e) {
      warnings.push('host key lookup failed: ' + e.message);
    }
  }
  if (!hostkey) {
    throw new Error(
      'hostkey (SSH host key fingerprint, SHA256:...) is required — plink refuses unknown hosts.\n' +
        'Ask the user for the fingerprint. To obtain it: `plink -ssh -batch -P ' +
        port + ' ' + host + ' exit` prints the SHA256:... line on first contact.'
    );
  }

  const mount = spec.mount ? String(spec.mount) : prev.mount || null;
  const drive = spec.drive ? String(spec.drive).toUpperCase() : prev.drive || null;
  if (mount && !drive) {
    warnings.push('mount was set but no drive letter: file mapping needs a drive (e.g. M:). Command/MCP use works without it.');
  }
  if (drive && !/^[A-Z]:$/.test(drive)) {
    throw new Error(`invalid drive "${drive}": use a bare drive letter like M:`);
  }

  const entry = {
    host,
    port,
    user,
    ...(password ? { password } : {}),
    ...(keyFile ? { keyFile } : {}),
    hostkey,
    ...(mount ? { mount } : {}),
    ...(drive ? { drive } : {}),
    remote: String(spec.remote || prev.remote || `/home/${user}`),
    tmuxSession: String(spec.tmuxSession || prev.tmuxSession || 'srb-ai'),
    ...(spec.note ? { note: String(spec.note) } : prev.note ? { note: prev.note } : {}),
  };

  if (spec.isDefault) {
    for (const k of Object.keys(cfg.servers)) {
      if (k !== name && cfg.servers[k] && cfg.servers[k].default) delete cfg.servers[k].default;
    }
    entry.default = true;
  } else if (!existed) {
    // 第一台服务器默认就是默认服务器
    const anyDefault = Object.values(cfg.servers).some((s) => s && s.default);
    if (!anyDefault) entry.default = true;
  } else if (prev.default) {
    entry.default = true;
  }

  cfg.servers[name] = entry;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch (_) {}

  return {
    ok: true,
    file: CONFIG_PATH,
    name,
    created: !existed,
    hostkeyFetched,
    warnings,
    // 密码不回显
    entry: { ...entry, password: password ? '***(stored in servers.json)***' : undefined },
  };
}

/**
 * 供 MCP list_servers 友好报错用: 配置是否可用。
 * 区分两种失败:
 *  - missing: 文件不存在/没有服务器条目 —— 这是「首次接入」的正常状态, 不是错误,
 *             不该把ENOENT 原始信息甩给 AI (噪音 + 泄漏本机路径)
 *  - invalid: 文件存在但坏了 (JSON 语法错/结构不对) —— 真错误, 要原样报给用户
 */
export function configState() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ok: false, missing: true, file: CONFIG_PATH, count: 0 };
  }
  try {
    const cfg = loadConfig();
    return { ok: true, file: CONFIG_PATH, count: Object.keys(cfg.servers).length };
  } catch (e) {
    return { ok: false, missing: false, file: CONFIG_PATH, count: 0, error: e.message };
  }
}

// ---------------------------------------------------------------- 挂载 / 卸载 (Windows 侧)

/** 远程绝对路径 -> SSHFS-Win UNC */
export function remoteToUnc(srv) {
  const p = String(srv.remote).replace(/^\/+/, '').replace(/\//g, '\\');
  const hostPart = srv.port && srv.port !== 22 ? `${srv.host}!${srv.port}` : srv.host;
  const prefix = srv.password ? 'sshfs.r' : 'sshfs.kr';
  return `\\\\${prefix}\\${srv.user}@${hostPart}\\${p}`;
}

/** 盘符是否已挂载 (纯 fs 探测, 不 spawn) */
export function driveMounted(drive) {
  if (!drive) return false;
  try {
    fs.readdirSync(drive.endsWith('\\') ? drive : drive + '\\');
    return true;
  } catch (_) {
    return false;
  }
}

/** 挂载点是否可用 */
export function mountOk(mount) {
  if (!mount) return false;
  try {
    fs.readdirSync(mount.endsWith('\\') ? mount : mount + '\\');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 挂载: net use 盘符 (SSHFS-Win, 持久化) + mklink 符号链接
 * @returns {{ok, steps: string[], error?}}
 */
export function mountServer(srv) {
  const steps = [];
  if (!srv.drive) return { ok: false, steps, error: `server "${srv.name}" has no "drive" configured in servers.json` };
  const unc = remoteToUnc(srv);
  steps.push(`UNC: ${unc}`);
  runCapture('net', ['use', srv.drive, '/delete', '/y']);
  const args = ['use', srv.drive, unc, '/persistent:yes'];
  if (srv.password) args.push(srv.password);
  args.push('/user:' + srv.user);
  const r = runCapture('net', args, { timeoutMs: 90000 });
  steps.push(`net use ${srv.drive} => exit ${r.status}${r.stdout ? ' | ' + r.stdout.trim().split('\n').pop() : ''}${r.error ? ' | ' + r.error : ''}`);
  if (r.status !== 0 || !driveMounted(srv.drive)) {
    return { ok: false, steps, error: `net use failed (exit ${r.status}). ${r.stdout}${r.stderr}`.trim() };
  }
  let n = 0;
  try {
    n = fs.readdirSync(srv.drive + '\\').length;
  } catch (_) {}
  steps.push(`drive ${srv.drive} mounted, ${n} entries`);
  if (srv.mount) {
    try {
      fs.rmdirSync(srv.mount);
      steps.push(`removed old ${srv.mount} (empty dir or stale symlink)`);
    } catch (_) {}
    const mk = runCapture('cmd', ['/c', `mklink /D "${srv.mount}" "${srv.drive}\\"`], { timeoutMs: 30000 });
    steps.push(`mklink /D ${srv.mount} -> ${srv.drive}\\ => exit ${mk.status}${mk.error ? ' | ' + mk.error : ''}`);
    if (mk.status !== 0) {
      return { ok: true, warning: 'drive mounted but symlink failed (need Developer Mode or admin). Use the drive letter directly, or enable Developer Mode.', steps };
    }
    try {
      n = fs.readdirSync(srv.mount + '\\').length;
      steps.push(`symlink ${srv.mount} OK, ${n} entries`);
    } catch (e) {
      return { ok: true, warning: `symlink created but not readable: ${e.message}`, steps };
    }
  }
  return { ok: true, steps };
}

/** 卸载: 删除盘符映射 (符号链接保留, 下次 setup 自动重建) */
export function umountServer(srv) {
  const steps = [];
  if (srv.drive) {
    const r = runCapture('net', ['use', srv.drive, '/delete', '/y'], { timeoutMs: 60000 });
    steps.push(`net use ${srv.drive} /delete => exit ${r.status}`);
  }
  return { ok: true, steps };
}

// ---------------------------------------------------------------- 主机密钥

/**
 * 获取服务器 SSH 主机密钥指纹 (供 servers.json 的 hostkey 字段)
 *
 * 方式一 (推荐, 只用 plink): 对未知主机发起一次 -batch 连接,
 *   plink 会在 stderr 里吐出 "The server's ssh-ed25519 key fingerprint is:
 *   ssh-ed25519 255 SHA256:..." — 解析即可。不依赖 OpenSSH,
 *   收件人机器上只有 plink 也能用。
 * 方式二 (兜底): 系统的 ssh-keyscan (Linux/macOS 或装了 OpenSSH 的 Windows)
 */
export function fetchHostKey(host, port = 22) {
  // 用 lenient 读配置: 新建第一台服务器时 servers.json 可能还不存在,
  // 此时 loadConfig() 会抛 cannot read config → hostkey 自动抓取永远失败（死依赖）
  let cfg;
  try {
    cfg = loadConfig();
  } catch (_) {
    cfg = readConfigLenient();
  }
  const r = runCapture(plinkPath(cfg), ['-ssh', '-batch', '-P', String(port), host, 'exit'], { timeoutMs: 30000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const fps = [...new Set(text.match(/SHA256:[A-Za-z0-9+/=]+/g) || [])];
  if (fps.length) {
    return { ok: true, fingerprints: fps, raw: text.trim(), via: 'plink' };
  }
  // 方式二: ssh-keyscan
  const scan = runCapture('ssh-keyscan', ['-t', 'ed25519,rsa', '-p', String(port), '--', host], { timeoutMs: 30000 });
  if (scan.status !== 0 || !scan.stdout.trim()) {
    return {
      ok: false,
      error:
        `could not fetch host key for ${host}:${port}.\n` +
        `plink said:\n${text.trim() || '(no output)'}\n\n` +
        `Manual alternative:\n  ssh-keyscan -t ed25519,rsa -p ${port} ${host} | ssh-keygen -lf -`,
    };
  }
  const kg = runCapture('ssh-keygen', ['-lf', '-'], { timeoutMs: 30000, input: Buffer.from(scan.stdout, 'latin1') });
  if (kg.status !== 0 || !kg.stdout.trim()) {
    return {
      ok: false,
      error: `ssh-keygen failed (exit ${kg.status}). Run manually:\nssh-keyscan -t ed25519,rsa -p ${port} ${host} | ssh-keygen -lf -`,
    };
  }
  const fps2 = kg.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('256 ') || l.startsWith('2048 ') || l.startsWith('3072 '))
    .map((l) => (l.match(/SHA256:\S+/) || [])[0])
    .filter(Boolean);
  return { ok: true, fingerprints: fps2, raw: kg.stdout.trim(), via: 'ssh-keyscan' };
}

/**
 * fetchHostKey 的异步版本（async spawn, 不阻塞事件循环）。
 *
 * 为什么需要: MCP server 的工具调用是 async 的, 用同步 spawnSync 抓主机密钥会
 * 把整个 MCP 通道卡住最多 30s（期间任何并发请求都排队）；某些受限环境下
 * spawnSync 还会直接失败。
 *
 * 解析逻辑与同步版完全一致, 只是执行方式不同。
 */
export function fetchHostKeyAsync(host, port = 22) {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (_) {
    cfg = readConfigLenient();
  }
  const exe = plinkPath(cfg);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, ['-ssh', '-batch', '-P', String(port), host, 'exit'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, error: `could not launch plink: ${e.message}` });
      return;
    }
    const chunks = [];
    let bytes = 0;
    const MAX = 4 * 1024 * 1024;
    const onData = (d) => {
      bytes += d.length;
      if (bytes <= MAX) chunks.push(d);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish({ ok: false, error: `plink timed out after 30s while fetching host key for ${host}:${port}` });
    }, 30000);
    child.on('error', (e) => finish({ ok: false, error: `plink failed: ${e.message}` }));
    child.on('close', (code) => {
      const text = Buffer.concat(chunks)
        .toString('latin1')
        .replace(/[^\x20-\x7E\n\r]/g, '?');
      const fps = [...new Set(text.match(/SHA256:[A-Za-z0-9+/=]+/g) || [])];
      if (fps.length) {
        finish({ ok: true, fingerprints: fps, raw: text.trim(), via: 'plink' });
        return;
      }
      finish({
        ok: false,
        error:
          `could not fetch host key for ${host}:${port} (plink exit ${code}).\n` +
          `plink said:\n${text.trim() || '(no output)'}\n\n` +
          `Ask the user for the fingerprint, or have them run:\n` +
          `  plink -ssh -batch -P ${port} ${host} exit\n` +
          `and paste the SHA256:... line shown by plink.`,
      });
    });
  });
}

// ---------------------------------------------------------------- rclone 备用挂载

/** 包内 rclone.exe 路径 (便携打包随附) */
export function rcloneExePath() {
  return path.join(ROOT, 'rclone', 'rclone.exe');
}

/** 用包内 rclone 把明文密码转成 rclone 认识的 obscured 形式 */
function rcloneObscure(plain) {
  const exe = rcloneExePath();
  if (!fs.existsSync(exe) || !plain) return null;
  const r = spawnSync(exe, ['obscure', String(plain)], { encoding: 'buffer', timeout: 20000, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  return Buffer.from(r.stdout).toString('utf8').trim();
}

/**
 * 由 servers.json 条目生成临时 rclone.conf (密码自动 obscure)
 * @returns {string} conf 文件路径
 */
export function buildRcloneConf(srv) {
  const lines = [`[${srv.name}]`, 'type = sftp', `host = ${srv.host}`, `user = ${srv.user}`, `port = ${srv.port}`];
  const pass = rcloneObscure(srv.password);
  if (pass) lines.push(`pass = ${pass}`);
  else if (srv.keyFile) lines.push(`key_file = ${srv.keyFile}`);
  const confPath = path.join(os.tmpdir(), `srb_rclone_${srv.name}.conf`);
  fs.writeFileSync(confPath, lines.join('\n') + '\n', 'utf8');
  return confPath;
}

// ---------------------------------------------------------------- 路径映射

/** 本地挂载路径 -> 远程路径; 不在挂载树下返回 null */
export function localToRemote(srv, localPath) {
  if (!srv.mount) return null;
  try {
    const norm = path.resolve(localPath);
    const root = path.resolve(srv.mount);
    const n = norm.toLowerCase();
    const r = root.toLowerCase();
    if (n === r) return srv.remote;
    if (n.startsWith(r + path.sep)) {
      const rel = norm.slice(root.length + 1).split(path.sep).filter(Boolean).join('/');
      return srv.remote + '/' + rel;
    }
  } catch (_) {}
  return null;
}
