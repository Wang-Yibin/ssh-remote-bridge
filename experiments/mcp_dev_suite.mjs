/**
 * mcp_dev_suite.mjs — MCP 通道真实开发流程回归（模拟大模型接手写代码）
 *
 * 直接以 JSON-RPC 驱动 mcp/server.mjs，覆盖 LLM 干活会用到的全部动作：
 * 探查环境 / 建目录 / 多行写文件 / 原地改代码(sed,python) / 追加 / 读回校验 /
 * grep|sed 取片段 / 引号与 $() 地狱 / 退出码 / 大输出 / 超时中断 /
 * git 仓库操作 / 二进制读 / 中文路径 / CRLF / 后台任务 / 错误路径
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testConn, safeConn } from './_server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FWD = path.resolve(__dirname, '..');

// 期望的 home /用户名 / GPU 数量都从配置推导, 不在测试里硬编码任何真实服务器信息
const CONN = testConn();
const EXPECT_HOME = `/home/${CONN.user}`;
const EXPECT_GPU_COUNT = Number(process.env.SRB_TEST_GPUS || 4);

const proc = spawn(process.execPath, [path.join(FWD, 'mcp', 'server.mjs')], {
  cwd: FWD,
  stdio: ['pipe', 'pipe', 'pipe'],
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
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
  }
});
proc.stderr.on('data', (d) => {
  if (process.env.SRB_DEBUG) process.stderr.write(d);
});

let id = 0;
function rpc(method, params) {
  return new Promise((res) => {
    const myId = ++id;
    waiters.set(myId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}

async function call(name, args) {
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args });
  const ms = Date.now() - t0;
  const text = (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || JSON.stringify(r);
  return { ms, text, isError: !!(r.result && r.result.isError) };
}

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, tool, args, check) {
  const r = await call(tool, args);
  let ok = false;
  let why = '';
  try {
    const res = check(r.text, r);
    ok = res === true || (res && res.ok);
    if (!ok) why = res && res.why ? res.why : 'assertion returned falsy';
  } catch (e) {
    why = 'check threw: ' + e.message;
  }
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}  (${r.ms}ms)`);
  } else {
    fail++;
    failures.push(name + (why ? ' :: ' + why : ''));
    console.log(`  ❌ ${name}  (${r.ms}ms)  ${why}`);
    console.log('     ' + r.text.replace(/\n/g, '\n     ').slice(0, 500));
  }
  return r;
}

const has = (...needles) => (text) => {
  const miss = needles.filter((n) => !text.includes(n));
  return miss.length ? { ok: false, why: 'missing: ' + JSON.stringify(miss) } : true;
};
const hasNot = (...needles) => (text) => {
  const hit = needles.filter((n) => text.includes(n));
  return hit.length ? { ok: false, why: 'should NOT contain: ' + JSON.stringify(hit) } : true;
};
const exitIs = (code) => (text) => (text.includes(`exit=${code} `) ? true : { ok: false, why: `exit != ${code}` });

// ---------------------------------------------------------------- 1. 环境探查
console.log(`\ntarget: ${safeConn(CONN)}`);
console.log('\n[1] 环境探查（LLM 接手第一步）');
await t('pwd', 'exec', { command: 'pwd' }, has(EXPECT_HOME, 'exit=0'));
await t('whoami + uname', 'exec', { command: 'whoami; uname -sr' }, has(CONN.user, 'Linux', 'exit=0'));
await t(`GPU 列表（期望 ${EXPECT_GPU_COUNT} 张）`, 'exec', { command: 'nvidia-smi --query-gpu=index,name,memory.used --format=csv,noheader' }, (x) => {
  // nvidia-smi 不存在时输出会含 "not found"/"command" —— 那也算通过(这台机器没 GPU)
  if (/not found|No such file|command not found/i.test(x)) return true;
  const n = (x.split('\n').filter((l) => l.includes('RTX') || /\d{2,4}MiB|\d+ GiB/.test(l)) || []).length;
  return n >= EXPECT_GPU_COUNT ? true : { ok: false, why: `GPU 行数=${n} (期望 >=${EXPECT_GPU_COUNT})` };
});
await t('磁盘', 'exec', { command: 'df -h / | tail -1' }, (x) => (x.includes('exit=0') && /[0-9]+[TGM]\b/.test(x) ? true : { ok: false, why: 'no df output' }));
await t('conda 环境', 'exec', { command: 'ls -d ~/miniconda3/envs/* 2>/dev/null || ls -d ~/anaconda3/envs/* 2>/dev/null || echo no-conda-dir' }, (x) =>
  x.includes('exit=0') ? true : { ok: false, why: 'no output' }
);

// ---------------------------------------------------------------- 2. 建目录 + 写多行代码
console.log('\n[2] 建目录 + 写多行代码文件');
const PY = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小工具: 统计文本行数 (LLM 写代码的典型产物)"""
import sys

# TODO: 支持 stdin

def count_lines(path):
    # 中文注释: 逐行读, 兼容任意编码
    n = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for _ in f:
            n += 1
    return n

if __name__ == "__main__":
    print(count_lines(sys.argv[1]))
`;
await t('mkdir -p', 'exec', { command: 'mkdir -p /tmp/srbdev/pkg && cd /tmp/srbdev && pwd' }, has('/tmp/srbdev', 'exit=0'));
await t('write_file 多行 Python（含中文/引号/空行）', 'write_file', { path: '/tmp/srbdev/pkg/count.py', content: PY }, has('exit=0', 'bytes='));
await t('read_file 读回校验', 'read_file', { path: '/tmp/srbdev/pkg/count.py' }, has('TODO: 支持 stdin', '中文注释', 'def count_lines(path)'));
await t('运行刚写的脚本（cd 状态）', 'exec', { command: 'cd /tmp/srbdev/pkg && python3 count.py count.py' }, has('exit=0'));

// ---------------------------------------------------------------- 3. 改代码（LLM 最常见动作）
console.log('\n[3] 原地改代码 + 校验');
await t('sed -i 替换', 'exec', { command: "cd /tmp/srbdev/pkg && sed -i 's/# 中文注释/# EDITED-BY-SED/' count.py && grep -n EDITED-BY-SED count.py" }, has('EDITED-BY-SED', 'exit=0'));
await t('python 脚本做多行改写', 'exec', {
  command: `cd /tmp/srbdev/pkg && python3 - <<'PYEOF'
import re, pathlib
p = pathlib.Path('count.py')
s = p.read_text(encoding='utf-8')
s = s.replace('TODO: 支持 stdin', 'DONE: 支持 stdin (by python)')
s = re.sub(r'def count_lines\\(path\\):', 'def count_lines(path: str) -> int:', s)
p.write_text(s, encoding='utf-8')
print('patched')
PYEOF`,
}, has('patched', 'exit=0'));
await t('读回确认修改生效', 'read_file', { path: '/tmp/srbdev/pkg/count.py' }, has('DONE: 支持 stdin (by python)', 'def count_lines(path: str) -> int:', 'EDITED-BY-SED'));
await t('write_file 整体重写', 'write_file', { path: '/tmp/srbdev/pkg/count.py', content: PY.replace('TODO: 支持 stdin', 'REWRITTEN') }, has('exit=0'));
await t('重写后校验', 'read_file', { path: '/tmp/srbdev/pkg/count.py' }, has('REWRITTEN'));
await t('write_file append=true', 'write_file', { path: '/tmp/srbdev/pkg/count.py', content: '\n# appended line 中文\n', append: true }, has('(append)'));
await t('追加后校验', 'read_file', { path: '/tmp/srbdev/pkg/count.py' }, has('appended line 中文', 'REWRITTEN'));

// ---------------------------------------------------------------- 4. 读片段
console.log('\n[4] grep / sed 取片段 / wc');
await t('grep -nH', 'exec', { command: "cd /tmp/srbdev/pkg && grep -nH 'def \\|TODO\\|DONE\\|REWRITTEN' count.py" }, has('count.py', 'exit=0'));
await t('sed -n 区间', 'exec', { command: "cd /tmp/srbdev/pkg && sed -n '5,9p' count.py" }, (x) => (x.split('\n').length >= 4 ? true : { ok: false, why: 'too few lines' }));
await t('wc -l / ls -la', 'exec', { command: 'cd /tmp/srbdev && wc -l pkg/count.py && ls -la pkg' }, has('count.py', 'exit=0'));
await t('find + head -c', 'exec', { command: 'find /tmp/srbdev -type f | head -3 && head -c 20 /tmp/srbdev/pkg/count.py' }, has('count.py', 'exit=0'));

// ---------------------------------------------------------------- 5. 引号 / $() / 管道地狱
console.log('\n[5] 特殊字符（最容易翻车的地方）');
await t('单引号+双引号+反引号+$', 'exec', {
  command: `cd /tmp/srbdev && echo 'single' "double" \`backtick\` $HOME \${NOT_SET} | wc -c`,
}, has('exit=0'));
await t('$(...) 命令替换 + 百分号', 'exec', { command: `cd /tmp/srbdev && printf '%s|%s|%s\\n' "$(date +%Y)" "100%" "$((2*3))"` }, has('|', '100%', '6', 'exit=0'));
await t('多行命令 (换行+&&+;)', 'exec', {
  command: `cd /tmp/srbdev
set -e
echo line1
echo line2 && echo line3
false || echo "fallback ran"`,
}, has('line1', 'line3', 'fallback ran', 'exit=0'));
await t('管道 + 重定向 + 引号混合（合法但难写）', 'exec', {
  command: `cd /tmp/srbdev && printf '%s\\n' "a\\tb" 'q"q' "s's" '$HOME' > tricky.txt && cat tricky.txt | wc -l && sed -n '2p' tricky.txt`,
}, has('q"q', 'exit=0'));
await t('上面写入的 4 行内容逐行正确', 'exec', { command: "cd /tmp/srbdev && sed -n '3p;4p' tricky.txt" }, has("s's", '$HOME', 'exit=0'));
await t('python3 -c 带嵌套引号/JSON', 'exec', {
  command: `cd /tmp/srbdev && python3 -c 'import json; print(json.dumps({"k": "v", "n": [1, 2], "c": "中文"}, ensure_ascii=False))'`,
}, has('"n": [1, 2]', '中文', 'exit=0'));
await t('语法错误命令 → 报错且不泄露内部路径', 'exec', { command: `cd /tmp/srbdev && echo 'unclosed quote` }, (x) => {
  if (x.includes('/tmp/.srb-exec')) return { ok: false, why: '内部临时路径泄露到输出里' };
  return x.includes('exit=') ? true : { ok: false, why: '无退出码' };
});
await t('中文/emoji 内容往返', 'exec', { command: `cd /tmp/srbdev && echo '中文 emoji 🚀 反引号 \`x\`' > uni.txt && cat uni.txt` }, has('中文', '🚀', 'exit=0'));
await t('中文路径', 'exec', { command: `mkdir -p '/tmp/srbdev/中文 目录' && echo ok > '/tmp/srbdev/中文 目录/文件.txt' && cat '/tmp/srbdev/中文 目录/文件.txt'` }, has('ok', 'exit=0'));
await t('CRLF 文件往返', 'exec', { command: `cd /tmp/srbdev && printf 'a\\r\\nb\\r\\n' > crlf.txt && od -c crlf.txt | head -1` }, has('\\r', 'exit=0'));

// ---------------------------------------------------------------- 6. 退出码语义
console.log('\n[6] 退出码');
await t('exit 7', 'exec', { command: 'exit 7' }, exitIs(7));
await t('false → 1', 'exec', { command: 'false' }, exitIs(1));
await t('ls 不存在 → 2', 'exec', { command: 'ls /definitely/not/here' }, (x) => (x.includes('exit=2') ? true : { ok: false, why: 'expected exit=2' }));
await t('stderr 也有输出', 'exec', { command: 'echo to-stdout; echo to-stderr 1>&2' }, has('to-stdout', 'to-stderr'));

// ---------------------------------------------------------------- 7. 大输出 / 超时 / 后台
console.log('\n[7] 大输出 / 超时 / 后台任务');
await t('大输出只取尾部', 'exec', { command: 'seq 1 20000 | wc -l' }, has('20000', 'exit=0'));
await t('大输出字节数精确校验（30000 行=168894 字节）', 'exec', { command: 'seq 1 30000 | wc -c' }, has('168894', 'exit=0'));
await t('单行超长输出（200KB）', 'exec', { command: `python3 -c "print('x'*200000)" | wc -c` }, has('200001', 'exit=0'));
await t('大内容 write_file → read_file 往返（200KB）', 'write_file', { path: '/tmp/srbdev/big.txt', content: 'ABCDEFGH'.repeat(25000) + '中文尾' }, has('exit=0'));
await t('大文件读回大小校验（显式 max_bytes）', 'read_file', { path: '/tmp/srbdev/big.txt', max_bytes: 262144 }, (x) => (x.includes('200009 bytes') ? true : { ok: false, why: x.slice(0, 100) }));
await t('大文件默认 64KB 截断（设计行为）', 'read_file', { path: '/tmp/srbdev/big.txt' }, has('TRUNCATED at max_bytes'));
await t('大输出 tail', 'exec', { command: 'seq 1 5000 | tail -2' }, has('4999', '5000', 'exit=0'));
await t('超时被中断（timeout=5, sleep 8）', 'exec', { command: 'sleep 8', timeout: 5 }, has('TIMED-OUT'));
await t('超时后连接照常', 'exec', { command: 'echo alive-after-timeout' }, has('alive-after-timeout', 'exit=0'));
await t('后台任务（nohup）', 'exec', { command: `cd /tmp/srbdev && nohup bash -c 'for i in 1 2 3; do echo tick$i >> bg.log; sleep 1; done' >/dev/null 2>&1 & echo started` }, has('started', 'exit=0'));
await t('后台任务结果可查', 'exec', { command: 'sleep 3.5; cat /tmp/srbdev/bg.log 2>/dev/null' }, has('tick3', 'exit=0'));

// ---------------------------------------------------------------- 8. git（LLM 常做）
console.log('\n[8] git 流程');
await t('git init+add+commit', 'exec', {
  command: `cd /tmp/srbdev && rm -rf gitrepo && mkdir gitrepo && cd gitrepo && git init -q && cp ../pkg/count.py . && git add . && git -c user.email=ai@test -c user.name=ai commit -qm "init" && git log --oneline | head -1`,
}, has('init', 'exit=0'));
await t('改文件后 git diff', 'exec', { command: `cd /tmp/srbdev/gitrepo && sed -i 's/REWRITTEN/CHANGED/' count.py && git diff --stat` }, has('count.py', 'exit=0'));
await t('git status', 'exec', { command: 'cd /tmp/srbdev/gitrepo && git status --short' }, has('count.py', 'exit=0'));

// ---------------------------------------------------------------- 9. 二进制 / 错误路径
console.log('\n[9] 二进制与错误处理');
await t('读二进制 → base64', 'read_file', { path: '/bin/ls', max_bytes: 2048 }, has('BINARY -> base64'));
await t('读不存在的文件 → isError', 'read_file', { path: '/no/such/file.txt' }, (x, r) => (r.isError ? true : { ok: false, why: 'should be isError' }));
await t('写失败路径 → isError', 'write_file', { path: '/proc/cannot/write/here.txt', content: 'x' }, (x, r) => (r.isError ? true : { ok: false, why: 'should be isError' }));
await t('exec 缺参数 → isError', 'exec', {}, (x, r) => (r.isError ? true : { ok: false, why: 'should be isError' }));
await t('大文件读（截断到 max_bytes）', 'read_file', { path: '/bin/bash', max_bytes: 5000 }, has('TRUNCATED at max_bytes'));

// ---------------------------------------------------------------- 10. 状态保持 + 清理
console.log('\n[10] 状态保持与清理');
await t('cd 保持（相对路径）', 'exec', { command: 'cd /tmp/srbdev/gitrepo && pwd' }, has('/tmp/srbdev/gitrepo'));
await t('上一条的 cd 还在生效', 'exec', { command: 'ls | head -3' }, has('count.py'));
await t('cd 到不存在的目录 → 报错', 'exec', { command: 'cd /no/such/dir' }, (x) => (x.includes('exit=') && x.includes('exit=1') ? true : { ok: false, why: x.slice(0, 160) }));
await t('失败的 cd 不影响已有状态', 'exec', { command: 'pwd' }, has('/tmp/srbdev/gitrepo', 'exit=0'));
await t('清理', 'exec', { command: 'cd /tmp && rm -rf /tmp/srbdev && ls /tmp/srbdev 2>&1 | head -1' }, (x) => (x.includes('exit=0') ? true : { ok: false, why: 'cleanup failed' }));

console.log(`\n================ 结果: ${pass} 通过 / ${fail} 失败 ================`);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log('  - ' + f));
}
proc.stdin.end();
setTimeout(() => process.exit(fail ? 1 : 0), 500);
