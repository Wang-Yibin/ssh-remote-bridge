// debug_bin.mjs — 定位二进制往返不一致
//
// 凭据不在本文件里: 从项目根的 servers.json 读（见 _server.mjs）
import { getRemoteExec, closeAllRemoteExecs } from '../lib/persist.mjs';
import { banner } from './_server.mjs';

const conn = banner('二进制往返 debug');
const rex = getRemoteExec('test', conn);
await rex.ensure();

const payload = '中文测试 emoji 🚀 quotes "x" $VAR `cmd` \\ backslash 换行\n第二行';
const b64 = Buffer.from(payload, 'utf8').toString('base64');
console.log('payload bytes:', Buffer.byteLength(payload), 'b64:', b64);

// 方式1: printf %s
await rex.exec(`printf %s ${b64} > /tmp/.srb_bin1`, { timeout: 30 });
const r1 = await rex.exec('/usr/bin/base64 -w0 < /tmp/.srb_bin1; echo "|"; /usr/bin/wc -c < /tmp/.srb_bin1', { timeout: 30 });
console.log('方式1 read:', JSON.stringify(r1.output));

// 方式2: heredoc（write_file 将要用的方式）
const delim = '__SRB_EOF_deadbeef__';
const cmd = `/usr/bin/base64 -d > /tmp/.srb_bin2 <<'${delim}'\n${b64}\n${delim}`;
await rex.exec(cmd, { timeout: 30 });
const r2 = await rex.exec('/usr/bin/base64 -w0 < /tmp/.srb_bin2; echo "|"; /usr/bin/wc -c < /tmp/.srb_bin2', { timeout: 30 });
console.log('方式2 read:', JSON.stringify(r2.output));

const b1 = Buffer.from(r1.output.split('\n')[0].trim(), 'base64').toString('utf8');
const b2 = Buffer.from(r2.output.split('\n')[0].trim(), 'base64').toString('utf8');
console.log('方式1 match:', b1 === payload, JSON.stringify(b1));
console.log('方式2 match:', b2 === payload, JSON.stringify(b2));

closeAllRemoteExecs();
await new Promise((r) => setTimeout(r, 600));
process.exit(0);
