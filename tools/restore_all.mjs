#!/usr/bin/env node
/**
 * tools/restore_all.mjs — 一键恢复所有服务器的文件映射（重启后跑这个）
 *
 * 为什么需要它:
 *   重启后符号链接 F:\xxx -> M:\ 还在（符号链接存在磁盘上），但它指向的
 *   盘符映射 M: 没恢复 → 点开就是"路径不存在"。
 *   net use /persistent:yes 只保证"尝试恢复"，登录时网络没就绪就静默失败。
 *
 * 行为:
 *   遍历 servers.json 里所有配了 drive 的服务器, 逐个重新挂载。
 *   - 已挂载的跳过（幂等, 可以随便重复跑）
 *   - 某台失败不中断其余, 最后统一报告
 *
 * 用法:
 *   node tools/restore_all.mjs            # 恢复全部
 *   node tools/restore_all.mjs --check    # 只检查不改动, 看哪些断了
 *
 * ⚠️ 从 cmd.exe 直接跑本脚本会看到一屏 '????' ——
 *    Windows 控制台默认 GBK(cp936) 而 Node 写的是 UTF-8 字节, 是**控制台解码**坏了。
 *    process.stdout.setDefaultEncoding('utf8') 修不了（那个只管读流），
 *    唯一有效解是先把控制台切到 UTF-8：请走 remount_all.cmd（它会 chcp 65001 并在结束时还原），
 *    或手动先执行 chcp 65001。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../lib/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

function ok(s) {
  return `\x1b[32m${s}\x1b[0m`;
}
function bad(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function warn(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

let cfg;
try {
  cfg = engine.loadConfig();
} catch (e) {
  console.error(bad(`[restore] 读不到 servers.json: ${e.message}`));
  process.exit(1);
}

const names = Object.keys(cfg.servers);
if (!names.length) {
  console.error(bad('[restore] servers.json 里没有服务器'));
  process.exit(1);
}

console.log(`\n[restore] 共${names.length} 台服务器${CHECK_ONLY ? '（检查模式, 不会改动任何东西）' : ''}`);
console.log('='.repeat(64));

/* ---------------------------------------------------------------- 盘符冲突检测
 * 新增服务器时最容易忘的一件事: 每台要用**不同**的盘符。
 * 两台共用M: 会互相顶掉(第二个 net use 会把第一个踢掉), 症状是
 * "A 服务器的文件夹突然变成B 服务器的内容" —— 极难排查。
 * 所以在动手之前先把重复的挑出来。
 */
const driveOwners = new Map(); // drive -> [serverName]
for (const name of names) {
  const d = (engine.getServer(name).drive || '').toUpperCase();
  if (!d) continue;
  if (!driveOwners.has(d)) driveOwners.set(d, []);
  driveOwners.get(d).push(name);
}
const dupDrives = [...driveOwners.entries()].filter(([, v]) => v.length > 1);
if (dupDrives.length) {
  // 为每台冲突的服务器推荐一个**当前没被占用**的盘符。
  // 注意要对字母本身 +1(不能对 "M:" 整体 +1, 那样会算出不可见控制字符)。
  const taken = new Set(driveOwners.keys());
  const suggest = (from) => {
    const base = from.charCodeAt(0); // 只取第一个字母
    for (let i = 1; i <= 24; i++) {
      const cand = `${String.fromCharCode(base + i)}:`;
      if (!taken.has(cand)) { taken.add(cand); return cand; }
    }
    return '??:';
  };
  console.log('');
  console.log(bad('!!! 盘符冲突：多台服务器配了同一个盘符 !!!'));
  for (const [d, owners] of dupDrives) {
    console.log(bad(`  ${d}  ←  ${owners.join('  和  ')}`));
  }
  console.log(bad('  后果: 挂第二台会把第一台踢掉, 文件夹内容会"变成"另一台服务器。'));
  console.log(warn('  修法: 编辑 servers.json, 给每台一个不同的盘符, 例如'));
  for (const [, owners] of dupDrives) {
    owners.forEach((n, i) => {
      const cur = engine.getServer(n).drive.toUpperCase();
      // 第一台保持原盘符（先到先得），后面几台换新的
      const tip = i === 0 ? '保持不变（第一台优先）' : `改成  "${suggest(cur)}"`;
      console.log(warn(`         ${n}: drive "${cur}"  ->  ${tip}`));
    });
  }
  console.log(warn('         然后重新运行 remount_all.cmd。'));
  console.log(bad('  本次继续执行，但冲突的盘符只能挂上最后那一台。'));
  console.log('');
}

