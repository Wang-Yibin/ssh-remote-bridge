/**
 * lib/complete.mjs — 交互shell 的 Tab 补全
 *
 * 分三层,越靠前越快也越可靠:
 *   L1 本地内建   exit/help/gpu/raw/...   零延迟, 不出网
 *   L2 远端命令名  htop/gpustat/...       连上后拉一次, 缓存
 *   L3 远端路径    /home/wang<TAB>         按目录缓存, cd 后失效
 *
 * 参数补全（L4）故意不做: 服务器上没有 bash-completion
 * (实测_init_completion 未加载), 拿不到可靠的补全信息,硬做只会给出错误的候选。
 *
 * 远端查询只在连接空闲时执行，使用带超时的命令帧和子 shell，
 * 不把查询的 cd/env 写回会话状态。
 */
import { getExecFor } from './engine.mjs';

// ---------------------------------------------------------------- 缓存

const CMD_TTL_MS = 60 * 1000; // 命令名缓存 1 分钟
const DIR_TTL_MS = 30 * 1000; // 目录列表缓存 30 秒

let caches=new WeakMap();
function cacheFor(srv) {
  const rex=getExecFor(srv);
  let state=caches.get(rex);
  if(!state || state.session!==rex.session){state={session:rex.session,cmds:null,dirs:new Map(),inflight:new Map()};caches.set(rex,state);}
  return state;
}

/** 本地内建命令: 这些永远有效, 也不该被远端同名命令盖掉 */
const BUILTINS = [
  'exit',
  'quit',
  'help',
  'raw',
  'gpu',
  'list',
  'setup',
  'umount',
  'exec',
  'rclone',
  'history',
];

/** 重置缓存（切服务器 / 手动调用时用） */
export function resetCompletionCache() {
  caches=new WeakMap();
}

// ---------------------------------------------------------------- 远端查询

/** 同一个 key 并发只发一次请求, 避免连按 Tab 打出一堆重复查询 */
async function once(state, key, fn) {
  if (state.inflight.has(key)) return state.inflight.get(key);
  const p = fn().finally(() => state.inflight.delete(key));
  state.inflight.set(key, p);
  return p;
}

/** 拉远端命令名列表 (L2) */
async function remoteCommands(srv) {
  const state=cacheFor(srv);
  if (state.cmds && Date.now() - state.cmds.at < CMD_TTL_MS) return state.cmds.list;
  return once(state,'cmds', async () => {
    //compgen -c 会带上别名的名字和内建, 去重后过滤掉明显不是命令的
    const r = await getExecFor(srv).query(
      "LC_ALL=C compgen -c 2>/dev/null | LC_ALL=C sort -u | LC_ALL=C grep -E '^[A-Za-z0-9_.+-]+$' | head -4000",
      { timeout: 8000 }
    );
    if (r.timedOut || !r.output) {
      if (state.cmds && Date.now() - state.cmds.at < CMD_TTL_MS * 3) return state.cmds.list;
      return [];
    }
    const list = r.output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    state.cmds = { list, at: Date.now() };
    return list;
  });
}

/**
 * 拉远端某个目录下的条目 (L3)。
 * 目录用尾斜杠标记 —— 本地无法可靠猜"无扩展名的到底是不是目录"
 * (像 /etc/hosts 这种文件就没有扩展名), 只能让远端用 test -d 明确告诉。
 */
