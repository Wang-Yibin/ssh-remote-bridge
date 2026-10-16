# ssh-remote-bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-5FA04E.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4.svg)](https://learn.microsoft.com/windows/)

**[中文](README.md)** | [English](README.en.md)

> 远程服务器 **文件映射 + 命令转发** 系统（Windows 本机 ↔ Linux 服务器）
> 包含三件套：**盘符映射**、**命令行转发**、**MCP server（给 AI 用）**
> 支持多服务器、多账号密码、可插拔——加服务器只改一个配置文件。

在 VS Code 里打开 `M:\` 就是服务器的文件，在终端里敲命令就是在服务器上执行，
AI（WorkBuddy / Codex / 任何 MCP 客户端）也能直接调工具操作服务器。

**毫秒级响应**：SSH 长连接复用，首次握手约 5.6s（成本在服务器侧 KEX/PAM），
之后每条命令 **4-35ms**（实测），`cd` 和环境变量跨命令保持。

```bat
:: 1) 装依赖：Node.js >= 18 + plink.exe（必需，见 §4.1）
::    挂文件映射还要 WinFsp + SSHFS-Win，本仓库不带安装包，请自行从官网下
check_deps.cmd              :: 一键体检，缺什么会告诉你去哪下

:: 2) 配服务器（复制模板改成自己的；或直接问 AI「帮我配一下这台服务器」）
copy servers.example.json servers.json

:: 3) 挂载 + 用起来
setup_ssh-remote.cmd
ssh-remote.cmd                :: 进入远程 shell

:: 4) 电脑重启后恢复映射（随时可重复运行）
remount_all.cmd
```

给 AI 用：

```bat
register_mcp.cmd          :: 注册到 WorkBuddy
register_mcp_codex.cmd    :: 注册到 Codex
```

> **不依赖任何特定 AI 客户端** —— 实现的是标准 MCP 协议（stdio + JSON-RPC），
> WorkBuddy、Codex、Claude Desktop 等任何 MCP 客户端都能接入。

> **仓库只装源码，不含任何 `.exe` / `.msi`。** 需要驱动的话去官方站下（链接见 §4.1），
> 这样clone 只有 200 多 KB，而且你拿到的一定是上游最新版。

---

<details>
<summary><b>完整说明书（12 章）</b></summary>

# ssh-remote-bridge 使用说明书

---

## 目录

1. [这是什么](#1-这是什么)
2. [架构总览](#2-架构总览)
3. [文件清单](#3-文件清单)
4. [快速开始（5 分钟）](#4-快速开始5-分钟)
5. [servers.json 字段详解](#5-serversjson-字段详解)
6. [ssh-remote 命令行使用详解](#6-ssh-remote-命令行使用详解)
7. [MCP Server 使用详解](#7-mcp-server-使用详解)
   - [**7.2 AI 首次接入：必须先向用户索要信息（硬性规则）**](#72-ai-首次接入必须先向用户索要信息硬性规则)
8. [挂载机制详解（为什么这么设计）](#8-挂载机制详解为什么这么设计)
9. [可插拔：如何添加新服务器](#9-可插拔如何添加新服务器)
10. [安全说明](#10-安全说明)
11. [故障排查](#11-故障排查)
12. [已知限制](#12-已知限制)

---

## 1. 这是什么

一句话：**把远程 Linux 服务器的家目录挂到本地一个文件夹里（例如 `F:\<user>`），在这个文件夹里，看文件就是看服务器文件，跑命令就是在服务器上跑。**

三个使用入口，覆盖三种场景：

| 入口 | 适合谁 | 能干什么 |
|---|---|---|
| `F:\<user>` 文件夹 | 人 | VS Code / 资源管理器里直接浏览、编辑服务器上的文件 |
| `ssh-remote` 命令行 | 人 | 在任意终端敲命令，原样送到服务器执行，退出码和输出原样返回 |
| **MCP server** | AI 大模型 | AI 自己调工具在服务器上执行命令、读写文件、查状态、管挂载 |

核心特性：

- **完全利用服务器算力**：命令在服务器的 shell 里跑，CPU / GPU / conda 环境全部可用（多卡服务器实测正常访问）
- **毫秒级响应**：SSH 长连接复用，握手只付一次（约 5.6s，成本在服务器侧 KEX/PAM），之后每条命令 **4-35ms**（实测）
- **状态不丢**：命令跑在服务器端长连接执行器里，`cd`、环境变量跨命令保留
- **退出码真实回传**：`echo $?` 级别的保真，脚本编排可靠
- **特殊字符安全**：命令经 base64 帧传输，引号、管道、`$`、换行都不会坏
- **Ctrl+C 真中断**：中断帧打到远端进程组（SIGTERM，2s 后升级 KILL），不会误杀本机
- **多服务器可插拔**：所有服务器集中在 `servers.json`，加一台服务器 = 加一段 JSON
- **零第三方 Node 依赖**：只用 Node 内置模块 + 系统 plink + SSHFS-Win

---

## 2. 架构总览

```
┌───────────────────────── 本机 Windows ─────────────────────────┐
│                                                                │
│   M: ──net use──▶ SSHFS-Win      ( 可选: F:\xxx ──mklink──▶ M: ) │
│   ▲                 │             mount 留空时不需要符号链接      │
│   │                 │             (见 §8)                        │
│   └─ VS Code / Explorer / 任何工具直接读写服务器文件  │           │
│                                                                │
│   ssh-remote CLI ──┐                                           │
│            ├── plink (SSH 长连接) ──▶ 服务器 bash 循环执行器 ──┼──┐
│   MCP ◀────┘         命令 base64 帧      输出/退出码/cwd 帧回传  │  │
│                                                                │  │
└────────────────────────────────────────────────────────────────┼──┘
                                                                 ▼
                                              Linux 服务器（完整 CPU/GPU/conda 环境）
