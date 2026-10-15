# ssh-remote-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-5FA04E.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4.svg)](https://learn.microsoft.com/windows/)

**简体中文** | [English](README.en.md)

> A **file mapping + command forwarding** system for remote servers (Windows ↔ Linux).
> Three ways in: **drive mapping**, a **command line**, and an **MCP server for AI clients**.
> Multi-server, multi-account, pluggable — adding a server means editing one config file.

Open `M:\` in VS Code and you're editing files on the server. Type a command in any terminal
and it runs on the server. AI clients (WorkBuddy / Codex / anything speaking MCP) can drive
the server through tools directly.

**Millisecond responses**: one persistent SSH connection. The first handshake costs ~5.6s
(server-side KEX/PAM); every command after that takes **4-35ms** (measured). `cd` and exported
variables survive across commands.

```bat
:: 1) Dependencies: Node.js >= 18 + plink.exe (required, see §4.1)
::    File mapping additionally needs WinFsp + SSHFS-Win.
::    This repo ships NO binaries - download them from the official sites.
check_deps.cmd              :: one-shot check; tells you where to get whatever is missing

:: 2) Configure a server (copy the template, or just ask AI "set up this server for me")
copy servers.example.json servers.json

:: 3) Mount and go
setup_ssh-remote.cmd
ssh-remote.cmd                :: drop into the remote shell

:: 4) After a reboot, restore the mappings (safe to run any number of times)
remount_all.cmd
```

For AI clients:

```bat
register_mcp.cmd          :: register with WorkBuddy
register_mcp_codex.cmd    :: register with Codex
```

> **No dependency on any particular AI client** — it implements standard MCP over
> stdio + JSON-RPC, so WorkBuddy, Codex, Claude Desktop and any other MCP client can connect.

> **This repo contains source code only — no `.exe` or `.msi` files.** Get the drivers from
> their official sites (§4.1). Clone stays under 1MB and you always get the current upstream
> release.

[中文](README.md) | **English**

---

<details>
<summary><b>Full manual (12 chapters)</b></summary>

# ssh-remote-bridge manual

---

## Contents

1. [What this is](#1-what-this-is)
2. [Architecture](#2-architecture)
3. [Files](#3-files)
4. [Quick start](#4-quick-start)
5. [servers.json reference](#5-serversjson-reference)
6. [The ssh-remote CLI](#6-the-ssh-remote-cli)
7. [MCP server](#7-mcp-server)
   - [**7.2 Hard rule: the AI must ask the user for connection details first**](#72-hard-rule-the-ai-must-ask-the-user-for-connection-details-first)
8. [How mounting works](#8-how-mounting-works)
9. [Adding another server](#9-adding-another-server)
10. [Security](#10-security)
11. [Troubleshooting](#11-troubleshooting)
12. [Known limits](#12-known-limits)

---

## 1. What this is

In one sentence: **map a remote Linux server's home directory to a local drive letter (e.g. `M:\`), and from there — files you see are the server's files, commands you run execute on the server.**

Three entry points, covering three situations:

| Entry point | For whom | What it does |
|---|---|---|
| The `M:\` drive | humans | Browse and edit server files in VS Code / Explorer |
| The `ssh-remote` CLI | humans | Type commands in any terminal; they run on the server, exit code and output come back verbatim |
| **The MCP server** | AI models | The AI calls tools itself to run commands, read/write files, check status, manage mounts |

Key properties:

- **You use the server's compute**: commands run in the server's own shell, so CPU / GPU / conda all work (verified on a multi-GPU box)
- **Millisecond responses**: one persistent SSH connection pays the handshake once (~5.6s, server-side KEX/PAM); every later command takes **4-35ms** (measured)
- **State is kept**: commands run inside a long-lived executor on the server, so `cd` and exported variables persist
- **Exit codes are truthful**: `echo $?` level fidelity, so shell scripting is reliable
- **Special characters are safe**: commands travel as base64 frames; quotes, pipes, `$` and newlines survive intact
- **Ctrl+C really interrupts**: an interrupt frame hits the remote process group (SIGTERM, escalating to KILL after 2s) without touching your local machine
- **Multi-server and pluggable**: every server lives in `servers.json`; adding one means adding a JSON entry
- **Zero third-party Node dependencies**: Node built-ins + system plink + SSHFS-Win

---

## 2. Architecture

```
┌───────────────────────── Local Windows ─────────────────────────┐
│                                                                │
│   M: ──net use──▶ SSHFS-Win      (optional: F:\xxx ──mklink──▶ M: ) │
│   ▲                 │             not needed when "mount" is unset │
│   │                 │             (see §8)│
│   └─ VS Code / Explorer / any tool read & write server files  │           │
│                                                                │
│   ssh-remote CLI ──┐                                           │
│            ├── plink (persistent SSH) ──▶ bash loop on server ──┼──┐
│   MCP ◀────┘         commands as base64 frames   output/exit/cwd back  │  │
│                                                                │  │
└────────────────────────────────────────────────────────────────┼──┘
                                                                 ▼
                                              Linux server (full CPU/GPU/conda)
