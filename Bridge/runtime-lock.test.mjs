import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const exec=promisify(execFile);
test('kernel lock permits one runtime owner and survives exec without leaving a stale PID lock',{skip:process.platform!=='darwin'},async t=>{
 const root=fileURLToPath(new URL('../build/lock-fixtures/',import.meta.url));await mkdir(root,{recursive:true});
 const dir=await mkdtemp(join(root,'case-')),runtime=join(dir,'runtime'),helper=join(dir,'BridgeService');await mkdir(runtime,{mode:0o700});
 await exec('xcrun',['clang','-Wall','-Wextra','-Werror',fileURLToPath(new URL('../Launcher/BridgeService.c',import.meta.url)),'-o',helper]);
 const first=spawn(helper,[runtime,process.execPath,'-e','console.log("READY");setTimeout(()=>{},10000)'],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(first.exitCode===null&&first.signalCode===null)first.kill('SIGTERM');});
 const exited=once(first,'exit');
 let ready='';for await(const chunk of first.stdout){ready+=chunk;if(ready.includes('READY'))break;}
 assert.match(ready,/READY/);
 const second=spawn(helper,[runtime,process.execPath,'-e','process.exit(0)'],{stdio:'ignore'});
 assert.equal((await once(second,'exit'))[0],75);
 first.kill('SIGTERM');await exited;
 const third=spawn(helper,[runtime,process.execPath,'-e','const f=require("node:fs");if(!f.fstatSync(Number(process.env.CODEX_ACCOUNTS_LOCK_FD)).isFile())process.exit(3)'],{stdio:'ignore'});
 assert.equal((await once(third,'exit'))[0],0);
});
