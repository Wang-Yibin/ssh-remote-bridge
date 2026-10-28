import crypto from 'node:crypto';

const range=(offset,maxBytes)=>{
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('offset must be a nonnegative safe integer');
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>65536)throw new Error('max_bytes must be an integer from 1 to 65536');
};
export function waitBudget(value,name) {
  if(!Number.isInteger(value)||value<0||value>30000)throw new Error(name+' must be an integer from 0 to 30000');
  return value;
}

export class ExecJobs {
  constructor(engine){this.engine=engine;this.jobs=new Map();this.closed=false;}
  prune() {for(const [id,j] of this.jobs)if(j.result && Date.now()-j.finished>=600000)this.jobs.delete(id);}
  has(id){this.prune();return this.jobs.has(id);}
  get(id){this.prune();const j=this.jobs.get(id);if(!j)throw new Error('result expired or unknown; command was not replayed');return j;}
  changed(j){j.revision++;for(const wake of [...j.waiters])wake();}
  start(srv,command,options) {
    if(this.closed)throw new Error('server is shutting down');
    this.prune();
    const profile=[...this.jobs.values()].filter(j=>j.server===srv.name);
    for(const [id,j] of this.jobs) {
      if(j.result && (this.jobs.size>=32 || profile.length>=16 && j.server===srv.name)) {this.jobs.delete(id);const at=profile.indexOf(j);if(at>=0)profile.splice(at,1);}
    }
    if(this.jobs.size>=32 || profile.length>=16)throw new Error('too many active commands; read or cancel an existing result_id first');
    const j={id:crypto.randomBytes(12).toString('hex'),server:srv.name,cwd:options.cwd,created:Date.now(),state:'queued',revision:0,waiters:new Set(),controller:new AbortController(),ref:null,result:null,truncated:false};
    this.jobs.set(j.id,j);
    j.promise=Promise.resolve().then(()=>{j.controller.signal.throwIfAborted();return this.engine.execOnSmart(srv,command,{...options,signal:j.controller.signal,live:true,
      onStart:ref=>{j.ref=ref;j.state=j.controller.signal.aborted?'cancelling':'running';this.changed(j);},
      onOutput:(_bytes,truncated)=>{j.truncated ||= truncated;this.changed(j);}
    });}).catch(error=>({done:false,exitCode:null,error:error.message,spawnFailed:!j.controller.signal.aborted})).then(result=>{
      j.result={...result,aborted:result.aborted||j.controller.signal.aborted};j.finished=Date.now();j.truncated ||= !!result.truncated;
      j.cwd=result.cwd||j.cwd;j.state='completed';this.changed(j);return j.result;
    });
    return j;
  }
  wait(j,revision,ms,signal) {
    signal?.throwIfAborted();
    if(j.revision!==revision || j.result || ms<=0)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);j.waiters.delete(done);signal?.removeEventListener('abort',abort);};
      const done=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(new Error('result wait cancelled; original task is unchanged'));};
      const timer=setTimeout(done,ms);j.waiters.add(done);signal?.addEventListener('abort',abort,{once:true});
    });
  }
  async settle(j,ms,signal) {
    const deadline=Date.now()+ms;
    while(!j.result && Date.now()<deadline)await this.wait(j,j.revision,deadline-Date.now(),signal);
    signal?.throwIfAborted();return j.result;
  }
  async page(id,offset=0,maxBytes=8192,{signal,format,waitMs=0}={}) {
    range(offset,maxBytes);waitBudget(waitMs,'wait_ms');
    const j=this.get(id),deadline=Date.now()+waitMs;
    while(true) {
      signal?.throwIfAborted();const revision=j.revision;let page;
      if(j.ref && !j.result?.spawnFailed) {
        try {
          const r=await j.ref.read(offset,maxBytes,{signal});
          if(r.exitCode!==0 || r.timedOut || r.interrupted || r.truncated)throw new Error(r.output||r.error||'result read failed or expired');
          page=this.engine.decodePage(r.output,offset,maxBytes,format,j.truncated,!j.result || j.result.outputBytes>Number(r.output.split('\n')[0]));
        } catch(error) {if(error.code!=='LOST')throw error;await j.promise;if(j.result.done && !j.result.spawnFailed)throw error;}
      }
      if(!page && j.result) {
        const data=Buffer.from([j.result.error,j.result.output].filter(Boolean).join('\n'));
        page=this.engine.decodePage(data.length+'\n'+data.subarray(offset,offset+maxBytes+1).toString('base64'),offset,maxBytes,format);
      }
      page ||= {size:0,total_size:0,offset,next_offset:offset,truncated:false,isText:true,text:'',base64:'',raw_size:0};
      if(page.size || j.result || Date.now()>=deadline) return {...page,server:j.server,cwd:j.cwd,state:j.state,exitCode:j.result?.exitCode??null,spawnFailed:!!j.result?.spawnFailed,timedOut:!!j.result?.timedOut,interrupted:!!(j.result?.interrupted||j.result?.aborted),capture_limited:!!j.truncated,duration:((j.finished||Date.now())-j.created)/1000};
      await this.wait(j,revision,deadline-Date.now(),signal);
    }
  }
  cancel(id){const j=this.get(id);if(!j.result){j.state='cancelling';j.controller.abort();this.changed(j);}return j;}
  close(){this.closed=true;for(const j of this.jobs.values())if(!j.result)j.controller.abort();return Promise.allSettled([...this.jobs.values()].map(j=>j.promise));}
}
