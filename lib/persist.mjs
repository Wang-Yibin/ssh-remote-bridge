/**
 * lib/persist.mjs — 持久执行器（长连接命令通道）
 *
 * 背景: 旧 tmux 方案每条命令要 2 次 SSH 握手（本服务器实测 5.6s/次），
 * 交互体验不可接受。本模块维护一条长连接: 首次握手 5.6s（服务器侧 KEX/PAM 成本，
 * 与客户端无关），之后每条命令往返 4-35ms（实测）。
 *
 * 协议见同目录 exec-loop.sh（引导写入远端后由远端 bash 循环执行）。
 *
 * 用法:
 *   const rex = getRemoteExec('5090', conn);
 *   const r = await rex.exec('nvidia-smi', { timeout: 120 });   // 秒
 *   rex.interrupt();   // Ctrl+C: 杀当前任务进程组
 *   rex.close();       // 主动断开
 *
 * conn = { plink, host, port, user, password, hostkey, keyFile }
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOT_SCRIPT = path.join(__dirname, 'exec-loop.sh');
const BOOT_REMOTE_PATH = '/tmp/.srb-exec.v4.$$.sh';

const KEEPALIVE_MS = 30000; // 空闲保活间隔
const KEEPALIVE_TIMEOUT_MS = 15000; // 保活帧超时 -> 判定连接半死, 强制重连
const START_TIMEOUT_MS = 90000; // 握手+预热上限（服务器忙时握手可能到 20s+）
const INTERRUPT_GRACE_MS = 8000; // 超时后发 X, 等 D 的宽限

// 远端内部临时文件名会出现在 bash 的语法错误里（line N: unexpected EOF），
// 对使用者是噪音, 统一替换成可读名字
const TMPPATH_RE = /\/tmp\/\.srb-exec\.v4\.[a-z]+\.\d+/g;
function scrubTmpPaths(s) {
  return s.replace(TMPPATH_RE, '<remote-temp>');
}

const instances = new Map();

export function getRemoteExec(key, conn) {
  let re = instances.get(key);
  if (!re) {
    re = new RemoteExec(key, conn);
    instances.set(key, re);
  } else if (conn) {
    re.updateConn(conn);
  }
  return re;
}

export function closeRemoteExec(key) {
  const re = instances.get(key);
  if (re) {
    re.close();
    instances.delete(key);
  }
}

export function closeAllRemoteExecs() {
  for (const [, re] of instances) re.close();
  instances.clear();
}

/** 连接从未建立起来（可回落旧 tmux 通道） */
export class StartError extends Error {
  constructor(msg, { aborted = false } = {}) {
    super(msg);
    this.name = 'StartError';
    this.code = 'START_FAILED';
    this.aborted = aborted;
  }
}

/** 连接曾经正常, 后来断了（不回落, 直接报错, 下次自动重连） */
export class LostError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'LostError';
    this.code = 'LOST';
  }
}

export class RemoteExec extends EventEmitter {
  /**
   * @param {string} key   实例键（一般是服务器名）
   * @param {object} conn  { plink, host, port, user, password, hostkey, keyFile }
   */
  constructor(key, conn) {
    super();
    this.key = key;
    this.conn = conn || {};
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.pending = new Map(); // token -> rec
    this.seq = 0;
    this.curToken = null; // 正在远端执行的任务 token
    this.ready = false;
    this.everReady = false;
    this.starting = null;
    this.chain = Promise.resolve(); // 串行化: 同一连接同时只跑一个任务
    this.keepalive = null;
    this.stderrBuf = '';
  }

  updateConn(conn) {
    this.conn = { ...this.conn, ...conn };
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null && this.ready;
  }

  stats() {
    return {
      key: this.key,
      alive: this.alive,
      ready: this.ready,
      pid: this.proc ? this.proc.pid : null,
      pending: [...this.pending.keys()],
      curToken: this.curToken,
    };
  }

  // ---------------------------------------------------------------- 生命周期

