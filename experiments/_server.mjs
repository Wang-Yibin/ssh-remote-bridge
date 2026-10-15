// _server.mjs — 测试脚本共用：拿一个真实可用的连接参数。
//
// 设计原则（凭据卫生）：**测试脚本里不写任何真实 IP / 账号 / 密码 / 主机指纹**。
// 真实值只存在于本项目根目录的 servers.json 里；这里从配置读，读不到就报错退出。
//
// 想要测某台特定服务器：设环境变量 SRB_TEST_SERVER=<服务器名>，默认用 default:true 那台。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FWD = path.resolve(HERE, '..');

/**
 * @returns {{name, plink, host, port, user, password, hostkey}}
 * @throws 找不到可用配置时抛错（附带怎么修的提示）
 */
export function testConn() {
  const cfgPath = process.env.SRB_CONFIG || path.join(FWD, 'servers.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      `no servers.json at ${cfgPath}.\n` +
        `Create one (or point SRB_CONFIG at an existing config). Fields needed: ` +
        `plink, and a server entry with host / port / user / password(or keyFile) / hostkey.`
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new Error(`${cfgPath} is not valid JSON: ${e.message}`);
  }
  const servers = cfg.servers || {};
  const names = Object.keys(servers);
  const want = process.env.SRB_TEST_SERVER;
  const name = want || names.find((n) => servers[n].default) || names[0];
  if (!name) {
    throw new Error(`${cfgPath} has no server entries. Add one, or set SRB_TEST_SERVER.`);
  }
  if (want && !servers[want]) {
    throw new Error(`SRB_TEST_SERVER="${want}" not found in ${cfgPath}. available: ${names.join(', ') || '(none)'}`);
  }
  const s = servers[name];
  if (!s.password && !s.keyFile) {
    throw new Error(`server "${name}" has neither password nor keyFile — nothing to connect with.`);
  }
  return {
    name,
    plink: cfg.plink,
    host: s.host,
    port: s.port || 22,
    user: s.user,
    password: s.password,
    keyFile: s.keyFile,
    hostkey: s.hostkey,
  };
}

/** 打码后的连接信息（可安全打印） */
export function safeConn(c) {
  return `${c.name}: ${c.user}@${c.host}:${c.port} hostkey=${c.hostkey ? c.hostkey.slice(0, 20) + '...' : '(none)'} pw=***`;
}

/** 打印一段启动横幅 */
export function banner(title) {
  const c = testConn();
  console.log(`\n=== ${title} ===`);
  console.log(`target: ${safeConn(c)}\n`);
  return c;
}