```

### 命令转发协议（v4，已实测验证）

以 `ssh-remote> nvidia-smi` 为例，背后发生的事：

1. **建连（一次性）**：plink 连上服务器，把 `lib/exec-loop.sh`（base64 内联在连接命令行里）写到远端临时文件并执行，远端进入 bash 循环守着这条连接。**握手约 5.6 秒**——成本在服务器侧 SSH KEX/PAM，与客户端无关（VS Code Remote-SSH 首次连接同样等这么久）
2. **传输**：本地把命令 base64 编码加 Token 成一帧发出；远端 `setsid` 起独立会话执行，输出重定向到临时文件
3. **状态承接**：执行前先恢复上次的 `cd`/环境变量，执行后再存起来——**所以状态跨命令保持**
4. **回传**：stdout+stderr、真实退出码、当前目录各自 base64 成一帧回传，本地拼装后删临时文件

### 为什么快 / 为什么状态不丢

| | 每条命令新开 SSH | 旧 tmux 转发 | **长连接执行器（本方案）** |
|---|---|---|---|
| 每条命令开销 | 完整握手 5.6s | 2 次握手 ≈ 11s | **4-35ms** |
| `cd` / `conda activate` / `export` | 丢 | 保留 | **保留**（状态文件承接） |
| 后台任务（`&`） | 随连接断开被杀 | 继续跑 | **继续跑** |
| Ctrl+C 中断 | 只能断开 | 面板级 | **整进程组 SIGTERM → 2s 后 KILL** |
| 首次开销 | 5.6s | 5.6s | 5.6s（之后 ms 级） |

> 旧 tmux 通道保留为兜底：`SRB_TRANSPORT=tmux` 可强制走旧路；长连接建不起来时
> （极少数服务器缺 base64/setsid）自动回落，无需手动干预。

---

## 3. 文件清单

```
.
├── servers.example.json  ★ 配置模板：复制成 servers.json 再填自己的值
├── remote-shell.mjs      ★ ssh-remote CLI：交互 shell + setup/umount/list/exec 子命令
├── ssh-remote.cmd          跨平台入口：双击用，或加进 PATH 后任意终端敲 ssh-remote
├── setup_ssh-remote.cmd          一键挂载（薄包装 → ssh-remote setup）
├── umount_ssh-remote.cmd         一键卸载（薄包装 → ssh-remote umount）
├── remount_all.cmd                重启后一键恢复所有盘符映射（幂等，可重复跑）
├── check_deps.cmd                依赖体检：缺什么直接给出官方下载地址
├── register_mcp.cmd               注册到 WorkBuddy
├── register_mcp_codex.cmd         注册到 Codex
├── lib/
│   ├── engine.mjs        ★ 核心引擎：CLI 和 MCP 共用（执行/读写/挂载/密钥）
│   ├── persist.mjs       ★ 长连接执行器：RemoteExec 类（帧协议/超时中断/重连/保活）
│   └── exec-loop.sh         ★ 远端执行循环脚本（协议 v4，建连时 base64 引导写入）
├── mcp/
│   └── server.mjs        ★ MCP server：stdio 协议，9 个工具
├── tools/
│   ├── register_mcp.mjs / register_mcp_codex.mjs   两个注册脚本的实现
│   ├── restore_all.mjs   恢复脚本的实现（remount_all.cmd 调它）
│   └── scan_package.py   分发包凭据泄漏扫描器
├── experiments/          测试套件（58 项回归 + 并发 + 延迟基准）
├── package.json          npm 包定义（bin: ssh-remote）
└── README.md             本说明书
```

带 ★ 的是核心代码，约 1000 行，**零第三方 npm 依赖**（只用 Node 内置模块）。

**不进版本库的文件**（`.gitignore` 已挡）：`servers.json`（含明文密码）、
`servers.json.bak`、`rclone.conf`、`known_hosts`、日志、`dist/`、`rclone/`。

---

## 4. 快速开始（5 分钟）

### 4.1 前置条件（本机 Windows）

**这个仓库不含任何二进制文件**（没有 `.msi`、没有 `.exe`）。所有依赖都从官方渠道下载：

| 依赖 | 必需？ | 用途 | 下载 |
|---|---|---|---|
| **Node.js ≥ 18** | ✅ **必需** | 运行 CLI 和 MCP server | <https://nodejs.org>（选 LTS） |
| **plink.exe** | ✅ **必需** | SSH 客户端 | <https://www.chiark.greenend.org.uk/~sgtatham/putty/>（PuTTY 自带，或单独取 plink.exe） |
| WinFsp | ⭕ 仅文件映射 | Windows 文件系统驱动 | <https://winfsp.dev> 或 [GitHub Releases](https://github.com/winfsp/winfsp/releases) |
| SSHFS-Win | ⭕ 仅文件映射 | 基于 WinFsp 的 SSH 文件系统 | [GitHub Releases](https://github.com/winfsp/sshfs-win/releases) |

**只有前两项是硬需求。** WinFsp + SSHFS-Win 只在你想把服务器目录挂成
Windows 盘符时才需要 —— 只用 `ssh-remote` 命令行或 MCP server 的话完全可以不装。

下载完两个 `.msi` 后双击安装，或静默安装：

```bat
msiexec /i winfsp-2.1.25156.msi /qb /norestart
msiexec /i sshfs-win-3.5.20357-x64.msi /qb /norestart
```

双击 `check_deps.cmd` 可以一键体检，看还缺什么。

服务器端只需 `bash` + `base64` + `setsid`（util-linux，主流发行版默认自带）；
只有旧 tmux 兜底通道才需要 `tmux`（`sudo apt install tmux`）。

> **为什么不把安装包放进仓库？**
> 两个 `.msi` 加 `node.exe` 加 `rclone.exe` 约 170MB。放进 git 的话，
> 每次 clone 都要下载 170MB，而且 git 历史会永久保存这些文件（删掉也还在）。
> 更麻烦的是版本会陈旧 —— 仓库锁死的版本没人更新。
> 让你从官网拿，永远是最新版，clone 也只有 200 多 KB。

> **plink 路径怎么配**：`servers.json` 里写绝对路径，或用环境变量 `SRB_PLINK` 覆盖。
> 代码也支持相对路径（如 `"bin\\plink.exe"`），这样整个目录可以整包搬走。

### 4.2 配置服务器

编辑 `servers.json`（字段详解见[第 5 节](#5-serversjson-字段详解)）。最小可用配置：

```json
{
  "plink": "bin\\plink.exe",
  "servers": {
    "myserver": {
      "host": "10.0.0.1",
      "port": 22,
      "user": "alice",
      "password": "your-password",
      "hostkey": "SHA256:<把 plink 首连输出里的指纹粘这里>",
      "drive": "M:",
      "remote": "/home/alice",
      "default": true
    }
  }
}
```

**最省事的做法：让 AI 帮你配。** 注册 MCP（见[第 7 节](#7-mcp-server-使用详解)）后，
在对话里说「帮我配一下这台服务器」，AI 会**向你索要** IP、账号、密码、映射目录、盘符，
然后调 `configure_server` 自动写好——不用你手改JSON，也不用自己拿指纹。

**手工配也行**（如果你想自己填）：

**hostkey（主机密钥指纹）怎么拿**——两种方式任选：

```bash
# 方式一：命令行（Windows 10 1803+ 自带 ssh-keyscan）
ssh-keyscan -t ed25519 -p 22 10.0.0.1 | ssh-keygen -lf -

