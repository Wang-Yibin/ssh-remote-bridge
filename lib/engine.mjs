/**
 * lib/engine.mjs — ssh-remote-bridge 核心引擎（多服务器）
 *
 * 被 CLI (remote-shell.mjs) 和 MCP server (mcp/server.mjs) 共用。
 * 职责:
 *   - servers.json 配置加载（可插拔: 加服务器只改配置）
 *   - 命令执行: 带帧协议的持久 SSH 连接，不自动重放命令
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
import { StringDecoder } from 'node:string_decoder';
import { getRemoteExec, peekRemoteExec, closeRemoteExec, closeAllRemoteExecs, StartError } from './persist.mjs';

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
    throw new Error(`config ${CONFIG_PATH} is not valid JSON (content redacted)`);
  }
  if (!cfg || !cfg.servers || typeof cfg.servers !== 'object' || Array.isArray(cfg.servers) || Object.keys(cfg.servers).length === 0) {
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

/** 内部配置列表；调用方输出时必须明确挑选可公开字段。 */
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
  if (!s || typeof s !== 'object') throw new Error('invalid server entry');
  for (const key of ['host','user']) if (typeof s[key] !== 'string' || !s[key] || /[\s\x00-\x1f=]/.test(s[key]) || s[key].startsWith('-')) throw new Error('invalid server '+key);
  if (s.port !== undefined && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) throw new Error('invalid server port');
  validateMount(s);
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

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Only the framed SSH channel is supported. Never replay a failed command.
export function persistEnabled() { return true; }
export function persistStatus() { return { enabled: true, broken: false }; }
export function markPersistBroken() {}
export function closeAllPersist() { results.clear();return closeAllRemoteExecs(); }
export function ensureSession(srv) { return getExecFor(srv).ensure(); }
export function sessionAlive(srv) { return !!peekRemoteExec(srv.name)?.alive; }
export function execOn(srv, cmd, opts) { return execOnSmart(srv, cmd, opts); }

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
 *   startFailed=true: 连接从未建立；不重放命令
 *   lost=true:        曾正常后断线（不回落; 下次调用自动重连）
 */
const results = new Map();
function expireResults() {for(const [id,r] of results) if(Date.now()-r.created>=600000) results.delete(id);}
export async function execOnPersist(srv, cmd, { timeout = 120, stream = false, onStream = null, signal, isolated = false, cwd = srv.remote, maxOutputChars = 8192, live = false, onStart, onOutput } = {}) {
  const cfg = loadConfig();
  const rex = getRemoteExec(srv.name, connFor(cfg, srv));
  const t0 = Date.now();
  try {
    if(typeof cmd !== 'string') throw new Error('command must be a string');
    if(isolated) {remoteFilePath(cwd);cmd='cd -- '+shq(cwd)+' || exit\n'+cmd;}
    const r = await rex.exec(cmd, { timeout, stream, onStream, signal, retained:isolated, outputBudget:maxOutputChars*4+8,live,onOutput,
      onStart:ref=>onStart?.({read:(offset,maxBytes,options)=>rex.readResult(ref.session,ref.token,offset,maxBytes,options)}) });
    let resultId=null;
    if(r.resultRef && !onStart) {
      expireResults();
      const profile=[...results].filter(([,v])=>v.server===srv.name);
      while(profile.length>=16) results.delete(profile.shift()[0]);
      while(results.size>=32) results.delete(results.keys().next().value);
      resultId=crypto.randomBytes(12).toString('hex');
      results.set(resultId,{...r.resultRef,rex,server:srv.name,created:Date.now(),exitCode:r.exitCode,truncated:r.truncated,cwd:r.cwd,timedOut:!!r.timedOut,interrupted:!!r.interrupted});
    }
    return {
      ok: r.exitCode === 0 && !r.timedOut && !r.interrupted,
      done: Number.isInteger(r.exitCode),
      truncated: !!r.truncated,
      timedOut: !!r.timedOut,
      spawnFailed: false,
      startFailed: false,
      lost: false,
      aborted: false,
      exitCode: r.exitCode,
      output: r.output,
      outputTail: r.outputTail,
      outputBytes: r.outputBytes,
      resultId,
      cwd: r.cwd,
      duration: r.duration,
      error: r.error,
      interrupted: !!r.interrupted,
      via: 'persist',
    };
  } catch (e) {
    const duration = (Date.now() - t0) / 1000;
    const aborted = !!(signal?.aborted || e && e.aborted);
    if(aborted) return {ok:false,done:false,timedOut:false,spawnFailed:false,startFailed:false,lost:false,aborted:true,interrupted:true,exitCode:null,output:'',cwd:null,duration,error:e.message,via:'persist'};
    if (e instanceof StartError && !aborted) {
      return { ok: false, done: false, timedOut: false, spawnFailed: true, startFailed: true, lost: false, aborted: false, exitCode: null, output: '', cwd: null, duration, error: e.message, via: 'persist' };
    }
    return { ok: false, done: false, timedOut: false, spawnFailed: true, startFailed: false, lost: true, aborted, exitCode: null, output: '', cwd: null, duration, error: e.message, via: 'persist' };
  }
}

/**
 * 连接失败只返回错误，下一次调用可重新连接；绝不自动重放当前命令。
 */
