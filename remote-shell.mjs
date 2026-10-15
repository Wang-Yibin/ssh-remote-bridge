#!/usr/bin/env node
/**
 * remote-shell.mjs — ssh-remote CLI (多服务器)
 *
 * 用法:
 *   ssh-remote                      交互 shell (默认服务器)
 *   ssh-remote <profile>            交互 shell (指定服务器, 如 ssh-remote 5090)
 *   ssh-remote list                 列出所有服务器及挂载状态
 *   ssh-remote setup [profile]      挂载: net use 盘符(持久化) + 符号链接
 *   ssh-remote umount [profile]     卸载盘符映射
 *   ssh-remote exec <profile> <cmd...>   单条命令执行后退出
 *   ssh-remote rclone [profile]    备用挂载: rclone 挂到盘符 (SSHFS-Win 路线失败时用)
 *   ssh-remote help                 帮助
 *
 * 交互 shell 内:
 *   exit | quit | Ctrl+D  退出（断开长连接）
 *   Ctrl+C                中断正在运行的远程命令（不退出）; 空闲时清空输入行
 *   raw <cmd>             全屏交互模式 (plink -t 直连), 适用于 vim/htop/top/watch
 *   ! <cmd>               同 raw
 *   help | ?              帮助
 *   其余命令              经长连接送到服务器执行（cd/export 状态跨命令保持）
 */
import * as readline from 'node:readline';
import * as engine from './lib/engine.mjs';

const SUBCOMMANDS = ['setup', 'umount', 'list', 'exec', 'rclone', 'help'];

function printHelp(srv) {
  console.log([
    'ssh-remote - remote forwarding shell (multi-server)',
    '',
    'usage:',
    '  ssh-remote                          interactive shell (default server)',
    '  ssh-remote <profile>                interactive shell for one server',
    '  ssh-remote list                     list servers + mount status',
    '  ssh-remote setup [profile]          mount: net use drive letter',
    '  ssh-remote umount [profile]         remove the drive mapping',
    '  ssh-remote exec <profile> <cmd...>  run one command and exit',
    '  ssh-remote rclone [profile]         fallback mount via rclone',
    '  ssh-remote help                     this help',
    '',
    'inside the shell:',
    '  exit | quit | Ctrl+D    leave (closes the persistent channel)',
    '  Ctrl+C                  interrupt the running remote command (does NOT exit);',
    '                          when idle, clears the input line',
    '  raw <cmd>               full-screen passthrough (plink -t), for vim/htop/top',
    '  ! <cmd>                 same as raw',
    '  help | ?                help',
    '  anything else           runs on the server over the persistent channel',
    '                          (cd / export state persists between commands)',
    '',
    `config: ${engine.CONFIG_PATH}`,
    srv ? `default server: ${srv.name} (${srv.user}@${srv.host})` : '',
  ].filter(Boolean).join('\n'));
}

function printServerList() {
  const servers = engine.listServers();
  console.log('configured servers:');
  for (const s of servers) {
    const dm = engine.driveMounted(s.drive) ? 'mounted' : 'NOT mounted';
    const mo = engine.mountOk(s.mount) ? 'ok' : 'no';
    console.log(
      `  ${s.name.padEnd(12)} ${s.user}@${s.host}:${s.port}  drive=${String(s.drive).padEnd(4)} ${dm}  mount=${s.mount || '-'} ${mo}${s.default ? '  [default]' : ''}`
    );
    if (s.note) console.log(`               note: ${s.note}`);
  }
}

function doSetup(profile) {
  const srv = engine.getServer(profile);
  console.log(`[ssh-remote] mounting ${srv.name}: ${srv.user}@${srv.host}:${srv.remote} -> ${srv.mount} (drive ${srv.drive})`);
  const r = engine.mountServer(srv);
  r.steps.forEach((s) => console.log('  ' + s));
  if (!r.ok) {
    console.error(`[ssh-remote] mount FAILED: ${r.error}`);
    process.exit(1);
  }
  if (r.warning) console.log(`[ssh-remote] WARNING: ${r.warning}`);
  console.log(`[ssh-remote] done. ${srv.mount} is now the server's ${srv.remote}`);
}