```

### The command forwarding protocol (v4, measured)

Here is what happens behind `ssh-remote> nvidia-smi`:

1. **Connect (once)**: plink connects and writes `lib/exec-loop.sh` (base64, inlined into the
   connect command line) to a remote temp file and runs it; the remote side enters a bash loop
   holding that connection open. **The handshake takes ~5.6s** — the cost is server-side SSH
   KEX/PAM and has nothing to do with the client (VS Code Remote-SSH costs the same on first connect)
2. **Send**: the command is base64-encoded with a token and sent as one frame
3. **Carry state**: the executor restores the previous `cd` and environment before running, then
   saves them afterwards — **which is why state survives across commands**
4. **Return**: stdout+stderr, the real exit code, and the current directory each come back as a
   base64 frame; the local side assembles them and deletes the temp files

### Why it is fast, and why state survives

| | New SSH per command | Old tmux forwarding | **Persistent executor (this)** |
|---|---|---|---|
| Per-command cost | full handshake, 5.6s | 2 handshakes, ~11s | **4-35ms** |
| `cd` / `conda activate` / `export` | lost | kept | **kept** (via a state file) |
| Background jobs (`&`) | killed on disconnect | keep running | **keep running** |
| Ctrl+C | disconnects only | panel-level | **whole process group: SIGTERM → KILL after 2s** |
| First command | 5.6s | 5.6s | 5.6s (then ms-level) |

> The old tmux channel is kept as a fallback: set `SRB_TRANSPORT=tmux` to force it. If the
> persistent channel cannot start (very rare servers missing `base64`/`setsid`) it falls back
> automatically.

---

## 3. Files

```
.
├── servers.example.json  ★ config template: copy to servers.json and fill in
├── remote-shell.mjs      ★ the ssh-remote CLI: interactive shell + setup/umount/list/exec
├── ssh-remote.cmd          portable entry point: double-click it, or add to PATH
├── setup_ssh-remote.cmd          mount (thin wrapper → ssh-remote setup)
├── umount_ssh-remote.cmd         unmount (thin wrapper → ssh-remote umount)
├── remount_all.cmd                restore every drive mapping after a reboot (idempotent)
├── check_deps.cmd                dependency check; prints official download URLs
├── register_mcp.cmd               register with WorkBuddy
├── register_mcp_codex.cmd         register with Codex
├── lib/
│   ├── engine.mjs        ★ core engine, shared by the CLI and MCP (exec/read/write/mount/keys)
│   ├── persist.mjs       ★ persistent executor: RemoteExec class (frames/timeouts/reconnect)
│   └── exec-loop.sh         ★ the remote bash loop (protocol v4, inlined at connect time)
├── mcp/
│   └── server.mjs        ★ MCP server: stdio, 9 tools
├── tools/
│   ├── register_mcp.mjs / register_mcp_codex.mjs   implementations of the registrars
│   ├── restore_all.mjs   implementation behind remount_all.cmd
│   └── scan_package.py   credential-leak scanner for distributable packages
├── experiments/          test suite (58 regression tests + concurrency + latency benchmark)
├── package.json          npm manifest (bin: ssh-remote)
└── README.md / README.en.md   these docs
```

★ marks the core code: about 1000 lines, **zero third-party npm dependencies**.

**Never committed** (blocked by `.gitignore`): `servers.json` (contains a plaintext password),
`servers.json.bak`, `rclone.conf`, `known_hosts`, logs, `dist/`, `rclone/`.

---

## 4. Quick start

### 4.1 Requirements (Windows)

**This repo ships source code only** — no `.msi`, no `.exe`. Get every dependency from its
official source:

| Dependency | Required? | Used for | Download |
|---|---|---|---|
| **Node.js ≥ 18** | ✅ **required** | running the CLI and the MCP server | <https://nodejs.org> (LTS) |
| **plink.exe** | ✅ **required** | the SSH client | <https://www.chiark.greenend.org.uk/~sgtatham/putty/> (bundled with PuTTY, or grab plink.exe alone) |
| WinFsp | ⭕ file mapping only | Windows filesystem driver | <https://winfsp.dev> or [GitHub Releases](https://github.com/winfsp/winfsp/releases) |
| SSHFS-Win | ⭕ file mapping only | SSH filesystem on top of WinFsp | [GitHub Releases](https://github.com/winfsp/sshfs-win/releases) |

**Only the first two are hard requirements.** WinFsp + SSHFS-Win are needed only if you want a
server directory to appear as a Windows drive. If you just want the `ssh-remote` CLI or the MCP
server, you can skip them entirely.

After downloading the two `.msi` files you can double-click them, or install silently:

```bat
msiexec /i winfsp-2.1.25156.msi /qb /norestart
msiexec /i sshfs-win-3.5.20357-x64.msi /qb /norestart
```

Run `check_deps.cmd` for a one-shot check of what is still missing.

The server side needs `bash` + `base64` + `setsid` (util-linux, present by default on most
distros). Only the legacy tmux fallback needs `tmux` (`sudo apt install tmux`).

> **Why no installers in the repo?**
> The two `.msi` files plus `node.exe` plus `rclone.exe` come to roughly 170MB. Committing
> them means every clone downloads 170MB, and git keeps them in history forever (even after you
> delete them). Worse, the versions freeze — nobody updates a copy pinned in a repo. Fetching
> from upstream gives you the current release and keeps clone under 1MB.

> **Configuring the plink path**: put an absolute path in `servers.json`, or override it with
> the `SRB_PLINK` environment variable. Relative paths work too (e.g. `"bin\\plink.exe"`), which
> lets you move the whole directory around.

### 4.2 Configure a server

Edit `servers.json` (full field reference in [§5](#5-serversjson-reference)). Minimal config:

```json
{
  "plink": "C:\\path\\to\\plink.exe",
  "servers": {
    "myserver": {
      "host": "10.0.0.1",
      "port": 22,
      "user": "your-username",
      "password": "your-password",
      "hostkey": "SHA256:<paste the fingerprint here>",
      "drive": "M:"
    }
  }
}
```

Getting `hostkey` — run this and copy the `SHA256:...` line from the output:

```bat
plink.exe -ssh -batch -P 22 10.0.0.1 exit
```

Or let the AI do it for you: register the MCP server, then say *"help me set up this server"* —
it asks for the values and fetches the fingerprint automatically (§7.2).

### 4.3 Mount and start using

```bat
:: 1) mount (run check_deps.cmd first if you have not installed WinFsp / SSHFS-Win)
setup_ssh-remote.cmd

