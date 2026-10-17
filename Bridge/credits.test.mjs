import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PoolController, ManagementClient, evaluateQuota } from './pool-controller.mjs';
import { createPoolRouter as authenticatedRouter } from './pool-router.mjs';
const ingressKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const createPoolRouter = options => authenticatedRouter({ ...options, getIngressKey: async () => ingressKey });
const authorizedFetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { authorization: `Bearer ${ingressKey}`, ...options.headers } });
const root = fileURLToPath(new URL('../build/credits-fixtures/', import.meta.url));
await mkdir(root, { recursive: true });
const emails = ['first@example.test', 'second@example.test'];
function usage(used = 0, { exhausted = false, balance = '0', resets = 0, applicable = 0 } = {}) {
 return { rate_limit: { allowed: !exhausted, limit_reached: exhausted, primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 2000000000 } },
  credits: { has_credits: Number(balance) > 0, unlimited: false, balance, overage_limit_reached: false }, spend_control: { reached: false },
  rate_limit_reset_credits: { available_count: resets, applicable_available_count: applicable } };
}
const exhausted = balance => usage(100, { exhausted: true, balance });
async function fixture({ credits = false, automatic = [] } = {}) {
 const runtimeDir = await mkdtemp(root + 'case-');
 const accounts = emails.map((email, i) => ({ email, name: `synthetic-${i}.json`, prefix: `conta-0${i+1}`, plan: 'pro' }));
 await writeFile(runtimeDir + '/accounts-state.json', JSON.stringify({ accounts, priority_order: emails, mode: 'automatic', revision: 0, allow_extra_credits: credits, auto_reset_emails: automatic }));
 const values = new Map(emails.map(e => [e, usage()])); const consumed = []; const quotaCalls = [];
 const rows = accounts.map((a, i) => ({ ...a, provider: 'codex', auth_index: String(i), id_token: { chatgpt_account_id: `account-${i}`, plan_type: 'pro' } }));
 const management = { models: async () => ({ models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'].map(slug => ({ slug, visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast' }] })) }),
    credentials: async () => rows,
  quota: async c => { quotaCalls.push(c.email); const value = values.get(c.email); if (value instanceof Error) throw value; return value; },
  resetCooldown: async () => {}, consumeReset: async (c, key) => { consumed.push({ email: c.email, key }); values.set(c.email, usage()); return 'reset'; } };
 const clock = { value: 1900000000000 };
 const controller = new PoolController({ runtimeDir, management, now: () => clock.value });
 return { runtimeDir, accounts, rows, management, values, consumed, quotaCalls, clock, controller };
}
async function candidates(f) { const result = []; for await (const c of f.controller.candidates({ model: 'claude-sonnet-5-5' })) result.push({ email: c.email, source: c.consumption_source }); return result; }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function server(t, instance) { await new Promise(r => instance.listen(0,'127.0.0.1',r)); t.after(async () => { instance.closeAllConnections(); await new Promise(r=>instance.close(r)); }); return `http://127.0.0.1:${instance.address().port}`; }

