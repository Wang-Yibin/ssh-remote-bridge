/**
 * lib/persist.mjs — 持久执行器（长连接命令通道）
 *
 * 背景: 旧 tmux 方案每条命令要 2 次 SSH 握手（本服务器实测 5.6s/次），
 * 交互体验不可接受。本模块维护一条长连接: 首次握手 5.6s（服务器侧 KEX/PAM 成本，
 * 与客户端无关），之后每条命令往返 4-35ms（实测）。
 *
 * exec-loop.sh 加载用户环境，exec-loop.py 通过事件循环管理命令和输出。
 *
 * 用法:
 *   const rex = getRemoteExec('5090', conn);
 *   const r = await rex.exec('nvidia-smi', { timeout: 120 });   // 秒
 *   rex.interrupt();   // Ctrl+C: 杀当前任务进程组
 *   await rex.close(); // 等待远端清理后断开
 *
 * conn = { plink, host, port, user, password, hostkey, keyFile }
 */
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOT_SCRIPT = path.join(__dirname, 'exec-loop.sh');
let bootSource;
export const MAX_OUTPUT = 2 * 1024 * 1024;

const KEEPALIVE_MS = 30000; // 空闲保活间隔
const KEEPALIVE_TIMEOUT_MS = 15000; // 保活帧超时 -> 判定连接半死, 强制重连
const IDLE_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 90000; // 握手+预热上限（服务器忙时握手可能到 20s+）
const INTERRUPT_GRACE_MS = 8000; // 超时后发 X, 等 D 的宽限

// 远端内部临时文件名会出现在 bash 的语法错误里（line N: unexpected EOF），
// 对使用者是噪音, 统一替换成可读名字
const TMPPATH_RE = /\/tmp\/\.srb-exec\.[A-Za-z0-9]+(?:\/[we]\d+\/cmd)?/g;
function scrubTmpPaths(s) {
  return s.replace(TMPPATH_RE, '<remote-temp>');
}

const instances = new Map();
const children = new Set();
export function peekRemoteExec(key) { return instances.get(key); }

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
    instances.delete(key);
    return re.close();
  }
}

export function closeAllRemoteExecs() {
  const closing = [...instances.values()].map(re => re.close());
  instances.clear();
  return Promise.allSettled(closing);
}

