// test_configure_server.mjs — AI 首次接入流程测试（用临时 SRB_CONFIG, 不碰真实 servers.json）
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testConn } from './_server.mjs';

const FWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_CFG = path.join(os.tmpdir(), 'srb_cfgtest_servers.json');
try {
  fs.unlinkSync(TMP_CFG);
} catch (_) {}

const proc = spawn(process.execPath, [path.join(FWD, 'mcp', 'server.mjs')], {
  cwd: FWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, SRB_CONFIG: TMP_CFG },
});
let buf = '';
const waiters = new Map();
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const w = waiters.get(m.id);
    if (w) {
      waiters.delete(m.id);
      w(m);
    }
  }
});
let id = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const myId = ++id;
    waiters.set(myId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  return { text: r.result?.content?.[0]?.text || JSON.stringify(r), isError: !!r.result?.isError };
};

let pass = 0,
  fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}  ${detail || ''}`);
  }
};

await rpc('initialize', { protocolVersion: '2024-11-05' });

// 1) 未配置时 list_servers 必须给出"向用户索要"的清单
const l1 = await call('list_servers');
check('未配置时 list_servers 报错并列出索要清单',
  l1.isError && l1.text.includes('ASK THE USER') && l1.text.includes('drive letter'),
  l1.text.slice(0, 200));

// 2) configure_server 缺参数 → 提示先问用户
const c0 = await call('configure_server', { note: 'x' });
check('缺 host/user 时拒绝并提示先问用户', c0.isError && c0.text.includes('Ask the user'), c0.text.slice(0, 160));

// 3) 合法配置。
//host 指向真实服务器（从 servers.json 读，不在本文件硬编码）以验证 hostkey 自动抓取。
// 密码故意用假的 —— 抓 hostkey 不需要密码（首次接触时 plink 打出指纹就退出）
const REAL = testConn();
const c1 = await call('configure_server', {
  name: 'testbox',
  host: REAL.host,
  port: REAL.port,
  user: REAL.user,
  password: 'SHOULD-NOT-BE-ECHOED',
  mount: 'D:\\testbox',
  drive: 'N:',
  note: 'unit test entry',
});
check('configure_server 成功写入', !c1.isError && c1.text.includes('saved server "testbox"'), c1.text.slice(0, 200));
check('返回里不回显密码', !c1.text.includes('SHOULD-NOT-BE-ECHOED'), c1.text.slice(0, 200));
check('hostkey 自动抓取', c1.text.includes('host key was fetched automatically'), '');

// 4) 落盘内容正确
const exists = fs.existsSync(TMP_CFG);
check('servers.json 已生成', exists, TMP_CFG);
if (!exists) {
  console.log('\n配置未落盘，后续断言中止');
  console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
  proc.stdin.end();
  setTimeout(() => process.exit(1), 300);
  process.exit(1);
}
const saved = JSON.parse(fs.readFileSync(TMP_CFG, 'utf8'));
const e = saved.servers.testbox || {};
check('servers.json 字段正确',
  e.host === REAL.host && e.user === REAL.user && e.password === 'SHOULD-NOT-BE-ECHOED' &&
  /^SHA256:/.test(e.hostkey || '') && e.mount === 'D:\\testbox' && e.drive === 'N:' && e.default === true,
  JSON.stringify({ ...e, password: '***' }));
check('plink 路径已填', typeof saved.plink === 'string' && saved.plink.length > 0, saved.plink);

// 5) 配置后 list_servers 正常
const l2 = await call('list_servers');
check('配置后 list_servers 正常返回', !l2.isError && l2.text.includes('testbox'), l2.text.slice(0, 200));
check('list_servers 不含密码', !l2.text.includes('SHOULD-NOT-BE-ECHOED'), '');

// 6) 端到端：用真实凭据（从项目真实 servers.json 读，不在本文件硬编码）写进临时配置，
//然后确认「configure_server 落盘的条目」能直接跑通命令
if (REAL.password || REAL.keyFile) {
  const cReal = await call('configure_server', {
    name: 'realbox',
    host: REAL.host,
    port: REAL.port,
    user: REAL.user,
    password: REAL.password,
    ...(REAL.keyFile ? { keyFile: REAL.keyFile } : {}),
    hostkey: REAL.hostkey,
    remote: `/home/${REAL.user}`,
  });
  check('用真实凭据写入 realbox 成功', !cReal.isError, cReal.text.slice(0, 200));
  if (REAL.password) check('返回里不回显真实密码', !cReal.text.includes(REAL.password), '');
  const exReal = await call('exec', { server: 'realbox', command: 'echo config-ok && pwd' });
  check(
    '落盘条目可直接 exec 成功（真实凭据端到端）',
    !exReal.isError && exReal.text.includes('config-ok') && exReal.text.includes('exit=0'),
    exReal.text.slice(0, 300)
  );
} else {
  console.log('  ⚠ 跳过真实凭据端到端: 没有可用凭据');
}

// 6b) 假密码 -> 必须报"密码错"而不是把真因藏起来（AI 接手时的关键体验）
const exBad = await call('exec', { server: 'testbox', command: 'echo should-not-run' });
check(
  '密码错误时能直接指出是凭据问题（而非暴露次生错误）',
  exBad.isError && /WRONG PASSWORD|password/i.test(exBad.text),
  exBad.text.slice(0, 400)
);

// 7) 更新已有条目（不覆盖未传字段）
const c2 = await call('configure_server', { name: 'testbox', host: REAL.host, user: REAL.user, password: 'new-pass', note: 'updated' });
const saved2 = JSON.parse(fs.readFileSync(TMP_CFG, 'utf8'));
check('更新时保留 mount/drive', saved2.servers.testbox.mount === 'D:\\testbox' && saved2.servers.testbox.drive === 'N:', JSON.stringify(saved2.servers.testbox));
check('更新时密码被替换', saved2.servers.testbox.password === 'new-pass', '');

// 8) 非法输入
const bad = [
  [{ name: 'bad name!', host: '1.2.3.4', user: 'u', password: 'p' }, '非法服务器名'],
  [{ name: 'x', host: '', user: 'u', password: 'p' }, '空 host'],
  [{ name: 'x', host: '1.2.3.4', port: 99999, user: 'u', password: 'p' }, '非法端口'],
  [{ name: 'x', host: '1.2.3.4', user: 'u' }, '无凭据'],
  [{ name: 'x', host: '1.2.3.4', user: 'u', password: 'p', drive: 'M' }, '非法盘符'],
];
for (const [args, label] of bad) {
  const r = await call('configure_server', args);
  check(`拒绝非法输入: ${label}`, r.isError, r.text.slice(0, 120));
}

// 9) 缺 hostkey 且服务器不可达 → 明确报错（用不可路由地址, 快速失败）
const c3 = await call('configure_server', { name: 'unreach', host: '240.0.0.1', user: 'u', password: 'p', hostkey: '' });
check('不可达且无 hostkey → 报错或警告', c3.isError || c3.text.includes('warnings'), c3.text.slice(0, 160));

// 清理
try {
  fs.unlinkSync(TMP_CFG);
} catch (_) {}
console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
proc.stdin.end();
setTimeout(() => process.exit(fail ? 1 : 0), 400);