test('extra credits default off and all subscriptions must be exhausted before paid admission', async () => {
 const f = await fixture(); f.values.set(emails[0], exhausted('50')); f.values.set(emails[1], exhausted('100'));
 assert.deepEqual(await candidates(f), []);
 await f.controller.update({revision:0,allow_extra_credits:true});
 assert.deepEqual(await candidates(f), emails.map(email=>({email,source:'credits'})));
 f.values.set(emails[1], usage(95));
 assert.deepEqual(await candidates(f), [{email:emails[1],source:'subscription'}]);
});
test('fixed mode never uses its credits while another subscription is still available', async () => {
 const f = await fixture({credits:true}); f.values.set(emails[0], exhausted('50'));
 await f.controller.update({revision:0,mode:'fixed',fixed_email:emails[0]});
 assert.deepEqual(await candidates(f), []);
 f.values.set(emails[1], exhausted('0'));
 assert.deepEqual(await candidates(f), [{email:emails[0],source:'credits'}]);
});
test('unknown allowance, disabled connection and an additional model cap cannot open paid admission', async () => {
 const f = await fixture({credits:true});f.values.set(emails[0],exhausted('50'));
 f.values.set(emails[1],new Error('offline'));assert.deepEqual(await candidates(f),[]);
 f.values.set(emails[1],exhausted('0'));f.rows[1].disabled=true;f.controller.credentialCache=null;assert.deepEqual(await candidates(f),[]);
 f.rows[1].disabled=false;f.controller.credentialCache=null;
 f.values.set(emails[1],{...usage(10),additional_rate_limits:[{name:'separate-model',rate_limit:exhausted('0').rate_limit}]});
 assert.deepEqual(await candidates(f),[]);
 const blocked=evaluateQuota({...usage(10),rate_limit:{...usage(10).rate_limit,allowed:false}});
 assert.equal(blocked.subscription_status,'unknown');
});
test('credit and spend fields fail closed when missing or malformed', () => {
 for (const extra of [{credits:null},{credits:{has_credits:'true',unlimited:false,balance:'50'}},{credits:{has_credits:true,unlimited:false,balance:'NaN'}},{spend_control:{reached:true}},{credits:{has_credits:true,unlimited:false,balance:'50',overage_limit_reached:true}}]) {
  assert.equal(evaluateQuota({...exhausted('50'),...extra}).credits.eligible,false);
 }
 assert.equal(evaluateQuota({...exhausted('0'),credits:{has_credits:false,unlimited:true,balance:null}}).credits.eligible,true);
});
test('a setting change or newly connected account during a quota proof invalidates paid admission', async () => {
 for(const membership of [false,true]) {
  const f=await fixture({credits:true});f.values.set(emails[0],exhausted('50'));f.values.set(emails[1],exhausted('0'));
  const started=deferred(), gate=deferred(), quota=f.management.quota;
  f.management.quota=async c=>{if(c.email===emails[0]){started.resolve();await gate.promise;}return quota(c);};
  const pending=candidates(f);await started.promise;
  if(membership) await f.controller.mutate(async()=>{const s=await f.controller.readState();const extra={email:'third@example.test',name:'synthetic-2.json',prefix:'conta-03'};await f.controller.saveState({...s,accounts:[...s.accounts,extra],priority_order:[...s.priority_order,extra.email],revision:s.revision+1});});
  else await f.controller.update({revision:0,allow_extra_credits:false});
  gate.resolve();assert.deepEqual(await pending,[]);
 }
});
test('manual reset persists one identity before dispatch and verifies fresh recovery', async () => {
 const f=await fixture();f.values.set(emails[0],usage(96,{resets:1,applicable:1}));
 const consume=f.management.consumeReset;
 f.management.consumeReset=async(c,key)=>{const s=JSON.parse(await readFile(f.runtimeDir+'/accounts-state.json'));assert.equal(s.reset_journal[c.email].key,key);assert.equal(s.reset_journal[c.email].status,'pending');return consume(c,key);};
 await f.controller.resetAccount(emails[0],{revision:0});
 assert.equal(f.consumed.length,1);assert.match(f.consumed[0].key,/^[0-9a-f-]{36}$/);
 const status=await f.controller.status();const receipt=status.accounts[0].resets.operation;
 assert.equal(receipt.status,'succeeded');assert.equal(receipt.verified,true);assert.equal(status.accounts[0].resets.available_count,0);
 const safe=JSON.stringify(status);assert.ok(!safe.includes(f.consumed[0].key));assert.ok(!safe.includes('account-0'));
});
test('reset double clicks, the timer, disconnect and reconnect share one pending operation', async () => {
 const f=await fixture({automatic:[emails[0]]});f.values.set(emails[0],usage(96,{resets:2,applicable:2}));
 const started=deferred(),gate=deferred(),consume=f.management.consumeReset;
 f.management.consumeReset=async(c,key)=>{started.resolve();await gate.promise;return consume(c,key);};
 const first=f.controller.resetAccount(emails[0],{revision:0});await started.promise;
 const duplicate=f.controller.resetAccount(emails[0],{automatic:true});
 await assert.rejects(f.controller.disconnect(emails[0]),{status:409});await assert.rejects(f.controller.connect(emails[0]),{status:409});
 gate.resolve();await Promise.all([first,duplicate]);assert.equal(f.consumed.length,1);
});
test('uncertain redemption survives restart and retries the same identity even after allowance recovered', async () => {
 const f=await fixture();f.values.set(emails[0],usage(96,{resets:1,applicable:1}));
 f.management.consumeReset=async(c,key)=>{f.consumed.push({email:c.email,key});f.values.set(c.email,usage());throw Error('lost response after success');};
 await f.controller.resetAccount(emails[0],{revision:0});
 assert.equal((await f.controller.status()).accounts[0].resets.operation.status,'uncertain');
 const restarted=new PoolController({runtimeDir:f.runtimeDir,management:f.management,now:()=>f.clock.value});
 f.management.consumeReset=async(c,key)=>{f.consumed.push({email:c.email,key});return 'already_redeemed';};
 const state=await restarted.readState();await restarted.resetAccount(emails[0],{revision:state.revision});
 assert.equal(f.consumed.length,2);assert.equal(new Set(f.consumed.map(x=>x.key)).size,1);
 assert.equal((await restarted.status()).accounts[0].resets.operation.status,'succeeded');
});
test('automatic reset defaults off, fires at 5%, and requires fresh recovery before another cycle', async () => {
 const f=await fixture();f.values.set(emails[0],usage(95,{resets:3,applicable:3}));
 await f.controller.runAutomaticResets();assert.equal(f.consumed.length,0);
 await f.controller.update({revision:0,auto_reset_emails:[emails[0]]});
 f.management.consumeReset=async(c,key)=>{f.consumed.push({email:c.email,key});return 'reset';};
 await f.controller.runAutomaticResets();assert.equal(f.consumed.length,1);
 f.clock.value+=61000;await f.controller.runAutomaticResets();assert.equal(f.consumed.length,1);
 f.values.set(emails[0],usage(10,{resets:2,applicable:0}));await f.controller.runAutomaticResets();
 f.values.set(emails[0],usage(95,{resets:2,applicable:2}));await f.controller.runAutomaticResets();
 assert.equal(f.consumed.length,2);assert.notEqual(f.consumed[0].key,f.consumed[1].key);
});
test('request-triggered automatic reset dispatches once after recovery without invalidating its routing choice', async t => {
 const f=await fixture({automatic:[emails[0]]});f.values.set(emails[0],usage(96,{resets:1,applicable:1}));
 const dispatched=[];const backend=await server(t,http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);dispatched.push(JSON.parse(Buffer.concat(chunks)).model);res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');}));
 const base=await server(t,createPoolRouter({controller:f.controller,backendPort:Number(new URL(backend).port),getClientKey:async()=>'synthetic'}));
 const response=await authorizedFetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-sonnet-5-5',messages:[]})});
 assert.equal(response.status,200);assert.equal(f.consumed.length,1);assert.deepEqual(dispatched,['conta-01/gpt-6.1-sol']);
 assert.equal((await f.controller.status()).accounts[0].resets.operation.verified,true);
});
test('non-applicable reset and read-only refresh never consume an available reset', async () => {
 const f=await fixture({automatic:[emails[0]]});f.values.set(emails[0],usage(96,{resets:1,applicable:0}));
 const status=await f.controller.status(true);assert.equal(status.accounts[0].resets.available_count,1);assert.equal(status.accounts[0].resets.can_apply,false);
 await f.controller.runAutomaticResets();assert.equal(f.consumed.length,0);
 f.values.set(emails[0],usage(96,{resets:1,applicable:1}));await f.controller.status(true);assert.equal(f.consumed.length,0);
});
test('old quota lookup cannot overwrite the post-reset generation', async () => {
 const f=await fixture();const old=deferred();let lookups=0;
 f.management.quota=async()=>{lookups++;if(lookups===1)return old.promise;if(lookups===2)return usage(96,{resets:1,applicable:1});return usage();};
 const credential=(await f.controller.credentials())[0];const stale=f.controller.quota(credential);
 await f.controller.resetAccount(emails[0],{revision:0});old.resolve(usage(99,{resets:1,applicable:1}));
 await stale;assert.equal(f.controller.quotas.get(emails[0]).remaining_percent,100);
});
test('a changed account identity cannot receive a pending retry', async () => {
 const f=await fixture();f.values.set(emails[0],usage(96,{resets:1,applicable:1}));f.management.consumeReset=async(c,key)=>{f.consumed.push({email:c.email,key});throw Error('unknown');};
 await f.controller.resetAccount(emails[0],{revision:0});f.rows[0].id_token.chatgpt_account_id='different-account';
 const s=await f.controller.readState();await assert.rejects(f.controller.resetAccount(emails[0],{revision:s.revision}),{status:409});assert.equal(f.consumed.length,1);
});
test('disabling automation during preflight prevents a new redemption', async () => {
 const f=await fixture({automatic:[emails[0]]});f.values.set(emails[0],usage(96,{resets:1,applicable:1}));
 const started=deferred(),gate=deferred(),quota=f.management.quota;
 f.management.quota=async c=>{started.resolve();await gate.promise;return quota(c);};
 const pending=f.controller.runAutomaticResets();await started.promise;await f.controller.update({revision:0,auto_reset_emails:[]});gate.resolve();await pending;assert.equal(f.consumed.length,0);
});
test('HTTP reset is origin protected and the updater drain blocks new work without stopping an existing stream',async t=>{
 const f=await fixture();let upstreamResponse;
 const backend=await server(t,http.createServer(async(req,res)=>{for await(const chunk of req){}res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: started\ndata: {}\n\n');upstreamResponse=res;}));
 const base=await server(t,createPoolRouter({controller:f.controller,backendPort:Number(new URL(backend).port),getClientKey:async()=>'synthetic'}));
 const send=(path,body={},origin=base)=>authorizedFetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin,'x-bridge-action':'accounts'},body:JSON.stringify(body)});
 assert.equal((await send('/_bridge/reset',{email:emails[0],revision:0},'https://untrusted.example')).status,403);
 assert.equal((await send('/_bridge/reset',{email:emails[0],revision:0,unexpected:true})).status,400);
 const first=await send('/v1/messages',{model:'claude-sonnet-5-5',stream:true,messages:[{role:'user',content:'synthetic'}]});const reader=first.body.getReader();await reader.read();
 const drain=await(await send('/_bridge/update/drain')).json();assert.equal(drain.draining,true);assert.equal(drain.ready,false);assert.equal(drain.active_requests,1);
 assert.equal((await send('/v1/messages',{model:'claude-sonnet-5-5',messages:[]})).status,503);assert.equal((await send('/_bridge/reset',{email:emails[0],revision:0})).status,503);
 upstreamResponse.end('event: stopped\ndata: {}\n\n');while(!(await reader.read()).done){}
 const ready=await(await send('/_bridge/update/drain')).json();assert.equal(ready.ready,true);
 await send('/_bridge/update/resume');assert.equal((await(await authorizedFetch(base+'/healthz')).json()).draining,false);
});
test('reset transport binds account header and sends the persisted idempotency body without a token in the returned payload',async()=>{
 const runtimeDir=await mkdtemp(root+'transport-');await writeFile(runtimeDir+'/management.key','synthetic-local-key');const calls=[];
 const client=new ManagementClient({runtimeDir,fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>({status_code:200,body:JSON.stringify({code:'already_redeemed'})})};}});
 const code=await client.consumeReset({name:'synthetic.json',auth_index:'index-1',account_id:'account-1'},'same-attempt');
 assert.equal(code,'already_redeemed');assert.equal(calls[0].body.header.Authorization,'Bearer $TOKEN$');assert.equal(calls[0].body.header['Chatgpt-Account-Id'],'account-1');
 assert.deepEqual(JSON.parse(calls[0].body.data),{redeem_request_id:'same-attempt'});assert.match(calls[0].body.url,/\/wham\/rate-limit-reset-credits\/consume$/);
});

