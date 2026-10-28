#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const NAME='ssh-remote-bridge';

// Scan strings/comments so a header-looking line inside a multiline value is data.
export function updateToml(text,node,server) {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/), headers=[];
  let quote='',triple=false,depth=0;
  const neutral=[];
  for(let n=0;n<lines.length;n++) {
    const line=lines[n];neutral[n]=!quote && !depth;
    if(neutral[n] && /^\s*\[/.test(line)) {headers.push({n,line:line.trim().replace(/\s*#.*$/,'')});continue;}
    for(let i=0;i<line.length;i++) {
      const c=line[i];
      if(quote) {
        if(quote==='"' && c==='\\') {i++;continue;}
        if(c===quote && (!triple || line.slice(i,i+3)===quote.repeat(3))) {if(triple)i+=2;quote='';triple=false;}
      } else if(c==='#') break;
      else if(c==='"' || c==="'") {quote=c;triple=line.slice(i,i+3)===c.repeat(3);if(triple)i+=2;}
      else if(c==='[' || c==='{') depth++;
      else if(c===']' || c==='}') depth--;
    }
    if(quote && !triple) throw new Error('invalid TOML string; existing configuration was kept');
    if(depth<0) throw new Error('invalid TOML brackets; existing configuration was kept');
  }
  if(quote || depth) throw new Error('unfinished TOML value; existing configuration was kept');
  const base=/^\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:ssh-remote-bridge|"ssh-remote-bridge"|'ssh-remote-bridge')\s*\]$/;
  const matching=headers.filter(h=>base.test(h.line));
  if(matching.length>1) throw new Error('duplicate bridge sections; repair configuration before registering');
  const values={command:JSON.stringify(node),args:JSON.stringify([server])};
  if(!matching.length) {
    if(lines.some((line,n)=>neutral[n] && /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers'|ssh-remote-bridge|"ssh-remote-bridge"|'ssh-remote-bridge')\s*=/.test(line))) throw new Error('inline MCP tables are unsupported; existing configuration was kept');
    return text.trimEnd()+'\n\n[mcp_servers.'+NAME+']\ncommand = '+values.command+'\nargs = '+values.args+'\nstartup_timeout_sec = 120\n';
  }
  const start=matching[0].n, end=headers.find(h=>h.n>start)?.n??lines.length, edits=[];
  for(let n=start+1;n<end;n++) {
    if(!neutral[n]) continue;
    const m=/^\s*(?:([A-Za-z_][\w-]*)|"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)')\s*=/.exec(lines[n]);
    if(!m) continue;
    m[1]=m[1]||m[2]||m[3];
    if(['url','transport'].includes(m[1])) throw new Error('existing bridge entry uses a different transport; configuration was kept');
    if(!Object.hasOwn(values,m[1])) continue;
    let next=n+1;while(next<end && !neutral[next])next++;
    if(edits.some(e=>e.key===m[1])) throw new Error('duplicate '+m[1]+' in bridge section');
    edits.push({start:n,end:next,key:m[1],text:m[1]+' = '+values[m[1]]});
  }
  const missing=Object.keys(values).filter(k=>!edits.some(e=>e.key===k));
  for(const e of edits.reverse()) lines.splice(e.start,e.end-e.start,e.text);
  lines.splice(start+1,0,...missing.map(k=>k+' = '+values[k]));
  return lines.join('\n');
}
export function register() {
  const cfgDir=process.env.SRB_CODEX_CONFIG_DIR || process.env.CODEX_HOME || path.join(process.env.SRB_USERPROFILE_OVERRIDE||os.homedir(),'.codex');
  const cfg=path.join(cfgDir,'config.toml'), server=path.join(ROOT,'mcp','server.mjs');
  if(!fs.existsSync(server)) throw new Error('mcp/server.mjs is missing');
  const bundled=path.join(ROOT,'runtime','node.exe'), node=fs.existsSync(bundled)?bundled:process.execPath;
  const before=fs.existsSync(cfg)?fs.readFileSync(cfg,'utf8'):'';
  const after=updateToml(before,node,server);
  fs.mkdirSync(cfgDir,{recursive:true});
  const tmp=cfg+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try {
    fs.writeFileSync(tmp,after,{flag:'wx',mode:0o600});
    if(fs.existsSync(cfg)) {
      if(fs.readFileSync(cfg,'utf8')!==before) throw new Error('configuration changed during registration; retry');
      fs.copyFileSync(cfg,cfg+'.srb-backup-'+Date.now());
    }
    fs.renameSync(tmp,cfg);
  } finally {try{fs.unlinkSync(tmp);}catch{}}
  console.log('[register-codex] bridge command updated; existing env/options preserved. Restart Codex to reload.');
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {register();} catch(e) {console.error('[register-codex] '+e.message);process.exitCode=1;}
}
