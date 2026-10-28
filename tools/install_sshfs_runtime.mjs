#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=path.join(root,'runtime'),target=path.join(runtime,process.argv.includes('--stage')?'sshfs-next':'sshfs');
const packages=JSON.parse(fs.readFileSync(new URL('./sshfs-runtime-lock.json',import.meta.url),'utf8'));
const privateSevenZip=path.join(runtime,'7zip','7z.exe');
const sevenZip=fs.existsSync(privateSevenZip)?privateSevenZip:path.join(process.env.ProgramFiles||'C:\\Program Files','7-Zip','7z.exe');
const sha=(bytes,algorithm='sha512')=>crypto.createHash(algorithm).update(bytes).digest('hex');
function run(file,args,options={}) {
  const r=spawnSync(file,args,{windowsHide:true,timeout:30000,maxBuffer:64*1024*1024,...options});
  if(r.error || r.status!==0)throw new Error(path.basename(file)+': '+(r.error?.message||r.stderr?.toString()||'exit '+r.status));
  return options.encoding?(r.stdout||'')+(r.stderr||''):r.stdout;
}
async function main() {
  if(process.platform!=='win32' || process.arch!=='x64')throw new Error('this runtime requires Windows x64');
  if(process.argv.slice(2).some(arg=>arg!=='--stage'))throw new Error('usage: node tools/install_sshfs_runtime.mjs [--stage]');
  if(fs.existsSync(target))throw new Error('runtime/'+path.basename(target)+' already exists; keep active mounts intact. Move the old runtime aside only after unmounting it.');
  if(!fs.existsSync(sevenZip))throw new Error('install 7-Zip first (used only to unpack verified Cygwin archives)');
  const stage=path.join(runtime,'.sshfs-install-'+crypto.randomUUID());
  fs.mkdirSync(path.join(stage,'bin'),{recursive:true});
  try {
    for(const dir of ['etc','dev/mqueue','dev/shm','var/run'])fs.mkdirSync(path.join(stage,dir),{recursive:true});
    fs.writeFileSync(path.join(stage,'etc','fstab'),'none /cygdrive cygdrive binary,posix=0,user 0 0\nnone /tmp usertemp binary,posix=0,user 0 0\n');
    fs.writeFileSync(path.join(stage,'etc','nsswitch.conf'),'db_home: windows\n');
    const provenance=[];
    for(const pkg of packages) {
      const response=await fetch('https://mirrors.tuna.tsinghua.edu.cn/cygwin/'+pkg.archive,{signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(pkg.name+': download HTTP '+response.status);
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>pkg.size)throw new Error(pkg.name+': oversized archive');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);
      if(size!==pkg.size || sha(bytes)!==pkg.sha512)throw new Error(pkg.name+': archive checksum mismatch');
      const archive=path.join(stage,path.basename(pkg.archive));fs.writeFileSync(archive,bytes,{flag:'wx'});
      const tar=run(sevenZip,['e','-so',archive]);
      // Extract only regular runtime files; never follow archive links or unpack arbitrary paths.
      const members=run('tar.exe',['-tf','-'],{input:tar,encoding:'utf8'}).split(/\r?\n/).filter(name=>/^usr\/bin\/(?:[^/]+\.dll|sshfs\.exe|ssh\.exe|cygwin-console-helper\.exe)$/.test(name));
      if(!members.length)throw new Error(pkg.name+': no runtime binaries');
      run('tar.exe',['-xf','-','-C',stage,...members],{input:tar});
      for(const name of members){const file=path.join(stage,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('unexpected runtime file type');fs.renameSync(file,path.join(stage,'bin',path.basename(name)));}
      const source='https://mirrors.tuna.tsinghua.edu.cn/cygwin/'+pkg.source;
      provenance.push({...pkg,source});
      fs.unlinkSync(archive);console.log('Verified '+pkg.name);
    }
    if(!fs.existsSync(path.join(stage,'bin','cygwin-console-helper.exe')))throw new Error('Cygwin console helper is required for invisible background mounts');
    const version=run(path.join(stage,'bin','sshfs.exe'),['--version'],{encoding:'utf8'});
    if(!/SSHFS version 3\.7\.2\b/.test(version))throw new Error('unexpected SSHFS version: '+version);
    const sshVersion=run(path.join(stage,'bin','ssh.exe'),['-V'],{encoding:'utf8'}).trim();
    if(!/OpenSSH_10\.5p1\b/.test(sshVersion))throw new Error('unexpected OpenSSH version: '+sshVersion);
    const files=Object.fromEntries(fs.readdirSync(path.join(stage,'bin')).map(name=>[name,sha(fs.readFileSync(path.join(stage,'bin',name)),'sha256')]));
    fs.writeFileSync(path.join(stage,'provenance.json'),JSON.stringify({version:'3.7.2',sshVersion,packages:provenance,files},null,2)+'\n');
    fs.writeFileSync(path.join(stage,'NOTICE.txt'),'SSHFS 3.7.2 (GPL), OpenSSH, Cygwin and supporting libraries are unmodified official Cygwin packages. Package/source URLs and hashes: provenance.json. No binaries are copied from the old system SSHFS-Win. This private runtime does not replace system binaries.\n');
    fs.renameSync(stage,target);console.log('Installed runtime/'+path.basename(target)+' (SSHFS 3.7.2, '+sshVersion+'). Existing mounts remain unchanged; remount to use it.');
  } catch(error) {throw new Error(error.message+'; incomplete files retained at '+stage);}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