test('an inference whose body is incomplete cannot enter upstream after update drain',async t=>{
 const f=await fixture();let hits=0;
 const backend=await server(t,http.createServer((req,res)=>{hits++;res.end('{}');}));
 const base=await server(t,createPoolRouter({controller:f.controller,backendPort:Number(new URL(backend).port),getClientKey:async()=>'synthetic'}));
 const body=JSON.stringify({model:'claude-sonnet-5-5',messages:[{role:'user',content:'synthetic'}]});
 let request;const result=new Promise((resolve,reject)=>{request=http.request(base+'/v1/messages',{method:'POST',headers:{authorization:`Bearer ${ingressKey}`,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();resolve(res.statusCode);});request.on('error',reject);request.write(body.slice(0,15));});
 await new Promise(r=>setImmediate(r));
 const drain=await authorizedFetch(base+'/_bridge/update/drain',{method:'POST',headers:{'content-type':'application/json',origin:base,'x-bridge-action':'accounts'},body:'{}'});assert.equal((await drain.json()).ready,true);
 request.end(body.slice(15));assert.equal(await result,503);assert.equal(hits,0);
});
test('update drain waits for an OAuth start before its pending state is persisted',async t=>{
 const f=await fixture();const started=deferred(),gate=deferred();
 f.management.startLogin=async()=>{started.resolve();await gate.promise;return{state:'synthetic-oauth',url:'https://auth.openai.com/oauth/authorize?state=synthetic-oauth'};};
 const base=await server(t,createPoolRouter({controller:f.controller,getClientKey:async()=>'synthetic'}));
 const send=(path,body)=>authorizedFetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:base,'x-bridge-action':'accounts'},body:JSON.stringify(body)});
 const connecting=send('/_bridge/connect',{email:'third@example.test'});await started.promise;
 const draining=send('/_bridge/update/drain',{});
 await new Promise(r=>setImmediate(r));
 const whileConnecting=await(await authorizedFetch(base+'/healthz')).json();assert.equal(whileConnecting.pending_actions,1);
 gate.resolve();assert.equal((await connecting).status,200);
 const drain=await(await draining).json();assert.equal(drain.ready,false);assert.equal(drain.pending_oauth,1);
 const health=await(await authorizedFetch(base+'/healthz')).json();assert.equal(health.pending_oauth,1);assert.equal(health.pending_actions,0);
});

