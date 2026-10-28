# ssh-remote-bridge manual

**Version 1.5.0 · Windows host → Linux servers · CLI + MCP · multiple profiles**

[简体中文](README.md)

Mount server directories as Windows drives for Agent file tools, and reuse SSH connections for server commands. The CLI provides a native Linux terminal; MCP provides incremental task output and cancellation.

Keep this project on a local Windows disk so recovery scripts remain accessible when a remote mount fails. Run the commands below from the project root, substituting your own paths and server profiles.

## 1. Agent workflow

Priorities: **efficiency → fewer tokens → less redundant context**.

| Work | Where to run it |
|---|---|
| Search, targeted reads, patches, diffs | Host file tools on an accessible mount |
| Small-file parsing, conversions, simple calculations | Host CPU and existing host tools |
| Tests, builds, training, large analysis, bulk scans | Server through MCP `exec` or CLI |
| Files outside the mapping, unavailable mount or host file tools | SSH fallback `read_file` / `write_file` |
| Mounting, unmounting, recovery | MCP management tools or local Windows scripts |

Reuse known profiles and mappings. If unknown, call `list_servers` once and inspect `file_access`: `remote_root` is the Linux root, `local_root` is the verified local recommendation, and `unc_root` is an unverified alternative. A verified directory link takes priority over a verified drive; neither available means `local_root:null`. Confirm that the host can access the recommendation. These are the **same server files**, not copies.