function doUmount(profile) {
  const srv = engine.getServer(profile);
  console.log(`[ssh-remote] unmounting ${srv.name} (drive ${srv.drive})`);
  const r = engine.umountServer(srv);
  r.steps.forEach((s) => console.log('  ' + s));
  // mount 可能没配（只用盘符模式）——措辞要跟着变, 别打印 "symlink null"
  const tail = srv.mount
    ? `symlink ${srv.mount} kept; run "ssh-remote setup ${srv.name}" to restore.`
    : `run "ssh-remote setup ${srv.name}" (or remount_all.cmd) to restore the drive.`;
  console.log(`[ssh-remote] done. ${tail}`);
}

async function doExec(profile, cmd) {
  const srv = engine.getServer(profile);
  const r = await engine.execOnSmart(srv, cmd, { timeout: 300 });
  if (r.output && r.output.trim()) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n');
  engine.closeAllPersist();
  if (r.spawnFailed) {
    console.error(`[ssh-remote] channel error: ${r.error}`);
    process.exit(2);
  }
  process.exit(r.exitCode === null ? 3 : r.exitCode);
}

/** 备用挂载: rclone mount 到盘符 (符号链接自动指过来) */
function doRclone(profile) {
  const srv = engine.getServer(profile);
  if (!srv.drive) {
    console.error(`[ssh-remote] server "${srv.name}" has no "drive" configured in servers.json`);
    process.exit(1);
  }
  const exe = engine.rcloneExePath();
  if (!require('node:fs').existsSync(exe)) {
    console.error(`[ssh-remote] rclone.exe not found at ${exe} (this package should ship rclone\\rclone.exe)`);
    process.exit(1);
  }
  // 先摘掉可能占用盘符的 SSHFS-Win 映射
  engine.umountServer(srv);
  const conf = engine.buildRcloneConf(srv);
  console.log(`[ssh-remote] rclone mount ${srv.name}:/${srv.remote} -> ${srv.drive}`);
  console.log('[ssh-remote] keep this window open to stay mounted; close it or Ctrl+C to unmount');
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(
    exe,
    ['mount', '--config', conf, `${srv.name}:/${srv.remote}`, srv.drive, '--network-mode', '--vfs-cache-mode', 'writes', '--dir-cache-time', '30s'],
    { stdio: 'inherit', windowsHide: false }
  );
  try {
    require('node:fs').unlinkSync(conf);
  } catch (_) {}
  if (r.status && r.status !== 0) console.log(`[ssh-remote] rclone exited with code ${r.status}`);
}

function runRaw(srv, cmd) {
  if (!cmd) return;
  console.log(`[ssh-remote] raw full-screen mode: ${cmd}`);
  const cfg = engine.loadConfig();
  const { spawnSync } = require('node:child_process');
  const args = ['-ssh', '-batch', '-P', String(srv.port), '-l', srv.user, '-t'];
  if (srv.hostkey) args.push('-hostkey', srv.hostkey);
  if (srv.keyFile) args.push('-i', srv.keyFile);
  else if (srv.password) args.push('-pw', srv.password);
  args.push(srv.host, cmd);
  const r = spawnSync(engine.plinkPath(cfg), args, { stdio: 'inherit', windowsHide: false });
  if (r.status && r.status !== 0) console.log(`[ssh-remote] raw exit code ${r.status}`);
}