export async function execOnSmart(srv, cmd, opts = {}) {
  if (process.env.SRB_TRANSPORT === 'tmux') throw new Error('tmux transport was removed; unset SRB_TRANSPORT to use persistent SSH');
  return execOnPersist(srv, cmd, opts);
}
export function persistChannelStatus(srv) {
  const rex = peekRemoteExec(srv.name);
  return { enabled: true, broken: false, alive: !!rex?.alive, pending: rex?.pending.size || 0, curToken: rex?.curToken || null };
}
export const readFileRemote = (...args) => readFileRemoteSmart(...args);
export const writeFileRemote = (...args) => writeFileRemoteSmart(...args);
function remoteFilePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || /[\0\r\n]/.test(p)) throw new Error('remote path must be absolute and contain no NUL or newline');
  return p;
}
export function decodePage(output, offset, maxBytes, format='auto', captureLimited=false, streaming=false) {
  const split=output.indexOf('\n'), size=Number(output.slice(0,split)), b64=output.slice(split+1).trim();
  const raw=Buffer.from(b64,'base64');
  if(split<0 || !Number.isSafeInteger(size) || size<0 || raw.toString('base64')!==b64 || raw.length>maxBytes+1) throw new Error('invalid file response');
  let buf=raw.subarray(0,maxBytes), text=buf.toString('utf8');
  const truncated=offset+buf.length<size;
  const captureEnd=captureLimited && raw.length<=maxBytes && offset+raw.length===size;
  if(format!=='base64' && (truncated || captureEnd || streaming && raw.length<=maxBytes) && !Buffer.from(text).equals(buf)) {
    const candidate=new StringDecoder('utf8').write(buf), prefix=Buffer.from(candidate);
    if(prefix.length<=buf.length && buf.subarray(0,prefix.length).equals(prefix)) {buf=prefix;text=candidate;}
  }
  const isText=Buffer.from(text).equals(buf) && !buf.includes(0);
  if(format!=='base64' && !buf.length && raw.length && truncated && !captureEnd) throw new Error('max_bytes is too small for the next UTF-8 character; use at least 4');
  const next=offset+(captureEnd?raw.length:buf.length);
  return {ok:true,size:buf.length,total_size:size,offset,next_offset:next,truncated:next<size,isText,text:isText?text:null,base64:raw.subarray(0,maxBytes).toString('base64'),raw_size:Math.min(raw.length,maxBytes)};
}
function validateRange(offset,maxBytes,max=1048576) {
  if(!Number.isSafeInteger(offset) || offset<0) throw new Error('offset must be a nonnegative safe integer');
  if(!Number.isInteger(maxBytes) || maxBytes<1 || maxBytes>max) throw new Error('max_bytes must be an integer from 1 to '+max);
}
export async function readResult(resultId, offset=0, maxBytes=8192, {signal,format}={}) {
  validateRange(offset,maxBytes,65536);expireResults();
  const ref=results.get(resultId);
  if(!ref) throw new Error('result expired or unknown; command was not replayed');
  const r=await ref.rex.readResult(ref.session,ref.token,offset,maxBytes,{signal});
  if(r.exitCode!==0 || r.timedOut || r.interrupted || r.truncated) throw new Error(r.output || r.error || 'result read failed');
  return {...decodePage(r.output,offset,maxBytes,format,ref.truncated),server:ref.server,exitCode:ref.exitCode,cwd:ref.cwd,capture_limited:!!ref.truncated,timedOut:ref.timedOut,interrupted:ref.interrupted};
}
export async function readFileRemoteSmart(srv, remotePath, maxBytes = 65536, { signal, offset=0, format } = {}) {
  remoteFilePath(remotePath);
  validateRange(offset,maxBytes);
  const r = await execOnSmart(srv, '(set -e -o pipefail; /usr/bin/stat -c %s -- '+shq(remotePath)+'; /usr/bin/dd if='+shq(remotePath)+' iflag=skip_bytes,count_bytes skip='+offset+' count='+(maxBytes+1)+' status=none | /usr/bin/base64 -w0)', { timeout: 60, signal });
  if (!r.ok || r.truncated) return { ok: false, error: r.error || r.output || 'read failed or output truncated' };
  try {return decodePage(r.output,offset,maxBytes,format);} catch(e) {return {ok:false,error:e.message};}
}
export function buildWriteCommand(remotePath, content, { append = false } = {}) {
  remoteFilePath(remotePath);
  if(typeof content!=='string' && !Buffer.isBuffer(content)) throw new Error('content must be a string or Buffer');
  if(typeof append!=='boolean') throw new Error('append must be boolean');
  const b64 = Buffer.from(content).toString('base64');
  // A subshell keeps traps and temporary variables out of the persistent state.
  return ['(', 'set -e; umask 077', 'T='+shq(remotePath),
    '[ ! -L "$T" ] || { echo "refusing to replace a symlink" >&2; exit 1; }',
    'W=$(mktemp -- "$(dirname -- "$T")/.srb-write.XXXXXXXXXX")',
    "trap 'rm -f -- \"$W\"' EXIT",
    "/usr/bin/base64 -d > \"$W\" <<'__SRB_CONTENT__'", b64, '__SRB_CONTENT__',
    append ? 'cat -- "$W" >> "$T"' : 'if [ -e "$T" ]; then [ -f "$T" ] || exit 1; chmod --reference="$T" -- "$W"; chown --reference="$T" -- "$W"; fi; mv -fT -- "$W" "$T"', ')'].join('\n');
}
export async function writeFileRemoteSmart(srv, remotePath, content, { append = false, signal } = {}) {
  if(typeof content!=='string' && !Buffer.isBuffer(content)) throw new Error('content must be a string or Buffer');
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (buf.length > 1048576) throw new Error('write_file content exceeds 1 MiB; use the mounted filesystem for larger files');
  const r = await execOnSmart(srv, buildWriteCommand(remotePath, buf, { append }), { timeout: 180, signal });
  return { ok: r.ok, exitCode: r.exitCode, output: r.error || r.output, bytes: buf.length, chunks: 1 };
}

// ---------------------------------------------------------------- 服务器配置写入（供 AI 首次接入用）

/** 新建配置时 plink 路径怎么填: 包内有就写相对路径（可整包搬走），否则退回探测结果 */
function plinkForNewConfig() {
  if (fs.existsSync(path.join(ROOT, 'bin', 'plink.exe'))) return 'bin\\plink.exe';
  return DEFAULT_PLINK;
}