async function remoteDir(srv, dir) {
  const state=cacheFor(srv);
  const hit = state.dirs.get(dir);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.list;
  return once(state,'dir:' + dir, async () => {
    const q = dir.replace(/'/g, "'\\''");
    // 每个条目跑一次 test -d: 慢一点(每个 1~2ms)但判断准确, 补全体验值得
    const r = await getExecFor(srv).query(
      `cd '${q}' 2>/dev/null || exit 0; LC_ALL=C; for f in * .[!.]*; do ` +
        `[ -e "$f" ] || continue; if [ -d "$f" ]; then printf '%s/\\n' "$f"; else printf '%s\\n' "$f"; fi; ` +
        `done | LC_ALL=C sort -u | head -2000`,
      { timeout: 12000 }
    );
    if (r.timedOut || !r.output) return hit ? hit.list : [];
    const list = r.output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    state.dirs.set(dir, { list, at: Date.now() });
    while(state.dirs.size>64)state.dirs.delete(state.dirs.keys().next().value);
    return list;
  });
}

// ---------------------------------------------------------------- 输入解析

/**
 * 拆出"光标前正在补的词"。readline 只会把我们负责的区段传进来,
 * 但仍要正确处理: 引号、空格、引号内的空格。
 * 返回 { word, start } —— start 是该词在 line 中的起始下标
 */
function currentWord(line) {
  let i = 0;
  let start = 0;
  let quote = null;
  let word = '';
  while (i < line.length) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        word += c;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      start = i + 1; // 引号本身不属于词
      word = '';
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      start = i + 1;
      word = '';
      i++;
      continue;
    }
    word += c;
    i++;
  }
  return { word, start, quote };
}

/** 前面有没有别的词? 有的话这一格是参数位, 不补命令名 */
function isFirstWord(line, start) {
  return line.slice(0, start).trim() === '';
}

// ---------------------------------------------------------------- 匹配

/**
 * 公共前缀; 没有公共前缀返回 null（readline 会列全部候选）
 */
function commonPrefix(items) {
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  let p = items[0];
  for (const s of items) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) return null;
  }
  return p;
}

/** 需要给带空格的候选加引号, 否则补完直接执行会散架 */
function needsQuote(s) {
  return /[\s'"\\$`!*?()[\]{};&|<>#~]/.test(s);
}

function shellQuote(s) {
  if (!needsQuote(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------- 主入口

/**
 * 补全入口。给 readline 用, 必须是 (line, callback) 异步形式。
 * @param {object} srv  server 对象
 * @param {string} line readline 传来的待补全区段
 * @param {(err, matches: string[]) => void} cb
 */
export function makeCompleter(srv, hooks = {}) {
  const isBusy = hooks.isBusy || (() => false);

  return function completer(line, cb) {
    const finish=matches=>cb(null,[matches,line]);
    // 任务运行中直接放弃: 此时发查询过去也只会等, 还可能干扰正在跑的任务
    if (isBusy()) return finish([]);

    const { word, start, quote } = currentWord(line);
    if (!word) return finish([]);
    const replaceStart=quote ? start-1 : start;
    const done=matches=>finish(matches.map(m=>line.slice(0,replaceStart)+m));

    const first = isFirstWord(line, replaceStart);
    let list;

    if (first) {
      // L1 + L2: 命令名
      const local = BUILTINS.filter((b) => b.startsWith(word));
      // 先立刻给本地的（零延迟），再异步补远端的
      if (local.length && word.length >= 1) {
        // 本地已能唯一确定, 就别打扰远端了
        if (local.length === 1 && local[0] === word) return done(local);
      }
      remoteCommands(srv)
        .then((remote) => {
          const all = [...new Set([...local, ...remote.filter((c) => c.startsWith(word))])];
          done(all.sort());
        })
        .catch(() => done(local));
      return;
    }

    // L3: 路径
    const slash = word.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
    const filePart = slash >= 0 ? word.slice(slash + 1) : word;
    const absDir = dirPart.startsWith('/');
    const queryDir = absDir ? dirPart : '.' + (dirPart ? '/' + dirPart : '');
    remoteDir(srv, queryDir)
      .then((entries) => {
        // 远端已用尾斜杠标出目录, 这里按 filePart 匹配时要把标记剥掉
        const hits = entries.filter((e) => {
          const base = e.endsWith('/') ? e.slice(0, -1) : e;
          return base.startsWith(filePart) && base !== '.' && base !== '..';
        });
        // 目录 -> 保留尾斜杠（能直接继续敲下一层）; 文件 -> 按需加引号
        const matches = hits.map((e) => {
          if (e.endsWith('/')) return shellQuote(dirPart + e);
          return shellQuote(dirPart + e);
        });
        done(matches);
      })
      .catch(() => finish([]));
  };
}

/** 导出给测试用 */
export const _internals = { currentWord, isFirstWord, commonPrefix, shellQuote, needsQuote, BUILTINS };