# 方式二：直接跑 plink（首次连接它会把指纹打出来然后拒绝）
bin\plink.exe -ssh -batch -P 22 10.0.0.1 exit

# 方式三：让 AI 调 MCP 工具 trust_host（见 7.4）
```

输出里 `SHA256:...` 那一串就是，原样填进 `hostkey` 字段。**没有它 plink 会拒绝连接**（这是防中间人攻击的安全设计，不是 bug）。

### 4.3 挂载 + 开始用

```bat
:: 1. 挂载（net use 盘符；重启后跑 remount_all.cmd 恢复）
setup_ssh-remote.cmd
:: 等价于: ssh-remote setup

:: 2. 进入挂载盘符，用 VS Code 打开就是服务器文件
::    （若配了 mount 符号链接，也可以 cd /d F:\<user>）
cd /d M:\
code .

:: 3. 任意终端敲 ssh-remote，进入远程 shell
ssh-remote

ssh-remote> nvidia-smi              :: 直接看到服务器上的 GPU（首次连接约 5.6s, 之后 ms 级）
ssh-remote> conda activate <env>    :: 激活服务器上的环境
ssh-remote> python train.py         :: 用服务器 CPU/GPU 跑
ssh-remote> exit                    :: 退出（断开长连接; Ctrl+C 是中断命令, 不退出）
```

---

## 5. servers.json 字段详解

### 顶层字段

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `plink` | 否 | `bin\plink.exe`（包内自带时） | plink.exe 路径，相对或绝对都行。也可用环境变量 `SRB_PLINK` 覆盖 |
| `servers` | **是** | — | 服务器集合。key 就是"服务器名"（profile），CLI 和 MCP 里都用它指代服务器 |

### 每个服务器的字段

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `host` | **是** | — | 服务器 IP 或域名 |
| `port` | 否 | `22` | SSH 端口 |
| `user` | **是** | — | SSH 登录用户名 |
| `password` | 二选一 | — | SSH 密码。与 `keyFile` 二选一 |
| `keyFile` | 否 | — | PuTTY 格式 `.ppk` 私钥路径（免密登录时用） |
| `hostkey` | 强烈建议 | — | `SHA256:...` 主机密钥指纹，防中间人。缺它 plink 拒绝连接 |
| `mount` | 否 | — | 本地挂载点目录，如 `F:\<user>`。**留空 = 只用盘符**（推荐，见第 8 节）。要填时 JSON 里反斜杠必须双写 |
| `drive` | 挂载必填 | — | 盘符，如 `M:`。**每台服务器必须不同**，重复会被顶掉 |
| `remote` | 否 | `/home/<user>` | 服务器上被映射的根目录 |
| `tmuxSession` | 否 | `srb-ai` | 仅旧 tmux 兜底通道使用（`SRB_TRANSPORT=tmux`），长连接方案不依赖它 |
| `default` | 否 | `false` | 是否默认服务器（省略 server 参数时用它） |
| `note` | 否 | — | 备注信息，`ssh-remote list` 时显示 |

> ⚠️ JSON 字符串里反斜杠要双写：`"F:\\<user>"` 表示 `F:\<user>`。
> ⚠️ 一台服务器的 `drive` 盘符不能和另一台重复（会互相顶掉）。
> `remount_all.cmd` 每次运行都会先做盘符冲突检测，重复时直接告诉你每台该改成什么。

### 配置模板（占位符，请替换成你自己的值）

> 下面所有 `<...>` 都是占位符。本仓库**不包含任何真实服务器信息**——
> IP、账号、密码、主机指纹一律不进文档、不进代码、不进 git。
> 只有你本机的 `servers.json` 里才有真实值（该文件请勿提交）。

```json
{
  "plink": "bin\\plink.exe",
  "servers": {
    "myserver": {
      "host": "<服务器IP或域名>",
      "port": 22,
      "user": "<你的SSH用户名>",
      "password": "<你的SSH密码>",
      "hostkey": "SHA256:<从plink首连输出里复制的指纹>",
      "drive": "M:",
      "remote": "/home/<你的SSH用户名>",
      "tmuxSession": "srb-ai",
      "default": true,
      "note": "备注：用途、GPU 型号、conda 环境名等"
    }
  }
}
```

拿 `hostkey` 的方法（首次连接，plink 会拒绝并把指纹打出来）：

```bat
bin\plink.exe -ssh -batch -P 22 <服务器IP> exit
```

复制输出里`SHA256:...` 那一行，填进 `hostkey`。

**更省事的方式：让 AI 通过 MCP 自动配。** 见下一节。

---

## 6. ssh-remote 命令行使用详解

### 6.1 注册命令（一次性，可选）

```bat
cd /d <ssh-remote-bridge 的解压目录>
npm install -g .
```

之后任意终端直接敲 `ssh-remote`。不注册也能用：`node remote-shell.mjs <子命令>`，或直接用 `setup_ssh-remote.cmd`。

### 6.2 子命令一览

| 命令 | 作用 |
|---|---|
| `ssh-remote` | 进入交互 shell（默认服务器） |
| `ssh-remote <服务器名>` | 进入交互 shell（指定服务器，如 `ssh-remote myserver`） |
| `ssh-remote list` | 列出所有服务器 + 实时挂载状态（盘符挂没挂、挂载点能不能读） |
| `ssh-remote setup [profile]` | 挂载：`net use` 盘符（持久化）+ 创建符号链接 |
| `ssh-remote umount [profile]` | 卸载：删除盘符映射（符号链接保留） |
| `ssh-remote exec <profile> <命令...>` | 执行单条命令后退出，适合脚本/批处理 |
| `ssh-remote exec -f <profile> <命令...>` | 同上，但**边跑边打印**（长任务看实时输出） |
| `ssh-remote gpu [profile]` | GPU 快照（等价 `gpustat`） |
| `ssh-remote gpu -w [profile]` | **持续刷新** GPU 视图，Ctrl+C 停止 |
| `ssh-remote help` | 帮助 |

`ssh-remote exec` 示例（可脚本化，退出码透传）：

```bat
ssh-remote exec myserver nvidia-smi
ssh-remote exec myserver "tail -5 ~/train.log"
echo 退出码=%errorlevel%
```

### 6.2.1 实时输出（流式）

加 `-f`（`--follow`）后，命令**边跑边打印**，不再干等：

```bat
:: 以前：跑完 8 秒，一次性吐出 4 行
ssh-remote exec myserver "for i in 1 2 3 4; do echo tick-$i; sleep 2; done"

