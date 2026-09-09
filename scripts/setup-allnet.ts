/** One-time authorized bootstrap. Never prints key or subscription tokens. */
import { readFileSync } from 'node:fs';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { setSecret } from '../packages/web/src/secrets.ts';
import { searchAllnet, subscribeAllnet } from '../packages/connectors/src/allnet.ts';
const file=process.argv[2];
if(file) {
  const text=readFileSync(file,'utf8');
  const key=text.match(/(?:api[_ -]?key|密钥|key)\s*[:：=]\s*([^\s]+)/i)?.[1] ?? text.split(/\r?\n/).map(s=>s.trim()).find(s=>s && !s.startsWith('http') && /^[a-zA-Z0-9_-]{20,}$/.test(s));
  if(!key) throw new Error('无法从文件识别密钥，请在设置页保存 ALLNET_API_KEY');
  setSecret('ALLNET_API_KEY',key);
}
const db=openDb(process.env.DATABASE_PATH??'./data/brief.db');migrate(db,'./migrations');
try {
  for(const [upstream,name] of [[76,'知乎热搜'],[9,'微博-热搜'],[864,'美团社区-最新']] as const) {
    const matches=await searchAllnet(db,name);if(!matches.some(m=>m.id===upstream&&m.title===name))throw new Error(`上游来源名称或 ID 已变化：${name}`);
    const id=await subscribeAllnet(db,upstream,name);console.log(`${name}: ${id}`);
  }
}finally{db.close();}
