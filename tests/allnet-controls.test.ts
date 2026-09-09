import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,copyFileSync,mkdirSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDb,migrate } from '../packages/db/src/index.ts';
import { itemsInWindow } from '../packages/db/src/queries.ts';
import { candidateEligibleSql,eligibilitySignature,assertEligibilityUnchanged } from '../packages/db/src/eligibility.ts';
import { toggleSource,deleteSource } from '../packages/web/src/actions.ts';
import { toggleAllnetCollection } from '../packages/connectors/src/allnet.ts';
import { deliver } from '../packages/templates/src/delivery.ts';
const dir=mkdtempSync(join(tmpdir(),'allnet-controls-'));const dbpath=join(dir,'test.db');const db=openDb(dbpath);
const older=join(dir,'old');mkdirSync(older);for(const f of readdirSync('migrations').filter(f=>f<'011'))copyFileSync(join('migrations',f),join(older,f));migrate(db,older);
const now=new Date().toISOString();
for(const [id,enabled] of [['hot',1],['off',0],['normal',1]] as const){
 db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,managed_by,enabled,source_group,created_at,updated_at) VALUES(?,?,?,'society','allnet','ranking_feed','{}',1,'admin',?,'weibo',?,?)`).run(id,id,id,enabled,now,now);
 if(id!=='normal')db.prepare(`INSERT INTO allnet_subscriptions(source_id,upstream_id,item_limit,kind,token) VALUES(?,?,15,'ranking',?)`).run(id,id==='hot'?76:9,id.repeat(20));
}
migrate(db,'migrations');
assert.deepEqual(db.prepare('SELECT collection_enabled FROM allnet_subscriptions ORDER BY upstream_id').all(),[{collection_enabled:0},{collection_enabled:1}]);
assert.equal((db.prepare("SELECT source_group FROM sources WHERE id='off'").get() as any).source_group,'weibo');
const mock=join(dir,'mock.mjs');writeFileSync(mock,`globalThis.fetch=async()=>Response.json({code:200,data:{list:[{title:'AI useful news',jump_url:'https://example.com/old'}]}});`);
const env={...process.env,DATABASE_PATH:dbpath,SNAPSHOT_DIR:join(dir,'snap'),ALLNET_API_KEY:'test-key'};
const harvest=()=>{const r=spawnSync(process.execPath,['--import',mock,'apps/worker/src/harvest.ts','--source','hot'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
const win={key:'test',label:'test',start:new Date(Date.now()-3600000),end:new Date(Date.now()+3600000)};
try{
 for(const [daily,collection,expected] of [[1,1,true],[0,1,true],[1,0,true],[0,0,false]] as const){
  db.prepare("UPDATE sources SET enabled=? WHERE id='hot'").run(daily);toggleAllnetCollection(db,'hot',!!collection);
  const count=()=>Number((db.prepare('SELECT count(*) n FROM harvest_runs').get() as any).n);
  const before=count();harvest();assert.equal(count()-before,expected?1:0,`${daily}/${collection}`);
  assert.equal(itemsInWindow(db,win).filter(r=>r.source_id==='hot').length,daily?1:0);
 }
 // Resume never admits the prior snapshot; duplicate appearances preserve first_seen_at.
 toggleSource(db,'hot',true,'resume daily');harvest();assert.equal(itemsInWindow(db,win).length,0);
 const cutoff=(db.prepare("SELECT briefing_enabled_since FROM allnet_subscriptions WHERE source_id='hot'").get() as any).briefing_enabled_since;assert.ok(cutoff);
 toggleSource(db,'hot',true,'repeat enable');assert.equal((db.prepare("SELECT briefing_enabled_since FROM allnet_subscriptions WHERE source_id='hot'").get() as any).briefing_enabled_since,cutoff);
 const add=(source:string,key:string,url:string,seen:string)=>{
  const id=Number(db.prepare(`INSERT INTO feed_items(source_id,source_item_key,key_kind,canonical_url,published_at,timestamp_confidence,first_seen_at,last_seen_at,created_at) VALUES(?,?,'guid',?,?,'exact',?,?,?)`).run(source,key,url,now,seen,seen,seen).lastInsertRowid);
  const vid=Number(db.prepare(`INSERT INTO item_versions(item_id,content_hash,raw_hash,title,clean_text,is_excerpt,discovered_at,version_no) VALUES(?,?,'test',?, ?,0,?,1)`).run(id,key,key,key,seen).lastInsertRowid);
  db.prepare('UPDATE feed_items SET current_version_id=? WHERE id=?').run(vid,id);return vid;
 };
 const oldSeen=new Date(Date.now()-10000).toISOString();
 add('off','rss-only','https://example.com/shared',oldSeen);const normalVid=add('normal','daily','https://example.com/shared',new Date().toISOString());
 assert.equal(itemsInWindow(db,win).find(r=>r.vid===normalVid)?.dup_canonical,0,'RSS-only content must not suppress eligible source');
 const newVid=add('hot','new','https://example.com/new',new Date().toISOString());assert.ok(itemsInWindow(db,win).some(r=>r.vid===newVid));
 db.prepare(`INSERT INTO runs(window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger) VALUES('2026-09-06:evening','test',?,?,?,'running','timer')`).run(now,now,now);
 for(const vid of [newVid,normalVid])db.prepare(`INSERT INTO candidates(run_id,item_version_id,origin_window_key,decision,created_at) VALUES(1,?,'2026-09-06:evening','escalate',?)`).run(vid,now);
 const before=eligibilitySignature(db,1);toggleSource(db,'hot',false,'stop daily');
 assert.throws(()=>assertEligibilityUnchanged(db,1,before),/资格已变化/);
 assert.equal((db.prepare(`SELECT count(*) n FROM candidates c WHERE ${candidateEligibleSql()}`).get() as any).n,1,'Existing candidate excluded');
 assert.throws(()=>deleteSource(db,'hot','delete prohibited'),/全网热点/);
 db.prepare("UPDATE candidates SET decision='filter',filter_rule_id='TEST',filter_reason='test' WHERE item_version_id=?").run(normalVid);
 for(const stage of ['triage','review','brief']) {
   const r=spawnSync(process.execPath,[`apps/worker/src/${stage}.ts`,'--run','1','--no-send'],{env:{...env,MAIL_TO:'',AI_PROVIDER:'mock',AI_L1_PROVIDER:'mock',AI_L2_PROVIDER:'mock',AI_L3_PROVIDER:'mock'},encoding:'utf8'});
   assert.equal(r.status,0,`${stage}: ${r.stderr} ${r.stdout}`);
 }
 assert.equal((db.prepare('SELECT count(*) n FROM evaluations e JOIN candidates c ON c.id=e.candidate_id WHERE c.item_version_id=?').get(newVid) as any).n,0);
 const generated=db.prepare('SELECT html_body FROM briefs WHERE run_id=1 ORDER BY id DESC LIMIT 1').get() as any;
 assert.ok(generated && !generated.html_body.includes('https://example.com/new'),'Excluded item must not appear in body or appendix');

 // A source toggle during retry sleep must prevent the second mail attempt.
 const signature=eligibilitySignature(db,1);
 const brief=Number(db.prepare(`INSERT INTO briefs(run_id,version,subject,text_body,html_body,html_bytes,status,rule_version,created_at,eligibility_signature) VALUES(1,2,'s','t','h',1,'final',1,?,?)`).run(now,signature).lastInsertRowid);
 let calls=0;
 await assert.rejects(()=>deliver(db,async()=>{calls++;return {ok:false,permanent:false,error:'temporary'};},{briefId:brief,recipient:'test@example.com',deliveryType:'primary',subject:'s',text:'t',html:'h',sleep:async()=>{toggleSource(db,'normal',false,'stop before retry');}}),/资格已变化/);
 assert.equal(calls,1);assert.equal((db.prepare('SELECT status FROM deliveries WHERE brief_id=?').get(brief) as any).status,'failed');
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
 console.log('Independent controls: migration, four states, no backlog, dedupe, candidate exclusion and retry guard passed');
}finally{db.close();rmSync(dir,{recursive:true,force:true});}