:: 2) open the drive in VS Code
cd /d M:\
code .

:: 3) remote shell in any terminal
ssh-remote.cmd
```

After a reboot, run `remount_all.cmd` once — see [§8](#8-how-mounting-works).

---

## 5. servers.json reference

### Top level

| Field | Required | Default | Meaning |
|---|---|---|---|
| `plink` | no | probed | path to plink.exe, relative or absolute. Override with `SRB_PLINK` |
| `servers` | **yes** | — | the server collection; each key is a profile name |

### Per-server fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `host` | **yes** | — | IP address or hostname |
| `port` | no | `22` | SSH port |
| `user` | **yes** | — | SSH login name |
| `password` | one of | — | SSH password (alternative to `keyFile`) |
| `keyFile` | no | — | absolute path to a `.ppk` private key |
| `hostkey` | strongly advised | — | `SHA256:...` fingerprint; plink refuses to connect without it |
| `drive` | for mounting | — | drive letter, e.g. `M:`. **Must be unique per server** |
| `mount` | no | — | plain-folder path, e.g. `F:\myserver`. **Leave empty = drive-letter-only** (see §8) |
| `remote` | no | `/home/<user>` | the directory on the server to expose |
| `tmuxSession` | no | `srb-ai` | only used by the legacy tmux fallback (`SRB_TRANSPORT=tmux`) |
| `default` | no | `false` | make this the default server |
| `note` | no | — | free-form note shown by `ssh-remote list` |

> Backslashes must be doubled inside JSON strings: `"F:\\<user>"` means `F:\<user>`.
> Two servers must never share a `drive` letter — the second mount evicts the first.
> `remount_all.cmd` detects this before touching anything and suggests a free letter.

### Template

> Everything below is a placeholder. This project contains **no real server information** —
> IPs, accounts, passwords and fingerprints never appear in the code, the docs or git.
> Real values live only in your local `servers.json` (which you should not commit).

```json
{
  "plink": "C:\\path\\to\\plink.exe",
  "servers": {
    "myserver": {
      "host": "10.0.0.1",
      "port": 22,
      "user": "your-username",
      "password": "your-password",
      "hostkey": "SHA256:<paste the fingerprint here>",
      "drive": "M:",
      "remote": "/home/your-username",
      "default": true,
      "note": "what this box is for"
    }
  }
}
```

---

## 6. The ssh-remote CLI

### 6.1 Register the command (optional, one-time)

```bat
cd /d <the ssh-remote-bridge directory>
npm install -g .
```

After that `ssh-remote` works in any terminal. It also works without installing:
`node remote-shell.mjs <subcommand>`, or just double-click `ssh-remote.cmd`.

### 6.2 Subcommands

| Command | Effect |
|---|---|
| `ssh-remote` | interactive shell on the default server |
| `ssh-remote <profile>` | interactive shell on a named server |
| `ssh-remote list` | list servers with live mount status |
| `ssh-remote setup [profile]` | mount: create the drive mapping (+ optional symlink) |
| `ssh-remote umount [profile]` | remove the drive mapping |
| `ssh-remote exec <profile> <cmd...>` | run one command and exit (script friendly) |
| `ssh-remote rclone [profile]` | fallback mount via rclone |
| `ssh-remote help` | help |

`exec` is scriptable and passes the exit code through:

```bat
ssh-remote exec myserver nvidia-smi
ssh-remote exec myserver "tail -5 ~/train.log"
echo exit code = %errorlevel%
```

### 6.3 Inside the interactive shell

```
> ssh-remote
------------------------------------------------------------
ssh-remote - remote forwarding shell
 server: myserver youruser@10.0.0.1  channel: persistent SSH (ms-level)
 remote cwd: /home/<user>
 exit/Ctrl+D to leave - Ctrl+C interrupts the running command - raw <cmd> full-screen
