// parallel_mcp_test.mjs — 大模型并行发多个工具调用的行为验证
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proc = spawn(process.execPath, [path.join(FWD, 'mcp', 'server.mjs')], { cwd: FWD, stdio: ['pipe', 'pipe', 'pipe'] });

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
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.result?.content?.[0]?.text) || JSON.stringify(r);
  return { ms: Date.now() - t0, text };
};

await rpc('initialize', { protocolVersion: '2024-11-05' });
const warm = await call('exec', { command: 'echo warmup' });
console.log(`预热(握手): ${warm.ms}ms`);

// 1) 同时发 6 个 exec（不等前一个返回）——模拟模型并行调用
const cmds = [
  'echo P1',
  'sleep 0.6; echo P2-slow',
  'echo P3',
  'cat /etc/hostname',
  'echo P4; echo P4b',
  'echo P5',
];
const wants = ['P1', 'P2-slow', 'P3', 'wj-', 'P4b', 'P5'];
const t0 = Date.now();
const rs = await Promise.all(cmds.map((c) => call('exec', { command: c })));
console.log(`6 个并发 exec 全部返回: ${Date.now() - t0}ms`);
let ok = true;
rs.forEach((r, i) => {
  const want = wants[i];
  const got = r.text.includes(want) && r.text.includes('exit=0');
  if (!got) ok = false;
  console.log(`  ${got ? '✅' : '❌'} ${cmds[i].padEnd(22)} → ${r.ms}ms  ${got ? '内容正确' : r.text.slice(0, 120).replace(/\n/g, ' | ')}`);
});

// 2) 并发混合: exec + write_file + read_file 同时发
await call('exec', { command: 'mkdir -p /tmp/srbpar && echo ready > /tmp/srbpar/a.txt' });
const mixed = await Promise.all([
  call('exec', { command: 'cd /tmp/srbpar && cat a.txt' }),
  call('write_file', { path: '/tmp/srbpar/b.txt', content: 'B-中文-🚀' }),
  call('read_file', { path: '/tmp/srbpar/a.txt' }),
]);
const m1 = mixed[0].text.includes('ready');
const m2 = mixed[1].text.includes('exit=0');
const m3 = mixed[2].text.includes('ready');
console.log(`  ${m1 ? '✅' : '❌'} 并发 exec     : ${mixed[0].ms}ms`);
console.log(`  ${m2 ? '✅' : '❌'} 并发 write_file: ${mixed[1].ms}ms`);
console.log(`  ${m3 ? '✅' : '❌'} 并发 read_file : ${mixed[2].ms}ms`);
ok = ok && m1 && m2 && m3;

// 3) 并发后读回 b.txt 校验内容
const b = await call('read_file', { path: '/tmp/srbpar/b.txt' });
const bok = b.text.includes('B-中文-🚀');
console.log(`  ${bok ? '✅' : '❌'} 并发写入内容校验: ${b.text.slice(0, 80).replace(/\n/g, ' | ')}`);
ok = ok && bok;

// 4) 失败标识
const f = await call('exec', { command: 'ls /no/such/path' });
const fok = f.text.includes('FAILED');
console.log(`  ${fok ? '✅' : '❌'} 非零退出显式标 FAILED: ${f.text.split('\n')[0]}`);
ok = ok && fok;
const g = await call('exec', { command: 'grep -q zzzz-no-match /etc/hostname' });
const gok = g.text.includes('exit=1') && g.text.includes('FAILED');
console.log(`  ${gok ? '✅' : '❌'} grep 无匹配 exit=1: ${g.text.split('\n')[0]}`);

await call('exec', { command: 'rm -rf /tmp/srbpar' });
console.log(ok && gok ? '\n=== 并发与失败标识验证全部通过 ===' : '\n=== 存在问题 ===');
proc.stdin.end();
setTimeout(() => process.exit(ok && gok ? 0 : 1), 400);
