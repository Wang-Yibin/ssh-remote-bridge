# SSHFS Windows 传输修复手册

## 当前版本

项目要求 **SSHFS 3.7.6+srb.2**。它基于官方稳定版 3.7.6，包含 Cygwin/WinFsp 集成、四处条件变量销毁修复，以及改为逐段完整写入 SFTP 管道并对 EINTR 重试的 Windows 写入路径。

问题复现时，SSHFS 发出 SFTP WRITE 后没有收到或处理对应应答；复制操作卡住，远端 PDF 大小看似正确，但其中一个 32 KiB 区块全为零。官方 3.7.6 单独升级仍能复现。隔离盘符上的 3.7.6+srb.2 连续 10 次 Windows Shell 复制均完成，远端 SHA-256 与源文件相同；另 10 次无诊断日志 Shell 复制也全部通过。测试样本有限，不能保证所有网络与服务器场景。

## 构建

在 Windows x64 本机准备独立 Cygwin 根目录，安装 gcc-core、meson、ninja、tar、patch、pkg-config、cygfuse 和 libglib2.0-devel。源码下载使用项目内置 7-Zip 解压，Linux 服务器无需安装编译器。

在项目目录运行：

    rtk proxy .\runtime\node.exe .\tools\build_sshfs_handle_fix.mjs '<独立 Cygwin 根目录>'

脚本校验官方源码包 SHA-256，应用 tools/sshfs-stability-fix.patch，构建并创建 runtime/sshfs-next。它不会覆盖活动运行库或卸载任何盘符。构建日志在 runtime/sshfs-reliability-build-376/build.log；来源、补丁、二进制哈希和修改后源码随暂存运行库保存在 source/ 与 provenance.json。

克隆后必须先运行 tools/install_sshfs_runtime.mjs 准备基础依赖，再运行上述构建脚本。基础安装器提供的官方 Cygwin SSHFS 3.7.2 不是最终可挂载版本。

## 隔离验证与启用

验证只使用空闲临时盘符及唯一远端临时目录。对 Windows Shell 复制和小文件读写执行复制后 SHA-256 对比；结束时卸载临时盘并清理临时目录。当前用户的 M:、N: 不会被构建脚本触碰。

切换活动运行库前保存文件并暂停所有 Agent/程序写入。卸载受影响映射，将 runtime/sshfs 移到唯一备份名，再将 runtime/sshfs-next 改名为 runtime/sshfs，然后重新挂载。切换会使已有文件句柄失效。失败时保留两份目录，恢复旧目录并重新挂载；不要删除服务器项目文件。

新 SSHFS 进程启动时会检查精确版本 3.7.6+srb.2；重载 MCP 不会替换已有挂载进程。确认新挂载完成后，再对目标目录做一次唯一临时文件复制并核对哈希。