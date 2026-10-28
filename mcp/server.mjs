#!/usr/bin/env node
/**
 * mcp/server.mjs — ssh-remote-bridge MCP server
 *
 * 把 ssh-remote-bridge 引擎暴露给 AI: 在远程 SSH 服务器上执行命令 / 读写文件 / 挂载管理。
 * 协议: MCP (JSON-RPC 2.0 over stdio, newline-delimited JSON)。
 * 零第三方依赖。
 *
 * stdout 只承载协议消息; 日志一律走 stderr。
 *
 * 注册方式见 README.md (在 ~/.workbuddy/mcp.json 加条目, 然后点"信任")。
 */
import * as readline from 'node:readline';
import * as engine from '../lib/engine.mjs';
import { ExecJobs, waitBudget } from '../lib/jobs.mjs';

const SERVER_INFO = { name: 'ssh-remote-bridge', version: '1.5.0' };
const jobs=new ExecJobs(engine);
const DEBUG = !!process.env.SRB_DEBUG;
let shuttingDown=false;
const INSTRUCTIONS =
  'Priorities: efficiency, token economy, then minimal context. ' +
  'Prefer host-native file search, targeted reads, patches and diffs on accessible mounted files; they are the same server files, not local copies. ' +
  'Use host-local tools for small-file parsing, format conversion and simple calculations. ' +
  'Run tests, builds, large data analysis, training and high-I/O bulk scans on the server with exec; return only relevant summaries. ' +
  'If mappings are unknown, discover them once with list_servers; reuse them until configuration changes or access fails. ' +
  'file_access.local_root is a verified recommendation from the MCP process; confirm the host can access it. unc_root is an unverified alternative. ' +
  'Use Windows paths with host tools and Linux paths with SSH tools. ' +
  'Use SSH read_file/write_file only when the mount is inaccessible, the path is outside the mapped root, or host file tools are unavailable. ' +
  'After any write failure, inspect the actual file before retrying or changing transports, especially for append. ' +
  'New mounts require SSHFS >=3.7.2 to fix existing-directory mkdir errors; upgrading the runtime requires remounting existing volumes. Report raw host-tool errors, especially backup/UNC errors; do not assume the mount failed or bypass host policy. ' +
  'Locate relevant files and lines before reading; prefer small edits over full rewrites. Avoid repeated reads and dumping whole files, datasets, binaries or logs into context. ' +
  'exec starts an isolated task in cwd (default remote_root); cd/export do not persist between MCP calls. ' +
  'exec yields after 1000 ms by default and returns queued/running plus result_id when unfinished. Read incremental output with read_result using next_offset and wait_ms (default 10000); do not busy-poll or rerun the command. Use cancel_exec to stop an active job. ' +
  'exec returns at most 8192 characters by default; explicitly set max_output_chars for more. Results expire 10 minutes after completion, disconnection or eviction (16 per profile, 32 total); active jobs are never evicted. ' +
  'Command channels reconnect on demand after 10 idle minutes; task timeouts and process-group cleanup also run on the server. Use setsid nohup with redirected stdin/stdout/stderr or a task manager for intentionally detached work. ' +
  'Reuse saved profiles; ask only for missing connection details and never invent or expose credentials.';

function fileAccess(srv, status) {
  return {
    remote_root: srv.remote,
    local_root: status.mount_ok && srv.mount ? srv.mount : status.drive_mounted && srv.drive ? srv.drive + '\\' : null,
    unc_root: engine.remoteToUnc(srv),
  };
}

async function serverViews(servers,signal) {
  const views=[];
  // Bound PowerShell/filesystem probes when many profiles are configured.
  for(let i=0;i<servers.length;i+=2)views.push(...await Promise.all(servers.slice(i,i+2).map(async s=>{
    const status=await engine.serverMountStatus(s,{signal});
    return {name:s.name,host:s.host,port:s.port,user:s.user,mount:s.mount,drive:s.drive,remote:s.remote,default:s.default,note:s.note,...status,file_access:fileAccess(s,status)};
  })));
  return views;
}

function charLength(text) {let length=0;for(const char of text)length++;return length;}
function prefixText(text,count) {
  let end=0;
  for(let i=0;i<count && end<text.length;i++)end+=text.codePointAt(end)>0xffff?2:1;
  return text.slice(0,end);
}
function suffixText(text,count) {
  let start=text.length;
  for(let i=0;i<count && start>0;i++){start--;if(start>0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start-1]))start--;}
  return text.slice(start);
}