------------------------------------------------------------
ssh-remote> _
```

| Input | Behaviour |
|---|---|
| any command | forwarded to the server; output and exit code come back (ms-level) |
| `exit` / `quit` / Ctrl+D | leave the local shell (drops the persistent connection) |
| Ctrl+C | **interrupt the running remote command** (kills the remote process group); does not exit, clears the line when idle |
| `raw vim x.txt` or `! vim x.txt` | full-screen mode (plink -t) for vim / htop / top / watch |
| `help` or `?` | help |

**cwd mapping**: start `ssh-remote` inside a mount path and the remote side `cd`s to the
matching directory — local and remote paths always stay in sync.

**Long jobs**: use `nohup ... &` so they survive a dropped connection.

```bash
ssh-remote> nohup python train.py > train.log 2>&1 &
ssh-remote> tail -f train.log      # Ctrl+C interrupts tail, training continues
```

The first connection takes ~5.6s (server-side handshake); every later command takes 4-35ms.
`cd` and `export` stay effective for the whole session; a new `ssh-remote` starts back in the
remote home directory.

---

## 7. MCP server

### 7.1 What it is

MCP (Model Context Protocol) is the standard for connecting AI models to external tools.
Registering this MCP server lets the model **operate your server directly** — no more copying
logs back and forth; the AI runs commands, reads files, edits configs and checks mount state
on its own.

Typical conversation:

```
You: check how the training is going on myserver
AI: [calls exec] tail -5 ~/train.log  ->  "epoch 42, loss 0.31..."