/** 连接从未建立起来（明确报错，不自动重放命令） */
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
    this.fragments = [];
    this.bufferedBytes = 0;
    this.pending = new Map(); // token -> rec
    this.seq = 0;
    this.curToken = null; // 正在远端执行的任务 token
    this.ready = false;
    this.closed = false;
    this.epoch = 0;
    this.closing = null;
    this.lastUsed = Date.now();
    this.keepOpen = false;
    this.starting = null;
    this.chain = Promise.resolve(); // 串行化: 同一连接同时只跑一个任务
    this.keepalive = null;
    this.stderrBuf = '';
    this.session = null;
  }

  updateConn(conn) {
    const next = { ...this.conn, ...conn };
    const changed = ['plink','host','port','user','password','keyFile','hostkey'].some(k => next[k] !== this.conn[k]);
    if (changed) {
      if (this.pending.size || this.starting || this.queued) throw new Error('server connection settings changed while commands are active; retry when idle');
      this.close();
      this.conn = next;
      this.closed = false;
    }
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
    if (this.closed) throw new LostError('connection closed locally');
    if (this.closing) await this.closing;
    if (this.closed) throw new LostError('connection closed locally');
    if (this.alive) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    const epoch = this.epoch;
    this._abortRequested = false;
    let script;
    try {
      bootSource ??= fs.readFileSync(BOOT_SCRIPT,'utf8').replace(/\r\n/g,'\n').replace('__SRB_CONTROLLER__', () => fs.readFileSync(path.join(__dirname,'exec-loop.py'),'utf8').replace(/\r\n/g,'\n'));
      script = Buffer.from(bootSource);
    } catch (e) {
      throw new StartError(`cannot read ${BOOT_SCRIPT}: ${e.message}`);
    }
    const b64 = script.toString('base64');
    // 一次连接搞定: base64 只含 [A-Za-z0-9+/=], 无需考虑远端 shell 转义;
    // $$ 由远端登录 shell 展开成本次连接的 PID, 保证临时文件不撞车
    const remoteCmd = `umask 077; D=$(mktemp -d /tmp/.srb-exec.XXXXXXXXXX) || exit; export SRB_DIR="$D"; trap 'rm -rf -- "$D"' EXIT; printf %s ${b64} | /usr/bin/base64 -d > "$D/boot.sh" && bash "$D/boot.sh"`;
    if (!this.conn.hostkey) throw new StartError('a pinned SSH hostkey is required');
    const args = ['-ssh', '-batch', '-P', String(this.conn.port || 22), '-l', this.conn.user];
    if (this.conn.hostkey) args.push('-hostkey', this.conn.hostkey);
    if (this.conn.keyFile) args.push('-i', this.conn.keyFile);
    else if (this.conn.password) args.push('-pw', this.conn.password);
    args.push(this.conn.host, remoteCmd);

    const proc = spawn(this.conn.plink, args, { windowsHide: true, cwd: path.resolve(__dirname, '..') });
    children.add(proc);
    proc.once('exit', () => children.delete(proc));
    proc.once('error', () => children.delete(proc));
    this.proc = proc;
    this.session = null;
    this.stderrBuf = '';
    this.fragments = [];
    this.bufferedBytes = 0;
    this.ready = false;
    proc.stdout.on('data', (c) => { if (this.proc === proc) this._onData(c); });
    proc.stderr.on('data', (c) => {
      if (this.proc === proc) this.stderrBuf = (this.stderrBuf + c.toString('utf8')).slice(-8192);
    });
    proc.on('exit', (code, sig) => { if (this.proc === proc) this._onExit(code, sig); });
    proc.on('error', (e) => { if (this.proc === proc) {this.stderrBuf=e.message;this.killProc();} });
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
    if (this.closed || epoch !== this.epoch) throw new LostError('connection closed during handshake');
    this.ready = true;
    this.lastUsed = Date.now();
    this._startKeepalive();
    this.emit('ready');
  }

  /** EOF lets the remote controller reap its children before the SSH client exits. */
  close({idle = false} = {}) {
    this.closed = !idle;
    this.epoch++;
    this._stopKeepalive();
    const p = this.proc;
    this._failAll(new LostError('connection closed locally'));
    this.proc = null;
    this.ready = false;
    this.session = null;
    this.fragments = [];
    this.bufferedBytes = 0;
    if (!p || p.exitCode !== null || p.signalCode !== null) return this.closing || Promise.resolve();
    const closing = new Promise(resolve => {
      let timer;
      const done = () => {clearTimeout(timer);p.removeListener('exit',done);p.removeListener('error',done);resolve();};
      p.once('exit',done);p.once('error',done);
      timer = setTimeout(() => {try {p.kill();} catch {} timer=setTimeout(done,1000);timer.unref();},3000);
      timer.unref();
      try {p.stdin.end();} catch {try {p.kill();} catch {} done();}
    });
    this.closing = closing.finally(() => {if(this.closing === tracked)this.closing=null;});
    const tracked = this.closing;
    return tracked;
  }

  /** 立即杀掉连接进程（握手阶段 Ctrl+C 用） */
  abort() {
    this._abortRequested = true;
    this.killProc();
  }

  killProc() {
    this.epoch++;
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    this.fragments = [];
    this.bufferedBytes = 0;
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
    if (typeof cmd !== 'string' || Buffer.byteLength(cmd) > 2 * 1024 * 1024) throw new Error('command must be a string of at most 2 MiB');
    const signal=opts.signal;
    const cancelled = () => Object.assign(new Error('request cancelled before execution'), {aborted:true});
    if(signal?.aborted) throw cancelled();
    if(this.closed) throw new LostError('connection closed locally');
    const epoch=this.epoch;
    this.queued=(this.queued || 0)+1;
    let running=false, rejectQueued;
    const cancellation = new Promise((_,reject) => {rejectQueued=reject;});
    const queuedAbort=() => {if(!running) rejectQueued(cancelled());};
    signal?.addEventListener('abort',queuedAbort,{once:true});
    const run=this.chain.then(async () => {
      if(this.closed || epoch!==this.epoch) throw new LostError('connection closed before queued command started; command was not replayed');
      if(signal?.aborted) throw cancelled();
      running=true;
      const onAbort=() => { if (!this.ready) this.abort(); else this.interrupt(); };
      signal?.addEventListener('abort',onAbort,{once:true});
      try {
        if(opts.expectedSession && (!this.alive || this.session!==opts.expectedSession)) throw new Error('result expired after SSH disconnection');
        await this.ensure();
        if(this.closed || epoch!==this.epoch) throw new LostError('connection closed before execution');
        this.lastUsed=Date.now();
        if(signal?.aborted) throw cancelled();
        return await this._execOne(cmd,{ timeout:Math.max(1000,(Number(opts.timeout)||120)*1000),stream:!!opts.stream,onStream:opts.onStream,retained:!!opts.retained,outputBudget:opts.outputBudget,live:opts.live,onStart:opts.onStart,onOutput:opts.onOutput });
      }
      finally {this.lastUsed=Date.now();signal?.removeEventListener('abort',onAbort);}
    });
    this.chain=run.then(()=>{},()=>{});
    try {return await Promise.race([run,cancellation]);} finally {this.queued--;signal?.removeEventListener('abort',queuedAbort);}
  }

  async readResult(session, token, offset, maxBytes, {signal} = {}) {
    if (!this.alive || this.session !== session) throw new LostError('result expired after SSH disconnection; command was not replayed');
    if (!/^\/tmp\/\.srb-exec\.[A-Za-z0-9]+$/.test(session) || !/^e\d+$/.test(token)) throw new Error('invalid result reference');
    if(!Number.isSafeInteger(offset) || offset<0 || !Number.isInteger(maxBytes) || maxBytes<1 || maxBytes>65536) throw new Error('invalid result byte range');
    signal?.throwIfAborted();
    this.lastUsed=Date.now();
    return new Promise((resolve,reject)=>{
      const query='r'+ ++this.seq;
      const fail=error=>{const rec=this.pending.get(query);if(!rec)return;this.pending.delete(query);clearTimeout(rec.timer);rec.cleanup();reject(error);};
      const abort=()=>fail(new Error('result read cancelled; original task is unchanged'));
      const rec={token:query,resolve,reject,outB64:'',cwdB64:'',startedAt:Date.now(),cleanup:()=>signal?.removeEventListener('abort',abort)};
      rec.timer=setTimeout(()=>fail(new Error('result read timed out; original task may still be running')),5000);
      this.pending.set(query,rec);signal?.addEventListener('abort',abort,{once:true});
      if(!this._send(`B ${query} ${token} ${offset} ${maxBytes}`))fail(new LostError('cannot read result: SSH connection is gone'));
    });
  }

  // Completion uses the same bounded, cancellable task protocol and never overtakes a command.
  async query(qcmd, { timeout = 15000 } = {}) {
    if(this.curToken || this.queued || !this.alive) return {output:'',timedOut:false};
    try {return await this.exec('( '+qcmd+'\n)',{timeout:timeout/1000});}
    catch {return {output:'',timedOut:false,spawnFailed:true};}
  }

  _execOne(cmd, { timeout = 120000, warmup = false, stream = false, onStream = null, retained = false, outputBudget = MAX_OUTPUT, live = false, onStart, onOutput } = {}) {
    timeout=Math.ceil(timeout);
    if(!Number.isFinite(timeout) || timeout<1 || timeout>86400000)throw new Error('invalid execution timeout');
    const token = (warmup ? 'w' : 'e') + ++this.seq;
    return new Promise((resolve, reject) => {
      const rec = {
        token,
        resolve,
        reject,
        outB64: '',
        tailB64: '',
        retained,
        onStart,
        onOutput,
        outputBytes: 0,
        streamChunks: [],
        streamBytes: 0,
        cwdB64: '',
        decoder: new StringDecoder('utf8'),
        truncated: false,
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
      const op = retained ? live ? 'J' : 'E' : stream ? 'F' : 'C';
      const line = `${sendts}|${op} ${token} ${retained ? Math.min(8388616,Math.max(1,Math.ceil(outputBudget)))+' ' : ''}${Buffer.from(cmd, 'utf8').toString('base64')} ${timeout}`;
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
    if (!rec.grace) rec.grace = setTimeout(() => this.killProc(), INTERRUPT_GRACE_MS);
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
    clearTimeout(rec.grace);
    rec.grace = setTimeout(() => {
      if (!this.pending.has(token)) return;
      this.pending.delete(token);
      if (this.curToken === token) this.curToken = null;
      const output = this._output(rec).output;
      this.killProc();
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
    let start=0;
    while(start<chunk.length) {
      const end=chunk.indexOf(0x0a,start),part=chunk.subarray(start,end<0?chunk.length:end);
      this.bufferedBytes+=part.length;
      if(this.bufferedBytes>MAX_OUTPUT*2){this.killProc();return;}
      if(end<0){this.fragments.push(part);return;}
      const line=this.fragments.length?Buffer.concat([...this.fragments,part],this.bufferedBytes):part;
      this.fragments=[];this.bufferedBytes=0;
      this._onLine(line.toString('utf8').replace(/\r$/,''));
      if(!this.proc)return;
      start=end+1;
    }
  }

  _onLine(line) {
    const m = /^([TODPSLHAZVU]) (\S+)(?: (.*))?$/.exec(line);
    if (!m) return; // 远端启动噪音（banner 等）
    const type = m[1];
    const token = m[2];
    const rest = m[3] || '';
    if(type === 'H') {this.session=Buffer.from(rest,'base64').toString('utf8');return;}
    const rec = this.pending.get(token);
    if (!rec) return; // 迟到帧（超时后已被丢弃）
    if(type==='U') {rec.timedOut=true;rec.interruptSent=true;return;}
    if(type==='T') {try{rec.onStart?.({session:this.session,token});}catch{} return;}
    if(type==='V') {if(!/^\d+$/.test(rest) || Number(rest)>MAX_OUTPUT) {this.killProc();return;}rec.outputBytes=Number(rest);try{rec.onOutput?.(rec.outputBytes,!!rec.truncated);}catch{} return;}
    if (type === 'A') {rec.outputBytes=Number(rest);return;}
    if (type === 'Z') {if(rest.length>Math.ceil(MAX_OUTPUT/3)*4) {this.killProc();return;} rec.tailB64=rest;return;}
    if (type === 'L') { rec.truncated = true;try{rec.onOutput?.(rec.outputBytes,true);}catch{} return; }
    if (type === 'P') {
      rec.cwdB64 = rest;
      return;
    }
    if (type === 'S') {
      // 流式增量: 立刻回调给调用方（不等 D 帧）
      let text = '';
      try {
        const bytes=Buffer.from(rest,'base64');
        rec.streamChunks.push(bytes); rec.streamBytes+=bytes.length;
        while(rec.streamBytes>MAX_OUTPUT && rec.streamChunks.length) {
          const excess=rec.streamBytes-MAX_OUTPUT, first=rec.streamChunks[0];
          if(first.length<=excess) {rec.streamBytes-=first.length;rec.streamChunks.shift();}
          else {rec.streamChunks[0]=first.subarray(excess);rec.streamBytes-=excess;}
          rec.truncated=true;
        }
        text = rec.decoder.write(bytes);
      } catch (_) {
        return;
      }
      if (text) {
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
      if (rec.outB64.length + rest.length > Math.ceil(MAX_OUTPUT/3)*4) { this.killProc(); return; }
      rec.outB64 += rest;
      return;
    }
    if (type === 'D') {
      if (rec.done) return;
      if (!/^\d{1,3}$/.test(rest) || Number(rest) > 255) { this.killProc(); return; }
      if (rec.stream && rec.decoder) { const tail=rec.decoder.end(); if(tail && rec.onStream) {try {rec.onStream(tail);} catch {}} }
      rec.done = true;
      clearTimeout(rec.timer);
      clearTimeout(rec.grace);
      rec.cleanup?.();
      this.pending.delete(token);
      if (this.curToken === token) this.curToken = null;
      // 流式模式: 以S 帧累计的文本为准。远端 srb_done 会先补发尾巴再发 O,
      // 所以 rec.streamed 已是完整输出; O 帧是同一份内容的重复, 用它会打印两遍。
      const {output,outputTail}=this._output(rec);
      rec.resolve({
        exitCode: Number(rest),
        truncated: !!rec.truncated,
        output,
        outputTail,
        outputBytes: rec.outputBytes,
        resultRef: rec.retained && this.session ? {session:this.session,token} : null,
        cwd: rec.cwdB64 ? Buffer.from(rec.cwdB64, 'base64').toString('utf8') : null,
        timedOut: !!rec.timedOut,
        interrupted: !!rec.interruptSent,
        duration: (Date.now() - rec.startedAt) / 1000,
        error: rec.timedOut ? `timed out after ${Math.round((Date.now() - rec.startedAt) / 1000)}s` : null,
      });
    }
  }

  _output(rec) {
    const clean=(b,tail=false) => {
      if(tail) {let i=0;while(i<b.length && (b[i]&0xc0)===0x80)i++;b=b.subarray(i);}
      return scrubTmpPaths(new StringDecoder('utf8').write(b));
    };
    return {output:rec.stream ? clean(Buffer.concat(rec.streamChunks || []),true) : clean(Buffer.from(rec.outB64 || '','base64')),
      outputTail:rec.tailB64 ? clean(Buffer.from(rec.tailB64,'base64'),true) : null};
  }

  _failAll(err) {
    for (const [token, rec] of [...this.pending]) {
      clearTimeout(rec.timer);
      clearTimeout(rec.grace);
      rec.cleanup?.();
      this.pending.delete(token);
      if (this.curToken === token) this.curToken = null;
      rec.reject(err);
    }
  }

  _onExit(code, sig) {
    const wasAlive = this.ready || this.pending.size > 0;
    this.epoch++;
    this.proc = null;
    this.ready = false;
    this.fragments=[];this.bufferedBytes=0;
    this._stopKeepalive();
    const tail = this.stderrBuf ? ` | plink: ${this.stderrBuf.trim().split('\n').slice(-2).join(' / ')}` : '';
    const err = new LostError(`plink exited (code=${code} signal=${sig})${tail}`);
    this._failAll(err);
    if (wasAlive) this.emit('drop', err);
  }

  // ---------------------------------------------------------------- 保活

  _startKeepalive() {
    this._stopKeepalive();
    this.keepalive = setInterval(() => {
      if (!this.alive || this.curToken || this.pending.size > 0 || this.queued) return;
      if(!this.keepOpen && Date.now()-this.lastUsed>=IDLE_MS) {void this.close({idle:true});return;}
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
      if(!this._send(`N ${token}`)) this._onExit(null,'keepalive-write-failed');
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
  for (const p of children) {
    if (p && p.exitCode === null) {
      try {
        p.kill();
      } catch (_) {}
    }
  }
});