/** 命令结果汇报: 快命令（<1s）不打印 done 行, 保持 shell 干净; 异常一定可见 */
function reportResult(res) {
  if (res.output && res.output.trim()) {
    process.stdout.write(res.output.endsWith('\n') ? res.output : res.output + '\n');
  }
  if (res.aborted) {
    console.log('[ssh-remote] aborted');
  } else if (res.interrupted) {
    console.log(`[ssh-remote] interrupted (exit ${res.exitCode}) - ${res.duration}s`);
  } else if (res.spawnFailed) {
    console.log(`[ssh-remote] channel error: ${res.error}`);
  } else if (res.done) {
    const slow = res.duration >= 1 ? ` - ${res.duration}s` : '';
    if (res.exitCode !== null && res.exitCode !== 0) console.log(`[ssh-remote] exit ${res.exitCode}${slow}`);
    else if (slow) console.log(`[ssh-remote] done${slow}`);
  } else if (res.timedOut) {
    console.log('[ssh-remote] connection timed out; command may still be running on the server');
  } else {
    console.log('[ssh-remote] sentinel timeout; command may still be running on the server');
  }
}

async function runShell(srv) {
  let rex = null; // 长连接执行器（persist 通道）
  let transport = engine.persistEnabled() ? 'persist' : 'tmux';
  let busy = false; // 是否有远程命令在跑（SIGINT 分流用）
  let closed = false;
  let working = false;
  let readyPromise = null; // 建连完成前, 命令只在队列里排着
  const queue = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });

  const finish = () => {
    if (closed && !working && queue.length === 0) {
      if (rex) rex.close();
      process.exit(0);
    }
  };

  async function runRemote(line) {
    if (transport === 'persist' && rex) {
      const res = await engine.execOnPersist(srv, line, { timeout: 86400 });
      if (res.lost) {
        // 断线: 不重跑命令, 下一条自动重连
        console.log(`[ssh-remote] connection lost (${res.error}); reconnecting on next command`);
        return;
      }
      reportResult(res);
      return;
    }
    reportResult(engine.execOn(srv, line));
  }

  async function drain() {
    if (working) return;
    working = true;
    // 建连/回落完成前不执行命令（管道喂入时连接期间到达的行会在这里等）
    if (readyPromise) {
      try {
        await readyPromise;
      } catch (_) {}
    }
    while (queue.length) {
      const raw = queue.shift();
      const line = raw.trim();
      try {
        if (!line) {
          /* empty */
        } else if (line === 'exit' || line === 'quit') {
          queue.length = 0;
          if (rex) rex.close();
          rl.close();
          break;
        } else if (line === 'help' || line === '?') {
          printHelp(srv);
        } else if (line.startsWith('raw ')) {
          runRaw(srv, line.slice(4).trim());
        } else if (line.startsWith('!')) {
          runRaw(srv, line.slice(1).trim());
        } else {
          busy = true;
          try {
            await runRemote(line);
          } finally {
            busy = false;
          }
        }
      } catch (e) {
        console.log(`[ssh-remote] local error: ${e.message}`);
      }
      // 一条命令的输出打印完毕, 重画一次提示符。
      // 注意: 必须 preserveCursor=true — rl.prompt() 默认会把光标重置到行首,
      // 若用定时器轮询重画, 用户打字时光标会被反复拽回行首(光标飞速左移, 无法输入)。
      if (!closed) rl.prompt(true);
    }
    working = false;
    finish();
  }

  // 注意: 处理器必须在任何 await 之前注册 — 连接要 5.6s,
  // 这期间到达的输入行（尤其是管道喂入）必须进队列, 不能被 readline 丢弃。
  rl.on('line', (l) => {
    queue.push(l);
    drain();
  });
  rl.on('close', () => {
    closed = true;
    finish();
  });
  // Ctrl+C: 任务在跑 -> 中断; 正在握手 -> 掐掉连接尝试; 空闲 -> 清行重提示
  rl.on('SIGINT', () => {
    if (rex && busy && rex.interrupt()) {
      process.stdout.write('^C\n');
      return;
    }
    if (rex && rex.starting) {
      process.stdout.write('^C (aborting connection)\n');
      rex.abort();
      return;
    }
    try {
      rl.write(null, { ctrl: true, name: 'u' }); // 清空当前输入行
    } catch (_) {}
    process.stdout.write('\n');
    rl.prompt(true);
  });

  // ---- 建连（首次 ~5.6s: 服务器侧 SSH 握手成本, 之后每条命令 ms 级）----
  readyPromise = (async () => {
    if (transport === 'persist') {
      console.log('------------------------------------------------------------');
      console.log(' ssh-remote - remote forwarding shell');
      console.log(` server: ${srv.name} ${srv.user}@${srv.host}`);
      process.stdout.write(' channel: connecting (first connect takes ~5s, then ms-level) ...');
      try {
        rex = engine.getExecFor(srv);
        await rex.ensure();
        console.log(' ok');
      } catch (e) {
        console.log(' FAILED');
        if (e && e.aborted) {
          console.log('[ssh-remote] connect aborted');
          process.exit(130);
        }
        console.log(`[ssh-remote] fast channel unavailable: ${e.message}`);
        console.log('[ssh-remote] falling back to the classic tmux channel (~10s per command)');
        engine.markPersistBroken();
        transport = 'tmux';
        rex = null;
      }
    } else {
      engine.ensureSession(srv);
    }

    // ---- 初始 cwd 同步（本地在挂载树下 -> 远程 cd 到对应目录, 之后状态保持）----
    const rcwd = engine.localToRemote(srv, process.cwd());
    let syncInfo = '(local cwd not under mount tree; starting at remote home)';
    if (rcwd) {
      const cdCmd = `cd '${rcwd.replace(/'/g, "'\\''")}'`;
      if (transport === 'persist') {
        const res = await engine.execOnPersist(srv, cdCmd, { timeout: 60 });
        syncInfo = res.done && res.exitCode === 0 ? rcwd : `sync failed: ${res.error || res.output || 'unknown'}`;
      } else {
        const res = engine.execOn(srv, cdCmd, { timeout: 20 });
        syncInfo = res.done ? rcwd : `sync failed: ${res.error || 'unknown'}`;
      }
    }

    console.log('------------------------------------------------------------');
    console.log(` ssh-remote - remote forwarding shell`);
    console.log(` server: ${srv.name} ${srv.user}@${srv.host}  channel: ${transport === 'persist' ? 'persistent SSH (ms-level)' : 'tmux (fallback)'}`);
    console.log(` remote cwd: ${syncInfo}`);
    console.log(' exit/Ctrl+D to leave - Ctrl+C interrupts the running command - raw <cmd> full-screen - help for help');
    console.log('------------------------------------------------------------');
  })();

  rl.setPrompt('ssh-remote> ');
  await readyPromise;
  rl.prompt();
}