You: set learning_rate to 1e-4
AI: [read_file config.yaml] -> [write_file] -> done
```

### 7.2 Hard rule: the AI must ask the user for connection details first

> **This is the first rule for any AI driving this server, and it overrides everything else.**

The project contains **no real server information, by design**. Every IP, account, password and
host fingerprint in this repo is a placeholder. Therefore:

**The first time an AI connects (this session has not yet run a successful command), it must
NOT guess, infer or reuse any credential. It has to ask the user:**

| # | Ask for | Field | Required |
|---|---|---|---|
| 1 | **Server IP or hostname** | `host` | ✅ |
| 2 | **SSH port** | usually `22`, ask if unsure | advisable |
| 3 | **SSH username** | `user` | ✅ |
| 4 | **Password** (or absolute path to a private key) | `password` / `keyFile` | ✅ |
| 5 | **Which drive letter** | `drive`, e.g. `M:` (only for file mapping; **confirm it is not already taken**) | advisable |
| 6 | **Also want a plain-folder path?** | `mount`, e.g. `F:\myserver`. Default: **no** | advisable |
| 7 | **Which directory on the server** | `remote`, default `/home/<username>` | has a default |
| 8 | **What to call this server** | `name`, defaults to `myserver` | optional |

**The correct flow (AI side):**

1. Call `list_servers` first to see whether anything is configured.
2. If it reports "not configured / unavailable" → **stop and ask the user all of the above in
   one go.** Do not drip-feed questions.
3. Then call `configure_server`, passing **exactly the values the user gave you**.
   You usually do not need to ask for `hostkey`: `configure_server` fetches it automatically
   (plink prints the fingerprint the first time it meets a host). If that fails it will tell
   you to ask the user for the `SHA256:...` value.
4. After it is written, `exec` / `read_file` / `write_file` work immediately. File mapping also
   needs `drive`.

**Credential discipline (non-negotiable):**

- ❌ Do not write passwords, fingerprints or internal IPs into any code, script, document,
  comment, note or chat transcript.
- ❌ Do not pass a password as a command-line argument (it lands in shell history and the
  process list) — use `configure_server`.
- ❌ Do not "infer" a credential from memory or from another file, even when it looks obvious.
- ✅ Real credentials may exist **only** in your local `servers.json` (do not commit it).
- ✅ Passwords never appear in any tool return value (`configure_server` returns
  `***(stored in servers.json)***`).

**The drive letter (#5) must be confirmed free.** Check `list_servers` for what is already in
use and recommend an unused one. Duplicates cause "the files from server A suddenly became
server B's" — extremely hard to diagnose.

**`mount` (#6): default to leaving it unset.** Drive-letter-only needs no Developer Mode and no
administrator rights, and removes a whole failure point. Add it only when the user explicitly
asks for a fixed path like `F:\xxx`.

### 7.3 Registering

This is a standard MCP server, so WorkBuddy and Codex both work. Their config formats differ,
and each has a helper script.

#### A. WorkBuddy

Double-click **`register_mcp.cmd`** (it merges into `mcp.json`, preserving existing entries), or
edit `C:\Users\<you>\.workbuddy\mcp.json` by hand (note: **no dot prefix**, it is not
`.mcp.json`):

```json
{
  "mcpServers": {
    "ssh-remote-bridge": {
      "command": "C:\\path\\to\\node.exe",
      "args": ["C:\\path\\to\\ssh-remote-bridge\\mcp\\server.mjs"]
    }
  }
}
```

Then: **connector page → custom connectors → ssh-remote-bridge → Trust.**
Nothing works until you click Trust.

#### B. Codex

```bat
codex mcp add ssh-remote-bridge -- "<abs path>\node.exe" "<abs path>\mcp\server.mjs"
```

Or double-click `register_mcp_codex.cmd`. Verify with `codex mcp list`, remove with
`codex mcp remove ssh-remote-bridge`.

> Restart Codex afterwards — `config.toml` is only read at startup.
> `register_mcp_codex.mjs` also honours `SRB_CODEX_CONFIG_DIR` to point at a different
> config directory (handy for testing or several setups side by side).

### 7.4 The nine tools

Parameters are described by each tool's own schema (your client shows it to you), so this table
covers purpose and key points only.

| Tool | Key parameters | Notes |
|---|---|---|
| `list_servers` | — | All servers plus **live mount state** (`drive_mounted` / `mount_ok`). No passwords. **The AI should call this first to confirm profile names** |
| `configure_server` | `name` `host` `user` `port` `hostkey` `drive` `mount` `remote` `note` + (`password` or `keyFile`) | Write/update a server. **Merge semantics**: fields you omit keep their value. `hostkey` is fetched if omitted. Passwords are never echoed back |
| `exec` | `command` `server` `timeout=120` | Run a command; returns `exit=`, `duration=` and the output. **Most used** |
| `read_file` | `path` `server` `max_bytes=65536` | Text returns as text, binaries as base64; truncated with a marker when over the limit |
| `write_file` | `path` `content` `append` `server` | Large payloads are chunked automatically (works around the 4096-byte pty line limit) |
| `mount_server` | `server` | Mounts: creates the drive mapping (+ optional symlink). Needs WinFsp + SSHFS-Win |
| `unmount_server` | `server` | Removes the drive mapping; any symlink is kept |
| `server_status` | `server` | Health check: mounts, channel state. **Call this when something looks wrong** |
| `trust_host` | `host` `port=22` | Fetch the `SHA256:...` host fingerprint. Used when adding a server |

A few things that are easy to get wrong:

- **Do not run interactive full-screen programs through `exec`** (vim/htop/top) — use the
  local `ssh-remote` `raw` mode.
- **`configure_server` accepts only values the user just gave you.** Never infer credentials
  (§7.2).
- **It is normal for `hostkey` fetching to fail on the first try**: plink refuses and prints the
  fingerprint — that fingerprint is exactly what you need.
- **If `list_servers` says "not configured", you must stop and ask the user.**

### 7.5 Verifying the registration

Say to the AI: *"call list_servers and show me what servers exist."* If it returns your server
with `drive_mounted: true`, the whole chain works.

---

## 8. How mounting works

### Pick one of two modes

| | **Drive letter only (recommended)** | Drive letter + symlink |
|---|---|---|
| Config | set `drive`, **leave `mount` empty** | set both `drive` and `mount` |
| Paths | `M:\` | `M:\` **and** `F:\<user>\` |
| Privileges | **none** (`net use` always works) | needs Developer Mode or an elevated shell |
| In VS Code / Explorer | type `M:` | both work |
| Custom folder name | rely on the letter | you choose the folder name |

**Start with drive-letter-only.** One less symlink means one less failure point and one less
privilege pitfall. Add `mount` later if you genuinely need a fixed path like `F:\myserver`
(some tools only accept plain folders).

### The chain

```
[drive only]  M:  ──net use──▶  SSHFS-Win  ──SSH──▶  server /home/<user>