function limitOutput(output, maxChars) {
  const length=charLength(output);
  if (length <= maxChars) return { text: output, shortened: false };
  const head = Math.ceil(maxChars / 2);
  const tail = Math.floor(maxChars / 2);
  const notice = `\n...[omitted ${length - maxChars} characters; max_output_chars=${maxChars}; use read_result or query a saved log]...\n`;
  return { text: prefixText(output,head) + notice + suffixText(output,tail), shortened: true };
}

function log(...args) {
  if (DEBUG) process.stderr.write(`[ssh-remote-mcp] ${args.join(' ')}\n`);
}

function send(msg) {
  if(shuttingDown)return;
  const s = JSON.stringify(msg);
  process.stdout.write(s + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolText(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], isError };
}
function pageReply(label,r,format='auto') {
  if(format==='text' && !r.isText) return toolText(label+' is binary; use the mount or explicitly request base64',true);
  const raw=format==='base64', next=raw ? r.offset+r.raw_size : r.next_offset;
  const head=`${label} bytes=${r.total_size} offset=${r.offset} next_offset=${next}${next<r.total_size?' MORE':''}${!r.isText?' BINARY':''}`;
  return toolText(head+'\n'+(raw?r.base64:r.isText?r.text:'(binary content omitted; use the mount or format=base64)'));
}

function progress(j,token,maxChars,signal) {
  if(typeof token!=='string' && !Number.isInteger(token))return ()=>{};
  let stopped=false,busy=false,revision=-1,offset=0,sent=0;
  const controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setInterval(async()=>{
    if(stopped || busy || sent>=maxChars || !j.ref || revision===j.revision)return;
    busy=true;revision=j.revision;
    try {
      const r=await jobs.page(j.id,offset,2048,{signal:controller.signal});offset=r.next_offset;
      const message=prefixText(r.text||'',maxChars-sent);
      if(!stopped && message){sent+=charLength(message);send({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:token,progress:sent,message}});}
    } catch {} finally {busy=false;}
  },500);
  return ()=>{stopped=true;clearInterval(timer);controller.abort();signal?.removeEventListener('abort',abort);};
}

// ---------------------------------------------------------------- 工具定义

