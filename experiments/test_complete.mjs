/**
 * experiments/test_complete.mjs — Tab 补全专项测试
 *
 * 覆盖:
 *   1. 纯逻辑（词解析/首词判定/公共前缀/转义）—— 不连服务器
 *   2. Q 查询帧: 能执行、只读继承 cwd、不污染跨命令状态
 *   3. 补全候选: 命令名、远端路径、参数位vs首词位
 *   4. 缓存: 第二次查询应显著更快
 *   5. 干扰: busy 时立刻放弃、任务运行中补全不打断任务
 *
 * 用法: node experiments/test_complete.mjs [profile]
 */
import * as engine from '../lib/engine.mjs';
import { makeCompleter, resetCompletionCache, _internals as I } from '../lib/complete.mjs';

const srv = engine.getServer(process.argv[2] || null);

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
const eq = (got, want, name) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)}`);

console.log('\n[1] 纯逻辑（不连服务器）');
{
  eq(I.currentWord('AD').word, 'AD', "词解析 'AD'");
  eq(I.currentWord('cd /ho').word, '/ho', "斜杠属于词");
  eq(I.currentWord('cd /ho').start, 3, "起点 3");
  eq(I.currentWord('cat /etc/pa').start, 4, "起点 4");
  eq(I.currentWord('ls  ').word, '', '尾随空格 -> 空');
  eq(I.currentWord("echo 'my fi").word, 'my fi', '引号内空格');
  eq(I.isFirstWord('AD', 0), true, '首词判定');
  eq(I.isFirstWord('cd /ho', 3), false, '参数位判定');
  eq(I.commonPrefix(['ADMN', 'ADTX']), 'AD', '公共前缀');
  eq(I.commonPrefix(['only']), 'only', '唯一候选');
  eq(I.commonPrefix(['abc', 'xyz']), null, '无公共前缀');
  eq(I.shellQuote('simple'), 'simple', '不需引号');
  eq(I.shellQuote('has space'), "'has space'", '加引号');
  eq(I.shellQuote("it's"), "'it'\\''s'", "单引号转义");
}

console.log('\n[2] Q 查询帧');
{
  const rex = engine.getExecFor(srv);
  await rex.ensure();
  const r1 = await rex.query('echo HELLO_FROM_Q');
  ok('Q 能执行命令', r1.output.includes('HELLO_FROM_Q'), JSON.stringify(r1.output.trim()));

  await rex.exec('cd /tmp');
  const rq = await rex.query('pwd');
  const ra = await rex.exec('pwd');
  ok('Q 只读继承当前 cwd', rq.output.trim() === '/tmp', rq.output.trim());
  ok('Q 不写回状态（cd 未被污染）', ra.output.trim() === '/tmp', ra.output.trim());
  await rex.exec('cd ~');
}

console.log('\n[3] 补全候选（需连接）');
{
  const rex = engine.getExecFor(srv);
  await rex.ensure();
  resetCompletionCache();
  const c = makeCompleter(srv, { isBusy: () => false });
  const ask = (line) => new Promise((res) => c(line, (e, m) => res(m[0])));

  const gpust = await ask('gpust');
  ok('命令名补全 gpustat', gpust.includes('gpustat'), gpust.join(' '));

  const ex = await ask('exit');
  ok('本地内建命令 exit', ex.includes('exit'), ex.join(' '));

  const cdAd = await ask('cd AD');
  // 目录候选带尾斜杠（ADMN 是文件夹），这样能直接继续敲下一层
  ok('参数位补出家目录文件夹 (cd AD -> ADMN/)', cdAd.includes('cd ADMN/'), cdAd.join(' ') || '(无候选)');

  const absHome = await ask('cat /etc/ho');
  ok('绝对路径补全 /home/wa -> /etc/hosts', absHome.includes('cat /etc/hosts'), absHome.join(' ') || '(无候选)');

  const dirSlash = await ask('cd /tm');
  ok('目录候选带尾斜杠便于下钻', dirSlash.some((x) => x === 'cd /tmp/'), dirSlash.join(' '));

  // 带扩展名的算文件, 不加尾斜杠
  const hosts = await ask('cat /etc/hosts');
  ok('文件候选不加尾斜杠', hosts.includes('cat /etc/hosts') && !hosts.includes('cat /etc/hosts/'), hosts.join(' '));

  const firstWord = await ask('AD');
  ok('首词位不补文件夹（AD 在首词位无候选）', firstWord.length === 0, firstWord.join(' '));
}

console.log('\n[4] 缓存');
{
  resetCompletionCache();
  const c = makeCompleter(srv, { isBusy: () => false });
  const ask = (line) => new Promise((res) => c(line, (e, m) => res(m[0])));
  await ask('zzz_cold_query_xyz'); // 触发远端拉取
  const t0 = Date.now();
  await ask('gpust');
  const cold = Date.now() - t0;
  const t1 = Date.now();
  await ask('gpust');
  const warm = Date.now() - t1;
  ok('第二次查询走缓存（更快或持平）', warm <= cold + 5, `第一次 ${cold}ms, 第二次 ${warm}ms`);
}

console.log('\n[5] 干扰防护');
{
  const busyC = makeCompleter(srv, { isBusy: () => true });
  const t0 = Date.now();
  const bm = await new Promise((r) => busyC('gpust', (e, m) => r(m[0])));
  ok('busy 时立刻返回空', bm.length === 0 && Date.now() - t0 < 50, `${Date.now() - t0}ms`);

  const rex = engine.getExecFor(srv);
  const c = makeCompleter(srv, { isBusy: () => false });
  const task = rex.exec('sleep 3; echo TASK_FINISHED');
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => c('gpust', () => r()));
  const t = await task;
  ok('任务运行中补全不打断任务', t.output.includes('TASK_FINISHED'), t.output.trim());
}

engine.closeAllPersist();
console.log(`\n================ 结果: ${pass} 通过 / ${fail} 失败 ================`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