:: 现在：每 2 秒出一批
ssh-remote exec -f myserver "for i in 1 2 3 4; do echo tick-$i; sleep 2; done"
```

下列命令在**交互 shell 里会自动走流式**，不用加任何参数：

| 命令 | 效果 |
|---|---|
| `gpustat -i 2` | 每 2 秒刷新，原地重画（自动清屏，不会刷出几千行） |
| `nvidia-smi -l 2` | 每 2 秒刷一次 GPU 状态 |
| `tail -f xxx.log` | 跟着训练日志滚 |
| `ping <host>` | 持续 ping |
| `watch <cmd>` | 持续刷新 |

想看 GPU 就用 `gpu -w`（等价于上面的 `gpustat -i 2`，已带清屏）：

```bat
ssh-remote gpu-w
```

**注意**：`htop` / `top` / `vim` / `nvitop` 这类**全屏 TUI 程序在快通道上跑不了**——
长连接没有 PTY（伪终端），它们需要真终端才能画界面。直接输 `htop` 会得到提示：

```
[ssh-remote] "htop" needs a real terminal (PTY); the fast channel has none.
[ssh-remote] run: raw htop
```

`raw htop` 现在就能用（走 `plink -t` 分配真 PTY），代价是每次要重走一次 SSH 握手（约 5 秒）。

### 6.3 交互 shell 内怎么用

```
> ssh-remote
------------------------------------------------------------
ssh-remote - remote forwarding shell
 server: myserver youruser@<服务器IP>  channel: persistent SSH (ms-level)
 remote cwd: /home/<user>
 exit/Ctrl+D to leave - Ctrl+C interrupts the running command - raw <cmd> full-screen - help for help
