import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { allnetRequest, parseAllnet, searchAllnet, subscribeAllnet, rotateAllnetToken, allnetRss, classifyAllnetSource } from '../packages/connectors/src/allnet.ts';
import { renderSources } from '../packages/web/src/views.ts';
const dir=mkdtempSync(join(tmpdir(),'allnet-'));
const db=openDb(join(dir,'test.db'));
try {
  const old=join(dir,'migrations'); const {mkdirSync}=await import('node:fs');mkdirSync(old);
  for(const f of readdirSync('migrations').filter(f=>f<'010')) copyFileSync(join('migrations',f),join(old,f));
  migrate(db,old);
  db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,source_group,created_at,updated_at) VALUES('old','old','old','tech','x','standard','{}',1,'cloudflare','now','now')`).run();
  db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,source_group,created_at,updated_at) VALUES('x_github','x_github','GitHub','developer','x','standard','{}',1,'unclassified','now','now')`).run();
  db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,source_group,created_at,updated_at) VALUES('x_claudeai','x_claudeai','ClaudeAI','ai','x','standard','{}',1,'unclassified','now','now')`).run();
  migrate(db,'migrations');
  assert.equal((db.prepare("SELECT source_group FROM sources WHERE id='old'").get() as any).source_group,'cloudflare');
  assert.equal((db.prepare("SELECT source_group FROM sources WHERE id='x_github'").get() as any).source_group,'github');
  assert.equal((db.prepare("SELECT source_group FROM sources WHERE id='x_claudeai'").get() as any).source_group,'claude');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const list=Array.from({length:20},(_,i)=>({title:'title '+i,jump_url:`https://example.com/${i}`}));list[3]!.title='';
  const sub={upstream_id:76,item_limit:15,origin:null};const rows=parseAllnet(list,sub);
  assert.equal(rows.length,14);assert.equal(rows.at(-1)?.title,'title 14');assert.equal(rows[0]?.publishedRaw,null);assert.equal(rows[0]?.html,'');
  assert.equal(rows[0]?.guid,parseAllnet([{...list[0],hot:12,rank:3}],sub)[0]?.guid);
  assert.throws(()=>parseAllnet([{title:'a',jump_url:'/a'}],sub),/原站/);
  assert.equal(parseAllnet([{title:'a',jump_url:'/2020/01/01/a.html'}],{...sub,origin:'https://tech.meituan.com'})[0]?.link,'https://tech.meituan.com/2020/01/01/a.html');
  assert.deepEqual(classifyAllnetSource(468,'GitHub-日榜'),['github','ranking',null]);
  assert.deepEqual(classifyAllnetSource(467,'GitHub-周榜'),['github','ranking',null]);
  assert.deepEqual(classifyAllnetSource(999,'某技术 Trending'),['unclassified','ranking',null]);
  process.env.ALLNET_API_KEY='test-private-key';
  const realFetch=globalThis.fetch;let calls=0;
  const reset=()=>{db.prepare('UPDATE allnet_lock SET until_ms=0').run();db.prepare('DELETE FROM allnet_cache').run();};
  globalThis.fetch=async(input,init)=>{calls++;assert.ok(String(input).startsWith('https://api.allnet.hot/api/open/v1/'));assert.equal(init?.redirect,'error');assert.equal((init?.headers as any)['X-API-Key'],'test-private-key');return Response.json({code:200,data:{list:String(input).includes('/search')?[{id:76,title:'知乎热搜'},{id:9,title:'微博-热搜'}]:list}});};
  try {
    const candidates=await searchAllnet(db,'热搜');assert.equal(candidates.length,2);reset();
    const id=await subscribeAllnet(db,76,'知乎热搜');const before=calls;assert.equal(await subscribeAllnet(db,76,'知乎热搜'),id);assert.equal(calls,before);
    assert.equal((db.prepare('SELECT enabled FROM sources WHERE id=?').get(id) as any).enabled,0);
    const saved=db.prepare('SELECT * FROM allnet_subscriptions WHERE source_id=?').get(id) as any;
    const feed=allnetRss(saved,'Test & <title>','上游限流');const parsed=new XMLParser().parse(feed);assert.equal(parsed.rss.channel.item.length,14);assert.ok(!feed.includes('test-private-key'));assert.ok(!feed.includes('<pubDate>'));assert.ok(feed.includes('上游限流'));
    const first=saved.token;rotateAllnetToken(db,id);assert.equal(db.prepare('SELECT * FROM allnet_subscriptions WHERE token=?').get(first),undefined);rotateAllnetToken(db,id,true);assert.equal((db.prepare('SELECT token FROM allnet_subscriptions WHERE source_id=?').get(id) as any).token,null);
    reset();const github=await subscribeAllnet(db,468,'GitHub-日榜');
    const githubSub=db.prepare('SELECT kind,item_limit FROM allnet_subscriptions WHERE source_id=?').get(github) as any;
    const githubSource=db.prepare('SELECT category,source_group,harvest_tier FROM sources WHERE id=?').get(github) as any;
    assert.deepEqual(githubSub,{kind:'ranking',item_limit:15});
    assert.deepEqual(githubSource,{category:'tech',source_group:'github',harvest_tier:'ranking_feed'});
    reset();await allnetRequest(db,'/sources/data',{id:'76'});const cnt=calls;await allnetRequest(db,'/sources/data',{id:'76'});assert.equal(calls,cnt);
    for(const status of [401,429]) {reset();globalThis.fetch=async()=>new Response('',{status});await assert.rejects(()=>allnetRequest(db,'/sources'),e=>(e as any).status===status);}
    reset();globalThis.fetch=async()=>Response.json({code:500,data:{list}});await assert.rejects(()=>allnetRequest(db,'/sources'),/业务错误码/);
    reset();globalThis.fetch=async()=>Response.json({code:200,data:{list:[]}});await assert.rejects(()=>allnetRequest(db,'/sources'),/空榜单/);assert.deepEqual(await searchAllnet(db,'不存在'),[]);
    reset();globalThis.fetch=async()=>new Response('bad json');await assert.rejects(()=>allnetRequest(db,'/sources'),/解析失败/);
    assert.equal((db.prepare('SELECT snapshot_json FROM allnet_subscriptions WHERE source_id=?').get(id) as any).snapshot_json,saved.snapshot_json);
    const page=renderSources({csrf:'test',sources:[]});assert.ok(page.includes('社会生活'));assert.ok(page.includes('百度热搜'));assert.ok(page.includes('暂不可用'));
    db.prepare('UPDATE allnet_usage SET calls=2000').run();reset();await assert.rejects(()=>allnetRequest(db,'/sources'),/每日调用限额/);
  } finally {globalThis.fetch=realFetch;}
  console.log('Allnet migration, parsing, limits, errors, cache, subscriptions, tokens, RSS and placeholder tests passed');
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
