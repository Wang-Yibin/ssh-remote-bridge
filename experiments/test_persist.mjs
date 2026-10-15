// test_persist.mjs — persist.mjs 实测（打真实服务器）
//
// 凭据不在本文件里: 从项目根的 servers.json 读（见 _server.mjs）。
// 默认用 servers.json 里 default:true 的那台; 想指定: SRB_TEST_SERVER=<名字> node test_persist.mjs
import { getRemoteExec, closeAllRemoteExecs } from '../lib/persist.mjs';
import { banner } from './_server.mjs';

const conn = banner('persist 通道实测');

const rex = getRemoteExec('test', conn);

async function t(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`[OK]   ${name}  (${Date.now() - t0}ms)  ${typeof r === 'string' ? JSON.stringify(r.slice(0, 120)) : JSON.stringify(r)}`);
    return r;
  } catch (e) {
    console.log(`[FAIL] ${name}  (${Date.now() - t0}ms)  ${e.message}`);
    return null;
  }
}

await t('ensure/warmup (含5.6s握手)', async () => {
  await rex.ensure();
  return 'connected, everReady=' + rex.everReady;
});

await t('echo PING', async () => (await rex.exec('echo PING', { timeout: 30 })).output.trim());
await t('echo PING2', async () => (await rex.exec('echo PING2', { timeout: 30 })).output.trim());

await t('cd /tmp', async () => (await rex.exec('cd /tmp', { timeout: 30 })).exitCode);
await t('pwd (expect /tmp)', async () => (await rex.exec('pwd', { timeout: 30 })).output.trim());
await t('cwd 上报 (expect /tmp)', async () => (await rex.exec('pwd', { timeout: 30 })).cwd);

await t('export SRB_TEST=hello', async () => (await rex.exec('export SRB_TEST=hello', { timeout: 30 })).exitCode);
await t('echo $SRB_TEST (expect hello)', async () => (await rex.exec('echo "SRB_TEST=$SRB_TEST"', { timeout: 30 })).output.trim());

await t('exit 42 (expect exitCode 42)', async () => (await rex.exec('exit 42', { timeout: 30 })).exitCode);

await t('seq 1 2000 (expect 2000 行)', async () => {
  const r = await rex.exec('seq 1 2000', { timeout: 30 });
  return r.output.trim().split('\n').length;
});

await t('并发排队: 3 条同时发', async () => {
  const ps = [
    rex.exec('echo A1; sleep 0.3; echo A2', { timeout: 30 }),
    rex.exec('echo B', { timeout: 30 }),
    rex.exec('echo C', { timeout: 30 }),
  ];
  const rs = await Promise.all(ps);
  return rs.map((r) => r.output.trim().replace(/\n/g, '|'));
});

await t('中断: sleep 30, 1s 后 Ctrl+C', async () => {
  const p = rex.exec('sleep 30', { timeout: 60 });
  setTimeout(() => rex.interrupt(), 1000);
  const r = await p;
  return { exitCode: r.exitCode, interrupted: r.interrupted, ms: Math.round(r.duration * 1000) };
});

await t('中断后连接可用', async () => (await rex.exec('echo ALIVE', { timeout: 30 })).output.trim());

await t('超时: sleep 30, timeout=2s', async () => {
  const r = await rex.exec('sleep 30', { timeout: 2 });
  return { timedOut: r.timedOut, interrupted: r.interrupted, exitCode: r.exitCode, ms: Math.round(r.duration * 1000) };
});

await t('超时后连接可用', async () => (await rex.exec('echo ALIVE2', { timeout: 30 })).output.trim());

await t('二进制/中文/emoji 往返', async () => {
  const payload = '中文测试 emoji 🚀 quotes "x" $VAR `cmd` \\ backslash 换行\n第二行';
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  const w = await rex.exec(`printf %s ${b64} > /tmp/.srb_bin_test`, { timeout: 30 });
  const rd = await rex.exec('/usr/bin/base64 -w0 < /tmp/.srb_bin_test', { timeout: 30 });
  const got = Buffer.from(rd.output.trim(), 'base64').toString('utf8');
  return { writeExit: w.exitCode, match: got === payload };
});

await t('断线重连: abort 后重发', async () => {
  rex.abort();
  await new Promise((r) => setTimeout(r, 500));
  const r = await rex.exec('echo RECONNECTED', { timeout: 60 });
  return r.output.trim();
});

await t('stats', async () => rex.stats());

closeAllRemoteExecs();
await new Promise((r) => setTimeout(r, 600));
console.log('=== done ===');
process.exit(0);