------------------------------------------------------------
ssh-remote> _
```

| 输入 | 行为 |
|---|---|
| `nvidia-smi` | 原样送到服务器执行，输出 + 退出码回传（ms 级） |
| `gpustat -i 2` | **自动流式**：每 2 秒刷新并原地重画 |
| `tail -f x.log` / `ping <host>` | **自动流式**：跟着滚 |
| `gpu` / `gpu -w` | GPU 快照 / 持续刷新 |
| `htop`（任何要 TTY 的程序） | 提示改用 `raw htop`（见 §6.2.1） |
| `exit` / `quit` / Ctrl+D | 退出本地 shell（断开长连接） |
| Ctrl+C | **中断正在运行的远程命令**（杀远端进程组）；不退出，空闲时清空输入行 |
| `raw vim x.txt` 或 `! vim x.txt` | 全屏直连模式（plink -t），适用于 vim / htop / top / watch |
| `help` 或 `?`  | 显示帮助 |
| 其它任何命令 | 同上，送服务器执行（`cd`/`export` 跨命令保持） |

**cwd 自动映射**：在挂载目录里启动 `ssh-remote`，远端会自动 `cd` 到对应路径——本地和远程始终一致。

**长任务正确姿势**（需要看着进度就用 `nohup ... &`，断线也不杀）：

```bash
ssh-remote> nohup python train.py > train.log 2>&1 &
ssh-remote> tail -f train.log      # Ctrl+C 中断 tail, 训练继续
```

首次连接约 5.6 秒（服务器侧握手成本），之后每条命令 4-35ms。会话内 `cd` / `export` 一直有效；
新开一个 `ssh-remote` 会回到远程家目录。

---

## 7. MCP Server 使用详解

### 7.1 MCP 是什么，能干什么

MCP（Model Context Protocol）是 AI 连接外部工具的标准协议。注册本 MCP server 后，**AI 大模型可以直接操作你的服务器**——不用你复制粘贴日志，AI 自己会执行命令、读文件、改配置、查挂载状态。

典型对话：

```
你：看一下 myserver 上训练跑到多少了
AI：[调 exec] tail -5 ~/train.log  →  "epoch 42, loss 0.31..."