const TOOLS = [
  {
    name: 'list_servers',
    description:
      'Discover saved servers and file_access mappings without SSH. Prefer host file tools on the accessible local_root. ' +
      'Reuse known mappings; refresh only after configuration changes or access failures. Passwords are omitted.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'configure_server',
    description:
      'Create or merge a saved profile using supplied fields only; existing credentials need not be resent. ' +
      'New profiles require host, user and password or keyFile; hostkey is fetched if absent. ' +
      'Passwords are stored locally in servers.json and redacted in replies. Never invent or expose credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Server profile name used by the other tools (default: myserver).' },
        host: { type: 'string', description: 'Server IP address or hostname, as provided by the user.' },
        port: { type: 'number', description: 'SSH port (default 22).' },
        user: { type: 'string', description: 'SSH login user, as provided by the user.' },
        password: { type: 'string', description: 'SSH password, as provided by the user. Stored in servers.json only.' },
        keyFile: { type: 'string', description: 'Private key file path, as an alternative to password.' },
        hostkey: { type: 'string', description: 'SSH host key fingerprint (SHA256:...). Optional — fetched automatically if omitted.' },
        mount: { type: 'string', description: 'Local folder the server maps into, e.g. D:\\myserver.' },
        drive: { type: 'string', description: 'Drive letter used for the mapping, e.g. M:. Needed for file mapping only.' },
        remote: { type: 'string', description: 'Remote directory to expose (default /home/<user>).' },
        isDefault: { type: 'boolean', description: 'Make this the default server (default false unless it is the only one).' },
        note: { type: 'string', description: 'Free-form note shown by "ssh-remote list".' },
      },
      required: [],
    },
  },
  {
    name: 'exec',
    description:
      'Start server work over persistent SSH with isolated cwd/environment. Yield after 1000 ms by default; unfinished jobs return result_id for incremental read_result or cancel_exec. ' +
      'Prefer host tools for mounted-file edits and small calculations. Return summaries; save large logs remotely. ' +
      'Replies default to 8192 characters (head and tail); remote capture separately has a 2 MiB limit. ' +
      'Real failure, timeout and cancellation states are preserved. Timeout interrupts the job. Remaining command-group children are cleaned up; use setsid nohup with redirected stdin/stdout/stderr or a task manager for intentionally detached work.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from servers.json. Omit for the default server.' },
        command: { type: 'string', description: 'The shell command to execute on the server.' },
        cwd: { type: 'string', description: 'Linux absolute working directory; defaults to the profile remote root. Set explicitly for project commands.' },
        timeout: { type: 'number', minimum:1, maximum:3600, description: 'Execution seconds after queueing/handshake (default 120, range 1–3600). Timeout interrupts the remote group; cancellation also stops queued waits.' },
        max_output_chars: { type: 'integer', default: 8192, minimum: 1, maximum: 2097152, description: 'Returned body character budget; retains head and tail, excluding status and omission notice. Does not change execution or remote capture.' },
        yield_time_ms:{type:'integer',default:1000,minimum:0,maximum:30000,description:'How long this tool call waits; the job continues after yielding. Use read_result with next_offset to read live output.'},
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description:
      'SSH fallback for reading a Linux absolute path when host file tools or the mapped file are inaccessible, or the path is outside the mapping. ' +
      'Prefer mounted-file reads. Paginate by byte offset; binary defaults to metadata. Request format=base64 only when necessary.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name. Omit for default.' },
        path: { type: 'string', description: 'Absolute file path on the server, e.g. /home/user/train.log' },
        max_bytes: { type: 'integer', default:8192, minimum:1, maximum:1048576, description: 'Page byte budget; text ends at a complete UTF-8 character.' },
        offset: { type:'integer', default:0, minimum:0, description:'Byte offset; reuse next_offset from the previous page.' },
        format: {type:'string',enum:['auto','text','base64'],default:'auto'},
      },
      required: ['path'],
    },
  },
  {
    name:'read_result',
    description:'Read new output while an exec job is running or after it finishes. Reuse next_offset; wait_ms waits for new output or completion instead of busy-polling. Reading does not rerun or cancel the job. Binary defaults to metadata.',
    inputSchema:{type:'object',properties:{result_id:{type:'string'},offset:{type:'integer',minimum:0,default:0},max_bytes:{type:'integer',minimum:1,maximum:65536,default:8192},wait_ms:{type:'integer',minimum:0,maximum:30000,default:10000},format:{type:'string',enum:['auto','text','base64'],default:'auto'}},required:['result_id']},
  },
  {
    name:'cancel_exec',description:'Request cancellation of an active exec result_id. Stops queued work or interrupts its remote process group. Read the result to confirm the final status; cancellation does not roll back side effects.',
    inputSchema:{type:'object',properties:{result_id:{type:'string'}},required:['result_id']},
  },
  {
    name: 'write_file',
    description:
      'SSH fallback for writing a Linux absolute path; prefer host-native patches and diffs on accessible mounted files. ' +
      'Overwrite stages content before replacement; append is not atomic. After a write failure inspect the file before any retry or transport switch.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name. Omit for default.' },
        path: { type: 'string', description: 'Absolute file path on the server.' },
        content: { type: 'string', description: 'Text content to write (UTF-8).' },
        append: { type: 'boolean', description: 'Append instead of overwrite (default false).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'mount_server',
    description:
      'Mount a saved profile using SSHFS-Win/WinFsp and its configured drive and optional directory link. ' +
      'Refresh file_access after success, then prefer host-native file tools on the mounted files.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from servers.json.' },
      },
      required: ['server'],
    },
  },
  {
    name: 'unmount_server',
    description: 'Unmount a server: deletes its drive-letter mapping. The symlink at the mount path is kept.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from servers.json.' },
      },
      required: ['server'],
    },
  },
  {
    name: 'server_status',
    description:
      'Refresh one server\'s drive ownership, readability, file_access mapping and SSH channel status without connecting SSH. Use after access failures or configuration changes.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name. Omit for default.' },
      },
      required: [],
    },
  },
  {
    name: 'trust_host',
    description:
      'Fetch SSH host key fingerprints for a new or untrusted host; save the intended fingerprint as hostkey with configure_server.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Hostname or IP of the server.' },
        port: { type: 'number', description: 'SSH port (default 22).' },
      },
      required: ['host'],
    },
  },
];