[with symlink]  F:\<user>  ──mklink /D──▶  M:  ──net use──▶  SSHFS-Win  ──SSH──▶  server
                (plain folder)        (drive)             (user-mode FS)         (real files)
```

### Three design decisions

**① Why a drive letter rather than a folder?**
SSHFS-Win's `net use` only accepts drive letters; mounting a folder directly fails with error
87/67. So the bottom layer is always a drive letter. Whether to wrap it in a symlink to get a
plain-folder path is your choice (see the table above).

**② Why is the password inlined in the net use command line?**
Measured: credentials stored via `cmdkey /add` are **not read** by SSHFS-Win (it reports an
invalid password). The only reliable form puts the password directly in the command line:
`net use M: \\sshfs.r\user@host\path <password> /user:user /persistent:yes`.
`ssh-remote setup` already does this.

**③ UNC prefixes**
- `\\sshfs.r\...` = **r**ooted, followed by the absolute path (`\home\<user>`) — what this project uses
- `\\sshfs.kr\...` = key-based (passwordless) mode
- `\\sshfs.r\user@host!port\...` = non-standard ports use `!port` after the hostname

### Every server needs a different drive letter

**One drive letter can only be connected to one machine at a time.** If two servers both use
`M:`, mounting the second evicts the first, and the symptom is:

> "I was looking at server A, and suddenly `M:\` contained server B's files."

It looks like files changed, but the mapping was replaced — the hardest class of problem to
diagnose by yourself.

Two lines of defence:
1. **Give each server a free letter when you add it** (`N:`, `O:`, ... once `M:` is taken)
2. **`remount_all.cmd` checks before it touches anything** and tells you what to change:

```
!!! 盘符冲突：多台服务器配了同一个盘符 !!!
  M:  ←  5090  and  box-b  and  box-c
  修法: 编辑 servers.json, 给每台一个不同的盘符, 例如
         5090: drive "M:"  ->  保持不变（第一台优先）
         box-b: drive "M:"  ->  改成  "N:"
         box-c: drive "M:"  ->  改成  "O:"