test('a fresh subscription observation supersedes an older exhausted observation during credit selection',async()=>{
 const f=await fixture({credits:true});f.values.set(emails[0],exhausted('0'));f.values.set(emails[1],exhausted('50'));
 const started=deferred(),gate=deferred(),quota=f.management.quota;
 f.management.quota=async c=>{if(c.email===emails[1]){started.resolve();await gate.promise;}return quota(c);};
 const selecting=candidates(f);await started.promise;
 f.values.set(emails[0],usage(10));await f.controller.quota((await f.controller.credentials())[0],{force:true});gate.resolve();
 assert.deepEqual(await selecting,[{email:emails[0],source:'subscription'}]);
});
test('paid dispatch rechecks every latest quota and expires a proof at its known renewal deadline',async()=>{
 for(const refresh of [true,false]){
  const f=await fixture({credits:true});
  const first=exhausted('0');first.rate_limit.primary_window.reset_at=f.clock.value/1000+1;
  f.values.set(emails[0],first);f.values.set(emails[1],exhausted('50'));
  const iterator=f.controller.candidates({ model: 'claude-sonnet-5-5' });const candidate=(await iterator.next()).value;
  assert.equal(candidate.consumption_source,'credits');assert.equal(await f.controller.validateCandidate(candidate),true);
  if(refresh){f.values.set(emails[0],usage(0));await f.controller.quota((await f.controller.credentials())[0],{force:true});}
  else f.clock.value+=1001;
  assert.equal(await f.controller.validateCandidate(candidate),false);assert.equal(f.controller.validateCandidateNow(candidate),false);
  await iterator.return();
 }
});
test('a timer holding pre-reset healthy quota cannot rearm the new reset cycle',async()=>{
 const f=await fixture({automatic:[emails[0]]});const credential=(await f.controller.credentials())[0];
 f.values.set(emails[0],usage(90,{resets:2,applicable:1}));const oldQuota=await f.controller.quota(credential);
 const started=deferred(),gate=deferred(),read=f.controller.readState.bind(f.controller);
 f.controller.readState=async()=>{started.resolve();await gate.promise;return read();};
 const staleTimer=f.controller.maybeAutomaticReset(emails[0],credential,oldQuota);await started.promise;f.controller.readState=read;
 f.values.set(emails[0],usage(96,{resets:2,applicable:2}));f.management.consumeReset=async(c,key)=>{f.consumed.push({email:c.email,key});return'reset';};
 await f.controller.resetAccount(emails[0],{revision:0});assert.equal((await read()).reset_journal[emails[0]].recovered,false);
 gate.resolve();await staleTimer;assert.equal((await read()).reset_journal[emails[0]].recovered,false);
 await f.controller.runAutomaticResets();assert.equal(f.consumed.length,1);
});
test('recovery proof is checked again after waiting for the state mutation queue',async()=>{
 const f=await fixture({automatic:[emails[0]]});f.values.set(emails[0],usage(96,{resets:2,applicable:2}));
 f.management.consumeReset=async(c,key)=>{f.consumed.push({email:c.email,key});return'reset';};
 await f.controller.resetAccount(emails[0],{revision:0});const credential=(await f.controller.credentials())[0];
 f.values.set(emails[0],usage(50,{resets:1,applicable:0}));const healthy=await f.controller.quota(credential);
 const state=await f.controller.readState();const gate=deferred(),entered=deferred();const holding=f.controller.mutate(async()=>{entered.resolve();await gate.promise;});await entered.promise;
 const confirming=f.controller.confirmRecovery(emails[0],state.reset_journal[emails[0]].key,credential,healthy);
 f.values.set(emails[0],usage(96,{resets:1,applicable:1}));await f.controller.quota(credential,{force:true});gate.resolve();await Promise.all([holding,confirming]);
 assert.equal((await f.controller.readState()).reset_journal[emails[0]].recovered,false);
});