// ---------------------------------------------------------------- 工具实现

async function callTool(name, args, signal, meta) {
  args = args || {};
  try {
    signal?.throwIfAborted();
    if(args.format!==undefined && !['auto','text','base64'].includes(args.format)) throw new Error('format must be auto, text or base64');
    switch (name) {
      case 'list_servers': {
        const st = engine.configState();
        if (!st.ok) {
          const head = st.missing
            ? 'No server is configured yet (servers.json has no entries).\n'
            : 'servers.json exists but is not usable (' + st.error + ').\n';
          return toolText(
            head +
              'Config file: ' + st.file + '\n' +
              (st.missing
                ? 'Ask for missing host, user and password/keyFile, then configure_server. A drive is needed for mounting. Never guess credentials.'
                : 'Inspect and repair the existing configuration; do not overwrite it or ask for saved credentials again without checking the error.'),
            true
          );
        }
        const servers = await serverViews(engine.listServers(),signal);
        return toolText(JSON.stringify({ config: st.file, servers }, null, 2));
      }

      case 'configure_server': {
        const r = await engine.saveServer(args,{signal});
        const lines = [
          `saved server "${r.name}" to ${r.file}${r.created ? ' (new entry)' : ' (updated existing entry)'}`,
          '',
          JSON.stringify(r.entry, null, 2),
        ];
        if (r.hostkeyFetched) lines.push('', 'SSH host key was fetched automatically (trust_host).');
        if (r.warnings.length) lines.push('', 'warnings:', ...r.warnings.map((w) => '  - ' + w));
        lines.push(
          '',
          r.entry.drive
            ? 'Refresh file_access for this profile; use host file tools on an accessible mount, or mount_server if needed. Use exec for heavy server work.'
            : 'SSH execution and file fallback tools are available. Configure a drive if local mounted-file access is needed.'
        );
        return toolText(lines.join('\n'));
      }

      case 'exec': {
        if (typeof args.command!=='string' || !args.command.trim()) return toolText('command must be a nonempty string', true);
        const maxChars = args.max_output_chars === undefined ? 8192 : args.max_output_chars;
        if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 2097152) {
          return toolText('max_output_chars must be an integer from 1 to 2097152', true);
        }
        const yieldMs=waitBudget(args.yield_time_ms===undefined?1000:args.yield_time_ms,'yield_time_ms');
        const srv = engine.getServer(args.server);
        const timeout=args.timeout===undefined ? 120 : args.timeout;
        if(typeof timeout!=='number' || !Number.isFinite(timeout) || timeout<1 || timeout>3600) throw new Error('timeout must be a number from 1 to 3600 seconds');
        const cwd=args.cwd===undefined ? srv.remote : args.cwd;
        if(typeof cwd!=='string' || !cwd.startsWith('/') || /[\0\r\n]/.test(cwd))throw new Error('cwd must be a Linux absolute path');
        const j=jobs.start(srv,args.command,{timeout,isolated:true,cwd,maxOutputChars:maxChars});
        const onAbort=()=>jobs.cancel(j.id);signal?.addEventListener('abort',onAbort,{once:true});
        const stopProgress=progress(j,meta?.progressToken,maxChars,signal);
        let r;
        try {
          r=await jobs.settle(j,yieldMs,signal);
          if(!r) {
            const page=await jobs.page(j.id,0,Math.min(65536,maxChars*4+8),{signal});
            if(j.result)r=j.result;
            else {
              const text=page.isText ? prefixText(page.text,maxChars) : '';
              const next=page.isText ? Buffer.byteLength(text) : page.next_offset;
              return toolText(`[${srv.name}] state=${page.state} cwd=${page.cwd} result_id=${j.id} next_offset=${next}${page.capture_limited?' REMOTE-CAPTURE-LIMIT':''}\n${text || (page.isText?'(no output yet; read_result waits for new output)':'(binary content omitted)')}`);
            }
          }
          r={...r,resultId:j.id};
        } finally {stopProgress();signal?.removeEventListener('abort',onAbort);}
        // 非零退出码显式标 FAILED: 大模型只看 isError 容易误判成功, 文本里必须刺眼
        const failed = !r.done || r.exitCode !== 0 || r.timedOut || r.spawnFailed || r.interrupted || r.aborted;
        const prefix=[r.error,r.output].filter(Boolean).join('\n');
        const output = r.outputTail==null ? prefix : prefixText(prefix,Math.ceil(maxChars/2))+'\n...[remote response shortened; use read_result]...\n'+suffixText(r.outputTail,Math.floor(maxChars/2));
        const body = r.outputTail==null ? limitOutput(output,maxChars) : {text:output,shortened:true};
        const head =
          `[${srv.name}] cwd=${r.cwd || args.cwd || srv.remote || '?'} exit=${r.exitCode}${failed ? ' FAILED' : ''} ` +
          `duration=${r.duration}s${r.resultId ? ' result_id='+r.resultId : ''}${r.timedOut ? ' TIMED-OUT' : ''}${r.spawnFailed ? ' CHANNEL-FAILED' : ''}` +
          `${r.interrupted || r.aborted ? ' CANCELLED' : ''}${r.truncated ? ' REMOTE-CAPTURE-LIMIT' : ''}${body.shortened ? ' RESPONSE-LIMIT' : ''}`;
        return toolText(`${head}\n${body.text || '(no output)'}`, !!failed);
      }

      case 'read_result': {
        if(typeof args.result_id!=='string') throw new Error('result_id is required');
        const waitMs=waitBudget(args.wait_ms===undefined?10000:args.wait_ms,'wait_ms');
        const options={signal,format:args.format,waitMs};
        const r=await (jobs.has(args.result_id)?jobs.page(args.result_id,args.offset===undefined?0:args.offset,args.max_bytes===undefined?8192:args.max_bytes,options):engine.readResult(args.result_id,args.offset===undefined?0:args.offset,args.max_bytes===undefined?8192:args.max_bytes,options));
        const failed=(r.state===undefined || r.state==='completed') && (r.exitCode!==0 || r.timedOut || r.interrupted);
        const reply=pageReply(`[${r.server}] result_id=${args.result_id}${r.state?' state='+r.state:''} exit=${r.exitCode}${failed?' FAILED':''}${r.spawnFailed?' CHANNEL-FAILED':''}${r.timedOut?' TIMED-OUT':''}${r.interrupted?' CANCELLED':''}${r.capture_limited?' REMOTE-CAPTURE-LIMIT':''}`,r,args.format);
        reply.isError ||= !!failed;
        return reply;
      }

      case 'cancel_exec': {
        if(typeof args.result_id!=='string')throw new Error('result_id is required');
        const j=jobs.cancel(args.result_id);return toolText(`[${j.server}] result_id=${j.id} state=${j.state}; read_result for final status`);
      }

      case 'read_file': {
        if (!args.path) return toolText('missing required argument: path', true);
        const srv = engine.getServer(args.server);
        const maxBytes = args.max_bytes===undefined ? 8192 : args.max_bytes;
        const r = await engine.readFileRemoteSmart(srv, args.path, maxBytes, { signal, offset:args.offset===undefined?0:args.offset, format:args.format });
        if (!r.ok) return toolText(`[${srv.name}] read ${args.path} failed: ${r.error}`, true);
        return pageReply(`[${srv.name}] ${args.path}`,r,args.format);
      }

      case 'write_file': {
        if (!args.path || args.content === undefined) return toolText('missing required arguments: path, content', true);
        if(typeof args.content!=='string') throw new Error('content must be a string');
        if(args.append!==undefined && typeof args.append!=='boolean') throw new Error('append must be boolean');
        const srv = engine.getServer(args.server);
        const r = await engine.writeFileRemoteSmart(srv, args.path, args.content, { append: args.append??false, signal });
        const head = `[${srv.name}] write ${args.path} exit=${r.exitCode} bytes=${r.bytes}${args.append ? ' (append)' : ''}`;
        if (!r.ok) return toolText(`${head}\n${r.output}`, true);
        return toolText(head);
      }

      case 'mount_server': {
        if (!args.server) return toolText('missing required argument: server', true);
        const srv = engine.getServer(args.server);
        const r = await engine.mountServer(srv,{signal});
        let body = r.steps.join('\n');
        if (!r.ok && r.stuck) body += `\n\nSTUCK DRIVE (${r.stuck.kind})\n${r.stuck.fix}`;
        if (!r.ok) return toolText(`[${srv.name}] mount FAILED\n${body}\nERROR: ${r.error}`, true);
        return toolText(`[${srv.name}] mount OK${r.warning ? ' (warning: ' + r.warning + ')' : ''}\n${body}`);
      }

      case 'unmount_server': {
        if (!args.server) return toolText('missing required argument: server', true);
        const srv = engine.getServer(args.server);
        const r = await engine.umountServer(srv,{signal});
        let body = r.steps.join('\n');
        if (r.stuck) body += `\n\nSTUCK DRIVE (${r.stuck.kind})\n${r.stuck.fix}`;
        return toolText(`[${srv.name}] unmount ${r.ok ? 'OK' : 'FAILED'}\n${body}\n${r.error || ''}`, !r.ok);
      }

      case 'server_status': {
        const srv = engine.getServer(args.server);
        const status = await engine.serverMountStatus(srv,{signal});
        const persist = engine.persistChannelStatus(srv);
        return toolText(
          JSON.stringify(
            {
              server: srv.name,
              host: `${srv.user}@${srv.host}:${srv.port}`,
              drive: srv.drive,
              ...status,
              mount_path: srv.mount,
              file_access: fileAccess(srv, status),
              persist_channel: persist,
            },
            null,
            2
          )
        );
      }

      case 'trust_host': {
        if (!args.host) return toolText('missing required argument: host', true);
        const r = await engine.fetchHostKeyAsync(args.host, args.port??22,{signal});
        if (!r.ok) return toolText(r.error, true);
        return toolText(
          `Host key fingerprints for ${args.host}:${args.port || 22}:\n${r.fingerprints.map((f) => '  ' + f).join('\n')}\n\n` +
            `Copy the SHA256:... line into servers.json as the "hostkey" field of this server.`
        );
      }

      default:
        return toolText(`unknown tool: ${name}`, true);
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // Keep configuration errors actionable without asking for already saved credentials.
    if (/config|servers\.json|not found\. available/i.test(msg)) {
      return toolText(
        `${msg}\nInspect the saved configuration or profile name; ask only for missing details. Never guess credentials or overwrite an invalid config.`,
        true
      );
    }
    return toolText(`error: ${msg}`, true);
  }
}