```
(the tool's own messages are Chinese; the conflict list and suggested letters are the part
to read)

### Symlink permissions (only needed for `mount` mode)

With `mount` unset you never need any of this. If you do set `mount`, you need **one** of
(permanent once granted):
**Settings → System → Optional features → Developer Mode**, or run the terminal as
administrator.

> Some sandboxes and remote tools "materialise" `mklink` results into empty directories — an
> environment limitation, not a bug. **Run the mount from a real local terminal**
> (double-click `setup_ssh-remote.cmd`).

### Mount lifecycle

| Action | Effect |
|---|---|
| `ssh-remote setup` | Creates the mapping. `/persistent:yes` only **tries** to reconnect at logon and fails silently if the network is not up yet |
| **Reboot** | Drive mappings are usually gone → **run `remount_all.cmd` once** (idempotent; healthy ones are skipped) |
| `ssh-remote umount` | Removes the drive mapping; any symlink is kept and rebuilt on the next setup |
| A symlink pointing at a dead drive | shows as an empty folder; `ssh-remote setup` restores it |

### Fallback: rclone

If SSHFS-Win misbehaves, `ssh-remote rclone [profile]` mounts over sftp instead. Pick one
route, never both at once.

---

## 9. Adding another server

**The rule: adding a server only ever means editing `servers.json`. No code changes.**

### Easiest path: let the AI do it

Register the MCP server (§7.3), then say *"help me set up this server"*. The AI asks for the IP,
account, password and drive letter, writes the config and fetches the host fingerprint. **You
never touch JSON.**

### Manual route

Add an entry under `servers`:

```json
"dgx": {
  "host": "10.0.0.2",
  "port": 22,
  "user": "bob",
  "password": "<password>",
  "hostkey": "SHA256:<see below>",
  "drive": "N:",
  "remote": "/home/bob",
  "note": "DGX station"
}
```

**Get `hostkey`** (AI: call `trust_host`; or locally):
```bat
ssh-keyscan -t ed25519 -p 22 10.0.0.2 | ssh-keygen -lf -
```

**Verify**:
```bat
ssh-remote setup dgx     :: mount
ssh-remote list          :: confirm the status is ok
ssh-remote dgx           :: enter the shell, run hostname
```

Afterwards just tell the AI *"run nvidia-smi on dgx"* — it calls `exec` with `server="dgx"`.
**No code changes, no restart.**

Four things people trip over:

- **One drive letter per server.** If `myserver` took `M:`, use `N:` or `O:` for the next one.
  Duplicates evict each other (§8). `remount_all.cmd` detects and reports them.
- **Leave `mount` unset by default.** Add it only if you need a fixed path (and then you need
  Developer Mode).
- **Double the backslashes in JSON**: `"F:\\dgx"` means `F:\dgx`.
- **Give each server its own `tmuxSession`** (e.g. `srb-ai-dgx`), even though the default
  transport no longer depends on it.

---

## 10. Security

| Topic | Note |
|---|---|
| Credential storage | Passwords/keys live in plaintext in `servers.json`; tighten its permissions and keep it out of version control |
| No credentials in the source tree | **No real IP / account / password / host fingerprint appears in any doc, code or test script here** — all placeholders. Real values exist only in your local `servers.json` |
| AI credential discipline | On first contact the AI **must ask the user** for connection details (§7.2), never guess, infer or reuse; and never write credentials into code, docs or its own notes |
| Man-in-the-middle | `hostkey` fingerprint verification; plink refuses a host whose fingerprint differs |
| Command injection | Commands travel base64-encoded with single-quote escaping; special characters cannot break the SSH command line |
| MCP privilege boundary | The `exec` tool has full shell rights on the server; prompt-injection risk is the operator's responsibility |
| Transport encryption | SSH end to end (plink) |
| Mount encryption | the mount path is SSH as well |

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Files under the drive "became" another server's** | **Two servers share one `drive`; the later mount evicted the earlier one** | Run `remount_all.cmd` and follow the conflict list it prints |
| Drive gone / folder won't open after a reboot | The persistent mapping failed silently at logon because the network was not ready | Double-click `remount_all.cmd` (`--check` diagnoses without changing anything) |
| `net use` error 67 / 87 | SSHFS-Win's `net use` only accepts drive letters, not folders | Use `ssh-remote setup`; never hand-write a folder mount |
| "Invalid password" after mounting | Windows credentials stored by `cmdkey` are not read by SSHFS-Win | Inline the password in the `net use` command line (`ssh-remote setup` does this) |
| `F:\...` is an empty folder | The symlink was not created (needs Developer Mode / admin), or it was materialised | **Switch to drive-letter-only**: delete the `mount` line from `servers.json` and use `M:` directly |
| `mklink` access denied | No symlink permission | Settings → System → Optional features → Developer Mode, or run elevated; **or simply leave `mount` unset** |
| plink reports a host key failure | `servers.json` has no `hostkey` | Get the fingerprint via the `trust_host` tool or `ssh-keyscan` |
| A command "times out at the sentinel" | The command is still running past its `timeout` | Not an error. Use `nohup ... > log2>&1 &` then `tail` |
| `?` characters at the end of output | `net use` output is GBK-encoded and gets sanitised to ASCII | Harmless, ignore |
| MCP tools missing or calls fail | Registered but not trusted | Connector page → custom connectors → ssh-remote-bridge → Trust |
| `ssh-remote: command not found` | The global command was never installed | `npm install -g .`, or use `node remote-shell.mjs` |
| First connection takes 5-6s | Server-side SSH handshake cost (KEX/PAM), unrelated to the client | Pay it once; every later command is ms-level |
| Persistent channel fails, falls back to tmux | Very rare servers missing `base64`/`setsid` | Install them, or force the old path with `SRB_TRANSPORT=tmux` |
| Output truncated at 30K characters | By design, to avoid flooding | Use `head`/`tail`/`grep`, or redirect to a file and read that |
| Mounting fails inside an AI sandbox | Sandboxes block spawn and symlinks | Run the mount from a real local terminal |

---

## 12. Known limits

1. **Windows local machine only**: `net use`, `mklink` and `sshfs.r` are Windows features. On
   Linux/macOS you can mount with plain `sshfs`; the execution engine (`engine.mjs`) itself is
   portable.
2. **4096-byte pty line limit**: `write_file` works around it automatically with base64 chunking;
   a single exec output is capped at 30000 characters (configurable anti-flood guard).
3. **Interactive full-screen programs** (vim/htop/top) do not go through the frame protocol —
   use `ssh-remote`'s `raw <cmd>` mode.
4. **One drive letter per server, and letters must be unique.** There are only 26, which is
   plenty, but duplicates evict each other — `remount_all.cmd` checks on every run.
5. **The persistent connection is scoped to one MCP server process.** Each WorkBuddy/Codex
   process keeps its own connection; when it exits, the connection drops. Two clients on the
   same server means two connections — that is normal and they do not interfere.

---

*Doc version: 2026-10-15 · code version: ssh-remote-bridge v1.0.0*
</details>
