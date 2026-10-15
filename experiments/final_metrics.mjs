// final_metrics.mjs — 最终指标: 握手 + 命令延迟分布 + 30s 保活 + 重连
//
// 凭据不在本文件里: 从项目根的 servers.json 读（见 _server.mjs）
import { getRemoteExec, closeAllRemoteExecs } from '../lib/persist.mjs';
import { banner } from './_server.mjs';

const conn = banner('最终指标');
const rex = getRemoteExec('metrics', conn);

const lat = [];
async function run(cmd, timeout = 60) {
  const r = await rex.exec(cmd, { timeout });
  lat.push(Math.round(r.duration * 1000));
  return r;
}

const t0 = Date.now();
await rex.ensure();
console.log(`握手+预热: ${Date.now() - t0} ms`);

for (let i = 0; i < 10; i++) await run(`echo ping$i`);
console.log(`10 条 echo: ${lat.join(', ')} ms  (avg ${(lat.reduce((a, b) => a + b) / lat.length).toFixed(1)} ms)`);
lat.length = 0;

await run('ls ~ | head -5');
await run('cat /proc/loadavg');
await run('nproc');
console.log(`实用命令(ls/loadavg/nproc): ${lat.join(', ')} ms`);
lat.length = 0;

console.log('--- 空闲 35 秒（触发 30s 保活帧）---');
await new Promise((r) => setTimeout(r, 35000));
await run('echo after_idle_keepalive');
console.log(`保活后首条: ${lat[0]} ms  (alive=${rex.alive}, 未重连则说明保活生效)`);
lat.length = 0;

// 断线重连
rex.abort();
await new Promise((r) => setTimeout(r, 300));
const t1 = Date.now();
await run('echo after_reconnect');
console.log(`重连后: ${Date.now() - t1} ms 总耗时, 其中命令本身 ${lat[0]} ms`);

closeAllRemoteExecs();
await new Promise((r) => setTimeout(r, 600));
process.exit(0);