  async ensure() {
    if (this.alive) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    this._abortRequested = false;
    let script;
    try {
      script = fs.readFileSync(BOOT_SCRIPT);
    } catch (e) {
      throw new StartError(`cannot read ${BOOT_SCRIPT}: ${e.message}`);
    }
    const b64 = script.toString('base64');
    // 一次连接搞定: base64 只含 [A-Za-z0-9+/=], 无需考虑远端 shell 转义;
    // $$ 由远端登录 shell 展开成本次连接的 PID, 保证临时文件不撞车
    const remoteCmd = `echo ${b64} | /usr/bin/base64 -d > ${BOOT_REMOTE_PATH} && exec bash ${BOOT_REMOTE_PATH}`;
    const args = ['-ssh', '-batch', '-P', String(this.conn.port || 22), '-l', this.conn.user];
    if (this.conn.hostkey) args.push('-hostkey', this.conn.hostkey);
    if (this.conn.keyFile) args.push('-i', this.conn.keyFile);
    else if (this.conn.password) args.push('-pw', this.conn.password);
    args.push(this.conn.host, remoteCmd);

    const proc = spawn(this.conn.plink, args, { windowsHide: true });
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.ready = false;
    proc.stdout.on('data', (c) => this._onData(c));
    proc.stderr.on('data', (c) => {
      this.stderrBuf = (this.stderrBuf + c.toString('utf8')).slice(-8192);
    });
    proc.on('exit', (code, sig) => this._onExit(code, sig));
    proc.on('error', (e) => this._failAll(new LostError(`plink error: ${e.message}`)));
    proc.stdin.on('error', () => {});

    // 预热: 发一条空命令等 D 回来, 用来判定握手+协议是否真的通了
    try {
      await this._execOne(':', { timeout: START_TIMEOUT_MS, warmup: true });
    } catch (e) {
      this.killProc();
      const tail = this.stderrBuf ? ` | plink: ${this.stderrBuf.trim().split('\n').slice(-3).join(' / ')}` : '';
      if (e instanceof StartError) throw e;
      throw new StartError(`handshake failed: ${e.message}${tail}`, { aborted: this._abortRequested || !!(e && e.aborted) });
    }
    this.ready = true;
    this.everReady = true;
    this._startKeepalive();
    this.emit('ready');
  }

  /** 主动优雅关闭（发 EOF 让远端清理, 300ms 后兜底 kill） */
  close() {
    this._stopKeepalive();
    const p = this.proc;
    if (p && p.exitCode === null) {
      try {
        p.stdin.end();
      } catch (_) {}
      setTimeout(() => {
        try {
          p.kill();
        } catch (_) {}
      }, 300).unref();
    }
    this._failAll(new LostError('connection closed locally'));
    this.proc = null;
    this.ready = false;
  }

  /** 立即杀掉连接进程（握手阶段 Ctrl+C 用） */
  abort() {
    this._abortRequested = true;
    this.killProc();
  }

  killProc() {
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    this._stopKeepalive();
    if (p && p.exitCode === null) {
      try {
        p.kill();
      } catch (_) {}
    }
    this._failAll(new LostError('connection killed'));
  }

  // ---------------------------------------------------------------- 命令执行