/** 仅不存在时创建空配置；损坏的配置必须保留。 */
function readConfigLenient() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { plink: plinkForNewConfig(), servers: {} }; throw new Error('refusing to overwrite unreadable or invalid config (content redacted)'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !cfg.servers || typeof cfg.servers !== 'object' || Array.isArray(cfg.servers)) throw new Error('invalid config servers object');
  return cfg;
}
function validateMount(srv) {
  if (srv.drive && !/^[A-Z]:$/i.test(srv.drive)) throw new Error('invalid drive letter');
  if (srv.mount && (!/^[A-Z]:[\\/].+/i.test(srv.mount) || /[<>:"|?*\x00-\x1f]/.test(srv.mount.slice(2)) || srv.mount.split(/[\\/]/).some(p => /[. ]$/.test(p)))) throw new Error('mount must be an absolute Windows directory path without special characters');
}
export function validateDrives(servers = listServers()) {
  const owners = new Map();
  for (const srv of servers) {
    validateMount(srv);
    if (!srv.drive) continue;
    const drive = srv.drive.toUpperCase();
    if (owners.has(drive)) throw new Error('duplicate drive '+drive+': '+owners.get(drive)+' and '+srv.name);
    owners.set(drive, srv.name);
  }
}
export async function saveServer(spec = {}, {signal} = {}) {
  signal?.throwIfAborted();
  const name = String(spec.name || 'myserver').trim();
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name) || ['__proto__','constructor','prototype'].includes(name)) throw new Error('invalid server name');
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const lock = CONFIG_PATH+'.lock';
  let fd;
  const deadline = Date.now()+10000;
  while (fd === undefined) {
    signal?.throwIfAborted();
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (Date.now() >= deadline) throw new Error('config is locked; check for another writer or a stale .lock file'); await new Promise(r => setTimeout(r, 50)); }
  }
  const tmp = CONFIG_PATH+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try {
    const cfg = readConfigLenient();
    const existed = Object.hasOwn(cfg.servers, name);
    const prev = existed ? cfg.servers[name] : {};
    const entry = { ...prev };
    for (const key of ['host','port','user','password','keyFile','hostkey','mount','drive','remote','note','tmuxSession']) if (Object.hasOwn(spec,key)) entry[key] = spec[key];
    for (const key of ['password','keyFile','hostkey','mount','drive','remote','note','tmuxSession']) if (entry[key] != null && typeof entry[key] !== 'string') throw new Error(key+' must be a string or null');
    if (Object.hasOwn(spec,'isDefault') && typeof spec.isDefault !== 'boolean') throw new Error('isDefault must be boolean');
    if (spec.password) delete entry.keyFile;
    if (spec.keyFile) delete entry.password;
    entry.port = Number(entry.port ?? 22);
    for (const key of ['host','user']) if (typeof entry[key] !== 'string' || !/^[^\s\x00-\x1f=]+$/.test(entry[key]) || entry[key].startsWith('-')) throw new Error(key+' is required and must be a valid SSH value');
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error('invalid port');
    if (!entry.password && !entry.keyFile) throw new Error('password or keyFile is required');
    if (entry.drive) entry.drive = entry.drive.toUpperCase();
    validateMount(entry);
    const changedHost = existed && (entry.host !== prev.host || entry.port !== (prev.port || 22));
    if (changedHost && !Object.hasOwn(spec,'hostkey')) delete entry.hostkey;
    let hostkeyFetched = false;
    if (!entry.hostkey) {
      const k = await fetchHostKeyAsync(entry.host, entry.port,{signal});
      if (!k.ok || !k.fingerprints.length) throw new Error('hostkey is required: '+(k.error || 'no fingerprint received'));
      entry.hostkey = k.fingerprints[0]; hostkeyFetched = true;
    }
    entry.remote ??= '/home/'+entry.user;
    remoteFilePath(entry.remote);
    if (Object.hasOwn(spec,'isDefault')) entry.default = !!spec.isDefault;
    else if (!Object.keys(cfg.servers).length) entry.default = true;
    if (entry.default) for (const v of Object.values(cfg.servers)) v.default = false;
    cfg.servers[name] = entry;
    validateDrives(Object.entries(cfg.servers).map(([name,v]) => ({ name, ...v })));
    signal?.throwIfAborted();
    const handle = fs.openSync(tmp,'wx',0o600);
    try { fs.writeFileSync(handle,JSON.stringify(cfg,null,2)+'\n'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(tmp, CONFIG_PATH);
    return { ok: true, file: CONFIG_PATH, name, created: !existed, hostkeyFetched, warnings: [], entry: { ...entry, password: entry.password ? '***(stored in servers.json)***' : undefined } };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
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

const mountStateDir=path.join(path.dirname(CONFIG_PATH),'.srb-mounts');
const mountRecordPath=srv=>path.join(mountStateDir,crypto.createHash('sha256').update(srv.name).digest('hex')+'.json');
const psq=s=>"'"+String(s).replaceAll("'","''")+"'";
function secureMountRecord(srv) {
  try {const r=JSON.parse(fs.readFileSync(mountRecordPath(srv),'utf8'));return r.unc===remoteToUnc(srv) && r.drive===srv.drive ? r : null;} catch {return null;}
}
export function pinnedKnownHosts(scan,pin) {
  const fingerprint=String(pin||'').match(/SHA256:[A-Za-z0-9+/]+={0,2}/)?.[0]?.replace(/=+$/,'');
  if(!fingerprint) throw new Error('a SHA256 pinned hostkey is required for SSHFS');
  const lines=scan.split(/\r?\n/).filter(line=>{
    const fields=line.trim().split(/\s+/);
    if(fields.length!==3 || line.startsWith('#')) return false;
    const key=Buffer.from(fields[2],'base64');
    return 'SHA256:'+crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,'')===fingerprint;
  });
  if(!lines.length) throw new Error('SSHFS host key does not match the configured pin; mount refused');
  return lines.join('\n')+'\n';
}
async function mountProcess(record,{signal,stop=false}={}) {
  if(!Number.isSafeInteger(record.pid) || record.pid<1) throw new Error('invalid mount process record');
  const script='$ErrorActionPreference="Stop"; $p=Get-CimInstance Win32_Process -Filter '+psq('ProcessId='+record.pid)+'; if(!$p){exit 3}; if($p.ExecutablePath -ne '+psq(record.exe)+' -or !$p.CommandLine.Contains('+psq(record.marker)+')){throw "mount process ownership mismatch"}; '+(record.created ? 'if($p.CreationDate.ToUniversalTime().ToString("o") -ne '+psq(record.created)+'){throw "mount process identity changed"}; ' : '')+(stop ? 'Stop-Process -Id $p.ProcessId -Force' : '$p.CreationDate.ToUniversalTime().ToString("o")');
  const r=await runCaptureAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{signal});
  if(r.status!==0) throw Object.assign(new Error('cannot verify SSHFS process ownership: '+(r.error||r.stderr||r.status)),{processMissing:r.status===3});
  return r.stdout.trim();
}
async function stopSecureMount(srv,record,{signal,recordFile=mountRecordPath(srv)}={}) {
  await mountProcess(record,{signal,stop:true});
  for(let n=0;n<30;n++) {if(!(await driveInfo(srv.drive,{signal})).exists) break;await new Promise(r=>setTimeout(r,100));}
  if((await driveInfo(srv.drive,{signal})).exists) throw new Error('SSHFS process stopped but drive is still registered');
  fs.unlinkSync(recordFile);
  try {fs.unlinkSync(record.knownHosts);} catch {}
}
async function startSecureMount(srv,{signal}={}) {
  if(!srv.drive) throw new Error('drive is required for mounting');
  if(srv.keyFile && /\.ppk$/i.test(srv.keyFile)) throw new Error('SSHFS requires an OpenSSH key; convert PPK and configure keyFile first');
  const exe=sshfsExecutable();
  if(!fs.existsSync(exe)) throw new Error('SSHFS-Win sshfs.exe not found; set SRB_SSHFS');
  const version=await runCaptureAsync(exe,['--version'],{timeoutMs:5000,signal});
  const match=(version.stdout+'\n'+version.stderr).match(/SSHFS version (\d+)\.(\d+)\.(\d+)/);
  if(version.status!==0 || !match || Number(match[1])<3 || Number(match[1])===3 && (Number(match[2])<7 || Number(match[2])===7 && Number(match[3])<2))throw new Error('SSHFS >= 3.7.2 is required for correct mkdir/EEXIST handling; run node tools/install_sshfs_runtime.mjs. '+(version.error||''));
  // Obtain the public key over the already pinned channel, then enforce it in SSHFS too.
  let keys;
  if(process.env.SRB_KNOWN_HOSTS) keys=fs.readFileSync(process.env.SRB_KNOWN_HOSTS,'utf8');
  else {
    const existing=peekRemoteExec(srv.name), keep=!!existing?.alive;
    const rex=getExecFor(srv);
    let r;
    try {r=await execOnSmart(srv,'(for f in /etc/ssh/ssh_host_*_key.pub; do if [ -r "$f" ]; then /bin/cat -- "$f"; fi; done)',{timeout:30,signal});}
    finally {if(!keep && peekRemoteExec(srv.name)===rex && !rex.queued && !rex.pending.size)await closeRemoteExec(srv.name);}
    if(!r.ok || r.truncated) throw new Error('cannot obtain SSHFS public key over the pinned SSH channel: '+(r.error||'read failed'));
    const hostToken=(srv.port||22)===22 ? srv.host : '['+srv.host+']:'+srv.port;
    keys=r.output.split(/\r?\n/).map(line=>{const f=line.trim().split(/\s+/);return f.length>=2 ? hostToken+' '+f[0]+' '+f[1] : '';}).join('\n');
  }
  const verified=pinnedKnownHosts(keys,srv.hostkey);
  fs.mkdirSync(mountStateDir,{recursive:true});
  const knownHosts=path.join(mountStateDir,crypto.randomBytes(16).toString('hex')+'.known_hosts');
  fs.writeFileSync(knownHosts,verified,{flag:'wx',mode:0o600});
  const marker=knownHosts.replaceAll('\\','/');
  const host=srv.host.includes(':') ? '['+srv.host+']' : srv.host;
  const optionPath=p=>'"'+p.replaceAll('\\','/').replaceAll(',','\\,').replaceAll('"','\\"')+'"';
  const args=[srv.user+'@'+host+':'+remoteFilePath(srv.remote),srv.drive,'-f','-orellinks','-ofstypename=SSHFS','-ouid=-1,gid=-1','--VolumePrefix='+remoteToUnc(srv).slice(1),'-ossh_command=/usr/bin/ssh.exe','-oStrictHostKeyChecking=yes','-oUserKnownHostsFile='+optionPath(marker),'-oGlobalKnownHostsFile=/dev/null','-oPort='+srv.port,'-oConnectTimeout=15','-oServerAliveInterval=30','-oServerAliveCountMax=3','-oNumberOfPasswordPrompts=1'];
  if(srv.keyFile) args.push('-oIdentityFile='+optionPath(srv.keyFile),'-oIdentitiesOnly=yes','-oBatchMode=yes');
  else if(typeof srv.password==='string' && !/[\r\n]/.test(srv.password)) args.push('-opassword_stdin','-oPreferredAuthentications=password,keyboard-interactive');
  else {fs.unlinkSync(knownHosts);throw new Error('SSHFS requires a password without newline or an OpenSSH key');}
  let child,record,lastInfo,stderr='',exited=false;
  try {
    signal?.throwIfAborted();
    child=spawn(exe,args,{cwd:ROOT,windowsHide:true,detached:true,stdio:['pipe','ignore','pipe'],env:{...process.env,PATH:path.dirname(exe)+';'+(process.env.PATH||'')}});
    child.stderr.on('data',b=>stderr=(stderr+b.toString()).slice(-2048));
    child.once('error',e=>{stderr=e.message;exited=true;});child.once('exit',()=>{exited=true;});child.stdin.on('error',()=>{});
    child.stdin.end(!srv.keyFile && srv.password ? srv.password+'\n' : undefined);
    record={pid:child.pid,exe,marker,knownHosts,drive:srv.drive,unc:remoteToUnc(srv),pin:srv.hostkey};
    fs.writeFileSync(mountRecordPath(srv),JSON.stringify(record),{mode:0o600});
    for(let n=0;n<30;n++) {
      signal?.throwIfAborted();
      if(exited) throw new Error('SSHFS exited before mounting: '+stderr);
      const info=await driveInfo(srv.drive,{signal});
      lastInfo=info;
      if(info.exists && sameUNC(info.target,record.unc) && await driveMounted(srv.drive,{signal})) {
        record.created=await mountProcess(record,{signal});
        fs.writeFileSync(mountRecordPath(srv),JSON.stringify(record),{mode:0o600});
        child.unref();child.stderr.unref?.();return;
      }
      await new Promise(r=>setTimeout(r,200));
    }
    throw new Error('SSHFS mount could not be verified: '+JSON.stringify(lastInfo)+'; '+stderr);
  } catch(e) {
    if(child && !exited) {try {child.kill();} catch {}}
    if(record) {try {if(secureMountRecord(srv)?.pid===record.pid) fs.unlinkSync(mountRecordPath(srv));} catch {}}
    try {fs.unlinkSync(knownHosts);} catch {}
    throw e;
  }
}

export function sshfsExecutable() {
  if(process.env.SRB_SSHFS)return process.env.SRB_SSHFS;
  const fixed=path.join(ROOT,'runtime','sshfs','bin','sshfs.exe');
  return fs.existsSync(fixed)?fixed:path.join(process.env.ProgramFiles||'C:\\Program Files','SSHFS-Win','bin','sshfs.exe');
}

export function runCaptureAsync(file, args, { timeoutMs = 15000, input, signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject) => {
    const child = spawn(file,args,{ windowsHide: true, cwd: ROOT });
    let stdout='', stderr='', error=null, finished=false, aborted=false, stopping=false;
    const finish = status => {
      if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      if(aborted)reject(Object.assign(new Error('request cancelled; inspect actual state before retrying a mutation'),{aborted:true}));
      else resolve({status:stopping?null:status,stdout,stderr,error});
    };
    const stop=reason=>{if(finished||stopping)return;stopping=true;error=reason;clearTimeout(timer);timer=setTimeout(()=>finish(null),1000);try {child.kill();}catch {finish(null);}};
    const onAbort=()=>{aborted=true;stop('request cancelled');};
    signal?.addEventListener('abort',onAbort,{once:true});
    let timer = setTimeout(() => stop('process timed out'),timeoutMs);
    child.stdout.on('data',b => { if(stopping||finished)return;stdout += b.toString('utf8');if(stdout.length>4*1024*1024){stdout=stdout.slice(0,4*1024*1024);stop('output limit exceeded');} });
    child.stderr.on('data',b => { if(!finished)stderr=(stderr+b.toString('utf8')).slice(-8192); });
    child.on('error',e => { error=e.message; finish(null); }); child.on('close',finish);
    child.stdin.on('error',()=>{}); child.stdin.end(input);
  });
}
// An isolated process gives stalled network filesystem probes a hard deadline.
async function probeMount(mount, {signal} = {}) {
  if (!mount) return {status:1};
  // shortcut: WinFsp can return EINVAL for empty roots; verify directory metadata/access in that case.
  return runCaptureAsync(process.execPath,['--input-type=module','-e', 'import fs from "node:fs"; const p=process.argv[1]; let d; try {d=fs.opendirSync(p); d.readSync();} catch(e) {if(e.code!=="EINVAL")throw e; fs.accessSync(p,fs.constants.R_OK); if(!fs.statSync(p).isDirectory())throw e;} finally {d?.closeSync();}', mount],{ timeoutMs: 5000,signal });
}
export async function mountOk(mount, opts) {return (await probeMount(mount,opts)).status===0;}
export const driveMounted = (drive,opts) => mountOk(drive ? drive+'\\' : null,opts);
const sameUNC = (a,b) => String(a).replace(/[\\/]+$/,'').toLowerCase() === String(b).replace(/[\\/]+$/,'').toLowerCase();
export async function driveInfo(drive, {signal} = {}) {
  if (!drive || !/^[A-Z]:$/i.test(drive)) throw new Error('invalid drive');
  // WMI caches removed/replaced network drives; QueryDosDevice reports this session's actual mapping.
  const script = String.raw`$ErrorActionPreference="Stop";
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class SRBDrive { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint QueryDosDevice(string name, StringBuilder target, int size); }';
$b=New-Object System.Text.StringBuilder 32768;
$n=[SRBDrive]::QueryDosDevice("${drive.toUpperCase()}",$b,$b.Capacity);
if(!$n){$e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); if($e -ne 2 -and $e -ne 3){throw "QueryDosDevice failed: $e"}; [pscustomobject]@{exists=$false;target=""}|ConvertTo-Json -Compress; exit};
$raw=$b.ToString().Split([char]0)[0]; $target="";
if($raw -match '^\\Device\\Volume\{[^}]+\}\\(.+)$'){$target='\\'+$Matches[1]}
elseif($raw -match '^\\Device\\(?:LanmanRedirector|Mup)\\'){$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive.toUpperCase()}'"; if($d.ProviderName){$target=$d.ProviderName}};
[pscustomobject]@{exists=$true;target=$target}|ConvertTo-Json -Compress`;
  const r = await runCaptureAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{signal});
  if (r.status !== 0) throw new Error('cannot establish drive ownership: '+(r.error || r.stderr));
  try { const v=JSON.parse(r.stdout.replace(/^\uFEFF/,'')); if(typeof v.exists !== 'boolean' || typeof v.target !== 'string') throw Error(); return v; } catch { throw new Error('invalid drive ownership response'); }
}
export async function driveRegistered(drive) { return drive ? (await driveInfo(drive)).exists : false; }
export async function serverMountStatus(srv, {signal} = {}) {
  if (!srv.drive) return { drive_mounted:false, mount_ok:false, target:null };
  const info=await driveInfo(srv.drive,{signal});
  const owned=info.exists && sameUNC(info.target,remoteToUnc(srv));
  const readable=owned && await driveMounted(srv.drive,{signal});
  let linked=false;
  if (srv.mount) { try { linked=sameUNC(await fs.promises.readlink(srv.mount),srv.drive+'\\'); } catch {} }
  let pinned=false;
  const record=owned && secureMountRecord(srv);
  if(record && record.pin===srv.hostkey) {try {await mountProcess(record,{signal});pinned=true;} catch(e) {signal?.throwIfAborted();}}
  return { drive_mounted:!!readable, mount_ok:!!(readable && linked && await mountOk(srv.mount,{signal})), target:info.target, occupied:info.exists, owned, host_key_enforced:pinned };
}
export async function diagnoseStuckDrive(drive) {
  if (!drive || await driveMounted(drive)) return null;
  const info=await driveInfo(drive);
  if (!info.exists) return null;
  return { kind:'unavailable-drive', known:!!info.target, pids:[], message:drive+' is registered but inaccessible; process ownership is unconfirmed', fix:'Close applications using this drive and retry. If Windows cannot release it, reboot Windows. No process or service will be stopped automatically.' };
}
async function mountServerUnlocked(srv, {signal} = {}) {
  const steps=[];
  try {
    validateDrives(); validateMount(srv);
    signal?.throwIfAborted();
    const status=await serverMountStatus(srv,{signal});
    const unc=remoteToUnc(srv);
    if (status.occupied && !status.owned) throw new Error('drive is occupied by another or unidentified target; refusing to replace it');
    if (!status.drive_mounted) {
      if(status.occupied) throw new Error('configured drive is inaccessible; release it manually or reboot before retrying');
      await startSecureMount(srv,{signal});
      steps.push('SSHFS mounted with pinned host key');
    }
    if(srv.mount) {
      signal?.throwIfAborted();
      let stat; try { stat=await fs.promises.lstat(srv.mount); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      if(stat) {
        if(!stat.isSymbolicLink() || !sameUNC(await fs.promises.readlink(srv.mount),srv.drive+'\\')) throw new Error('mount path already exists and is not the expected symlink; refusing to remove it');
      } else {
        try { await fs.promises.symlink(srv.drive+'\\',srv.mount,'dir'); }
        catch(e) { return { ok:true,steps,warning:'drive mounted; symlink creation failed: '+e.message }; }
      }
    }
    steps.push('verified '+srv.drive+' -> '+unc);
    return { ok:true,steps,...(status.drive_mounted && !status.host_key_enforced ? {warning:'existing mapping was kept; host-key enforcement is unverified until a secure remount'} : {}) };
  } catch(e) { return { ok:false,steps,error:e.message }; }
}
async function umountServerUnlocked(srv, {signal} = {}) {
  const steps=[];
  try {
    signal?.throwIfAborted();
    validateDrives(); const info=await driveInfo(srv.drive,{signal});
    if(!info.exists) return { ok:true,steps:['drive is already unmounted'] };
    if(!sameUNC(info.target,remoteToUnc(srv))) throw new Error('drive ownership is unconfirmed; refusing to unmount');
    const record=secureMountRecord(srv);
    if(record) {
      await stopSecureMount(srv,record,{signal});
      if((await driveInfo(srv.drive,{signal})).exists) throw new Error('Windows has not released the drive; inspect state before retrying');
      return {ok:true,steps:['stopped the verified SSHFS mount process']};
    }
    const r=await runCaptureAsync('net.exe',['use',srv.drive,'/delete','/y'],{timeoutMs:15000,signal});
    steps.push('net use /delete => '+r.status);
    if(r.status !== 0 || (await driveInfo(srv.drive)).exists) throw new Error('Windows did not release the drive');
    return {ok:true,steps};
  } catch(e) {return {ok:false,steps,error:e.message};}
}
// Serialize mutations across Codex/WorkBuddy processes without touching unrelated drives.
async function withMountLock(srv, fn, opts={}) {
  opts.signal?.throwIfAborted();
  const lock=CONFIG_PATH+'.mount.lock'; let fd;
  try { fd=fs.openSync(lock,'wx',0o600); } catch(e) {return {ok:false,steps:[],error:e.code === 'EEXIST' ? 'another mount operation is active; retry later' : e.message};}
  try {return await fn(srv,opts);} finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
export const mountServer = (srv,opts) => withMountLock(srv,mountServerUnlocked,opts);
export const umountServer = (srv,opts) => withMountLock(srv,umountServerUnlocked,opts);

// A server identity deliberately ignores remote directories: cleanup follows the user's server-level rule.
function mountServerIdentity(unc) {
  const m=String(unc).match(/^\\\\sshfs(?:\.(?:r|k|kr))?\\(?:[^=@\\]+=)?([^@\\]+)@([^!\\]+)(?:!(\d+))?(?:\\|$)/i);
  return m ? JSON.stringify([m[1],m[2].toLowerCase(),Number(m[3]||22)]) : null;
}
async function inspectDuplicateMounts({signal}={}) {
  const servers=listServers();validateDrives(servers);
  const identities=new Set(servers.map(s=>mountServerIdentity(remoteToUnc(s))));
  const records=[];
  let names=[];try {names=fs.readdirSync(mountStateDir);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))) {
    const file=path.join(mountStateDir,name);
    try {
      const r=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!/^[A-Z]:$/i.test(r.drive)||!mountServerIdentity(r.unc)||typeof r.exe!=='string'||path.basename(r.exe).toLowerCase()!=='sshfs.exe')continue;
      if(typeof r.knownHosts!=='string'||path.resolve(path.dirname(r.knownHosts))!==path.resolve(mountStateDir)||!/^[a-f0-9]{32}\.known_hosts$/.test(path.basename(r.knownHosts))||r.marker!==r.knownHosts.replaceAll('\\','/'))continue;
      records.push({file,record:r});identities.add(mountServerIdentity(r.unc));
    } catch {}
  }
  const script=String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;