你：把 learning_rate 改成 1e-4
AI：[调 read_file 读 config.yaml] → [调 write_file 改回去] → 完成
```

### 7.2 AI 首次接入：必须先向用户索要信息（**硬性规则**）

> **这一节是给 AI 看的第一条规则，优先级高于任何其他说明。**

ssh-remote-bridge 的包里**不含、也不应含任何真实服务器信息**。仓库里所有 IP、账号、密码、
主机指纹都是占位符。因此：

**当 AI 第一次接入（本会话中还没成功执行过任何服务器命令）时，禁止猜测、推断、
复用任何凭据 —— 必须先向用户索要以下信息：**

| # | 索要什么 | 说明 | 必填 |
|---|---|---|---|
| 1 | **服务器 IP 或域名** | `host` | ✅ |
| 2 | **SSH 端口** | 一般是 `22`，不确定就问 | 建议问 |
| 3 | **SSH 登录用户名** | `user` | ✅ |
| 4 | **密码**（或私钥文件绝对路径） | `password` / `keyFile`，二选一 | ✅ |
| 5 | **用哪个盘符做映射** | `drive`，如 `M:`（挂文件时才需要，**必须确认未被其他服务器占用**） | 建议问 |
| 6 | **要不要额外挂个普通文件夹路径** | `mount`，如 `F:\myserver`。**默认不要**（留空即只用盘符，无需开发者模式） | 建议问 |
| 7 | **服务器上映射哪个目录** | `remote`，默认 `/home/<用户名>` | 可默认 |
| 8 | **这台服务器起个什么名字** | `name`，省略则叫 `myserver` |可选 |

**正确流程（AI 侧）：**

1. 先调 `list_servers` 看有没有已配置的服务器。
2. 若返回「未配置 / 不可用」→ **停下来向用户问上面 8 项**，一次性问清，别挤牙膏。
3. 拿到答案后调 `configure_server`，**原样传入用户给的值**。
   `hostkey` 通常不用问：`configure_server` 会自动抓（plink 首次接触时会打出指纹）；
   抓不到时它会报错，那时再向用户索要 `SHA256:...` 指纹。
4. 落盘后即可直接用 `exec` / `read_file` / `write_file`。需要文件映射再调 `mount_server`。

**凭据纪律（不可违反）：**

- ❌ 不要把密码/主机指纹/内网 IP 写进任何代码、脚本、文档、注释、笔记、聊天记录。
- ❌ 不要把密码写进命令行参数（会进 shell 历史和进程列表）——用 `configure_server`。
- ❌ 不要凭记忆或从其它文件"推断"凭据，即使看起来像。
- ✅ 真实凭据**只允许**存在于本机 `servers.json`（此文件请勿提交到 git）。
- ✅ 密码不会出现在任何工具的返回值里（`configure_server` 返回 `***(stored in servers.json)***`）。

**盘符（第 5 项）必须确认没被别的服务器占用** —— 可先 `list_servers` 看各占什么，
给用户推荐一个空闲的。盘符重复会让「A 服务器的文件夹内容变成 B 服务器的」，极难排查。

**`mount`（第 6 项）默认建议用户不要填** —— 只用盘符就不需要开发者模式和管理员权限，
少一个失效点。等用户明确说「我想要 `F:\xxx` 这种固定路径」再补。

### 7.3 注册步骤（WorkBuddy / Codex，两个都装就都可用）

ssh-remote-bridge 是标准 MCP server，WorkBuddy 和 Codex 都能用。两个客户端配置格式不同，各有一个注册脚本。

#### A. 注册到 WorkBuddy

双击 **`register_mcp.cmd`**（自动合并进 `mcp.json`，保留已有条目），或手动编辑
`C:\Users\<你的用户名>\.workbuddy\mcp.json`（注意：**没有点前缀**，不是 `.mcp.json`）：

```json
{
  "mcpServers": {
    "ssh-remote-bridge": {
      "command": "<node.exe 的完整路径，如 D:\\Program Files\\nodejs\\node.exe>",
      "args": [
        "<ssh-remote-bridge 目录>\\mcp\\server.mjs"
      ]
    }
  }
}
```

| 配置项 | 说明 |
|---|---|
| `command` | node.exe 完整路径（用系统 Node，不用 npx——本机实测 npx 会挂死） |
| `args` | MCP server 入口脚本的**绝对路径** |
| 多服务器共存 | `mcpServers` 是个对象，已有的条目（如 rea）保持不动，追加 `ssh-remote-bridge` 即可 |

**保存后必须做最后一步**：打开**连接器管理页 → 右上角「自定义连接器 / 信任」入口 → 找到 ssh-remote-bridge → 点「信任」**。不点信任，MCP 不会生效。

#### B. 注册到 Codex

Codex 用 `~/.codex/config.toml`（**TOML，不是 JSON**），配置键叫 `mcp_servers`。

双击 **`register_mcp_codex.cmd`**，它优先调官方 CLI：

```bat
codex mcp add ssh-remote-bridge -- "<ssh-remote-bridge 目录>\runtime\node.exe" "<ssh-remote-bridge 目录>\mcp\server.mjs"
```

`codex` 不在 PATH 上时脚本自动退回直接改 `config.toml`。也可以手动在文件末尾追加：

```toml
[mcp_servers.ssh-remote-bridge]
command = '<ssh-remote-bridge 目录>\runtime\node.exe'
args = ['<ssh-remote-bridge 目录>\mcp\server.mjs']
startup_timeout_sec = 120
```

> ⚠️ TOML 的**单引号是字面量、不做转义**，所以 Windows 反斜杠可以直接写。
> 千万别用双引号 —— 那样 `\r`、`\n` 会被当成转义符，路径直接坏掉。

```bat
codex mcp list                查看已注册的 MCP（确认 ssh-remote-bridge 在列表里）
codex mcp get ssh-remote-bridge看单项详情
codex mcp remove ssh-remote-bridge    卸载
```

#### 两边对比

| | WorkBuddy | Codex |
|---|---|---|
| 配置文件 | `~\.workbuddy\mcp.json`（JSON） | `~\.codex\config.toml`（TOML） |
| 注册键 | `mcpServers` | `mcp_servers` |
| 注册脚本 | `register_mcp.cmd` | `register_mcp_codex.cmd` |
| 生效方式 | 连接器页点「信任」 | **重启 Codex** |
| 验证 | 连接器页能看到 ssh-remote-bridge | `codex mcp list` |

> 想换配置位置：server.mjs 支持环境变量 `SRB_CONFIG` 指向另一个 servers.json；想换 plink 路径用 `SRB_PLINK`。
> `register_mcp_codex.mjs` 还支持 `SRB_CODEX_CONFIG_DIR` 直接指定 config.toml 所在目录（测试隔离 / 多套 Codex 配置用）。

### 7.4 九个工具

参数细节直接看 MCP 工具自身的 schema（客户端里能看到），这里只列用途和关键点。

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `list_servers` | — | 列出所有服务器 + **实时挂载状态**（`drive_mounted`/`mount_ok`）。不含密码。**AI 每次操作前应先调它确认服务器名** |
| `configure_server` | `name` `host` `user` `port` `hostkey` `drive` `mount` `remote` `note` + (`password` 或 `keyFile`) | 写入/更新服务器。**合并语义**：没传的字段保持原值。`hostkey` 省略则自动抓取。密码永不回显 |
| `exec` | `command` `server` `timeout=120` | 执行命令，返回 `exit=` `duration=` + 输出。**最常用** |
| `read_file` | `path` `server` `max_bytes=65536` | 读文件。文本直返，二进制返 base64，超限截断并标注 |
| `write_file` | `path` `content` `append` `server` | 写文件。大文件自动分片（绕开 pty 单行 4096 字节限制） |
| `mount_server` | `server` | 挂载：建盘符映射（+ 可选符号链接）。需已装 WinFsp+SSHFS-Win |
| `unmount_server` | `server` | 卸载：删除盘符映射，符号链接保留 |
| `server_status` | `server` | 体检：挂载状态、通道健康度。**出问题先调它** |
| `trust_host` | `host` `port=22` | 取 `SHA256:...` 主机指纹。添加新服务器时用 |

几个容易踩的点：

- **`exec` 不要跑交互式全屏程序**（vim/htop/top）——用本机 `ssh-remote` 的 `raw` 模式。
- **`configure_server` 只接受用户刚刚明确告诉你的值**，绝不从别处"推断"凭据（见 §7.2）。
- **`hostkey` 抓不到是正常的**：首次接触服务器时 plink 本来就会拒绝并打印指纹，那就是你要的指纹。
- **`list_servers` 返回「未配置」时必须停下来问用户**，别继续往下调。

### 7.5 注册后的验证

在 AI 对话里说：「调 list_servers 看看有哪些服务器」——能返回服务器信息（含 `drive_mounted: true`）就说明整条链路通了。

---

## 8. 挂载机制详解（为什么这么设计）

### 两种模式，先选一种

| | **只用盘符（推荐）** | 盘符 + 符号链接 |
|---|---|---|
| 配置 | 只填 `drive`，**`mount` 留空** | `drive` 和 `mount` 都填 |
| 访问路径 | `M:\` | `M:\` **和** `F:\<user>\` |
| 权限要求 | **无**（`net use` 任何人都会） | 需要开发者模式或管理员（`mklink /D`） |
| VS Code / 资源管理器 | 直接输 `M:` 可以 | 两种都行 |
| 目录名带服务器名 | 靠盘符区分 | 目录名可以自定义 |

**建议：先只用盘符。** 少一层符号链接就少一个失效点、少一个权限坑。等你确实需要 `F:\myserver` 这种固定路径（某些工具只认普通文件夹）时，再补 `mount`。

### 完整链路

```
[只用盘符]  M:  ──net use──▶  SSHFS-Win  ──SSH──▶  服务器 /home/<user>

[带符号链接] F:\<user>  ──mklink /D──▶  M:  ──net use──▶  SSHFS-Win  ──SSH──▶  服务器
             (普通文件夹路径)          (盘符)             (用户态文件系统)        (真实文件)