// ---------------------------------------------------------------- 协议处理

const requests = new Map();
async function handleMessage(req) {
  if(shuttingDown)return;
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  // 通知 (无 id) 不回复
  if (id === undefined || id === null) {
    if (method === 'notifications/cancelled') requests.get(params?.requestId)?.abort();
    log('notification:', method);
    return;
  }

  log('request:', method); // Never log tool arguments or credentials.

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      const args = params && params.arguments;
      if (requests.has(id)) return replyError(id, -32600, 'duplicate active request id');
      const controller=new AbortController(); requests.set(id,controller);
      try { const result=await callTool(name,args,controller.signal,params?._meta); return reply(id,result); }
      finally {requests.delete(id);}
    }

    case 'resources/list':
      return reply(id, { resources: [] });

    case 'prompts/list':
      return reply(id, { prompts: [] });

    default:
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const shutdown=()=>{
    if(shuttingDown)return;
    shuttingDown=true;rl.close();
    for(const c of requests.values())c.abort();
    void Promise.allSettled([jobs.close(),engine.closeAllPersist()]).then(()=>{process.exitCode ||= 0;});
  };
  rl.on('line', (line) => {
    if(shuttingDown)return;
    const t = line.trim();
    if (!t) return;
    let req;
    try {
      req = JSON.parse(t);
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${e.message}` } });
      return;
    }
    Promise.resolve(handleMessage(req)).catch((e) => {
      if (req && req.id !== undefined && req.id !== null) {
        replyError(req.id, -32603, `internal error: ${e.message}`);
      }
    });
  });
  rl.on('close',shutdown);
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('SIGHUP',shutdown);
  process.stdout.on('error',error=>{if(error.code!=='EPIPE')process.exitCode=1;shutdown();});
  log('ssh-remote-bridge MCP server started, config:', engine.CONFIG_PATH);
}

main();
