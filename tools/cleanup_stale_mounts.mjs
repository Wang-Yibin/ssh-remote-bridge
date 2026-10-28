#!/usr/bin/env node
import * as engine from '../lib/engine.mjs';
import fs from 'node:fs';
import path from 'node:path';

const usage='Usage: cleanup_stale_mounts.cmd [--check | --apply] [Y: Z: ...] (default: cleanup; --check: preview only)';
const lines=[new Date().toISOString()];
const log=s=>{lines.push(s);console.log(s);};
const logFile=path.resolve(path.dirname(engine.CONFIG_PATH),'logs','cleanup_stale_mounts.log');
try {
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help')log(usage);
  else {
    const flags=args.filter(a=>a.startsWith('--'));
    const drives=args.filter(a=>!a.startsWith('--')).map(d=>d.toUpperCase());
    if(flags.length>1||flags.some(f=>!['--apply','--check'].includes(f))||drives.some(d=>!/^[A-Z]:$/.test(d)))throw new Error(usage);
    const apply=!flags.includes('--check');
    log('[ssh-remote] '+(apply?'Cleanup: offline duplicates and stale Explorer drive display':'Preview only; no mappings will be changed'));
    const result=await engine.cleanupDuplicateMounts({apply,drives});
    if(result.error)throw new Error(result.error);
    for(const row of result.rows)log(`${row.drive} ${row.state.toUpperCase()} ${row.action==='remove'?'CANDIDATE':'KEEP/SKIP'} ${row.target} - ${row.reason}`);
    if(!result.rows.length)log('[ssh-remote] No matching SSHFS mappings.');
    if(apply) {
      for(const item of result.outcomes)log(`${item.drive} ${item.action.toUpperCase()} - ${item.reason}`);
      if(!result.outcomes.length)log('[ssh-remote] No offline duplicate mappings needed removal.');
      if(result.shellRefresh?.error)log('[ssh-remote] '+result.shellRefresh.error);
      else if(result.shellRefresh)log('[ssh-remote] Delivered Windows drive-removal and Shell notifications for absent drive letters: '+(result.shellRefresh.notified.join(' ')||'(none)')+'. Actual mappings were not changed by these notifications.');
    } else log('[ssh-remote] To clean: cleanup_stale_mounts.cmd --apply [Y: Z: ...]. Preview does not refresh Explorer.');
    if(!result.ok)process.exitCode=1;
  }
} catch(e) {log('[ssh-remote] ERROR: '+e.message);process.exitCode=1;}
finally {
  await engine.closeAllPersist();
  try {fs.mkdirSync(path.dirname(logFile),{recursive:true});fs.writeFileSync(logFile,lines.join('\n')+'\n');console.log('[ssh-remote] Log: '+logFile);}
  catch(e) {console.error('[ssh-remote] Cannot save log: '+e.message);}
}