```

### 三个关键设计决策

**① 为什么挂的是盘符而不是目录？**
SSHFS-Win 的 `net use` 只支持盘符，不支持目录挂载（直接挂目录会报错误 87/67）。所以底层永远是盘符，
要不要再包一层符号链接变成普通文件夹路径，是你的选择（见上面对比表）。

**② 为什么密码要内联在 net use 命令行？**
实测：用 `cmdkey /add` 存的 Windows 凭据，SSHFS-Win **不读**（报"密码无效"）。唯一可靠方式是密码直接
出现在命令行：`net use M: \\sshfs.r\user@host\path <密码> /user:user /persistent:yes`。
`ssh-remote setup` 已自动处理。

**③ UNC 路径前缀**
- `\\sshfs.r\...` = **r**ooted，后面跟绝对路径（`\home\<user>`），本系统用这个
- `\\sshfs.kr\...` = 免密（key）模式
- `\\sshfs.r\user@host!port\...` = 非 22 端口时主机名后加 `!端口`

### 每台服务器必须用不同盘符

**同一个盘符同一时刻只能连一台机器。**两台都配 `M:` 时，后挂的会把先挂的踢掉，
症状是「刚才还在看 A 服务器，`M:\` 里突然变成了 B 服务器的文件」——
看起来像文件被改了，其实是映射被顶掉了，属最难自查的一类故障。

两道防线：
1. **加服务器时**就给它一个空闲盘符（`M:` 用了就 `N:`、`O:`）
2. **`remount_all.cmd` 每次运行前自动检测**，发现重复会列出冲突并建议每台改成什么：

```
!!! 盘符冲突：多台服务器配了同一个盘符 !!!
  M:  ←  5090  和  box-b  和  box-c
  修法: 编辑 servers.json, 给每台一个不同的盘符, 例如
         5090: drive "M:"  ->  保持不变（第一台优先）
         box-b: drive "M:"  ->  改成  "N:"
         box-c: drive "M:"  ->  改成  "O:"
