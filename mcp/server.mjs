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

const SERVER_INFO = { name: 'ssh-remote-bridge', version: '1.2.0' };
const DEBUG = !!process.env.SRB_DEBUG;

function log(...args) {
  if (DEBUG) process.stderr.write(`[ssh-remote-mcp] ${args.join(' ')}\n`);
}

function send(msg) {
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

// ---------------------------------------------------------------- 工具定义

const TOOLS = [
  {
    name: 'list_servers',
    description:
      'List all SSH servers configured in servers.json (name, host, user, mount point, drive letter, note). ' +
      'Does NOT return passwords. Call this first to learn which server names are available. ' +
      'IMPORTANT: if this fails or there are no servers, servers.json is not set up yet — do NOT guess or reuse ' +
      'any IP/user/password you may have seen elsewhere. ASK THE USER for: host (IP or hostname), port, login user, ' +
      'password (or a private key path), which local folder the server should map into (e.g. D:\\myserver) and a ' +
      'drive letter (e.g. M:), then call configure_server with exactly what the user gave you.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'configure_server',
    description:
      'Create or update one server entry in servers.json. USE ONLY WITH VALUES THE USER JUST GAVE YOU — ' +
      'never invent or reuse credentials. Ask the user first for: (1) server name (optional, default "myserver"), ' +
      '(2) host = server IP or hostname, (3) port (default 22), (4) login user, (5) password OR private-key path, ' +
      '(6) the local folder to map the server into (e.g. D:\\myserver) and a free drive letter (e.g. M:), ' +
      '(7) optional: remote home dir, note, and whether this is the default server. ' +
      'The SSH host key is fetched automatically if the user does not have it. ' +
      'The password is stored in servers.json in plain text (that file is the only place it lives; never echo it back, ' +
      'never put it into code, docs or your own notes). Returns the saved entry with the password redacted.',
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
      required: ['host', 'user'],
    },
  },
  {
    name: 'exec',
    description:
      'Execute a shell command on a remote SSH server. ' +
      'Call list_servers first to learn the server names; if the server list is empty, ASK THE USER for connection ' +
      'details and call configure_server (never guess credentials). ' +
      'Runs over a persistent SSH channel ' +
      '(first command pays the ~5s connection setup, then each command is ms-level). ' +
      'cd/export state persists between commands on the same channel. ' +
      'The result header always carries the real exit code: a non-zero exit is marked "FAILED". ' +
      'Concurrent calls are queued on the channel, so results come back one at a time. ' +
      'Commands with special characters (quotes, pipes, $) are transported safely via base64. ' +
      'For long-running jobs use nohup ... & and poll the log file (a command that exceeds ' +
      'timeout is killed on the server). Use raw interactive programs (vim/htop) via the ssh-remote CLI instead.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name from servers.json. Omit for the default server.' },
        command: { type: 'string', description: 'The shell command to execute on the server.' },
        timeout: { type: 'number', description: 'Max seconds to wait for completion (default 120, max 3600). On timeout the remote job is killed.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file from a remote server (absolute path). Text files are returned as text; binary files as base64. ' +
      'Truncated to max_bytes. Goes over the persistent SSH channel (ms-level after the first connect). ' +
      'For bulk browsing prefer the mounted local folder instead.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name. Omit for default.' },
        path: { type: 'string', description: 'Absolute file path on the server, e.g. /home/user/train.log' },
        max_bytes: { type: 'number', description: 'Max bytes to read (default 65536, max 1048576).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write text content to a file on a remote server (absolute path). Content is transported base64-encoded ' +
      'and written atomically in one shot over the persistent SSH channel. ' +
      'Overwrites by default; set append=true to append.',
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
      'Mount a configured server to the local machine: maps the remote directory to a Windows drive letter (persistent) ' +
      'and creates a symlink at the configured mount path (e.g. D:\\myserver). After this, the server files are visible ' +
      'in Explorer/VS Code. Requires WinFsp + SSHFS-Win installed (see README). ' +
      'The mount path and drive letter come from configure_server / servers.json — ask the user which local folder ' +
      'and drive letter they want if they are not set yet.',
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
      'Check a server: drive mounted? mount path readable? tmux session alive on the server?',
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
      'Fetch the SSH host key fingerprint (SHA256:...) of a server so it can be filled into the "hostkey" field of ' +
      'servers.json. Needed when adding a NEW server whose host key is not yet known. ' +
      'After getting the fingerprint, add it to servers.json; without it plink refuses the connection.',
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

async function callTool(name, args) {
  args = args || {};
  try {
    switch (name) {
      case 'list_servers': {
        const st = engine.configState();
        if (!st.ok) {
          const head = st.missing
            ? 'No server is configured yet (servers.json has no entries).\n'
            : 'servers.json exists but is not usable (' + st.error + ').\n';
          return toolText(
            head +
              'Config file: ' + st.file + '\n\n' +
              'ASK THE USER FOR THESE VALUES — do NOT guess, infer, or reuse any IP/host/user/password ' +
              'you may have seen in other files, docs, or earlier conversations:\n' +
              '  1) server name            (optional, default "myserver")\n' +
              '  2) host                   = server IP address or hostname\n' +
              '  3) port                   (default 22)\n' +
              '  4) user                = SSH login name\n' +
              '  5) password               (or a private key file path)\n' +
              '  6) local folder + drive letter the server should map into (e.g. D:\\myserver + M:)\n' +
              'Then call configure_server with exactly the values the user gave you.',
            true
          );
        }
        const servers = engine.listServers().map((s) => ({
          name: s.name,
          host: s.host,
          port: s.port,
          user: s.user,
          mount: s.mount,
          drive: s.drive,
          remote: s.remote,
          default: s.default,
          note: s.note,
          drive_mounted: engine.driveMounted(s.drive),
          mount_ok: engine.mountOk(s.mount),
        }));
        return toolText(JSON.stringify({ config: st.file, servers }, null, 2));
      }

      case 'configure_server': {
        if (!args.host || !args.user) {
          return toolText(
            'missing required arguments: host, user.\n' +
              'Ask the user for the connection details first (host/IP, port, user, password or key file, ' +
              'local mount folder + drive letter), then call this tool with their answers.',
            true
          );
        }
        const r = await engine.saveServer(args);
        const lines = [
          `saved server "${r.name}" to ${r.file}${r.created ? ' (new entry)' : ' (updated existing entry)'}`,
          '',
          JSON.stringify(r.entry, null, 2),
        ];
        if (r.hostkeyFetched) lines.push('', 'SSH host key was fetched automatically (trust_host).');
        if (r.warnings.length) lines.push('', 'warnings:', ...r.warnings.map((w) => '  - ' + w));
        lines.push(
          '',
          r.entry.mount && r.entry.drive
            ? 'Next: call mount_server to map the folder (net use + symlink). Command execution works already.'
            : 'Command execution (exec/read_file/write_file) works now. File mapping needs mount + drive, which were not set.'
        );
        return toolText(lines.join('\n'));
      }

      case 'exec': {
        if (!args.command) return toolText('missing required argument: command', true);
        const srv = engine.getServer(args.server);
        const timeout = Math.min(Math.max(Number(args.timeout) || 120, 5), 3600);
        const r = await engine.execOnSmart(srv, args.command, { timeout });
        // 非零退出码显式标 FAILED: 大模型只看 isError 容易误判成功, 文本里必须刺眼
        const failed = r.exitCode !== null && r.exitCode !== 0 && !r.timedOut;
        const head =
          `[${srv.name}] ${srv.user}@${srv.host} exit=${r.exitCode}${failed ? ' FAILED' : ' ok'} ` +
          `duration=${r.duration}s via=${r.via || 'tmux'}${r.timedOut ? ' TIMED-OUT' : ''}${r.spawnFailed ? ' CHANNEL-FAILED' : ''}`;
        if (!r.done && !r.timedOut) {
          return toolText(`${head}\n${r.error || ''}\n${r.output}`, true);
        }
        return toolText(`${head}\n${r.output || '(no output)'}`);
      }

      case 'read_file': {
        if (!args.path) return toolText('missing required argument: path', true);
        const srv = engine.getServer(args.server);
        const maxBytes = Math.min(Math.max(Number(args.max_bytes) || 65536, 1), 1048576);
        const r = await engine.readFileRemoteSmart(srv, args.path, maxBytes);
        if (!r.ok) return toolText(`[${srv.name}] read ${args.path} failed: ${r.error}`, true);
        const head = `[${srv.name}] ${args.path} (${r.size} bytes${r.size >= maxBytes ? ', TRUNCATED at max_bytes' : ''}${r.isText ? '' : ', BINARY -> base64'})`;
        return toolText(`${head}\n${r.isText ? r.text : r.base64}`);
      }

      case 'write_file': {
        if (!args.path || args.content === undefined) return toolText('missing required arguments: path, content', true);
        const srv = engine.getServer(args.server);
        const r = await engine.writeFileRemoteSmart(srv, args.path, args.content, { append: !!args.append });
        const head = `[${srv.name}] write ${args.path} exit=${r.exitCode} bytes=${r.bytes}${args.append ? ' (append)' : ''}`;
        if (!r.ok) return toolText(`${head}\n${r.output}`, true);
        return toolText(head);
      }

      case 'mount_server': {
        if (!args.server) return toolText('missing required argument: server', true);
        const srv = engine.getServer(args.server);
        const r = engine.mountServer(srv);
        const body = r.steps.join('\n');
        if (!r.ok) return toolText(`[${srv.name}] mount FAILED\n${body}\nERROR: ${r.error}`, true);
        return toolText(`[${srv.name}] mount OK${r.warning ? ' (warning: ' + r.warning + ')' : ''}\n${body}`);
      }

      case 'unmount_server': {
        if (!args.server) return toolText('missing required argument: server', true);
        const srv = engine.getServer(args.server);
        const r = engine.umountServer(srv);
        return toolText(`[${srv.name}] unmount done\n${r.steps.join('\n')}`);
      }

      case 'server_status': {
        const srv = engine.getServer(args.server);
        const driveMounted = engine.driveMounted(srv.drive);
        const mountOk = engine.mountOk(srv.mount);
        const alive = engine.sessionAlive(srv);
        const persist = engine.persistChannelStatus(srv);
        return toolText(
          JSON.stringify(
            {
              server: srv.name,
              host: `${srv.user}@${srv.host}:${srv.port}`,
              drive: srv.drive,
              drive_mounted: driveMounted,
              mount_path: srv.mount,
              mount_ok: mountOk,
              tmux_session: srv.tmuxSession,
              tmux_alive: alive,
              persist_channel: persist,
            },
            null,
            2
          )
        );
      }

      case 'trust_host': {
        if (!args.host) return toolText('missing required argument: host', true);
        const r = await engine.fetchHostKeyAsync(args.host, Number(args.port) || 22);
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
    // 配置缺失/不可用时, 明确告诉 AI 该向用户索要什么, 而不是抛一个天书般的错误
    if (/config|servers\.json|not found\. available/i.test(msg)) {
      return toolText(
        `${msg}\n\nservers.json looks missing or incomplete. Do NOT guess credentials — ask the user for: ` +
          'server name, host/IP, port, user, password (or key file), local mount folder + drive letter. ' +
          'Then call configure_server with their answers (list_servers will also print this checklist).',
        true
      );
    }
    return toolText(`error: ${msg}`, true);
  }
}

// ---------------------------------------------------------------- 协议处理

async function handleMessage(req) {
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  // 通知 (无 id) 不回复
  if (id === undefined || id === null) {
    log('notification:', method);
    return;
  }

  log('request:', method, JSON.stringify(params || {}).slice(0, 200));

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      const args = params && params.arguments;
      const result = await callTool(name, args);
      return reply(id, result);
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
  rl.on('line', (line) => {
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
  rl.on('close', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  log('ssh-remote-bridge MCP server started, config:', engine.CONFIG_PATH);
}

main();
