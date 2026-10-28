#!/usr/bin/env node
// Build the pinned SSHFS repair; existing mounts and the active runtime are untouched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version='3.7.2+srb.1';
const archiveHash='8a9b0d980e9d34d0d18eacb9e1ca77fc499d1cf70b3674cc3e02f3eafad8ab14';
const sourceHash='3c0516e747986e9f699ca719624c782b789faedef471304e733d9bd9ac567f47';
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
 const compilerRoot=path.resolve(process.argv[2]),bash=path.join(compilerRoot,'bin','bash.exe');
 if(!fs.existsSync(bash))throw Error('Cygwin Bash not found; install gcc-core, meson, ninja, patch, pkg-config, cygfuse and libglib2.0-devel in an isolated Cygwin root');
 const active=path.join(root,'runtime','sshfs'),stage=path.join(root,'runtime','sshfs-next');
 if(fs.existsSync(stage))throw Error('runtime/sshfs-next exists; inspect or move it aside before building');
 if(!fs.existsSync(path.join(active,'provenance.json')))throw Error('install the pinned official runtime before building its repair');
 const cache=path.join(root,'runtime','sshfs-handle-build');fs.mkdirSync(cache,{recursive:true});
 const archive=path.join(cache,'sshfs-3.7.2.tar.gz'),url='https://github.com/libfuse/sshfs/archive/refs/tags/sshfs-3.7.2.tar.gz';
 if(!fs.existsSync(archive)){
  const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('source download HTTP '+r.status);
  const b=Buffer.from(await r.arrayBuffer());if(hash(b)!==archiveHash)throw Error('source archive checksum mismatch');fs.writeFileSync(archive,b,{flag:'wx'});
 }
 if(hash(fs.readFileSync(archive))!==archiveHash)throw Error('cached source archive checksum mismatch');
 const source=path.join(cache,'sshfs-sshfs-3.7.2');
 if(!fs.existsSync(source)){
  const names=run('tar.exe',['-tf',archive]).split(/\r?\n/).filter(Boolean);
  if(!names.every(n=>n.startsWith('sshfs-sshfs-3.7.2/')&&!n.split('/').includes('..')&&!n.includes('\\')))throw Error('unsafe source archive paths');
  run('tar.exe',['-xf',archive,'-C',cache]);
 }
 const patch=fs.readFileSync(path.join(root,'tools','sshfs-condition-lifetimes.patch'),'utf8').replace(/\r\n/g,'\n');
 const patchFile=path.join(cache,'fix.patch');fs.writeFileSync(patchFile,patch);
 const c=path.join(source,'sshfs.c'),state=path.join(cache,'patched-source.sha256');
 const currentHash=hash(fs.readFileSync(c));
 if(currentHash===sourceHash)run(bash,['--noprofile','--norc','-c','export PATH=/usr/bin:/bin; set -e; cd '+q(cyg(source))+'; patch --forward -p1 -i '+q(cyg(patchFile))]);
 else if(!fs.existsSync(state)||fs.readFileSync(state,'utf8').trim()!==currentHash)throw Error('cached source was changed; inspect it before rebuilding');
 fs.writeFileSync(state,hash(fs.readFileSync(c))+'\n');
 const meson=path.join(source,'meson.build');fs.writeFileSync(meson,fs.readFileSync(meson,'utf8').replace("version: '3.7.2'","version: '"+version+"'"));
 const output=run(bash,['--noprofile','--norc','-c',"export PATH=/usr/bin:/bin; set -e; cd "+q(cyg(source))+"; if [ ! -f build/build.ninja ]; then meson setup build -Dbuildtype=release; fi; ninja -C build sshfs.exe; ./build/sshfs.exe --version; gcc --version | head -1; uname -r; pkg-config --modversion fuse3 glib-2.0"]);
 fs.writeFileSync(path.join(cache,'build.log'),output);console.log(output);
 const binary=path.join(source,'build','sshfs.exe');
 fs.cpSync(active,stage,{recursive:true,force:false,errorOnExist:true});fs.copyFileSync(binary,path.join(stage,'bin','sshfs.exe'));
 const reported=run(path.join(stage,'bin','sshfs.exe'),['--version']);if(!reported.includes('SSHFS version '+version))throw Error('staged runtime version verification failed');
 const srcDir=path.join(stage,'source');fs.mkdirSync(srcDir,{recursive:true});fs.writeFileSync(path.join(srcDir,'fix-condition-lifetimes.patch'),patch);
 run('tar.exe',['-czf',path.join(srcDir,'sshfs-'+version+'.tar.gz'),'--exclude=sshfs-sshfs-3.7.2/build','-C',cache,'sshfs-sshfs-3.7.2']);
 const provenance=JSON.parse(fs.readFileSync(path.join(stage,'provenance.json'),'utf8'));
 provenance.version=version;provenance.custom_build={source:url,source_archive_sha256:archiveHash,original_c_sha256:sourceHash,patched_c_sha256:hash(fs.readFileSync(c)),patch_sha256:hash(Buffer.from(patch)),binary_sha256:hash(fs.readFileSync(binary)),build_log:'../sshfs-handle-build/build.log',toolchain_root:compilerRoot,scope:'four pthread_cond_destroy calls and the package-version label'};
 provenance.files['sshfs.exe']=provenance.custom_build.binary_sha256;
 fs.writeFileSync(path.join(stage,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
 fs.writeFileSync(path.join(stage,'NOTICE.txt'),'SSHFS '+version+' is a locally built GPL repair of official SSHFS 3.7.2 with four condition-variable destruction calls. Complete modified source and patch are in source/. Other binaries remain the pinned official Cygwin packages. Provenance and hashes: provenance.json.\n');
 console.log('Prepared runtime/sshfs-next. Validate on a temporary drive before unmounting and switching active mappings.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
