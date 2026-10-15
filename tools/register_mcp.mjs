#!/usr/bin/env node
/**
 * tools/register_mcp.mjs — 把 ssh-remote-bridge 注册进 ~/.workbuddy/mcp.json
 *
 * - 自动合并: 保留已有的其他 MCP 条目 (如 rea), 只增/改 ssh-remote-bridge
 * - 路径用本包的绝对路径 (runtime/node.exe + mcp/server.mjs)
 * - 原文件不是合法 JSON 时先备份为 .bak 再重建
 *
 * 由 register_mcp.cmd 调用, 也可以手动:
 *   runtime\node.exe tools\register_mcp.mjs
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_MJS = path.join(ROOT, 'mcp', 'server.mjs');
const CFG = path.join(os.homedir(), '.workbuddy', 'mcp.json');

// ---- node 解释器定位: 包内自带优先, 否则用系统 PATH 上的 ----
// 自包含发行版带 runtime\node.exe, 免安装; 源码 clone 则用系统 Node (>=18)。
function pickNode() {
  const bundled = path.join(ROOT, 'runtime', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which',
    ['node'], { encoding: 'utf8', shell: false });
  const first = (r.stdout || '').split(/\r?\n/).find((s) => s.trim().endsWith('node.exe') || s.trim() === 'node');
  if (first && first.trim()) return first.trim();
  return null; // 交由下面的报错处理
}

const NODE_EXE = pickNode();

// ---- 自检: 必要文件 + 可用的 node ----
if (!fs.existsSync(SERVER_MJS)) {
  console.error(`[register] missing ${SERVER_MJS}`);
  console.error('[register] mcp\\server.mjs not found - is this the right directory?');
  process.exit(1);
}
if (!NODE_EXE) {
  console.error('[register] node.exe not found.');
  console.error('[register] Either keep runtime\\ next to this file (the self-contained release does),');
  console.error('[register] or install Node.js 18+ from https://nodejs.org and reopen the terminal.');
  process.exit(1);
}

// ---- 读现有配置 (保留其他条目) ----
let cfg = null;
if (fs.existsSync(CFG)) {
  try {
    cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    if (!cfg || typeof cfg !== 'object') cfg = null;
  } catch (e) {
    const bak = `${CFG}.bak`;
    fs.copyFileSync(CFG, bak);
    console.log(`[register] existing mcp.json is not valid JSON - backed up to ${bak}`);
    cfg = null;
  }
}
if (!cfg) cfg = {};
if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};

const before = Object.keys(cfg.mcpServers);
cfg.mcpServers['ssh-remote-bridge'] = {
  command: NODE_EXE,
  args: [SERVER_MJS],
};

// ---- 写回 ----
try {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error(`[register] cannot write ${CFG}: ${e.message}`);
  process.exit(1);
}

console.log(`[register] OK - ssh-remote-bridge written to:`);
console.log(`  ${CFG}`);
console.log(`[register] entry: ${NODE_EXE} ${SERVER_MJS}`);
console.log(`[register] MCP servers now configured: ${Object.keys(cfg.mcpServers).join(', ')}`);
if (before.length && !before.includes('ssh-remote-bridge')) {
  console.log(`[register] preserved existing entries: ${before.join(', ')}`);
} else if (before.includes('ssh-remote-bridge')) {
  console.log('[register] ssh-remote-bridge entry updated (was already present)');
}
console.log('');
console.log('[register] FINAL STEP: open the connector page in WorkBuddy,');
console.log('[register] find ssh-remote-bridge, and click "Trust". Then it is live.');