```

### 符号链接的权限要求（仅 `mount` 模式需要）

`mount` 留空时**完全用不到**。只有填了 `mount` 才需要以下任一条件（满足一次，永久有效）：
Windows 10 17003+ **设置 → 系统 → 可选功能 → 开发者模式 → 开**，或以管理员身份运行终端。

> 部分沙箱/远程工具里 mklink 会被"实体化"成空目录——这是环境限制不是 bug。
> **挂载必须在本机真实终端执行**（双击 setup_ssh-remote.cmd）。

### 挂载的生命周期

| 操作 | 效果 |
|---|---|
| `ssh-remote setup` | 建映射。`/persistent:yes` 只在登录时**尝试**重连，网络未就绪就静默失败 |
| **重启电脑** | 盘符映射大概率丢失 → **跑一次 `remount_all.cmd`**（幂等，可重复；已挂好的自动跳过） |
| `ssh-remote umount` | 只删盘符映射；符号链接保留（若有），再 setup 自动重建 |
| 符号链接指向失效盘符 | 显示为空文件夹，`ssh-remote setup` 即可恢复 |

### 备用方案：rclone

SSHFS-Win 出问题时可改用 rclone（sftp 协议）：`ssh-remote rclone [profile]`，
或 `mount_ssh-remote-rclone.cmd`。两条路线二选一，**不要同时挂**。

---

## 9. 可插拔：如何添加新服务器

**核心原则：加服务器永远只改 `servers.json`，代码一行不动。**

### 最简单的路径：让 AI 配

注册好 MCP 后（§7.3），对 AI 说「帮我配一下这台服务器」。它会问你 IP、账号、密码、盘符，
然后调 `configure_server` 写好配置并自动取主机指纹。**你不需要手改 JSON。**

### 手工配置

在 `servers` 对象里加一个条目即可：

```json
"dgx": {
  "host": "10.0.0.2",
  "port": 22,
  "user": "bob",
  "password": "<密码>",
  "hostkey": "SHA256:<见下方获取方式>",
  "drive": "N:",
  "remote": "/home/bob",
  "note": "DGX station"
}
```

**拿 hostkey**（AI 侧调 `trust_host`，或本机终端）：
```bat
ssh-keyscan -t ed25519 -p 22 10.0.0.2 | ssh-keygen -lf -
```

**验证**：
```bat
ssh-remote setup dgx     :: 挂载
ssh-remote list          :: 确认状态 ok
ssh-remote dgx           :: 进新服务器的 shell，敲 hostname 验证
```

之后对 AI 说「在 dgx 上跑一下 nvidia-smi」即可，它会调 `exec` 并传 `server="dgx"`。
**零代码改动，零重启。**

四个容易踩的点：

- **盘符必须一台一个**：`myserver` 占了 `M:`，新服务器就用 `N:`、`O:`。重复会互相顶掉，
  症状是 `M:\` 里的文件"变成"另一台服务器（见 §8）。`remount_all.cmd` 会当场检测并提示。
- **`mount` 默认不填**：只用盘符即可。需要 `F:\dgx` 这种固定路径再加这一行（要开发者模式）。
- **JSON 里反斜杠双写**：`"F:\\dgx"` 才表示 `F:\dgx`。
- **`tmuxSession` 建议区分**（如 `srb-ai-dgx`），虽然现在默认走长连接、不依赖它。

---

## 10. 安全说明

| 项目 | 说明 |
|---|---|
| 凭据存储 | 密码/密钥明文存于 `servers.json`，请收紧文件权限，勿入版本库 |
| 凭据不进代码库 | **本项目的文档、代码、测试脚本里一律不含真实 IP / 账号 / 密码 / 主机指纹**，全是占位符。真实值只允许存在于你本机的 `servers.json` |
| AI 的凭据纪律 | AI 首次接入必须**向用户索要**连接信息（见 §7.2），不得猜测、推断或复用任何凭据；也不得把凭据写进代码、文档或自己的笔记 |
| 中间人防护 | `hostkey` 指纹校验，plink 拒绝指纹不符的服务器 |
| 命令注入防护 | 命令经 base64 + 单引号转义传输，特殊字符不会破坏 SSH 命令行 |
| MCP 权限边界 | `exec` 工具 = 服务器 shell 的完整权限；AI 提示词注入风险由使用者自担 |
| 传输加密 | 全程 SSH 加密（plink） |
| 挂载加密 | 挂载链路底层同样是 SSH |

---

## 11. 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| **盘符里的文件"变成"另一台服务器** | **两台服务器配了同一个 `drive`，后挂的顶掉了先挂的** | 跑 `remount_all.cmd` 看它报的冲突清单，按提示改 `servers.json` 的 `drive` |
| 重启后盘符消失 / 文件夹打不开 | `net use` 的持久化映射在登录时网络未就绪就静默失败了 | 双击 `remount_all.cmd`（幂等，可重复跑） |
| `net use` 报错误 67 / 87 | SSHFS-Win 的 net use 只支持盘符，不支持目录 | 用 `ssh-remote setup`，别手写目录挂载 |
| 挂载后提示"密码无效" | 用了 cmdkey 存的 Windows 凭据，SSHFS-Win 不读 | 密码内联进 net use 命令行（`ssh-remote setup` 已自动处理） |
| `F:\<user>` 是空目录/打不开 | 符号链接没建成（缺开发者模式/管理员），或被环境实体化 | **改用纯盘符模式**（`servers.json` 删掉 `mount` 那一行，直接用 `M:`）；或开开发者模式 |
| `mklink` 拒绝访问 | 无符号链接权限 | 设置 → 更新和安全 → 开发者模式 → 开；或管理员运行；**或干脆不填 `mount`** |
| plink 报 host key 验证失败 | servers.json 缺 `hostkey` | `trust_host` 工具或 ssh-keyscan 拿指纹填进去 |
| 命令执行"哨兵超时" | 命令超过 timeout 仍在跑 | 不是错误。改用 `nohup ... > log 2>&1 &` + `tail` |
| 输出末尾出现 `?` 乱码 | net use 输出是 GBK 编码，已强制净化成 ASCII | 功能不受影响，忽略即可 |
| MCP 工具不出现/调用失败 | 注册后没点"信任" | 连接器管理页 → 自定义连接器 → ssh-remote-bridge → 信任 |
| `ssh-remote: command not found` | 没注册全局命令 | `npm install -g .`，或用 `node remote-shell.mjs` |
| 首次连接要 5-6 秒 | 服务器侧 SSH 握手成本（KEX/PAM），与客户端无关 | 只需等一次，之后每条命令 ms 级 |
| 长连接起不来, 自动回落 tmux | 极少数服务器缺 base64/setsid | 装齐即可；或 `SRB_TRANSPORT=tmux` 强制旧路 |
| 输出被截断（30K 字符） | 防爆缓冲的设计 | 用 `head`/`tail`/`grep` 取片段，或重定向到文件再 read_file |
| AI 沙箱里跑挂载失败 | 沙箱限制 spawn/符号链接 | 挂载必须在本机真实终端执行 |
| **重启后文件夹打不开** | 盘符映射没了（`/persistent:yes` 在登录时网络未就绪就静默失败） | 双击 `remount_all.cmd`；加 `--check` 可先只诊断 |
| 重启后盘符能挂上但文件夹路径仍不通 | 符号链接没建成（需开发者模式/管理员） | 删掉 `servers.json` 的 `mount` 行改纯盘符；或设置 → 系统 → 可选功能 → 开「开发者模式」 |

---

## 12. 已知限制

1. **仅支持 Windows 本机**：net use / mklink / sshfs.r 都是 Windows 特性。Linux/macOS 可用 `sshfs` 直接挂载，执行引擎（`engine.mjs` 的 execOn）本身跨平台可复用。
2. **pty 单行 4096 字节限制**：`write_file` 已自动 base64 分片绕过；单次 exec 输出上限 30000 字符（防爆缓冲，可调）。
3. **交互式全屏程序**（vim/htop/top/nvitop）跑不了快通道 —— 长连接没有 PTY。
   用 `ssh-remote` 的 `raw <cmd>` 模式（走 `plink -t` 分配真 PTY，代价是一次 SSH 握手约 5 秒）。
   纯文本循环刷新的命令（`gpustat -i` / `nvidia-smi -l` / `tail -f` / `ping`）**不受影响**，
   它们已在快通道上支持实时输出（见 §6.2.1）。
4. **每次 exec 一次 plink 连接**：含 SSH 握手开销（约 1 秒），批量小命令建议合并成一条 shell 脚本执行。
5. **每台服务器一个盘符，且盘符不能重复**：Windows 盘符资源有限（26 个），实际够用，但**重复会互相顶掉**——`remount_all.cmd` 每次运行前会自动检测并给出修改建议。
6. **长连接作用域 = MCP server 进程**：每个 WorkBuddy/Codex 进程各持一条到服务器的 SSH 长连接，进程退出即断开。同一服务器开两个客户端会有两条连接，属正常；两边各自的命令执行互不影响。

---

*文档版本：2026-10-15 · 对应代码版本：ssh-remote-bridge v1.0.0*

</details>
