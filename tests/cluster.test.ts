// 聚类与排序（PRD 7.4 / 8.4 / 9.1）
import { clusterCandidates, selectForBrief, scoreCluster, type ClusterInput }
  from '../packages/domain/src/cluster.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const it = (id: string, o: Partial<ClusterInput> = {}): ClusterInput => ({
  candidateId: id, sourceId: 'linuxdo', title: '标题'+id, url: 'https://x/'+id,
  publishedAt: new Date(Date.now()-3600e3).toISOString(), eventKey: 'evt-'+id,
  section: 'ai_tech', decision: 'normal', mandatoryClass: 'none',
  confidence: 0.9, importance: 0.5, novelty: 0.5, signals: [], sourcePriority: 5, ...o });

console.log('跨来源同事件合并（PRD 7.4）：\n');
{
  const cs = clusterCandidates([
    it('a', { eventKey: 'openai-release', sourceId: 'x_openai', sourcePriority: 1, isOfficial: true }),
    it('b', { eventKey: 'openai-release', sourceId: 'tg_durov', sourcePriority: 5 }),
    it('c', { eventKey: 'openai-release', sourceId: 'jike', sourcePriority: 3 }),
    it('d', { eventKey: 'other-thing' }),
  ]);
  ok('三条同事件合并为一簇', cs.length === 2);
  const merged = cs.find(c => c.primary.eventKey === 'openai-release')!;
  ok('官方来源被选为最佳原始来源', merged.primary.sourceId === 'x_openai');
  ok('其他渠道贡献被保留', merged.members.length === 2,
     merged.members.map(m => m.sourceId).join(','));
}

console.log('\n同关键词不等于重复（PRD 7.4 最易错项）：\n');
{
  // 模型给了同一个 event_key，但一个是项目发布、一个是使用教程
  const cs = clusterCandidates([
    it('proj', { eventKey: 'toolx', mandatoryClass: 'A' }),
    it('tut',  { eventKey: 'toolx', mandatoryClass: 'B' }),
  ]);
  ok('A 类项目与 B 类教程不合并', cs.length === 2);
}
{
  const cs = clusterCandidates([
    it('a', { eventKey: 'toolx', section: 'ai_tech' }),
    it('b', { eventKey: 'toolx', section: 'developer_product' }),
  ]);
  ok('不同分区不合并', cs.length === 2);
}

console.log('\n排序权重（PRD 8.4 合计 100）：\n');
{
  const hi = it('hi', { importance: 1, novelty: 1, sourcePriority: 1, isOfficial: true,
    signals: ['official_link','repo_url','demo_link','external_link','code_block','command_line','config_block','step_markers'] });
  const lo = it('lo', { importance: 0, novelty: 0, sourcePriority: 7,
    publishedAt: new Date(Date.now()-96*3600e3).toISOString() });
  const sHi = scoreCluster(hi, [hi]), sLo = scoreCluster(lo, [lo]);
  ok('满分接近 100', sHi >= 95, String(sHi));
  ok('最低分接近 0', sLo <= 10, String(sLo));
  const multi = scoreCluster(hi, [hi, it('x')]);
  ok('多来源互证提高可验证性', multi >= sHi, `单源=${sHi} 多源=${multi}`);
}

console.log('\n入选规则（PRD 8.4 / 9.1）：\n');
{
  const mk = (i: number, score: number, mc = 'none') =>
    ({ clusterKey: 'k'+i, section: 'ai_tech', primary: it('p'+i), members: [],
       mandatoryClass: mc, score });
  const many = Array.from({length: 20}, (_, i) => mk(i, 90 - i));
  const r = selectForBrief(many as any);
  ok('普通候选按分数截到 12 条', r.selected.length === 12, String(r.selected.length));
  ok('落选的进 dropped', r.dropped.length === 8);

  const withMandatory = [...Array.from({length: 12}, (_, i) => mk(i, 90 - i)),
                         mk(90, 30, 'A'), mk(91, 20, 'D')];
  const r2 = selectForBrief(withMandatory as any);
  ok('强制保留项不参与篇幅淘汰，总数可超 12', r2.selected.length === 14, String(r2.selected.length));
  ok('低分强制保留项仍入选',
     r2.selected.some(c => c.mandatoryClass === 'A' && c.score === 30));

  const weak = Array.from({length: 10}, (_, i) => mk(i, 40));
  const r3 = selectForBrief(weak as any);
  ok('全部低于分数线 → 收 0 条（禁止凑数，PRD 9.1）', r3.selected.length === 0);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
