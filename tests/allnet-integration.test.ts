import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { openDb,migrate } from '../packages/db/src/index.ts';
import { itemsInWindow, findLateDiscoveries } from '../packages/db/src/queries.ts';
import { hashPassword } from '../packages/web/src/auth.ts';
const dir=mkdtempSync(join(tmpdir(),'allnet-integration-'));const dbpath=join(dir,'test.db');const db=openDb(dbpath);migrate(db,'migrations');
const mock=join(dir,'mock.mjs');writeFileSync(mock,`globalThis.fetch=async()=>Response.json({code:200,data:{list:Array.from({length:20},(_,i)=>({title:'item '+i,jump_url:'https://example.com/'+i}))}});`);
const env={...process.env,DATABASE_PATH:dbpath,SNAPSHOT_DIR:join(dir,'snap'),ALLNET_API_KEY:'private-test-key',ADMIN_PASSWORD_HASH:hashPassword('test-pass'),ADMIN_TOTP_SECRET:'',ADMIN_PORT:'3197',ADMIN_SECURE_COOKIE:'false',ADMIN_BASE_URL:'http://127.0.0.1:3197'};
const now=new Date().toISOString();
db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,managed_by,created_at,updated_at) VALUES('hot','hot','hot','society','allnet','ranking_feed','{}',1,'admin',?,?)`).run(now,now);
db.prepare(`INSERT INTO allnet_subscriptions(source_id,upstream_id,item_limit,kind,token) VALUES('hot',76,15,'ranking',?)`).run('a'.repeat(64));
let child:ReturnType<typeof spawn>|undefined;
try {
  const harvest=()=>{const r=spawnSync(process.execPath,['--import',mock,'apps/worker/src/harvest.ts','--source','hot'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  harvest();harvest();assert.equal((db.prepare('SELECT count(*) n FROM feed_items').get() as any).n,15);assert.equal((db.prepare('SELECT count(*) n FROM item_versions').get() as any).n,15);
  assert.equal((db.prepare('SELECT count(*) n FROM feed_items WHERE published_at IS NOT NULL').get() as any).n,0);
  const win={key:'test',label:'test',start:new Date(Date.now()-3600000),end:new Date(Date.now()+3600000)};assert.equal(itemsInWindow(db,win).length,15);
  // Dated history before onboarding is backfill, not a late-breaking item.
  db.prepare("UPDATE feed_items SET published_at=?,timestamp_confidence='exact',first_seen_at=?").run('2020-01-01T01:00:00.000Z',now);
  const historical={key:'old',label:'old',start:new Date('2020-01-01'),end:new Date('2020-01-02')};assert.equal(findLateDiscoveries(db,[historical]).late.length,0);assert.equal(findLateDiscoveries(db,[historical]).backfill,15);
  let logs='';child=spawn(process.execPath,['apps/web/src/server.ts'],{env,stdio:['ignore','pipe','pipe']});child.stdout!.on('data',b=>logs+=b);child.stderr!.on('data',b=>logs+=b);
  const base='http://127.0.0.1:3197';for(let i=0;i<100;i++){try {if((await fetch(base+'/health/live')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const first='a'.repeat(64);assert.equal((await fetch(base+'/rss/allnet/'+first)).status,200);
  assert.equal((await fetch(base+'/rss/allnet/'+'b'.repeat(64))).status,404);
  assert.equal((await fetch(base+'/sources/allnet/search',{method:'POST',redirect:'manual'})).status,302);
  const login=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({password:'test-pass'}),redirect:'manual'});const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const html=await (await fetch(base+'/sources',{headers:{cookie}})).text();const csrf=html.match(/name="csrf" value="([^"]+)"/)![1]!;
  assert.ok(!html.includes('/rss/allnet/'+first));
  const allnetHtml=await (await fetch(base+'/allnet',{headers:{cookie}})).text();assert.ok(allnetHtml.includes('/rss/allnet/'+first));assert.ok(!allnetHtml.includes('item 0'));assert.ok(!allnetHtml.includes('private-test-key'));
  assert.equal((await fetch(base+'/allnet/hot/toggle',{method:'POST',headers:{cookie},body:new URLSearchParams({enabled:'false'})})).status,403);
  assert.equal((await fetch(base+'/allnet/hot/toggle',{method:'POST',headers:{cookie},body:new URLSearchParams({csrf,enabled:'false'}),redirect:'manual'})).status,302);
  assert.equal((db.prepare("SELECT enabled FROM sources WHERE id='hot'").get() as any).enabled,1);
  assert.equal((db.prepare("SELECT collection_enabled FROM allnet_subscriptions WHERE source_id='hot'").get() as any).collection_enabled,0);assert.ok(!html.includes('private-test-key'));assert.ok(html.includes('社会生活'));
  assert.equal((await fetch(base+'/sources/hot/allnet/token',{method:'POST',headers:{cookie},body:new URLSearchParams({action:'reset'})})).status,403);
  const post=(action:string)=>fetch(base+'/allnet/hot/token',{method:'POST',headers:{cookie},body:new URLSearchParams({csrf,action}),redirect:'manual'});
  assert.equal((await post('reset')).status,302);assert.equal((await fetch(base+'/rss/allnet/'+first)).status,404);
  const token=(db.prepare("SELECT token FROM allnet_subscriptions WHERE source_id='hot'").get() as any).token;assert.equal((await fetch(base+'/rss/allnet/'+token)).status,200);
  await post('revoke');assert.equal((await fetch(base+'/rss/allnet/'+token)).status,404);
  await new Promise(r=>setTimeout(r,100));assert.ok(!logs.includes(first));assert.ok(!logs.includes(token));assert.ok(!logs.includes('private-test-key'));
  console.log('Allnet worker dedupe, missing-time window, historical backfill, authenticated UI, CSRF, RSS and log redaction integration passed');
} finally {if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}db.close();rmSync(dir,{recursive:true,force:true});}