$network=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' | ForEach-Object { [pscustomobject]@{drive=$_.DeviceID;target=$_.ProviderName} });
$remembered=@(); if(Test-Path -LiteralPath 'HKCU:\Network'){ $remembered=@(Get-ChildItem -LiteralPath 'HKCU:\Network' | ForEach-Object { $v=Get-ItemProperty -LiteralPath $_.PSPath; [pscustomobject]@{drive=$_.PSChildName+':';target=$v.RemotePath} }) };
[pscustomobject]@{network=$network;remembered=$remembered}|ConvertTo-Json -Depth 4 -Compress`;
  const result=await runCaptureAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{signal});
  if(result.status!==0||result.error)throw new Error('cannot enumerate mappings: '+(result.error||result.stderr));
  const inventory=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  const remembered=new Map(inventory.remembered.map(r=>[String(r.drive).toUpperCase(),r.target]));
  const drives=new Set([...inventory.network,...inventory.remembered,...records.map(r=>r.record)].map(r=>String(r.drive).toUpperCase()));
  const rows=[];
  for(const drive of [...drives].sort()) {
    if(!/^[A-Z]:$/.test(drive))continue;
    let info;
    try {info=await driveInfo(drive,{signal});}
    catch(e) {signal?.throwIfAborted();rows.push({drive,target:'',state:'unknown',action:'skip',reason:'cannot establish drive ownership: '+e.message});continue;}
    const target=info.exists?info.target:remembered.get(drive);
    const identity=mountServerIdentity(target);
    if(!identity)continue;
    const row={drive,target,identity,state:'unknown',action:'skip',reason:'server ownership is unknown'};
    rows.push(row);
    if(!identities.has(identity))continue;
    if(info.exists&&remembered.has(drive)&&!sameUNC(target,remembered.get(drive))) {row.reason='live and remembered mappings disagree';continue;}
    const probe=info.exists?await probeMount(drive+'\\',{signal}):{status:1};
    if(probe.status===null||probe.error) {row.reason='access probe timed out or failed to run';continue;}
    if(probe.status!==0&&info.exists&&!/\b(?:ENOENT|ENODEV|ENXIO|ENOTCONN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EIO)\b/.test(probe.stderr||'')) {row.reason='offline state is unconfirmed (permission, busy or unexpected probe error)';continue;}
    row.state=probe.status===0?'online':'offline';
    row.configured=servers.some(s=>s.drive?.toUpperCase()===drive&&sameUNC(remoteToUnc(s),target));
    row.reason=row.state==='online'?'keep online mapping':'no duplicate to remove';
    const matched=records.filter(r=>r.record.drive.toUpperCase()===drive&&sameUNC(r.record.unc,target));
    if(matched.length===1)row.owner=matched[0];
    else if(matched.length>1) {row.state='unknown';row.reason='multiple process ownership records';}
  }
  const groups=new Map();
  for(const row of rows.filter(r=>r.state!=='unknown')) {if(!groups.has(row.identity))groups.set(row.identity,[]);groups.get(row.identity).push(row);}
  for(const group of groups.values()) {
    const online=group.filter(r=>r.state==='online');
    const offline=group.filter(r=>r.state==='offline').sort((a,b)=>Number(!!b.configured)-Number(!!a.configured)||a.drive.localeCompare(b.drive));
    const keeper=online[0]||offline[0];
    if(!keeper)continue;
    for(const row of offline) {
      if(row===keeper) {row.reason='keep '+(row.configured?'configured offline mapping':'one offline mapping');continue;}
      row.action='remove';row.keeper=keeper.drive;
      row.reason='duplicate of '+keeper.drive+' ('+keeper.state+')';
    }
  }
  return rows;
}
export async function cleanupDuplicateMounts({apply=false,drives=[],signal}={}) {
  if(process.platform!=='win32')throw new Error('mount cleanup requires Windows');
  if(typeof apply!=='boolean'||!Array.isArray(drives)||drives.some(d=>typeof d!=='string'||!/^[A-Z]:$/i.test(d)))throw new Error('invalid cleanup options');
  const selected=new Set(drives.map(d=>d.toUpperCase()));
  const summarize=row=>({drive:row.drive,target:row.target,state:row.state,action:row.action,reason:row.reason});
  if(!apply)return {ok:true,apply:false,rows:(await inspectDuplicateMounts({signal})).filter(r=>!selected.size||selected.has(r.drive)).map(summarize)};
  return withMountLock(null,async()=>{
    const rows=await inspectDuplicateMounts({signal});
    const outcomes=[];let ok=true;
    for(const candidate of rows.filter(r=>r.action==='remove'&&(!selected.size||selected.has(r.drive)))) {
      // Recompute before each mutation: an offline drive or its keeper may have recovered or changed.
      const current=await inspectDuplicateMounts({signal});
      const fresh=current.find(r=>r.drive===candidate.drive);
      if(!fresh||fresh.action!=='remove'||!sameUNC(fresh.target,candidate.target)) {outcomes.push({drive:candidate.drive,action:'skip',reason:'mapping or state changed'});continue;}
      try {
        if(fresh.state!=='offline'||!current.some(r=>r.drive===fresh.keeper&&r.identity===fresh.identity&&r.action!=='remove'&&r.state!=='unknown'))throw new Error('cleanup must retain another confirmed mapping for this server');
        if(fresh.owner) {
          const {record,file}=fresh.owner;
          if(typeof record.created!=='string')throw new Error('process creation identity is missing; refusing to stop it');
          let alive=true;
          try {await mountProcess(record,{signal});}catch(e){if(!e.processMissing)throw e;alive=false;}
          if(alive)await stopSecureMount({drive:fresh.drive},record,{signal,recordFile:file});
          else await removeRememberedMount(fresh,{signal});
        } else await removeRememberedMount(fresh,{signal});
        outcomes.push({drive:fresh.drive,action:'removed',reason:fresh.reason});
      } catch(e) {ok=false;outcomes.push({drive:fresh.drive,action:'failed',reason:e.message});}
    }
    let shellRefresh;
    try {shellRefresh=await refreshMissingDriveDisplay([...selected],{signal});}
    catch(e) {ok=false;shellRefresh={error:e.message};}
    return {ok,apply:true,rows:rows.filter(r=>!selected.size||selected.has(r.drive)).map(summarize),outcomes,shellRefresh};
  },{signal});
}
async function removeRememberedMount(row,{signal}={}) {
  const info=await driveInfo(row.drive,{signal});
  if(info.exists&&!sameUNC(info.target,row.target))throw new Error('drive target changed; refusing cleanup');
  const result=await runCaptureAsync('net.exe',['use',row.drive,'/delete','/y'],{timeoutMs:15000,signal});
  if(result.status!==0||result.error)throw new Error('mapping could not be released; no process was stopped: '+(result.error||result.stderr||result.stdout||result.status));
  if((await driveInfo(row.drive,{signal})).exists)throw new Error('Windows has not released the drive; close applications using it and retry');
}

async function refreshMissingDriveDisplay(drives,{signal}={}) {
  const protectedDrives=listServers().map(s=>s.drive?.toUpperCase()).filter(Boolean);
  const script=String.raw`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;