const done = [];
const broken = [];
const skipped = [];
let symlinkWarned = false;
const wantSymlink = []; // 盘符挂上了但符号链接没建成的服务器

for (const name of names) {
  const srv = engine.getServer(name);

  // 没配盘符 = 只想用命令行/AI, 不需要文件映射
  if (!srv.drive) {
    skipped.push({ name, why: '未配置 drive（只用命令行/AI，无需文件映射）' });
    console.log(`  -  ${name.padEnd(12)} ${warn('跳过')} 未配置 drive`);
    continue;
  }

  const driveLive = engine.driveMounted(srv.drive);
  const mountLive = engine.mountOk(srv.mount);
  const allLive = driveLive && (!srv.mount || mountLive);

  if (allLive) {
    skipped.push({ name, why: `已正常（${srv.drive} 已挂载${srv.mount ? `, ${srv.mount} 可读` : ''}）` });
    console.log(`  =  ${name.padEnd(12)} ${ok('正常')} ${srv.drive}${srv.mount ? ` + ${srv.mount}` : '  (只用盘符，无需符号链接)'}`);
    continue;
  }

  // 有问题, 报告具体坏在哪一环
  const why = [];
  if (!driveLive) why.push(`盘符 ${srv.drive} 未挂载`);
  if (srv.mount && !mountLive) why.push(`${srv.mount} 打不开（符号链接指向失效的 ${srv.drive}）`);

  if (CHECK_ONLY) {
    broken.push({ name, why: why.join('; ') });
    console.log(`  !  ${name.padEnd(12)} ${bad('断了')} ${why.join('; ')}`);
    continue;
  }

  console.log(`  -> ${name.padEnd(12)} 重新挂载 ${srv.drive} ...`);
  let r;
  try {
    r = engine.mountServer(srv);
  } catch (e) {
    broken.push({ name, why: why.join('; ') + `; 挂载抛错: ${e.message}` });
    console.log(`     ${bad('失败')} ${e.message}`);
    continue;
  }

  if (r.ok && !r.warning) {
    done.push(name);
    console.log(`     ${ok('恢复成功')}`);
  } else if (r.ok && r.warning) {
    // 盘符挂上了但符号链接没成 -> 能用, 只是路径要走盘符
    done.push(name);
    symlinkWarned = true;
    if (srv.drive) wantSymlink.push(`${srv.drive}\\`);
    console.log(`     ${warn('盘符已挂载, 但符号链接有问题')} ${r.warning}`);
    console.log(`     ${warn(`可以直接用 ${srv.drive}\\ 访问`)}`);
  } else {
    broken.push({ name, why: why.join('; ') + `; ${r.error || '未知错误'}` });
    console.log(`     ${bad('失败')} ${r.error || ''}`);
    for (const s of r.steps || []) console.log(`       · ${s}`);
  }
}

console.log('='.repeat(64));

/* ---------------------------------------------------------------- 权限诊断
 * 符号链接（mklink /D）在非管理员上下文需要「开发者模式」或管理员权限。
 * 这是「重启后文件夹打不开」的最常见根因, 必须明确告诉用户怎么修,
 * 否则用户只会看到 "找不到路径" 却不知道该做什么。
 */
