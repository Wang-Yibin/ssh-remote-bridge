#!/usr/bin/env node
// Build the pinned SSHFS Windows reliability repair without touching active mounts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const upstream='3.7.6';
const version='3.7.6+srb.2';
const archiveHash='6a1bcb31450a077e9cb1b7ff158c71de34db697c3c0da6cb362502131e495893';
const sourceHash='1b28015d5ff0bbb8b0bc445b0547cfe937002c4e76f92be6d453b98203e5c4fa';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
const cyg=p=>{if(!/^[A-Za-z]:[\\/]/.test(p))throw Error('build paths must be local Windows drive paths');return '/cygdrive/'+p[0].toLowerCase()+p.slice(2).replaceAll('\\','/');};
function run(file,args,options={}){
 const r=spawnSync(file,args,{cwd:root,windowsHide:true,timeout:180000,maxBuffer:8*1024*1024,encoding:'utf8',...options});
 if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr||r.stdout||'exit '+r.status);
 return (r.stdout||'')+(r.stderr||'');
}
async function main(){
 if(process.platform!=='win32'||process.arch!=='x64'||process.argv.length!==3)throw Error('usage: node tools/build_sshfs_handle_fix.mjs <isolated-Cygwin-root>');
 const compilerRoot=path.resolve(process.argv[2]),bash=path.join(compilerRoot,'bin','bash.exe'),tar=path.join(compilerRoot,'bin','tar.exe'),sevenZip=path.join(root,'runtime','7zip','7z.exe');
 if(!fs.existsSync(bash)||!fs.existsSync(tar)||!fs.existsSync(sevenZip))throw Error('Cygwin Bash/tar or bundled 7-Zip not found; install gcc-core, meson, ninja, tar, patch, pkg-config, cygfuse and libglib2.0-devel in an isolated Cygwin root');
 const active=path.join(root,'runtime','sshfs'),stage=path.join(root,'runtime','sshfs-next');
 if(fs.existsSync(stage))throw Error('runtime/sshfs-next exists; inspect it before building');
 if(!fs.existsSync(path.join(active,'provenance.json')))throw Error('install the pinned Cygwin runtime before building its SSHFS repair');
 const cache=path.join(root,'runtime','sshfs-reliability-build-376');fs.mkdirSync(cache,{recursive:true});
 const archive=path.join(cache,'sshfs-3.7.6.tar.xz');
 const url='https://github.com/libfuse/sshfs/releases/download/sshfs-3.7.6/sshfs-3.7.6.tar.xz';
 if(!fs.existsSync(archive)){
  const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('source download HTTP '+r.status);
  const b=Buffer.from(await r.arrayBuffer());if(hash(b)!==archiveHash)throw Error('source archive checksum mismatch');
  fs.writeFileSync(archive,b,{flag:'wx'});
 }
 if(hash(fs.readFileSync(archive))!==archiveHash)throw Error('cached source archive checksum mismatch');
 const tarArchive=path.join(cache,'sshfs-3.7.6.tar');
 if(!fs.existsSync(tarArchive))run(sevenZip,['x','-y','-o'+cache,archive]);
 const source=path.join(cache,'sshfs-3.7.6');
 if(!fs.existsSync(source)){
  const names=run(tar,['-tf',cyg(tarArchive)]).split(/\r?\n/).filter(Boolean);
  if(!names.every(n=>n.startsWith('sshfs-3.7.6/')&&!n.split('/').includes('..')&&!n.includes('\\')))throw Error('unsafe source archive paths');
  run(tar,['-xf',cyg(tarArchive),'-C',cyg(cache)]);
 }
 const c=path.join(source,'sshfs.c'),state=path.join(cache,'patched-source.sha256');
 const currentHash=hash(fs.readFileSync(c));
 const patch=fs.readFileSync(path.join(root,'tools','sshfs-stability-fix.patch'),'utf8').replace(/\r\n/g,'\n');
 const patchFile=path.join(cache,'fix.patch');fs.writeFileSync(patchFile,patch);
 if(currentHash===sourceHash)run(bash,['--noprofile','--norc','-c','export PATH=/usr/bin:/bin; set -e; cd '+q(cyg(source))+'; patch --forward -p1 -i '+q(cyg(patchFile))]);
 else if(!fs.existsSync(state)||fs.readFileSync(state,'utf8').trim()!==currentHash)throw Error('cached source was changed; inspect it before rebuilding');
 fs.writeFileSync(state,hash(fs.readFileSync(c))+'\n');
 const meson=path.join(source,'meson.build'),mesonText=fs.readFileSync(meson,'utf8');
 if(!mesonText.includes("version: '"+upstream+"'")&&!mesonText.includes("version: '"+version+"'"))throw Error('unexpected upstream Meson version');
 fs.writeFileSync(meson,mesonText.replace("version: '"+upstream+"'","version: '"+version+"'"));
 const output=run(bash,['--noprofile','--norc','-c',"export PATH=/usr/bin:/bin; set -e; cd "+q(cyg(source))+"; if [ ! -f build/build.ninja ]; then meson setup build -Dbuildtype=release; fi; ninja -C build sshfs.exe; ./build/sshfs.exe --version; gcc --version | head -1; uname -r; pkg-config --modversion fuse3 glib-2.0"]);
 fs.writeFileSync(path.join(cache,'build.log'),output);console.log(output);
 const binary=path.join(source,'build','sshfs.exe');
 fs.cpSync(active,stage,{recursive:true,force:false,errorOnExist:true});fs.copyFileSync(binary,path.join(stage,'bin','sshfs.exe'));
 const reported=run(path.join(stage,'bin','sshfs.exe'),['--version']);
 if(!reported.includes('SSHFS version '+version))throw Error('staged runtime version verification failed');
 const srcDir=path.join(stage,'source');fs.mkdirSync(srcDir,{recursive:true});
 fs.copyFileSync(archive,path.join(srcDir,'sshfs-3.7.6.tar.xz'));
 fs.copyFileSync(path.join(root,'tools','sshfs-stability-fix.patch'),path.join(srcDir,'sshfs-stability-fix.patch'));
 run(tar,['-cf',cyg(path.join(srcDir,'sshfs-'+version+'.tar')),'--exclude=sshfs-3.7.6/build','-C',cyg(cache),'sshfs-3.7.6']);
 const provenance=JSON.parse(fs.readFileSync(path.join(stage,'provenance.json'),'utf8'));
 provenance.version=version;
 provenance.custom_build={source:url,source_archive_sha256:archiveHash,original_c_sha256:sourceHash,patched_c_sha256:hash(fs.readFileSync(c)),patch_sha256:hash(Buffer.from(patch)),binary_sha256:hash(fs.readFileSync(binary)),build_log:'../sshfs-reliability-build-376/build.log',toolchain_root:compilerRoot,scope:'official SSHFS 3.7.6 with Cygwin/WinFsp integration, four condition-variable lifetime fixes, and an EINTR-safe sequential SFTP pipe writer'};
 provenance.files['sshfs.exe']=provenance.custom_build.binary_sha256;
 fs.writeFileSync(path.join(stage,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
 fs.writeFileSync(path.join(stage,'NOTICE.txt'),'SSHFS '+version+' is a local GPL build from official SSHFS 3.7.6 source. It includes Cygwin/WinFsp integration, four condition-variable lifetime fixes, and an EINTR-safe sequential SFTP pipe writer. Complete modified source, source archive and patch are in source/. Other binaries remain the pinned official Cygwin packages. Provenance and hashes: provenance.json.\n');
 console.log('Prepared runtime/sshfs-next. Validate on an isolated drive before switching active mappings.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});