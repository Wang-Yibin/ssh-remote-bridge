#!/usr/bin/env node
/**
 * tools/register_mcp_codex.mjs — 把 ssh-remote-bridge 注册进 Codex (~/.codex/config.toml)
 *
 * 为什么不手写 TOML 片段: TOML 里反斜杠和引号的转义规则很容易写错,
 * 而 codex 有官方 CLI (`codex mcp add`), 格式最稳。
 * 所以策略是:
 *   1) codex 在 PATH 上  -> 直接调 `codex mcp add`（推荐, 最稳）
 *   2) 没有 CLI          -> 兜底直接改 config.toml（用 TOML 字符串字面量,
 *                           单引号形式在 TOML 里不做转义, 反斜杠原样保留）
 *
 * node.exe 选择: 优先包内 runtime\node.exe（分发包自带 Node, 免安装）,
 * 找不到则退回系统 node（开发目录没有 runtime\）—— 两种布局都能注册。
 *
 * 幂等: 重复执行会先删掉旧的 [mcp_servers.ssh-remote-bridge] 段再追加。
 *
 * 环境变量:
 *   SRB_CODEX_CONFIG_DIR  直接指定 config.toml 所在目录（即 .../.codex）
 *   SRB_USERPROFILE_OVERRIDE  覆盖家目录（测试隔离用，等价于换 HOME）
 *   CODEX_CLI      强制指定 codex 可执行文件路径
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_MJS = path.join(ROOT, 'mcp', 'server.mjs');
const NAME = 'ssh-remote-bridge';

/** 选 node.exe: 包内 runtime 优先（分发包自带）, 否则系统 node */
function pickNode() {
  const bundled = path.join(ROOT, 'runtime', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (process.execPath && fs.existsSync(process.execPath)) return process.execPath;
  return 'node.exe';
}
const NODE_EXE = pickNode();

// ---- 自检（只查必须有的一样）----
if (!fs.existsSync(SERVER_MJS)) {
  console.error(`[register-codex] missing ${SERVER_MJS}`);
  console.error('[register-codex] the package looks incomplete (mcp\\server.mjs is required)');
  process.exit(1);
}

// ---- 找 codex CLI（Windows 上通常是 .cmd 垫片）----
function findCodex() {
  if (process.env.CODEX_CLI) return process.env.CODEX_CLI;
  const probe = spawnSync('where', ['codex'], { encoding: 'utf8', windowsHide: true });
  const first = (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

// ---- 路径 -> TOML 字符串 ----
// 优先用单引号字面量 ('...'), TOML 里它不做转义, 反斜杠原样保留, 最不容易出错。
// 只有路径里含单引号时才退回双引号形式(此时才需要转义)。
function tomlStr(s) {
  if (!s.includes("'")) return `'${s}'`;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function registerViaCli(codexExe) {
  console.log(`[register-codex] codex CLI found: ${codexExe}`);
  const rm = spawnSync(codexExe, ['mcp', 'remove', NAME], { encoding: 'utf8', windowsHide: true });
  const add = spawnSync(codexExe, ['mcp', 'add', NAME, '--', NODE_EXE, SERVER_MJS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = `${add.stdout || ''}${add.stderr || ''}`.trim();
  if (add.status === 0) {
    console.log('[register-codex] registered via `codex mcp add`');
    if (out) console.log(`  ${out.split(/\r?\n/).join('\n  ')}`);
    return true;
  }
  console.warn(`[register-codex] \`codex mcp add\` exited ${add.status}: ${out.split(/\r?\n/)[0] || '(no output)'}`);
  return false;
}

function registerViaToml() {
  // 配置目录定位优先级:
  //   SRB_CODEX_CONFIG_DIR  —— 直接给 .../.codex 这一层（最明确，推荐测试隔离用）
  //   SRB_USERPROFILE_OVERRIDE —— 换家目录，等价于改 HOME
  //   默认                   —— os.homedir()/.codex
  const cfgDir = process.env.SRB_CODEX_CONFIG_DIR
    || path.join(process.env.SRB_USERPROFILE_OVERRIDE || os.homedir(), '.codex');
  const cfg = path.join(cfgDir, 'config.toml');
  if (!fs.existsSync(cfg)) {
    console.error(`[register-codex] cannot find ${cfg} and codex CLI is not on PATH.`);
    console.error('[register-codex] Install codex (npm i -g @openai/codex) or create the config, then retry.');
    return false;
  }
  const sectRe = new RegExp(`\\n\\[mcp_servers\\.${NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*?(?=\\n\\[|$)`);
  let s = fs.readFileSync(cfg, 'utf8');
  s = s.replace(sectRe, '').trimEnd();

  const block =
    `\n\n[mcp_servers.${NAME}]\n` +
    `command = ${tomlStr(NODE_EXE)}\n` +
    `args = [${tomlStr(SERVER_MJS)}]\n` +
    `startup_timeout_sec = 120\n`;
  fs.writeFileSync(cfg, s + block, 'utf8');
  console.log(`[register-codex] appended [mcp_servers.${NAME}] to ${cfg}`);
  console.log(`  command = ${tomlStr(NODE_EXE)}`);
  console.log(`  args    = [${tomlStr(SERVER_MJS)}]`);
  return true;
}

const codexExe = findCodex();
const ok = (codexExe && registerViaCli(codexExe)) || registerViaToml();
if (!ok) process.exit(1);

console.log('');
console.log(`[register-codex] MCP servers configured: ${NAME}`);
console.log('[register-codex] NEXT: restart Codex (config.toml is only read at startup).');
console.log('[register-codex] verify with:  codex mcp list');