  /**
   * 执行一条命令（自动建连, 串行排队）
   * @param {string} cmd
   * @param {{timeout?: number, stream?: boolean, onStream?: (chunk: string) => void}} opts
   *        timeout 单位秒, 默认 120
   *        stream=true 时远端边跑边发 S 帧, 增量经onStream 实时回调
   * @returns {Promise<{exitCode, output, cwd, timedOut, interrupted, duration, error}>}
   */
  async exec(cmd, opts = {}) {
    await this.ensure();
    const timeoutMs = Math.max(1000, (Number(opts.timeout) || 120) * 1000);
    const run = this.chain.then(() => this._execOne(cmd, { timeout: timeoutMs, stream: !!opts.stream, onStream: opts.onStream }));
    this.chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * 只读查询（Tab 补全用）。刻意不走 this.chain：
   * chain 是给命令用的串行队列, 若补全也排队, 任务运行期间按 Tab 会
   * 一直卡到那个长任务结束。这里直接发帧, 与正在跑的任务互不干扰
   * （远端 Q 分支不建task、不占 curpid, 只读状态文件）。
   */
  query(qcmd, { timeout = 15000 } = {}) {
    const run = async () => {
      await this.ensure();
      const token = 'q' + ++this.seq;
      return new Promise((resolve) => {
        const rec = {
          token,
          resolve,
          reject: () => {},
          outB64: '',
          cwdB64: '',
          streamed: '',
          onStream: null,
          stream: false,
          startedAt: Date.now(),
          timer: null,
          grace: null,
          timedOut: false,
          interruptSent: false,
          warmup: false,
          done: false,
        };
        rec.timer = setTimeout(() => {
          if (!this.pending.has(token)) return;
          this.pending.delete(token);
          resolve({ output: '', timedOut: true, duration: (Date.now() - rec.startedAt) / 1000 });
        }, timeout);
        this.pending.set(token, rec);
        const sendts = (Date.now() / 1000).toFixed(3);
        const line = `${sendts}|Q ${token} ${Buffer.from(qcmd, 'utf8').toString('base64')}`;
        if (!this._send(line)) {
          clearTimeout(rec.timer);
          this.pending.delete(token);
          resolve({ output: '', timedOut: false, spawnFailed: true, duration: 0 });
        }
      });
    };
    // 握手未完成时 ensure() 会 await 完, 但补全不能因此卡住界面 -> 给它一个上限
    return Promise.race([
      run(),
      new Promise((resolve) => setTimeout(() => resolve({ output: '', timedOut: true, duration: timeout / 1000 }), timeout)),
    ]);
  }

  _execOne(cmd, { timeout = 120000, warmup = false, stream = false, onStream = null } = {}) {
    const token = (warmup ? 'w' : 'e') + ++this.seq;
    return new Promise((resolve, reject) => {
      const rec = {
        token,
        resolve,
        reject,
        outB64: '',
        cwdB64: '',
        streamed: '', // S 帧已流出的文本（拼回 output, 保证结果与不流式时一致）
        onStream,
        stream, // 是否流式任务（决定最终 output 取rec.streamed 还是 outB64）
        startedAt: Date.now(),
        timer: null,
        grace: null,
        timedOut: false,
        interruptSent: false,
        warmup,
      };
      rec.timer = setTimeout(() => this._onTimeout(token), timeout);
      this.pending.set(token, rec);
      this.curToken = token;
      const sendts = (Date.now() / 1000).toFixed(3);
      // F 帧 = 边跑边回传增量（S）; C 帧 = 跑完一次性回传（O）
      const op = stream ? 'F' : 'C';
      const line = `${sendts}|${op} ${token} ${Buffer.from(cmd, 'utf8').toString('base64')}`;
      if (!this._send(line)) {
        clearTimeout(rec.timer);
        this.pending.delete(token);
        if (this.curToken === token) this.curToken = null;
        reject(new LostError('cannot write to plink stdin (connection gone?)'));
      }
    });
  }

  /** Ctrl+C: 中断当前任务（远端整组 SIGTERM -> 2s 后 KILL） */
  interrupt() {
    const token = this.curToken;
    const rec = token ? this.pending.get(token) : null;
    if (!rec) return false;
    rec.interruptSent = true;
    this._send(`X ${token}`);
    return true;
  }

  _onTimeout(token) {
    const rec = this.pending.get(token);
    if (!rec || rec.done) return;
    rec.timedOut = true;
    if (rec.warmup) {
      // 握手就没通: 立即失败, 不走宽限
      this.pending.delete(token);
      if (this.curToken === token) this.curToken = null;
      rec.reject(new StartError(`no response within ${Math.round(START_TIMEOUT_MS / 1000)}s (server unreachable?)`));
      return;
    }
    rec.interruptSent = true;
    this._send(`X ${token}`);
    rec.grace = setTimeout(() => {
      if (!this.pending.has(token)) return;
      this.pending.delete(token);
      if (this.curToken === token) this.curToken = null;
      const output = rec.outB64 ? scrubTmpPaths(Buffer.from(rec.outB64, 'base64').toString('utf8')) : '';
      rec.resolve({
        exitCode: null,
        output,
        cwd: null,
        timedOut: true,
        interrupted: true,
        duration: (Date.now() - rec.startedAt) / 1000,
        error: `timed out after ${Math.round((Date.now() - rec.startedAt) / 1000)}s; interrupt sent to remote job`,
      });
    }, INTERRUPT_GRACE_MS);
  }

  // ---------------------------------------------------------------- 协议解析

  _send(s) {
    const p = this.proc;
    if (!p || p.exitCode !== null || !p.stdin.writable) return false;
    try {
      p.stdin.write(s + '\n');
      return true;
    } catch (_) {
      return false;
    }
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let idx;
    while ((idx = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.slice(0, idx).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    const m = /^([TODPS]) (\S+)(?: (.*))?$/.exec(line);
    if (!m) return; // 远端启动噪音（banner 等）
    const type = m[1];
    const token = m[2];
    const rest = m[3] || '';
    const rec = this.pending.get(token);
    if (type === 'T') return; // 任务启动通知, 不需要
    if (!rec) return; // 迟到帧（超时后已被丢弃）
    if (type === 'P') {
      rec.cwdB64 = rest;
      return;
    }
    if (type === 'S') {
      // 流式增量: 立刻回调给调用方（不等 D 帧）
      let text = '';
      try {
        text = Buffer.from(rest, 'base64').toString('utf8');
      } catch (_) {
        return;
      }
      if (text) {
        rec.streamed += text;
        if (typeof rec.onStream === 'function') {
          try {
            rec.onStream(text);
          } catch (_) {
            /* 消费方自己抛错不能影响协议循环 */
          }
        }
      }
      return;
    }
    if (type === 'O') {
      rec.outB64 += rest;
      return;
    }
    if (type === 'D') {
      if (rec.done) return;
      rec.done = true;
      clearTimeout(rec.timer);
      clearTimeout(rec.grace);
      this.pending.delete(token);
      if (this.curToken === token) this.curToken = null;
      // 流式模式: 以S 帧累计的文本为准。远端 srb_done 会先补发尾巴再发 O,
      // 所以 rec.streamed 已是完整输出; O 帧是同一份内容的重复, 用它会打印两遍。
      const output = rec.stream
        ? scrubTmpPaths(rec.streamed)
        : rec.outB64
          ? scrubTmpPaths(Buffer.from(rec.outB64, 'base64').toString('utf8'))
          : '';
      rec.resolve({
        exitCode: Number(rest),
        output,
        cwd: rec.cwdB64 ? Buffer.from(rec.cwdB64, 'base64').toString('utf8') : null,
        timedOut: !!rec.timedOut,
        interrupted: !!rec.interruptSent,
        duration: (Date.now() - rec.startedAt) / 1000,
        error: rec.timedOut ? `timed out after ${Math.round((Date.now() - rec.startedAt) / 1000)}s` : null,
      });
    }
  }

  _failAll(err) {
    for (const [token, rec] of [...this.pending]) {
      clearTimeout(rec.timer);
      clearTimeout(rec.grace);
      this.pending.delete(token);
      if (this.curToken === token) this.curToken = null;
      rec.reject(err);
    }
  }

  _onExit(code, sig) {
    const wasAlive = this.alive;
    this.proc = null;
    this.ready = false;
    this._stopKeepalive();
    const tail = this.stderrBuf ? ` | plink: ${this.stderrBuf.trim().split('\n').slice(-2).join(' / ')}` : '';
    const err = new LostError(`plink exited (code=${code} signal=${sig})${tail}`);
    this._failAll(err);
    if (wasAlive || this.pending.size) this.emit('drop', err);
  }

  // ---------------------------------------------------------------- 保活

  _startKeepalive() {
    this._stopKeepalive();
    this.keepalive = setInterval(() => {
      if (!this.alive || this.curToken || this.pending.size > 0) return;
      const token = 'k' + ++this.seq;
      const rec = {
        token,
        resolve: () => {},
        reject: () => {},
        outB64: '',
        cwdB64: '',
        startedAt: Date.now(),
        timer: null,
        grace: null,
        timedOut: false,
        interruptSent: false,
        warmup: false,
      };
      rec.timer = setTimeout(() => {
        // 保活帧没回来 -> TCP 半死, 杀掉的等下次 ensure 重连
        if (this.pending.has(token)) {
          this.pending.delete(token);
          this.killProc();
          this._onExit(null, 'keepalive-timeout');
        }
      }, KEEPALIVE_TIMEOUT_MS);
      this.pending.set(token, rec);
      this._send(`N ${token}`);
    }, KEEPALIVE_MS);
    if (this.keepalive.unref) this.keepalive.unref();
  }

  _stopKeepalive() {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }
}

// Node 退出不会自动杀子进程 — plink 必须在这里兜底杀掉, 否则会残留常驻连接
process.on('exit', () => {
  for (const [, re] of instances) {
    const p = re.proc;
    if (p && p.exitCode === null) {
      try {
        p.kill();
      } catch (_) {}
    }
  }
});
