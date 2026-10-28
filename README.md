# ssh-remote-bridge 使用手册

**当前版本：1.5.0 · Windows 本机连接 Linux 服务器 · CLI + MCP · 多服务器配置**

将服务器目录挂载为本机盘符，供 Agent 使用宿主工具读写；通过持久 SSH 执行服务器命令。CLI 支持原生交互终端，MCP 支持任务增量输出和取消。

将本项目保存在 Windows 本地磁盘上，确保远端挂载失效时仍能运行恢复脚本。下文命令均从项目根目录执行，路径和服务器 profile 请按实际配置替换。

## 目录

1. [Agent 操作规则](#1-agent-操作规则)
2. [Agent 使用 MCP](#2-agent-使用-mcp)
3. [本机挂载与会话外恢复](#3-本机挂载与会话外恢复)
4. [ssh-remote 命令行](#4-ssh-remote-命令行)
5. [安装、注册与服务器配置](#5-安装注册与服务器配置)
6. [当前运行环境](#6-当前运行环境)
7. [故障排查](#7-故障排查)
8. [维护与更新记录](#8-维护与更新记录)

## 1. Agent 操作规则

按 **效率 → 节省 token → 减少冗余上下文** 的顺序选择操作方式。

| 工作 | 使用位置与工具 |
|---|---|
| 搜索文件、局部读取、编辑、查看 diff | 宿主原生文件工具，直接操作可用的本地挂载目录 |
| 小文件解析、格式转换、简单运算 | 本机命令工具和本机 CPU |
| 测试、构建、训练、大规模分析、高 I/O 批量扫描 | MCP `exec` 或 CLI，在服务器执行 |
| 文件不在映射范围内、挂载不可访问、宿主文件工具不可用 | SSH 后备 `read_file` / `write_file` |
| 挂载、卸载、恢复盘符 | MCP 挂载工具，或 **Windows 本机**恢复脚本 |

### 开始工作

1. 复用已知的服务器 profile 和路径。未知时调用一次 `list_servers`，读取 `file_access`；不要每次操作前重新探测。
2. 确认宿主能访问推荐的 `local_root`。例如远端根 `/home/example` 对应 `M:\`，则 `/home/example/project/app.py` 对应 `M:\project\app.py`。
3. 先定位相关文件和行，再读取必要内容、做局部修改、查看 diff。避免整文件重写、重复回读和大规模本地网络扫描。
4. 远端任务显式指定 `server` 和 Linux `cwd`，只取必要输出。不要把完整数据集、二进制或大型日志塞进对话。

### 必须区分

- 挂载文件就是服务器上的同一份数据，修改会直接影响服务器；挂载 I/O 仍经过网络。
- 宿主文件工具使用 Windows 路径；MCP `exec`、SSH 文件工具使用 Linux 绝对路径。`exec` 始终是远端命令，不是本机终端。
- 已知映射仅在配置改变或访问失败时刷新。`list_servers` / `server_status` 不建立 SSH 连接。
- 任何写入失败后，先检查文件实际内容，再决定是否重试或换通道；尤其不能重复追加。保留原始错误，不凭总结认定“sshfs 间歇问题”。
- 复用保存的凭据，只询问缺少的信息；不猜测、不回显密码，不把凭据写进代码、日志或笔记。遵守宿主安全策略。
- MCP 初始化会提供操作指引，实际工具选择仍由宿主和 Agent 决定。README 需要被读取，不保证新对话自动加载。

## 2. Agent 使用 MCP

省略可选的 `server` 时使用默认 profile；多服务器任务建议显式指定。下面的 JSON 是工具调用参数示例。

### 2.1 发现映射

调用 `list_servers({})`，或在访问失败后调用 `server_status({"server":"5090"})`。返回的路径信息类似：

```json
{
  "file_access": {
    "remote_root": "/home/example",
    "local_root": "M:\\",
    "unc_root": "\\\\sshfs.r\\example@example.invalid\\home\\example"
  }
}
```

`local_root` 优先采用已验证的目录链接，其次是盘符，没有可用入口则为 `null`。验证来自 MCP 进程，宿主还需确认能访问；`unc_root` 只是候选路径。`drive_mounted` 表示盘符可读，**不保证每个文件可写**；没有配置目录链接时，`mount_ok=false` 不表示盘符失效。

### 2.2 执行命令并读取增量输出

```json
{
  "server": "5090",
  "command": "pytest -q",
  "cwd": "/home/example/project",
  "timeout": 120,
  "max_output_chars": 2048,
  "yield_time_ms": 1000
}
```

以上参数交给 `exec`。命令快速完成时直接返回结果；未结束时返回 `queued` / `running`、`result_id` 和 `next_offset`，任务继续执行。

后续调用 **`read_result`**，从上次返回的 `next_offset` 继续读取：

```json
{
  "result_id": "上次返回的任务ID",
  "offset": 0,
  "max_bytes": 8192,
  "wait_ms": 10000
}
```

这里的 `offset=0` 仅表示从头读取；若 `exec` 已返回部分内容，应使用其 `next_offset`，避免重复内容。继续读取直到任务完成；完成后若仍显示 `MORE`，可按需要继续取剩余片段。**不要为了获取输出重新执行原命令，也不要空轮询或无目的读完整份日志**。

| 参数 | 默认值与范围 |
|---|---|
| `exec.cwd` | profile 的远端根目录；项目命令应显式指定 Linux 绝对路径 |
| `exec.timeout` | 120 秒，1–3600 秒；排队和握手后计时，超时中断任务 |
| `exec.yield_time_ms` | 1000 毫秒，整数 0–30000；只控制本次调用等待多久 |
| `exec.max_output_chars` | 8192 个 Unicode 字符，整数 1–2097152；需要更多时显式提高 |
| `read_result.offset` | 0；字节偏移，后续使用返回的 `next_offset` |
| `read_result.max_bytes` | 8192，整数 1–65536 |
| `read_result.wait_ms` | 10000 毫秒，整数 0–30000；遇到新输出或完成就返回 |

执行与输出规则：

- MCP 每个命令的目录和环境独立，前一次 `cd` / `export` 不会传给下一次；在同一条命令内初始化 conda 等环境。同一 profile 的执行任务会排队，运行中仍可读取其输出。
- 完成后检查真实退出码、`FAILED`、`TIMED-OUT`、`CANCELLED` 等状态。取消用 `cancel_exec({"result_id":"任务ID"})`，然后读取最终状态；取消不回滚已经发生的修改，取消一次读取也不会取消原任务。
- 完成结果保留 10 分钟；容量为每 profile 16 个、进程总计 32 个，活动任务不被淘汰。断线、重载或完成结果被淘汰后，旧输出可能不可再读。
- 已完成的 `exec` 回复超限时保留开头和结尾；运行中使用 `next_offset` 继续读取。`RESPONSE-LIMIT` 是回复精简，`REMOTE-CAPTURE-LIMIT` 是独立的 **2 MiB 远端捕获上限**。提高回复限额不能恢复未捕获内容；长日志应保存到服务器文件并查询片段。
- 程序必须刷新输出才能实时读取，Python 可使用 `-u` 或 `flush=True`。宿主支持进度通知时可能额外展示日志，Agent 获取运行中内容使用 `read_result`，不依赖通知进入模型上下文。

### 连接与任务的生命周期

- 同一 profile 复用一条命令连接，避免重复 SSH 握手。普通命令通道空闲 10 分钟后断开，下次按需重连；CLI 交互终端保留连接直到退出。SSHFS 挂载是独立的常驻连接，不受命令通道断开影响。
- 远端控制器使用 Python 标准库事件循环，无输出时阻塞等待。任务超时由宿主和远端分别执行；取消向整组进程发送 TERM，2 秒后仍未退出则 KILL。
- 命令完成后清理同进程组内的后台子进程，不等待继承输出管道的后台程序自然退出。需要主动脱离会话的任务，使用任务管理器，或 `setsid nohup <命令> > /绝对路径/task.log 2>&1 < /dev/null &`，并自行管理其生命周期。
- MCP stdin 关闭或正常收到退出信号时，停止接收任务、取消排队工作、等待清理并关闭 SSH；关闭前排队的命令不会重新建连执行。直接强杀宿主无法保证它有机会清理，远端超时仍提供独立的终止路径。
- 挂载获取主机公钥时复用已有命令连接；如果只为此次挂载临时建立连接，读取完成后立即关闭。`list_servers` / `server_status` 不建立 SSH 连接，多个 profile 的本机状态探测最多同时运行两个。
- 需要跨断线、宿主重载继续运行的长任务，应使用服务器上的任务管理方式并记录 PID、日志位置。普通 MCP 命令不是持久作业管理器，不会自动重放。

### 2.3 十一个工具速查

| 工具 | 用途与主要参数 |
|---|---|
| `list_servers` | 无参数；发现已保存 profile、挂载状态和 `file_access`，不回显密码 |
| `server_status` | `server` 可选；刷新指定服务器的映射归属、可读性和命令通道状态 |
| `configure_server` | 新建或合并 profile；已有配置只传需改变的字段，未传字段保持原值 |
| `trust_host` | `host`、`port=22`；获取主机指纹，供配置与核对 |
| `mount_server` | 必填 `server`；挂载已配置盘符，成功后刷新该 profile 的映射信息 |
| `unmount_server` | 必填 `server`；卸载映射，保留目录链接和服务器文件 |
| `exec` | 必填 `command`；远端任务，支持 `server`、`cwd`、超时、输出预算、提前返回 |
| `read_result` | 必填 `result_id`；运行中或完成后的字节分页读取，支持等待新输出 |
| `cancel_exec` | 必填 `result_id`；取消活动或排队任务，再读结果确认最终状态 |
| `read_file` | 必填 Linux `path`；SSH 后备读取，支持 `server`、`offset`、`max_bytes`、`format` |
| `write_file` | 必填 Linux `path`、UTF-8 `content`；支持 `server`、`append=false`，SSH 后备写入 |

SSH 文件后备接口说明：

- `read_file` 默认 8192 字节，`max_bytes` 为 1–1048576；`read_result` 的单页上限为 65536 字节。两者 `format` 均支持 `auto` / `text` / `base64`，默认 `auto`；二进制默认省略正文，需要原始字节时显式请求 `base64`。文本分页避免拆开 UTF-8 字符。
- `write_file` 内容上限 1 MiB，父目录需已存在；覆盖写入先暂存再替换，拒绝替换软链接；追加不是原子操作。不要把它当作默认项目编辑工具。

## 3. 本机挂载与会话外恢复

恢复入口放在本机项目目录，不需要先打开远端项目或建立 MCP 会话。以下以 profile `5090`、盘符 `M:` 为例，请替换为自己的配置。

**Agent 执行时，将宿主命令工具的 `workdir` 显式设置为本机项目目录。** 失效的 `M:\` 或 `\\sshfs.r\…` 工作目录可能导致命令根本无法启动；仅在命令内部写 `Set-Location` 无法补救启动失败。

以下为 PowerShell 示例，每项按需单独执行。`rtk proxy` 是可选的命令前缀，未安装 RTK 时可去掉。

```powershell
Set-Location -LiteralPath '<项目根目录>'

# 查看状态
rtk proxy .\runtime\node.exe .\remote-shell.mjs list

# 挂载 / 恢复 5090
rtk proxy .\runtime\node.exe .\remote-shell.mjs setup 5090

# 恢复全部配置了盘符的服务器；健康挂载会复用
rtk proxy .\runtime\node.exe .\tools\restore_all.mjs

# 只诊断，不恢复
rtk proxy .\runtime\node.exe .\tools\restore_all.mjs --check

# 用户要求卸载时执行
rtk proxy .\runtime\node.exe .\remote-shell.mjs umount 5090
```

用户也可直接运行本机脚本，下面路径均相对于项目根目录：

| 脚本位置 | 操作 |
|---|---|
| [remount_all.cmd](remount_all.cmd) | 恢复全部服务器挂载 |
| [setup_ssh-remote.cmd](setup_ssh-remote.cmd) | 挂载默认服务器；命令行可加 profile |
| [umount_ssh-remote.cmd](umount_ssh-remote.cmd) | 卸载默认服务器；命令行可加 profile |
| [cleanup_stale_mounts.cmd](cleanup_stale_mounts.cmd) | 双击直接清理离线重复挂载并保留结果窗口；`--check` 仅预览，可指定 `Y: Z:` |
| [open-ssh-remote-terminal.cmd](open-ssh-remote-terminal.cmd) | 打开远端交互终端 |

Agent 自动执行优先调用 Node 入口，避免 `.cmd` 在失败时等待 `pause`。上述命令在 Windows 本机运行，不能发送到 Linux `exec`。

Node 挂载命令完成后会退出，SSHFS 在后台继续运行，无需保留终端窗口。

**清理离线重复挂载**（独立执行，不会自动在挂载前后运行）：

```powershell
# 仅列出状态和候选项
rtk proxy .\runtime\node.exe .\tools\cleanup_stale_mounts.mjs --check
# 默认清理全部符合规则的离线副本；双击 cleanup_stale_mounts.cmd 也是此模式
rtk proxy .\runtime\node.exe .\tools\cleanup_stale_mounts.mjs
# 仅清理指定盘符；--apply 可保留，也可省略
rtk proxy .\runtime\node.exe .\tools\cleanup_stale_mounts.mjs --apply Y: Z:
```

按账号、主机和端口判断同一服务器，不区分远端目录：存在在线挂载时保留在线的、清理离线副本；全部离线时优先保留配置中的盘符，否则保留字母排序最前的一个。同服务器不同目录的离线副本也可能被清理；需要保留时勿对其执行清理。仅处理当前配置或本项目历史挂载记录能识别的 SSHFS 服务器；超时、权限不足或归属不明时跳过。每次清理前重新核对状态，沿用挂载锁和进程身份检查；只解除映射，不删除远端文件。

对于系统映射已消失、资源管理器左侧仍显示红叉的残留盘符，清理模式会发送 Windows 驱动器移除事件（`WM_DEVICECHANGE / DBT_DEVICEREMOVECOMPLETE`）使资源管理器更新驱动器缓存，再发送 Shell 移除通知；仅发 Shell 通知可能在按 F5 后重新出现。只通知已确认不存在、未被当前配置或系统网络映射占用的盘符；指定 `Y: Z:` 时仅处理指定范围，`--check` 不刷新。每次运行的结果保存在本机 `logs/cleanup_stale_mounts.log`（相对于 `servers.json` 所在目录）；双击后的窗口保留结果，再按任意键退出。

卸载或更换运行库前保存文件、暂停其他 Agent 写入；已有文件句柄会失效。只处理确认归属的映射，不覆盖其他盘符，不杀无关进程，不自动提权，不无限重试。无法释放的卷按错误处理，必要时重启 Windows 后从本机恢复。

新会话可引用：**“读取 `<项目根目录>\README.md`，按挂载恢复章节恢复 `<profile>`。”** 请将占位符替换为实际路径和配置名。若远端项目会话打不开，从本机目录或无项目会话执行。

## 4. ssh-remote 命令行

已注册全局命令时使用 `ssh-remote`；也可从项目目录调用 `runtime\node.exe remote-shell.mjs ...`。CLI 检测到项目内 Node 时会使用它重新执行。

| 命令 | 功能 |
|---|---|
| `ssh-remote [profile]` | 打开原生 Linux PTY；省略 profile 使用默认服务器 |
| `ssh-remote list` | 查看所有 profile 和挂载状态 |
| `ssh-remote setup [profile]` | 挂载盘符及可选目录链接 |
| `ssh-remote umount [profile]` | 卸载；也支持 `unmount` 别名 |
| `ssh-remote exec <profile> <command...>` | 执行一条远端命令并返回结果 |
| `ssh-remote exec -f <profile> <command...>` | 持续显示命令输出；`--follow` 同义，位于 profile 前 |
| `ssh-remote gpu [profile]` | GPU 状态快照；加 `-w` 持续查看 |
| `ssh-remote rclone [profile]` | 用户主动选择的备用 SFTP 挂载方式 |
| `ssh-remote [profile] --framed` | 旧逐行兼容模式；管道输入也使用此模式 |
| `ssh-remote help` | 查看帮助 |

原生终端中，Tab 补全、方向键、Ctrl+C、颜色和窗口尺寸由远端 Bash/PTY 处理；支持服务器已加载的 bash-completion。可直接运行 `htop`、`nvitop`、`gpustat -i 1`；退出使用 `exit` / Ctrl+D。终端会话保留目录和环境，挂载内启动目录会映射到对应远端位置。

管理子命令在 Windows 外层运行；原生终端里的 `help` 是 Bash 帮助。`raw` / `!` 等旧快捷方式属于 `--framed` 模式。MCP `exec` 是文本任务接口，全屏 TUI 应在 CLI 中运行。

PowerShell 执行远端命令时可用单引号保护远端的 `$` 等字符，例如：

```powershell
ssh-remote exec 5090 'cd /home/example/project && pytest -q'
ssh-remote exec -f 5090 'python -u /home/example/project/train.py'
```

rclone 挂载要求项目内 `rclone/rclone.exe`，公钥文件取 `SRB_KNOWN_HOSTS` 指定路径或项目内 `known_hosts`；使用前核对其中的服务器公钥。它在前台运行，需保持窗口开启；关闭或 Ctrl+C 结束。桥接器不会自动切换挂载后端。

## 5. 安装、注册与服务器配置

### 5.1 本机依赖与安装

当前机器已配置，无需重新安装。新环境需要：

- **Node.js 与 npm**：包声明最低 Node 18，建议使用受支持的正式版；当前独立环境版本见第 6 节。
- **Plink**：持久命令通道使用，建议放在 `bin/plink.exe`。
- **WinFsp + SSHFS 运行库**：挂载时需要。原生终端还使用 npm 依赖 `ssh2`。
- **Cygwin 控制台辅助组件**：SSHFS 挂载运行库的必需组件，位置为 `runtime/sshfs/bin/cygwin-console-helper.exe`。由下方安装器从锁定的官方 Cygwin 包自动安装并检查，无需单独编译；缺少它可能导致后台挂载弹出常驻空白终端。部署或复制运行库时必须一并保留。
- **7-Zip**：仅运行库安装解包时需要。rclone 是可选的备用挂载工具。

服务器需提供 Linux、Bash、**`/usr/bin/python3` ≥ 3.9**（仅标准库，无需 pip）、以及常用 GNU coreutils（如 `base64`、`stat`、`dd`）。`setsid` 用于主动脱离命令会话的任务；`htop`、`nvitop`、`gpustat` 等交互程序需要在服务器上另行安装。Python 缺失或版本不满足时，命令通道会直接报错，不自动更换传输或重放命令；本机无需安装 Python。

在本机项目目录安装 npm 依赖：`npm ci`。注册全局 CLI 可执行 `npm install -g .`，也可始终使用 Node 直接调用入口。执行 npm 时遵循宿主命令规则。

安装独立挂载运行库：

```powershell
rtk proxy node .\tools\install_sshfs_runtime.mjs
```

安装器下载已锁定的官方 Cygwin 二进制包，检查大小和 SHA-512，并检查后台启动必需的 `cygwin-console-helper.exe`；不编译程序，不覆盖已有运行库、不触碰当前挂载。优先使用 `runtime/7zip/7z.exe`，否则使用系统 7-Zip。来源、版本和文件 SHA-256 保存于 `runtime/sshfs/provenance.json`。

升级时加 `--stage` 准备 `runtime/sshfs-next/`；验证后保存文件、卸载受影响映射，将旧 `sshfs/` 移至备份，再把 `sshfs-next/` 更名为 `sshfs/` 并重新挂载。运行库不能热更新。新启动的 SSHFS 必须 >=3.7.2；选择顺序为 `SRB_SSHFS` 显式路径 → 项目独立运行库 → 系统 SSHFS-Win。

**首次克隆 / Agent 安装要求：** 基础运行库安装器只准备构建所需依赖，安装完成不代表可直接挂载。首次部署必须继续按 [SSHFS 构建与修复手册](BUILD-SSHFS.md) 构建、验证并启用 3.7.2+srb.1；确认实际选中的 SSHFS 为修复版后再挂载。不要把已知存在句柄泄漏的官方 3.7.2 原版作为最终安装结果。SRB_SSHFS 或系统安装可能覆盖版本选择，必须检查实际使用的程序。若工具链缺失或构建失败，应报告阻塞，不能静默退回原版。Git 克隆和基础安装脚本都不会自动完成修复版构建。

**句柄泄漏修复版：** 本项目提供 `3.7.2+srb.1` 的源码补丁和构建脚本，需构建后启用到 `runtime/sshfs/` 并重新挂载。修复版二进制不随源码仓库分发；基础安装器仍提供官方原版，不能替代构建步骤。构建环境、验证结果和切换步骤见 [SSHFS 构建与修复手册](BUILD-SSHFS.md)。

### 5.2 注册 MCP

| 客户端 | 本机注册入口 | 配置与生效 |
|---|---|---|
| Codex | [register_mcp_codex.cmd](register_mcp_codex.cmd) 或 `node tools/register_mcp_codex.mjs` | 用户目录 `.codex/config.toml`；重载 MCP 或重启宿主 |
| WorkBuddy | [register_mcp.cmd](register_mcp.cmd) 或 `node tools/register_mcp.mjs` | 用户目录 `.workbuddy/mcp.json`；在客户端信任/启用该连接器并重新连接 |

注册脚本优先选择项目 `runtime/node.exe`，保留其他 MCP 条目及已有 env/选项。通用 STDIO 启动配置为：

```json
{
  "command": "<本机项目目录>\\runtime\\node.exe",
  "args": ["<本机项目目录>\\mcp\\server.mjs"]
}
```

此 JSON 表示启动参数，实际配置文件格式由客户端决定；Codex 的表名为 `[mcp_servers.ssh-remote-bridge]`，键为 `command`、`args`，可配置 `startup_timeout_sec=120`。路径使用绝对路径。注册后调用一次 `list_servers` 确认连接，不需要为了验证而新建 profile。

### 5.3 配置服务器

本机配置保存在 `servers.json`；首次部署可参考 [servers.example.json](servers.example.json)。已有配置不要用模板覆盖。多个服务器共用一个 MCP，各使用自己的 profile 名和不同盘符。

优先使用 `configure_server`：新 profile 提供 `name`、`host`、`user`、`password` 或 `keyFile`；按需指定 `drive`、`remote`、`port`。未提供主机指纹时会尝试获取；首次信任应核对目标和指纹。更新已有 profile 只传要变更的字段。

| 字段 | 含义 |
|---|---|
| 顶层 `plink` | Plink 路径；相对路径按项目根目录解析，例如 `bin\\plink.exe` |
| `servers.<name>` | 服务器 profile；工具的 `server` 参数使用此名称 |
| `host`、`port`、`user` | SSH 地址、端口、账户；端口默认 22 |
| `password` / `keyFile` | 二选一；完整功能使用 OpenSSH 格式私钥，PPK 需先转换 |
| `hostkey` | 固定的 `SHA256:...` 主机指纹；`trust_host` 可获取供核对 |
| `remote` | 映射的远端根目录，默认 `/home/<user>`；也是 MCP 默认 cwd |
| `drive` | 本地盘符，例如 `M:`；仅命令访问可不配置，每台映射服务器使用不同盘符 |
| `mount` | 可选本地目录链接；留空时只使用盘符，创建链接可能需要 Windows 开发者模式或权限 |
| `default` | JSON 配置中的默认服务器标记；MCP 配置时对应 `isDefault` |
| `note` | 可选备注 |

`servers.json` 可明文保存密码，工具回复会隐藏密码；文件及备份不应进入 Git 或发布包。挂载固定主机密钥，并在 `.srb-mounts/` 保存进程归属与公钥记录；卸载只处理已确认归属的进程或映射。

常用环境变量：`SRB_CONFIG` 指定服务器配置文件，`SRB_PLINK` 指定 Plink，`SRB_SSHFS` 指定 SSHFS，`SRB_KNOWN_HOSTS` 指定已知公钥文件。Codex 注册目录可用 `SRB_CODEX_CONFIG_DIR` 指定；未设置时遵循 `CODEX_HOME` / 默认用户目录。

## 6. 当前运行环境

以下为本机 **1.5.0** 使用的工具版本，并非换机器后自动具备：

| 组件 | 版本与位置 |
|---|---|
| Node.js / npm | 26.12.0 Current 正式版 / 11.20.0；`runtime/` |
| Plink | 0.85；`bin/plink.exe` |
| 7-Zip | 26.04；`runtime/7zip/` |
| SSHFS | 3.7.2+srb.1；需构建并启用到 `runtime/sshfs/`，包含四处条件变量销毁修复 |
| Cygwin / 控制台辅助组件 | 3.6.11；包含 `runtime/sshfs/bin/cygwin-console-helper.exe`，挂载运行库必需 |
| OpenSSH / OpenSSL | 10.5p1 / 3.5.9；独立 SSHFS 运行库中的官方 Cygwin 二进制 |
| WinFsp / ssh2 / rclone | 2.1 / 1.17.0 / 1.75.2 |

CLI 和已更新的 MCP 注册优先使用项目独立工具。第三方二进制不进入 Git/npm 包，换机器需重新部署；源码安装使用锁定的 npm 依赖及 Cygwin 包清单。SSHFS 3.7.2 未包含后续上游版本的全部修复。

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| 重启后 M: 消失或目录打不开 | 从本机项目目录执行第 3 节恢复入口，先确认目标 profile |
| 盘符被其他映射占用 | 查看状态并确认归属；不要覆盖或强行删除其他映射 |
| 已存在的深层目录 mkdir 报 EPERM | 检查活动挂载是否仍使用旧 SSHFS；>=3.7.2 修复了该错误码，升级后需重新挂载 |
| 对盘符根目录 mkdir 报 EPERM | Windows/Node 的根目录行为，不能据此认定深层目录或文件不可写 |
| Edit 报 ModifyBackup / UNC 路径错误 | 保留工具名、完整路径、原始错误及失败后内容；这是独立问题，尚未稳定复现 |
| 写入失败后准备改走 SSH | 先核对实际文件状态；不要重复追加，不绕过宿主安全策略 |
| 命令长时间没有输出 | 用 `read_result` 等待新内容；确认程序刷新 stdout，不要重跑原命令 |
| 输出被截断 | 区分 RESPONSE-LIMIT 与 REMOTE-CAPTURE-LIMIT，按第 2 节读取片段或服务器日志 |
| 主机指纹不匹配 | 核对服务器身份和主机密钥变化；不要关闭校验来继续连接 |
| UNC/盘符已失效，宿主命令启动失败 | 将工具 `workdir` 改为本机项目目录，再执行恢复 |
| 工具看不到新版本、挂载仍用旧程序 | MCP 重载影响命令进程；挂载运行库更换需要卸载再挂载，两者分别处理 |

## 8. 维护与更新记录

桥接器自身的检查入口：`npm test` 为轻量隔离回归；`npm run test:remote -- <profile>` 检查远端命令通道；`npm run test:lifecycle -- <profile>` 检查连接复用、远端超时、后台进程清理、退出和排队行为；`npm run test:mcp-live` 检查默认服务器的增量输出；`npm run test:terminal -- <profile>` 检查远端 PTY。远端检查会建立连接并执行测试命令，应在需要验证时运行。

1.5.0 重构远端执行循环、CLI 会话与退出清理，增加空闲回收，减少重复连接和输出解析的内存复制。更新后**重新加载 MCP，退出并重开 CLI**；现有 M: 无需重新挂载。资源实测与剩余风险见 [本轮审计](AUDIT-2026-10-19.md)；历史记录见 [FIXES.zh-CN.md](FIXES.zh-CN.md)。[English README](README.en.md) · [MIT License](LICENSE)
