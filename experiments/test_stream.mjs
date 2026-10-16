/**
 * experiments/test_stream.mjs — 流式输出（S 帧）专项测试
 *
 * 覆盖协议 v5 新增的 S 帧（任务运行中的增量输出）:
 *   - 增量是否真的边跑边到（而不是等结束一次性吐）
 *   - 流式与非流式的最终 output 是否一致（不能因为流式就丢内容或多打一遍）
 *   - 连续两条流式命令之间不能串内容（soff 基准必须重置）
 *   - 中断流式任务后连接照常
 *   - 中文/emoji/二进制在流式下不损坏
 *
 * 用法: node experiments/test_stream.mjs [profile]
 */
import * as engine from '../lib/engine.mjs';

const profile = process.argv[2] || null;
const srv = engine.getServer(profile);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log(`  ❌ ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
}

/** 流式跑一条命令, 记录每批到达的相对时刻(ms)和文本 */
async function streamRun(cmd, { timeout = 30 } = {}) {
  const t0 = Date.now();
  const batches = [];
  const r = await engine.execOnPersist(srv, cmd, {
    timeout,
    stream: true,
    onStream: (chunk) => batches.push({ at: Date.now() - t0, text: chunk }),
  });
  return { r, batches };
}

async function nonStreamRun(cmd, { timeout = 30 } = {}) {
  const r = await engine.execOnPersist(srv, cmd, { timeout });
  return r;
}

console.log(`\n[stream] 目标服务器: ${srv.name} ${srv.user}@${srv.host}\n`);

// 先热身: 首次建连要走 SSH 握手（本机实测 ~5.6s, 服务器侧 KEX/PAM 成本）。
// 不热身的话第一批必然被握手时间污染, 测不出"增量是否边跑边到"。
const warm = Date.now();
await engine.execOnPersist(srv, ':', { timeout: 60 });
console.log(`[warmup] 连接已建立 (${Date.now() - warm}ms)，后续测试排除握手开销\n`);

// ---------------------------------------------------------------- 1. 增量是否边跑边到
console.log('[1] 增量回传时机');
{
  // 4 次输出, 每次间隔 1.5s。流式模式下应该分成 4 批陆续到达;
  // 若等结束才吐, batches 只会是 1 批且 at ~= 总耗时
  const { r, batches } = await streamRun('for i in 1 2 3 4; do echo "tick-$i"; sleep 1.5; done');
  ok('退出码 0', r.exitCode === 0, `exit=${r.exitCode}`);
  ok('收到多批增量 (>=3)', batches.length >= 3, `${batches.length} 批`);
  const firstAt = batches.length ? batches[0].at : -1;
  const lastAt = batches.length ? batches[batches.length - 1].at : -1;
  ok('首批很快到达 (<3s)', firstAt >= 0 && firstAt < 3000, `首批 ${firstAt}ms`);
  ok('末批明显晚于首批（说明是陆续到达）', lastAt - firstAt > 2000, `跨度 ${lastAt - firstAt}ms`);
  const all = batches.map((b) => b.text).join('');
  for (let i = 1; i <= 4; i++) ok(`包含 tick-${i}`, all.includes(`tick-${i}`));
  ok('完整 output 含全部 tick', ['tick-1', 'tick-2', 'tick-3', 'tick-4'].every((t) => r.output.includes(t)));
}

// ---------------------------------------------------------------- 2. 流式 vs 非流式一致
console.log('\n[2] 流式与非流式结果一致');
{
  const cmd = 'printf "a\\nb\\nc\\n"; printf "no-newline-tail"';
  const s = await streamRun(cmd);
  const n = await nonStreamRun(cmd);
  ok('流式 output == 非流式 output', s.r.output === n.output, `流式 ${s.r.output.length}B vs 非流式 ${n.output.length}B`);
  ok('尾部无换行的内容没丢', s.r.output.includes('no-newline-tail'));
  ok('换行保留（没被 $() 吞掉）', s.r.output.includes('a\nb\nc\n'));
  ok('退出码一致', s.r.exitCode === n.exitCode, `${s.r.exitCode} vs ${n.exitCode}`);
}

// ---------------------------------------------------------------- 3. 连续命令不串内容
console.log('\n[3] 连续流式命令不串内容');
{
  // 这是本次最容易出错的点: soff（增量基准）若没重置, 第二条会先重发第一条的残留
  const a = await streamRun('echo FIRST-MARKER-AAA');
  const b = await streamRun('echo SECOND-MARKER-BBB');
  ok('第一条只含自己的标记', a.r.output.includes('FIRST-MARKER-AAA') && !a.r.output.includes('SECOND-MARKER-BBB'), JSON.stringify(a.r.output.trim()));
  ok('第二条只含自己的标记', b.r.output.includes('SECOND-MARKER-BBB') && !b.r.output.includes('FIRST-MARKER-AAA'), JSON.stringify(b.r.output.trim()));
  ok('第二条内容精确等于输出', b.r.output.trim() === 'SECOND-MARKER-BBB');
}

// ---------------------------------------------------------------- 4. 中文 / emoji / 二进制
console.log('\n[4] 特殊字符在流式下不损坏');
{
  const s = await streamRun('for i in 1 2 3; do echo "中文-$i-🚀-ok"; sleep 0.6; done');
  const all = s.batches.map((b) => b.text).join('');
  for (let i = 1; i <= 3; i++) ok(`批次里含中文 emoji (第${i}条)`, all.includes(`中文-${i}-🚀-ok`));
  ok('最终 output 完整含 3 条', [1, 2, 3].every((i) => s.r.output.includes(`中文-${i}-🚀-ok`)));
}
{
  // 注意: base64 默认按 76 字符折行, 所以校验前要先去掉换行 (别写成不允许 \n 的正则)
  const s = await streamRun('head -c 200 /bin/bash | base64');
  const b64 = s.r.output.replace(/\s+/g, '');
  ok('二进制经 base64 往返一致', b64.length > 100 && /^[A-Za-z0-9+/=]+$/.test(b64), `${b64.length} 字符`);
  ok('base64 能解出原始字节 (ELF 魔数)', Buffer.from(b64, 'base64').subarray(0, 4).toString('hex') === '7f454c46', Buffer.from(b64, 'base64').subarray(0, 4).toString('hex'));
}

// ---------------------------------------------------------------- 5. 大量输出（分片压力）
console.log('\n[5] 大输出分片');
{
  // 200KB 单行输出, 会被切成很多 S 帧, 检验重组是否无缝
  const s = await streamRun('for i in $(seq 1 4000); do echo "line-$i-abcdefghij"; done', { timeout: 60 });
  const lines = s.r.output.trim().split('\n');
  ok('行数正确 (4000)', lines.length === 4000, `${lines.length} 行`);
  ok('首行正确', lines[0] === 'line-1-abcdefghij');
  ok('末行正确', lines[3999] === 'line-4000-abcdefghij');
  ok('拼接后无空行/无重复', !lines.some((l) => l === ''));
}

// ---------------------------------------------------------------- 6. 中断后连接照常
console.log('\n[6] 中断流式任务后连接照常');
{
  const p = streamRun('echo before-interrupt; sleep 30; echo never-printed');
  await new Promise((res) => setTimeout(res, 2500));
  // 注意: getExecFor 收的是 server 对象, 不是名字 —— 传错会拿到 undefined 而静默返回 false
  const rex = engine.getExecFor(srv);
  ok('拿到执行器实例', !!rex);
  const sent = rex ? rex.interrupt() : false;
  ok('能发出中断帧', sent === true);
  const { r } = await p;
  ok('中断后有中断标记', r.interrupted === true, `interrupted=${r.interrupted} exit=${r.exitCode}`);
  ok('中断前的输出已收到', r.output.includes('before-interrupt'));
  ok('中断后的输出没出现', !r.output.includes('never-printed'));
  // 连接必须还能用
  const after = await nonStreamRun('echo still-alive');
  ok('连接中断后仍可用', after.output.includes('still-alive'), after.output.trim());
}

// ---------------------------------------------------------------- 7. 退出码语义
console.log('\n[7] 退出码');
{
  const s = await streamRun('echo out; echo err 1>&2; exit 7');
  ok('stdout+stderr 都收到', s.r.output.includes('out') && s.r.output.includes('err'));
  ok('退出码正确透传 (7)', s.r.exitCode === 7, `exit=${s.r.exitCode}`);
}

// ---------------------------------------------------------------- 8. 非流式路径零影响
console.log('\n[8] 非流式路径未受影响');
{
  const r = await nonStreamRun('echo plain-mode-still-works');
  ok('C 帧路径正常', r.output.includes('plain-mode-still-works'));
  ok('C 帧没有多余增量', !r.output.includes('undefined'));
}

// ---------------------------------------------------------------- 汇总
engine.closeAllPersist();
console.log(`\n================ 结果: ${pass} 通过 / ${fail} 失败 ================`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