For example, remote `/home/example/project/app.py` maps to `M:\project\app.py` when `/home/example` is mounted at `M:\`. Windows paths belong in host tools; Linux paths belong in SSH tools. Refresh mappings after configuration changes or access failures, rather than before each operation.

Locate relevant files and lines, read only what is needed, patch locally and inspect the diff. Avoid full-file rewrites, repeated reads, and sending large datasets, binaries or complete logs to the model. Always inspect actual file content after a failed write before retrying or changing transports, particularly for append. Do not bypass host safety policy.

## 2. MCP tools

| Tool | Purpose |
|---|---|
| `list_servers` | Discover saved profiles and mappings without SSH; omit passwords |
| `configure_server` | Create or merge a profile; retain unspecified credentials/settings |
| `server_status` | Refresh one mapping's readability, ownership and command-channel status without SSH |
| `exec` | Start an isolated server command; return a result ID if still running |
| `read_result` | Read incremental or completed output without rerunning a command |
| `cancel_exec` | Cancel queued work or interrupt its process group |
| `read_file` | SSH fallback for a Linux absolute path |
| `write_file` | SSH fallback for writing UTF-8 text |
| `mount_server` | Mount a saved profile, then refresh its mapping |
| `unmount_server` | Unmount an owned drive; retain its directory link |
| `trust_host` | Fetch SSH fingerprints for configuration |

Use supplied connection details only. Reuse saved credentials; ask only for missing fields. Do not expose passwords, invent profiles or overwrite corrupt configuration. A newly fetched host key should be checked against a trusted fingerprint.

### Commands and live output

```js
exec({server:"5090", command:"python -u train.py > train.log 2>&1", cwd:"/home/example/project", yield_time_ms:1000})
// If unfinished, keep the returned result_id. To read new output:
read_result({result_id:"returned ID", offset:0, wait_ms:10000})
// Continue using next_offset. To stop:
cancel_exec({result_id:"returned ID"})
```

Redirecting stdout to a file keeps the large training log outside the response. Use `exec` to query selected log lines; omit redirection when incremental pipe output is wanted.

| Parameter | Default and limits |
|---|---|
| `exec.cwd` | Profile remote root; use a Linux absolute project directory |
| `exec.timeout` | 120 seconds; range 1–3600, starts after queueing/handshake |
| `exec.yield_time_ms` | 1000; integer 0–30000 |
| `exec.max_output_chars` | 8192; integer 1–2097152; request more explicitly |
| `read_result.max_bytes` | 8192; range 1–65536 |
| `read_result.wait_ms` | 10000; integer 0–30000 |
| `read_file.max_bytes` / `offset` | 8192 / 0; pages up to 1 MiB |

Commands for one profile queue on one channel. MCP commands have isolated cwd/environment; `cd` and `export` do not persist between calls. Initialize environments in the same command. CLI interactive sessions retain their state.

Use `read_result` with `next_offset` and `wait_ms`; avoid busy polling or rerunning the original command. Programs must flush output (`python -u`, `flush=True`, or suitable buffering options). Optional MCP progress notifications depend on the client; use result tools for model-visible output. Canceling a result read does not cancel the job. Cancellation does not undo side effects.

Response shortening retains the beginning and end without splitting Unicode characters. The body budget excludes status and omission notices. `RESPONSE-LIMIT` is distinct from the **2 MiB remote capture limit** (`REMOTE-CAPTURE-LIMIT`). Real exit codes, failures, cancellations and timeouts remain visible. Keep long logs in server files. Text pages end at complete UTF-8 characters; binary content defaults to metadata unless `format:"base64"` is explicitly requested.

Completed results expire after 10 minutes, disconnection/reload or eviction: up to 16 per profile and 32 total. Active jobs are not evicted. Never replay a command just because a result expired. `write_file` accepts at most 1 MiB, stages overwrites before replacement, preserves existing ownership/mode and refuses to replace a symlink; append is not atomic.

### Connections and cleanup

- One command channel per profile is reused. Ordinary channels close after 10 idle minutes and reconnect on demand. Interactive terminals stay connected until exit. SSHFS mounts have independent persistent connections.
- The Linux controller uses a Python standard-library event loop, blocking on input, output and child exit. Both host and server enforce execution deadlines. Cancellation sends TERM to the command group, then KILL after two seconds if necessary.
- Remaining children in that process group are cleaned up after foreground completion, without waiting for inherited output pipes to close. For intentionally detached work, use a task manager or `setsid nohup <command> > /absolute/path/task.log 2>&1 < /dev/null &`, and manage that task separately.
- MCP stdin EOF and normal exit signals cancel queued work and wait for connection cleanup. Closing a channel cannot restart queued commands. Force-killing a host can prevent local cleanup; remote deadlines provide an independent termination path.
- Mounting reuses an existing pinned command connection to read host public keys; a connection created only for that read closes immediately. Status discovery does not connect SSH and limits concurrent host probes to two.

## 3. Local recovery and drive cleanup

Run these commands in **Windows**, with the local project as `workdir`, even when a remote workspace is unavailable. The `rtk proxy` prefix is optional; omit it on hosts without RTK.

```powershell
rtk proxy .\runtime\node.exe .\remote-shell.mjs list
rtk proxy .\runtime\node.exe .\remote-shell.mjs setup 5090
rtk proxy .\runtime\node.exe .\tools\restore_all.mjs
rtk proxy .\runtime\node.exe .\tools\restore_all.mjs --check
rtk proxy .\runtime\node.exe .\remote-shell.mjs umount 5090
```

| Local script | Action |
|---|---|
| `remount_all.cmd` | Restore all configured drive mappings; reuse healthy mounts |
| `setup_ssh-remote.cmd [profile]` | Mount default/specified profile |
| `umount_ssh-remote.cmd [profile]` | Unmount default/specified profile |
| `cleanup_stale_mounts.cmd [--check] [Y: Z:]` | Double-click to clean offline duplicates; `--check` previews only |
| `open-ssh-remote-terminal.cmd` | Open the interactive terminal |

Agents should call the Node entry points directly so `.cmd` pause prompts do not block them. Mount commands exit after mounting; hidden SSHFS continues in the background. Save files and pause writers before unmounting: existing handles become invalid.

```powershell
rtk proxy .\runtime\node.exe .\tools\cleanup_stale_mounts.mjs --check
rtk proxy .\runtime\node.exe .\tools\cleanup_stale_mounts.mjs --apply Y: Z:
```

Cleanup is a separate operation, not an automatic mount step. Server identity means account + host + port, **ignoring remote directory**. Keep online mounts and remove their offline duplicates. If all duplicates are offline, keep the configured drive, otherwise the first alphabetically. Consequently, offline mappings of different directories on the same server can be removed too. Only recognized SSHFS servers are eligible; unknown ownership, permission errors and timed-out probes are skipped. Locks and fresh identity checks protect mutations. Remote files are not deleted.

When a mapping is already absent but Explorer still shows a disconnected drive, cleanup sends a Windows drive-removal event and a Shell removal notification. Shell notification alone may reappear after F5. Configured/occupied drives are protected; `--check` does not refresh Explorer. Output is saved to `logs/cleanup_stale_mounts.log` beside `servers.json`. No automatic elevation, unrelated process termination or infinite retry is used. If Windows cannot release a volume, reboot and recover from this local directory.

## 4. CLI terminal

Run `ssh-remote` without a profile to choose a server by number when multiple servers are configured; a single configured server connects directly. Ctrl+C or Ctrl+D cancels selection. With piped input/output and multiple servers, specify a profile explicitly. An explicit `ssh-remote <profile>` connects directly; management commands retain their default-profile behavior.

```powershell
ssh-remote 5090
ssh-remote gpu -w 5090
ssh-remote exec 5090 'nvidia-smi'
ssh-remote exec -f 5090 'python -u /home/example/project/train.py'
ssh-remote 5090 --framed
```

With terminal input/output, the default is one native SSH2 PTY. Remote Bash handles Tab completion, history, Ctrl+C, colors and window resizing. Run `htop`, `nvitop` or `gpustat -i 1` directly; exit with `exit` or Ctrl+D. Completion depends on server-installed Bash completion rules. A local cwd inside the mount selects the corresponding remote directory. Management commands run outside the Linux shell; `help` inside the PTY means Bash help.

Pipes and `--framed` use the line interface, with limited completion and shortcuts such as `gpu`, `raw <command>` and `!<command>`. Explicit raw sessions use an additional PTY connection so framed cwd/environment can survive; use the default native PTY for interactive programs. `exec -f` streams text output. Script execution preserves real failures; timeout exits 124, cancellation 130, channel failure 2.

`ssh-remote rclone [profile]` is an optional foreground mount. Its process remains connected until unmounted; temporary configuration is removed on normal exit or failure. Let rclone finish handling Ctrl+C before closing its terminal.

## 5. Installation and configuration

### Required components

- **Host:** Node.js ≥18 and npm dependencies (`npm ci`), Plink for command SSH. Native PTY uses the pinned npm dependency `ssh2`.
- **Linux server:** Bash, **`/usr/bin/python3` ≥3.9**, and GNU coreutils such as `base64`, `stat` and `dd`. Python uses its standard library; no pip packages or local Python installation are required. A missing/old interpreter fails explicitly without transport fallback or replay. `setsid` is needed for intentionally detached commands.
- **File mapping:** WinFsp and SSHFS ≥3.7.2. The private runtime must include **`runtime/sshfs/bin/cygwin-console-helper.exe`**, installed and checked by the runtime installer. Keep it when copying the runtime: omitting it can leave a persistent blank terminal window.
- **Runtime installation only:** 7-Zip. rclone is optional. Install server TUI applications separately.

The source package excludes third-party executables. Install the locked official Cygwin binaries using:

```powershell
rtk proxy node .\tools\install_sshfs_runtime.mjs
```

**Fresh clone / Agent installation requirement:** The base runtime installer only prepares dependencies; it does not complete deployment. Follow [the build and repair guide](BUILD-SSHFS.md) to build, validate and activate 3.7.2+srb.1 before mounting. Verify the executable actually selected, including any SRB_SSHFS override or system installation. Do not treat official unpatched 3.7.2, which has the known handle leak, as the final installation. If the toolchain is missing or the build fails, report the blocker rather than silently falling back to the unpatched version. Neither Git clone nor the base installer automatically builds the repair.

The installer verifies sizes/hashes, records provenance, and does not compile binaries or overwrite an existing runtime. `--stage` prepares `runtime/sshfs-next/`. To switch runtimes, save work, unmount affected mappings, back up the old runtime, move the staged directory into place and remount. Executable priority is `SRB_SSHFS` → private runtime → system SSHFS-Win. The base installer still provides official SSHFS 3.7.2. This project supplies the source patch and build script for **3.7.2+srb.1**; build and activate it in `runtime/sshfs/` before mounting. The repaired binary is not included in the source repository. See [the build and repair guide](BUILD-SSHFS.md) for source, hashes, toolchain and switching instructions.

Official distribution sources: [Node.js](https://nodejs.org/en/download), [PuTTY](https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html), [WinFsp](https://winfsp.dev), [Cygwin](https://cygwin.com/packages/), [7-Zip](https://7-zip.org/download.html).

### Register and configure

Run `register_mcp.cmd` for WorkBuddy or `register_mcp_codex.cmd` for Codex, then reload MCP in the client. Registrations use the private Node when present. CLI installation can use `npm install -g .`; direct Node entry points also work.

Copy `servers.example.json` to `servers.json` for manual setup, or call `configure_server` with known fields. Profiles use `host`, `port`, `user`, `password` or `keyFile`, `hostkey`, Linux `remote`, and optional `drive`, directory `mount`, `isDefault`, and `note`. Passwords are saved locally and omitted from discovery replies. Corrupt configuration is reported rather than overwritten. A drive is required only for mounting; directory links are optional. SSHFS needs an OpenSSH key rather than PPK. Both command SSH and new mounts enforce the configured host-key pin.

Environment overrides: `SRB_CONFIG`, `SRB_PLINK`, `SRB_SSHFS`, `SRB_KNOWN_HOSTS`; Codex registration uses `SRB_CODEX_CONFIG_DIR`, otherwise `CODEX_HOME` or the default user directory. `SRB_KNOWN_HOSTS` must still contain the pinned key.

### Validated component versions

| Component | Version/location |
|---|---|
| Node.js / npm | 26.12.0 Current / 11.20.0; `runtime/` |
| Plink | 0.85; `bin/plink.exe` |
| 7-Zip | 26.04; `runtime/7zip/` |
| SSHFS | 3.7.2+srb.1 condition-variable repair; build and activate in `runtime/sshfs/` |
| Cygwin and console helper | 3.6.11; `runtime/sshfs/bin/` |
| OpenSSH / OpenSSL | 10.5p1 / 3.5.9; official Cygwin runtime binaries |
| WinFsp / ssh2 / rclone | 2.1 / 1.17.0 / 1.75.2 |

These tools must be deployed separately on a new machine. This update does not replace mounting binaries.

## 6. Troubleshooting and maintenance

| Symptom | Action |
|---|---|
| Drive disappeared after reboot | Use local recovery scripts with a valid local `workdir` |
| Existing-directory mkdir returns EPERM | Check the active SSHFS version; upgrading requires remounting |
| Root-directory mkdir returns EPERM | Windows/Node root behavior alone does not establish that file writes are broken |
| ModifyBackup / UNC error | Record the exact tool, path, error and file state; this is separate and has not reproduced reliably |
| Failed file write | Inspect actual content before retrying or switching transports |
| No task output | Read the existing result with a wait; check program flushing |
| Truncated response | Distinguish response budget from capture limit; query selected server-log lines |
| Host-key mismatch | Verify server identity and the key change; do not disable verification |
| Old behavior after editing source | Reload MCP and reopen CLI sessions; runtime upgrades separately require remounting |

Bridge verification entries (run when verification is requested):

- `npm test`: isolated host regressions.
- `npm run test:remote -- <profile>`: remote command/file protocol.
- `npm run test:lifecycle -- <profile>`: connection reuse, independent remote timeout, background cleanup, queued work and shutdown.
- `npm run test:mcp-live`: live output/cancel/progress on the default server.
- `npm run test:terminal -- <profile>`: pinned PTY, Tab, Ctrl+C, ANSI and resize.

Remote checks execute temporary test commands and clean their files. Actual project tests and heavy computation belong on the server.

**1.5.0:** event-driven remote execution, simpler framed CLI, coordinated shutdown, idle connection reclamation and less protocol copying. **Reload MCP and reopen CLI sessions** to use it; the existing M: mount does not need remounting. Measurements and the unresolved native SSHFS synchronization-handle growth are recorded in [the audit](AUDIT-2026-10-19.md). Detailed history: [FIXES.zh-CN.md](FIXES.zh-CN.md). [MIT License](LICENSE).
