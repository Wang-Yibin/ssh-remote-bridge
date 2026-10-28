# SSHFS 条件变量句柄泄漏修复

## 当前状态与操作入口

修复版为 **SSHFS 3.7.2+srb.1**，基于官方 3.7.2 源码，只增加四处条件变量销毁调用及版本标记。已于 2026-10-28 切换到 `runtime/sshfs/`，M: 已重新挂载生效。实际 M: 连续读取 300 次，句柄保持 304、Event 保持 96、Semaphore 保持 9，服务器端内容核对通过。旧运行库备份为 `C:\Users\riftRunnist\WorkBuddy\2026-10-14-19-00-39\fwd\runtime\sshfs-backup-handlefix-20261028-4476dc6081dd`。后续重新构建仍输出到 `runtime/sshfs-next/`，需要另行保存文件并切换。

构建脚本：[tools/build_sshfs_handle_fix.mjs](tools/build_sshfs_handle_fix.mjs)。源码补丁：[tools/sshfs-condition-lifetimes.patch](tools/sshfs-condition-lifetimes.patch)。官方包安装器 `tools/install_sshfs_runtime.mjs` 仍用于准备未修改的基础运行库，不会自动应用本修复。

本次构建环境位于：

`C:\Users\riftRunnist\.codex\visualizations\2026\10\15\01a13db8-65b6-7d02-a306-7fd9580ca178\sshfs-handles-20261028\build-env\root`

构建与验证证据保存在该 `sshfs-handles-20261028` 目录中。工具链是独立的 Cygwin，安装器来自官方站点并通过 GPG 签名验证。工具链版本为 GCC 14.4.0、Cygwin 3.6.12、Meson 1.10.2、Ninja 1.13.2、cygfuse 3.2、GLib 2.90.1；产物已验证可配合原有运行库依赖启动。

## 如何重新构建

Windows x64 本机需要独立 Cygwin 根目录，其中安装 `gcc-core`、`meson`、`ninja`、`patch`、`pkg-config`、`cygfuse`、`libglib2.0-devel`。目标是 Windows/Cygwin 程序，所以本次在本机构建。无需更新 Linux 服务器软件。

在本机项目目录执行：

```powershell
rtk proxy .\runtime\node.exe .\tools\build_sshfs_handle_fix.mjs '<独立 Cygwin 根目录>'
```

脚本从官方版本标签下载源码并核对固定 SHA-256，应用四处补丁，通过上游 Meson/Ninja 构建，然后复制当前基础运行库并只替换 SSHFS 程序。它拒绝覆盖已存在的 `runtime/sshfs-next`，不自动卸载挂载，也不改写活动的 `runtime/sshfs`。构建缓存和日志位于 `runtime/sshfs-handle-build/`。

`runtime/sshfs-next/provenance.json` 记录源码、补丁、构建产物哈希和工具链位置。完整修改后源码及补丁位于 `runtime/sshfs-next/source/`；源码保留上游 GPL 许可证。第三方程序、工具链、运行库不进入 Git/npm 源码包。

## 为什么需要修复

原 SSHFS 在创建文件对象、读取缓冲区和同步写入局部对象时初始化条件变量，却在释放对象时遗漏销毁。Cygwin 条件变量内部持有两个 Event 和一个 Semaphore；仅释放外层内存不能释放这些对象。当前旧程序的导入表包含 `pthread_cond_init`，不包含 `pthread_cond_destroy`，与源码相符。

2026-10-28 原挂载实测：仅打开/关闭 100 次增加 300 个句柄；完整读取 100 次增加 900 个句柄，连续两批规律一致。文件句柄保持 27，增长主要为同步句柄；等待后未回落。

修复位置为读取块释放、打开失败清理、正常文件释放、同步写入结束。全局条件变量的整个进程生命周期保持原样。参考 [SSHFS 3.7.2 源码](https://github.com/libfuse/sshfs/blob/sshfs-3.7.2/sshfs.c) 与 [Cygwin 同步原语实现](https://github.com/cygwin/cygwin/blob/main/winsup/cygwin/thread.cc)。

## 临时盘符验证与切换

验证使用唯一的远端临时目录和空闲盘符，避免与 M: 共用同一 UNC 挂载前缀。普通模式和 `sshfs_sync` 模式均测试重复读、打开关闭、失败打开、写入读回、512 次并发读及已存在目录的递归 mkdir。第一轮修复版在重复读取后稳定于约 306–309 个句柄；测试后的临时挂载和文件均清理。最终暂存产物的原始记录见上述证据目录。

切换步骤：保存文件并暂停使用相关盘符的 Agent/程序 → 从本机项目目录卸载受影响的 profile → 将 `runtime/sshfs` 更名为唯一备份目录 → 将 `runtime/sshfs-next` 更名为 `runtime/sshfs` → 按原 profile 重新挂载 → 用唯一临时文件核对读写和句柄趋势。切换会使已有文件句柄失效，因此需要先保存和暂停写入。切换失败时保留新旧运行库，恢复旧目录后重新挂载，不删除用户服务器文件。

重新挂载后新进程才使用修复版；仅重载 MCP 不会替换已运行的 SSHFS 进程。后续官方版本是否包含同样修复，应核对源码和行为，不能仅按版本数字推断。

短时验证已覆盖本次复现路径，尚未进行数天稳定性压测；不能据此声称解决所有 SSHFS/WinFsp 问题。
