#!/usr/bin/env node
import * as engine from '../lib/engine.mjs';
try {
  const servers=engine.listServers();
  engine.validateDrives(servers);
  for(const srv of servers) {
    if(!srv.drive) continue;
    try {
      if(process.argv.includes('--check')) {
        const st=await engine.serverMountStatus(srv);
        console.log(srv.name+': '+JSON.stringify(st));
        if(!st.drive_mounted || (srv.mount && !st.mount_ok)) process.exitCode=1;
      } else {
        const r=await engine.mountServer(srv);
        console.log(srv.name+': '+(r.ok ? 'OK' : 'FAILED')+' '+r.steps.join('; '));
        if(r.warning) console.warn(r.warning);
        if(!r.ok) {console.error(r.error);process.exitCode=1;}
      }
    } catch(e) {console.error(srv.name+': '+e.message);process.exitCode=1;}
  }
} catch(e) {console.error(e.message);process.exitCode=1;}
finally {await engine.closeAllPersist();}