// ---------------------------------------------------------------- 入口

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === 'help' || first === '--help' || first === '-h') {
    printHelp(null);
    return;
  }
  if (first === 'list') {
    printServerList();
    return;
  }
  if (first === 'setup') {
    doSetup(argv[1]);
    return;
  }
  if (first === 'umount' || first === 'unmount') {
    doUmount(argv[1]);
    return;
  }
  if (first === 'exec') {
    const profile = argv[1];
    const cmd = argv.slice(2).join(' ');
    if (!cmd) {
      console.error('usage: ssh-remote exec <profile> <command...>');
      process.exit(1);
    }
    await doExec(profile, cmd);
    return;
  }
  if (first === 'rclone') {
    doRclone(argv[1]);
    return;
  }

  // 交互 shell: ssh-remote [profile] [--timeout N]
  let profile = null;
  for (const a of argv) {
    if (a === '--timeout') continue;
    if (/^\d+$/.test(a) && argv[argv.indexOf(a) - 1] === '--timeout') continue;
    if (!a.startsWith('-')) profile = profile || a;
  }
  let srv;
  try {
    srv = engine.getServer(profile);
  } catch (e) {
    console.error(`[ssh-remote] ${e.message}`);
    console.error('[ssh-remote] run "ssh-remote list" to see configured servers, or "ssh-remote help"');
    process.exit(1);
  }
  await runShell(srv);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('remote-shell.mjs')) {
  main().catch((e) => {
    console.error(`[ssh-remote] fatal: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