function symlinkCapability() {
  // 查开发者模式开关。注意: 不用 reg.exe（受限环境/沙箱里常被拦）,
  // 改用 PowerShell 的 Get-ItemProperty, 没有 PowerShell 就当查不到。
  let devMode = false;
  let checked = false;
  for (const probe of [
    ['-NoProfile', '-NonInteractive', '-Command',
     "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense"],
  ]) {
    try {
      const r = engine.runCapture('powershell.exe', probe, { timeoutMs: 20000 });
      checked = true;
      if (r.status === 0 && /1/.test(r.stdout || '')) devMode = true;
    } catch (_) {}
    break;
  }
  if (devMode) return { ok: true, how: '开发者模式已开启' };
  return {
    ok: false,
    unknown: !checked,
    how:
      '需要二选一：\n' +
      '     ① 设置 → 系统 → 可选功能 → 「开发者模式」打开（一次性，永久生效，推荐）\n' +
      '     ② 或者「以管理员身份运行」本脚本（每次都要，不推荐）',
  };
}

function reportSymlinkProblem() {
  const cap = symlinkCapability();
  console.log('');
  if (!cap.ok) {
    console.log(bad('=== 符号链接没建成 —— 这就是「重启后文件夹打不开」的根因 ==='));
    if (cap.unknown) {
      console.log(warn('   （没能自动检测开发者模式状态，但你大概率没开）'));
    }
    console.log(`   ${cap.how}`);
    console.log('');
    console.log(warn('   临时办法：直接用盘符访问，文件完全一样:'));
    for (const d of wantSymlink) console.log(warn(`     ${d}`));
    console.log('');
    console.log(warn('   权限修好后重新运行本脚本，文件夹路径就恢复了。'));
  } else {
    console.log(warn('=== 符号链接没建成，但开发者模式是开着的 ==='));
    console.log(warn('   多半是当前终端不是管理员。请「以管理员身份运行」本脚本。'));
    for (const d of wantSymlink) console.log(warn(`   临时可用: ${d}`));
  }
  console.log('');
}

if (CHECK_ONLY) {
  if (broken.length) {
    // 盘符活着但文件夹路径不通 = 符号链接问题, 得单独说清楚
    const symlinkBroken = broken.filter((b) => /符号链接指向失效/.test(b.why) && !/盘符 \w: 未挂载/.test(b.why));
    const driveBroken = broken.filter((b) => /盘符 \w: 未挂载/.test(b.why));
    console.log(`\n${bad(`发现 ${broken.length} 处断开:`)}`);
    for (const b of broken) console.log(`  · ${b.name}: ${b.why}`);
    if (driveBroken.length) {
      console.log(`\n  其中 ${driveBroken.length} 台是盘符没挂上 —— 跑恢复脚本即可`);
    }
    if (symlinkBroken.length) {
      for (const b of symlinkBroken) {
        const s = engine.getServer(b.name);
        wantSymlink.push(`${s.drive}\\`);
      }
      reportSymlinkProblem();
    }
    console.log(`${ok('修复命令:')} node tools/restore_all.mjs   （不带 --check）`);
  } else {
    console.log(`\n${ok('全部正常，无需恢复。')}`);
  }
  process.exit(0);
}

const parts = [];
if (done.length) parts.push(ok(`已恢复 ${done.length} 台: ${done.join(', ')}`));
if (skipped.length) parts.push(`跳过 ${skipped.length} 台（${skipped.map((s) => s.why.includes('未配置 drive') ? '无盘符' : '已正常').join(' / ')}）`);
console.log('\n' + parts.join('\n'));

if (symlinkWarned) reportSymlinkProblem();

if (broken.length) {
  console.log(`\n${bad(`失败 ${broken.length} 台:`)}`);
  for (const b of broken) console.log(`  · ${b.name}: ${b.why}`);
  console.log(`\n常见原因:`);
  console.log(`  · net use 报错误 67/87 → SSHFS-Win 只支持盘符映射（正常，走的是符号链接路线）`);
  console.log(`  · 提示密码无效 → SSHFS-Win 不读 Windows 凭据管理器，必须密码内联（ssh-remote setup 已处理）`);
  console.log(`  · mklink 拒绝访问 → 开「设置 → 系统 → 可选功能 → 开发者模式」，或管理员运行`);
  console.log(`  · 找不到驱动器 → WinFsp/SSHFS-Win 没装或掉了，跑一次 install_deps.cmd`);
  process.exit(1);
}

console.log(ok('\n全部恢复完成。'));