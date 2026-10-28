#!/usr/bin/env node
/**
 * tools/default_mount.mjs — 打印默认服务器的本地挂载点
 * 供 open-ssh-remote-terminal.cmd 在未指定路径时使用。
 * 默认服务器没配 mount 时退化为当前目录。
 */
import * as engine from '../lib/engine.mjs';

try {
  const srv = engine.getServer();
  console.log(srv.mount || (srv.drive ? srv.drive+'\\' : process.cwd()));
} catch (e) {
  console.log(process.cwd());
}
