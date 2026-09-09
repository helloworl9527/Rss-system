import { randomBytes } from 'node:crypto';
import { type DB, nowIso, sha256 } from '../../db/src/index.ts';
import { resolveSecret } from '../../web/src/secrets.ts';
import type { RawItem } from './parsers.ts';
import type { Endpoint, FetchResult } from './fetch.ts';

const BASE = 'https://api.allnet.hot/api/open/v1';
export class AllnetError extends Error {
  kind: string; status: number;
  constructor(kind: string, message: string, status = 502) { super(message); this.kind = kind; this.status = status; }
}
export async function allnetRequest(db: DB, path: '/sources/search' | '/sources/data' | '/sources', params: Record<string,string> = {}, fresh = false, transport: typeof fetch = fetch): Promise<any[]> {
  const key = resolveSecret('ALLNET_API_KEY');
  if (!key) throw new AllnetError('auth', '未配置全网热点 API 密钥',401);
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  db.prepare('DELETE FROM allnet_cache WHERE expires_ms<=?').run(Date.now());
  const ck = sha256(key) + url;
  const cached = db.prepare('SELECT body FROM allnet_cache WHERE cache_key=? AND expires_ms>?').get(ck,Date.now()) as any;
  if (!fresh && cached) return JSON.parse(cached.body);
  // Shared lease serializes Web and Worker, including separate processes. Crash leases expire.
  let acquired = false;
  for (let n=0;n<250;n++) {
    acquired = db.prepare('UPDATE allnet_lock SET until_ms=? WHERE id=1 AND until_ms<=?').run(Date.now()+25000,Date.now()).changes === 1;
    if (acquired) break;
    await new Promise(r=>setTimeout(r,100));
  }
  if (!acquired) throw new AllnetError('rate_limit','全网热点请求繁忙，请稍后重试',429);
  try {
    db.transaction(()=>{
      // Count in both UTC and China calendar days: conservative across reset timezone ambiguity.
      for (const day of [new Date().toISOString().slice(0,10), 'cn:'+new Date(Date.now()+8*3600000).toISOString().slice(0,10)]) {
        db.prepare('INSERT OR IGNORE INTO allnet_usage VALUES(?,0)').run(day);
        if (!db.prepare('UPDATE allnet_usage SET calls=calls+1 WHERE day=? AND calls<2000').run(day).changes)
          throw new AllnetError('rate_limit','全网热点每日调用限额已达到',429);
      }
    })();
    const r = await transport(url,{headers:{'X-API-Key':key},redirect:'error',signal:AbortSignal.timeout(20000)});
    if (!r.ok) throw new AllnetError(r.status===401?'auth':r.status===429?'rate_limit':'http',`全网热点 HTTP ${r.status}`,r.status);
    const reader=r.body?.getReader(); let body=''; let size=0;
    if (!reader) throw new AllnetError('parse','全网热点响应为空');
    const decoder=new TextDecoder();
    for (;;) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>2*1024*1024){await reader.cancel(); throw new AllnetError('parse','全网热点响应过大');} body+=decoder.decode(value,{stream:true}); }
    body+=decoder.decode();
    let d:any; try { d=JSON.parse(body); } catch { throw new AllnetError('parse','全网热点 JSON 解析失败'); }
    if(d.code!==200) throw new AllnetError(d.code===401?'auth':d.code===429?'rate_limit':'business',`全网热点业务错误码 ${Number(d.code)||'未知'}`,d.code===401?401:d.code===429?429:502);
    if(!Array.isArray(d.data?.list)) throw new AllnetError('parse','全网热点缺少 data.list');
    if(path!=='/sources/search' && !d.data.list.length) throw new AllnetError('empty','全网热点返回空榜单');
    db.prepare('INSERT OR REPLACE INTO allnet_cache VALUES(?,?,?)').run(ck,JSON.stringify(d.data.list),Date.now()+60000);
    return d.data.list;
  } catch(e) { if(e instanceof AllnetError) throw e; throw new AllnetError('network','全网热点网络请求失败（超时或重定向被拒绝）'); }
  finally { db.prepare('UPDATE allnet_lock SET until_ms=? WHERE id=1').run(Date.now()+200); }
}
export type Subscription = {source_id:string;upstream_id:number;item_limit:number;kind:string;origin:string|null;token:string|null;snapshot_json:string|null;snapshot_at:string|null};
export function parseAllnet(list: any[], sub: Pick<Subscription,'upstream_id'|'item_limit'|'origin'>): RawItem[] {
  const out:RawItem[]=[];
  for(const row of list.slice(0,sub.item_limit)) {
    if(typeof row?.title!=='string' || !row.title.trim()) continue;
    let link:string|null=null;
    if(typeof row.jump_url==='string' && row.jump_url.trim()) {
      const raw=row.jump_url.trim();
      if(!/^[a-z][a-z\d+.-]*:/i.test(raw) && !sub.origin) throw new AllnetError('origin','相对链接需要补充原站地址');
      try { const u=new URL(raw,sub.origin??undefined); if(!['http:','https:'].includes(u.protocol)||u.username||u.password) continue; u.hash='';link=u.href; } catch { continue; }
    }
    out.push({title:row.title.trim(),html:'',link,guid:'allnet:'+sha256(link??`${sub.upstream_id}:${row.title.trim()}`),publishedRaw:null,author:null});
  }
  if(!out.length) throw new AllnetError('empty','全网热点榜单没有有效条目');
  return out;
}
export async function fetchAllnet(db:DB,sub:Subscription) {
  const endpoint:Endpoint={priority:1,url:`${BASE}/sources/data?id=${sub.upstream_id}&page=1`,parser:'allnet'};
  const start=Date.now(); let result:FetchResult;
  try { const rows=await allnetRequest(db,'/sources/data',{id:String(sub.upstream_id),page:'1'});parseAllnet(rows,sub); const body=JSON.stringify(rows);result={outcome:'ok',body,httpCode:200,bytes:Buffer.byteLength(body),latencyMs:Date.now()-start}; }
  catch(e) { const x=e as AllnetError;result={outcome:x.kind==='rate_limit'?'rate_limited':'fetch_failed',errorClass:x.kind,errorMessage:x.message,httpCode:x.status,latencyMs:Date.now()-start}; }
  const attempt={...result,endpoint,isFallback:false};return {attempts:[attempt],success:result.outcome==='ok'?attempt:undefined};
}
export async function searchAllnet(db:DB,name:string) {
  if(!name.trim()||name.length>100) throw new AllnetError('input','请输入来源名称',400);
  const rows=await allnetRequest(db,'/sources/search',{keyword:name.trim()});
  return rows.filter(r=>Number.isSafeInteger(r.id)&&r.id>0&&typeof r.title==='string').map(r=>({id:r.id,title:r.title,existing:(db.prepare('SELECT source_id FROM allnet_subscriptions WHERE upstream_id=?').get(r.id) as any)?.source_id}));
}
export function classifyAllnetSource(upstream:number,name:string): [string,string,string|null] {
  const known:Record<number,[string,string,string|null]>={
    76:['zhihu','ranking',null],
    9:['weibo','ranking',null],
    467:['github','ranking',null], // GitHub-周榜
    468:['github','ranking',null], // GitHub-日榜
    864:['meituan','latest','https://tech.meituan.com'],
  };
  if(known[upstream]) return known[upstream]!;
  const group = /知乎/.test(name)?'zhihu':/微博/.test(name)?'weibo':/美团/.test(name)?'meituan':/github/i.test(name)?'github':/openai/i.test(name)?'openai':/claude|anthropic/i.test(name)?'claude':/google/i.test(name)?'google':/deepseek/i.test(name)?'deepseek':/cloudflare/i.test(name)?'cloudflare':'unclassified';
  const kind = /(热搜|热榜|日榜|周榜|月榜|榜单|排行|trending)/i.test(name)?'ranking':'latest';
  return [group,kind,null];
}
export async function subscribeAllnet(db:DB,upstream:number,name:string, suppliedOrigin = '') {
  if(!Number.isSafeInteger(upstream)||upstream<=0) throw new AllnetError('input','无效上游 ID',400);
  const existing=db.prepare('SELECT source_id FROM allnet_subscriptions WHERE upstream_id=?').get(upstream) as any;
  if(existing) return existing.source_id as string;
  const [group,kind,defaultOrigin]=classifyAllnetSource(upstream,name);
  let origin=defaultOrigin;
  if(suppliedOrigin.trim()) {
    try {const u=new URL(suppliedOrigin);if(u.protocol!=='https:'||u.username||u.password)throw Error();origin=u.origin;}
    catch {throw new AllnetError('input','原站地址必须是 HTTPS 网站地址',400);}
  }
  const limit=kind==='ranking'?15:100;
  const list=await allnetRequest(db,'/sources/data',{id:String(upstream),page:'1'});
  const raws=parseAllnet(list,{upstream_id:upstream,item_limit:limit,origin});
  return db.transaction(()=>{
    const duplicate=db.prepare('SELECT source_id FROM allnet_subscriptions WHERE upstream_id=?').get(upstream) as any;if(duplicate)return duplicate.source_id as string;
    const id='allnet_'+randomBytes(8).toString('hex');const now=nowIso();
    db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,managed_by,source_group,created_at,updated_at,site_url)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,name,name,['zhihu','weibo','baidu'].includes(group)?'society':'tech','allnet',kind==='ranking'?'ranking_feed':'standard',JSON.stringify({historical_archive:upstream===864}),1,'admin',group,now,now,origin);
    db.prepare('INSERT INTO allnet_subscriptions(source_id,upstream_id,item_limit,kind,origin,token,snapshot_json,snapshot_at) VALUES(?,?,?,?,?,?,?,?)').run(id,upstream,limit,kind,origin,randomBytes(32).toString('hex'),JSON.stringify(raws),now);
    db.prepare('UPDATE sources SET enabled=0 WHERE id=?').run(id);
    db.prepare(`INSERT INTO audit_events(entity_type,entity_id,action,created_at) VALUES('source',?,'allnet_subscribed',?)`).run(id,now);
    return id;
  })();
}
export function rotateAllnetToken(db:DB,id:string,revoke=false) {
  if(!db.prepare('UPDATE allnet_subscriptions SET token=? WHERE source_id=?').run(revoke?null:randomBytes(32).toString('hex'),id).changes)throw new AllnetError('missing','订阅不存在',404);
  db.prepare(`INSERT INTO audit_events(entity_type,entity_id,action,created_at) VALUES('source',?,?,?)`).run(id,revoke?'rss_token_revoked':'rss_token_rotated',nowIso());
}
const xml=(v:string)=>v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function allnetRss(sub:Subscription,name:string,error?:string|null) {
  const rows:RawItem[]=JSON.parse(sub.snapshot_json??'[]');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(name)}</title><link>https://allnet.hot/</link><description>${xml(`最近成功快照：${sub.snapshot_at??'无'}${error?'；当前采集失败：'+error:''}`)}</description>${sub.snapshot_at?`<lastBuildDate>${new Date(sub.snapshot_at).toUTCString()}</lastBuildDate>`:''}${rows.map(r=>`<item><title>${xml(r.title)}</title>${r.link?`<link>${xml(r.link)}</link>`:''}<guid isPermaLink="false">${xml(r.guid!)}</guid>${r.publishedRaw?`<pubDate>${new Date(r.publishedRaw).toUTCString()}</pubDate>`:''}</item>`).join('')}</channel></rss>`;
}

export function toggleAllnetCollection(db:DB,id:string,enabled:boolean) {
  db.transaction(()=>{
    if(!db.prepare('UPDATE allnet_subscriptions SET collection_enabled=? WHERE source_id=?').run(enabled?1:0,id).changes)
      throw new AllnetError('missing','订阅不存在',404);
    db.prepare(`INSERT INTO audit_events(entity_type,entity_id,action,payload_json,created_at)
      VALUES('source',?,'allnet_collection_toggled',?,?)`).run(id,JSON.stringify({enabled}),nowIso());
  })();
}