test('a candidate whose credits disappear is skipped before dispatch so another account can be used',async t=>{
 const f=await fixture({credits:true});f.values.set(emails[0],exhausted('50'));f.values.set(emails[1],exhausted('50'));
 const dispatched=[];const backend=await server(t,http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);dispatched.push(JSON.parse(Buffer.concat(chunks)).model);res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');}));
 const validate=f.controller.validateCandidate.bind(f.controller);let changed=false;
 f.controller.validateCandidate=async account=>{if(!changed&&account.consumption_source==='credits'){changed=true;f.values.set(emails[0],exhausted('0'));await f.controller.quota((await f.controller.credentials())[0],{force:true});}return validate(account);};
 const base=await server(t,createPoolRouter({controller:f.controller,backendPort:Number(new URL(backend).port),getClientKey:async()=>'synthetic'}));
 const response=await authorizedFetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-sonnet-5-5',messages:[]})});
 assert.equal(response.status,200);assert.deepEqual(dispatched,['conta-02/gpt-6.1-sol']);
});
test('the update drain survives a replacement service until an explicit resume',async t=>{
 const f=await fixture();await f.controller.setUpdateDrain(true);
 const replacement=new PoolController({runtimeDir:f.runtimeDir,management:f.management});replacement.pausedForUpdate=(await replacement.readState()).update_draining;
 const base=await server(t,createPoolRouter({controller:replacement,getClientKey:async()=>'synthetic'}));
 const send=(path,body={})=>authorizedFetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:base,'x-bridge-action':'accounts'},body:JSON.stringify(body)});
 assert.equal((await(await authorizedFetch(base+'/healthz')).json()).draining,true);
 assert.equal((await send('/v1/messages',{model:'claude-sonnet-5-5',messages:[]})).status,503);
 assert.equal((await send('/_bridge/connect',{email:'new@example.test'})).status,503);
 await send('/_bridge/update/resume');assert.equal((await replacement.readState()).update_draining,false);
 for(const path of ['/','/accounts','/monitor'])assert.equal((await authorizedFetch(base+path)).status,404);
});