$q=[Console]::In.ReadToEnd()|ConvertFrom-Json;
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SRBShellRefresh {
 [StructLayout(LayoutKind.Sequential)] public struct Volume {public uint size,type,reserved,mask;public ushort flags;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint QueryDosDevice(string name,StringBuilder target,int size);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(int eventId,uint flags,string path,IntPtr unused);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,ref Volume v,uint flags,uint timeout,out IntPtr result);
 public static bool NotifyRemoved(uint mask) {
  var v=new Volume();v.size=(uint)Marshal.SizeOf(v);v.type=2;v.mask=mask;v.flags=2;
  IntPtr result;return SendMessageTimeout((IntPtr)65535,0x219,(IntPtr)0x8004,ref v,2,1000,out result)!=IntPtr.Zero;
 }
}
'@
$keep=@($q.protectedDrives)+@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' | ForEach-Object {$_.DeviceID});
if(Test-Path -LiteralPath 'HKCU:\Network'){$keep+=@(Get-ChildItem -LiteralPath 'HKCU:\Network' | ForEach-Object {$_.PSChildName+':'})};
$letters=@($q.drives);if(!$letters.Count){$letters=@(65..90|ForEach-Object{([string][char]$_)+':'})};$notified=@();$mask=0;
foreach($drive in $letters){
  if($drive -notmatch '^[A-Z]:$'){throw 'invalid refresh drive'};
  if($keep -contains $drive){continue};
  $buffer=New-Object Text.StringBuilder 32768;
  if([SRBShellRefresh]::QueryDosDevice($drive,$buffer,$buffer.Capacity)){continue};
  $err=[Runtime.InteropServices.Marshal]::GetLastWin32Error();if($err -ne 2 -and $err -ne 3){throw "cannot verify absent drive: $drive ($err)"};
  $mask=$mask -bor (1 -shl ([int][char]$drive[0]-65));$notified+=$drive;
};
# Shell-only notifications hide items temporarily; the device event also invalidates Explorer's drive cache.
if($mask -and ![SRBShellRefresh]::NotifyRemoved($mask)){throw 'Windows drive-removal notification did not complete; retry after closing unresponsive applications'};
foreach($drive in $notified){[SRBShellRefresh]::SHChangeNotify(0x80,0x1005,$drive+'\',[IntPtr]::Zero)};
[pscustomobject]@{notified=$notified;device_notification_completed=$true}|ConvertTo-Json -Compress`;
  const r=await runCaptureAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{signal,input:JSON.stringify({drives,protectedDrives})});
  if(r.status!==0||r.error)throw new Error('Explorer refresh failed: '+(r.error||r.stderr));
  return JSON.parse(r.stdout.replace(/^\uFEFF/,''));
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
export async function fetchHostKeyAsync(host, port = 22, {signal} = {}) {
  signal?.throwIfAborted();
  if (typeof host !== 'string' || !host || /[\s\x00-\x1f]/.test(host) || host.startsWith('-') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid host or port');
  let cfg;
  try {cfg=loadConfig();} catch {cfg=readConfigLenient();}
  const r=await runCaptureAsync(plinkPath(cfg),['-ssh','-batch','-P',String(port),host,'exit'],{timeoutMs:30000,signal});
  const text=r.stdout+'\n'+r.stderr;
  const fingerprints=[...new Set(text.match(/SHA256:[A-Za-z0-9+/=]+/g)||[])];
  return fingerprints.length ? {ok:true,fingerprints,via:'plink'} : {ok:false,error:r.error||'Could not fetch host key; ask for the SHA256 fingerprint.'};
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
  const knownHosts=process.env.SRB_KNOWN_HOSTS || path.join(ROOT,'known_hosts');
  if(!fs.existsSync(knownHosts)) throw new Error('rclone requires a verified known_hosts file (SRB_KNOWN_HOSTS)');
  const lines=[ '['+srv.name+']','type = sftp','host = '+srv.host,'user = '+srv.user,'port = '+srv.port,'known_hosts_file = '+knownHosts ];
  for(const value of [srv.name,srv.host,srv.user,srv.keyFile,knownHosts]) if(value && /[\r\n]/.test(value)) throw new Error('invalid rclone config value');
  if(srv.password) { const pass=rcloneObscure(srv.password); if(!pass) throw new Error('rclone password encoding failed'); lines.push('pass = '+pass); }
  else if(srv.keyFile) { if(/\.ppk$/i.test(srv.keyFile)) throw new Error('rclone requires an OpenSSH private key, not PPK'); lines.push('key_file = '+srv.keyFile); }
  else throw new Error('rclone authentication is missing');
  const confPath=path.join(os.tmpdir(),'srb_rclone_'+crypto.randomBytes(16).toString('hex')+'.conf');
  fs.writeFileSync(confPath,lines.join('\n')+'\n',{flag:'wx',mode:0o600});
  return confPath;
}

// ---------------------------------------------------------------- 路径映射

/** 本地挂载路径 -> 远程路径; 不在挂载树下返回 null */
/**
 * 本地路径 -> 远端路径。返回 null 表示"本地 cwd 不在挂载树下"。
 *
 * 根路径有两个来源, 都要认:
 *   - srv.mount  符号链接路径（如 F:\myserver），完整模式用
 *   - srv.drive  盘符（如 M:），**纯盘符模式下 mount 是空的, 这才是真正的入口**
 * 之前只看 mount, 于是纯盘符模式下永远返回 null —— 在 M:\ 里启动 shell
 * 明明就是服务器的家目录, 却提示 "not under mount tree"。
 */
export function localToRemote(srv, localPath) {
  const roots = [remoteToUnc(srv)];
  if (srv.mount) roots.push(srv.mount);
  if (srv.drive) {
    // "M:" -> "M:\"  这样 path.resolve 之后前缀比较才一致
    roots.push(/[\\/]$/.test(srv.drive) ? srv.drive : srv.drive + path.sep);
  }
  if (!roots.length) return null;
  try {
    const norm = path.resolve(localPath);
    const n = norm.toLowerCase();
    for (const rawRoot of roots) {
      const root = path.resolve(rawRoot);
      const r = root.toLowerCase();
      if (n === r) return srv.remote;
      if (n.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) {
        const rel = norm.slice(root.length).split(path.sep).filter(Boolean).join('/');
        return rel ? srv.remote + '/' + rel : srv.remote;
      }
    }
  } catch (_) {}
  return null;
}
