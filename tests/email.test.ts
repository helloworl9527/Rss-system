// 邮件渲染与安全（PRD 9.3 / 9.4 / 17.3）
import { renderHtml, renderText, checkEmail, esc, safeUrl, subjectOf, type BriefData }
  from '../packages/templates/src/email.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const data = (o: Partial<BriefData> = {}): BriefData => ({
  date: '2026-08-23', windowLabel: '晚报', windowRange: '12:00–22:00',
  highlights: ['要点一', '要点二'],
  sections: [{ id: 'ai_tech', title: 'AI 与科技趋势', items: [{
    title: '某模型发布', conclusion: '这是结论。',
    summarySentences: ['第一句。', '第二句。'],
    sourceName: 'LINUX DO', sourceUrl: 'https://linux.do/t/topic/1',
  }] }],
  audit: { mandatoryMisses: [], counts: [{ label: '已过滤', count: 5 }], sourceIssues: [] },
  ...o });

console.log('注入防护（PRD 17.3）：\n');
{
  const evil = data({ sections: [{ id: 'ai_tech', title: '<script>alert(1)</script>', items: [{
    title: '<img src=x onerror=alert(1)>标题',
    conclusion: '"><script>evil()</script>',
    summarySentences: ["' onmouseover='x", '<iframe src=//evil></iframe>'],
    sourceName: '<b>源</b>', sourceUrl: 'javascript:alert(1)',
  }] }] });
  const html = renderHtml(evil);
  ok('script 标签被转义', !/<script/i.test(html));
  ok('iframe 被转义', !/<iframe/i.test(html));
  const tagsHaveHandler = [...html.matchAll(/<[a-z][^>]*>/gi)].some(t => /\son[a-z]+\s*=/i.test(t[0]));
  ok('真实标签内无事件处理器属性', !tagsHaveHandler);
  ok('恶意属性以纯文本形式存在（已被转义）', html.includes('onerror=alert(1)&gt;'));
  ok('javascript: 链接被拒绝', !html.includes('javascript:'));
  ok('无法生成链接时给出替代文案', html.includes('原文链接不可用'));
  ok('整体校验通过', checkEmail(html, renderText(evil)).length === 0,
     checkEmail(html, renderText(evil)).join('; '));
}

console.log('\n链接协议白名单：\n');
{
  ok('https 通过', safeUrl('https://a.com/x?y=1') === 'https://a.com/x?y=1');
  ok('http 被拒', safeUrl('http://a.com') === null);
  ok('javascript: 被拒', safeUrl('javascript:alert(1)') === null);
  ok('data: 被拒', safeUrl('data:text/html,<script>') === null);
  ok('畸形 URL 被拒', safeUrl('not a url') === null);
  ok('空值被拒', safeUrl(null) === null);
}

console.log('\n格式约束（PRD 9.4）：\n');
{
  const html = renderHtml(data());
  ok('含 760px 最大宽度', html.includes('max-width:760px'));
  ok('无 JavaScript', !/<script/i.test(html));
  ok('无外部字体/远程样式表', !/<link[^>]+stylesheet/i.test(html) && !/@import/.test(html));
  ok('无图片（含追踪像素）', !/<img/i.test(html));
  ok('CSS 全部内联', !/<style[\s>]/i.test(html));
  ok('声明 color-scheme 以适配深色模式', html.includes('color-scheme'));
  const kb = Buffer.byteLength(html, 'utf8') / 1024;
  ok('体积远小于 100 KB', kb < 20, kb.toFixed(1) + ' KB');
}

console.log('\n主题与纯文本备用（PRD 9.4 / 9.5）：\n');
{
  const d = data();
  ok('主题格式正确', subjectOf(d) === '十六源简报｜2026-08-23 晚报', subjectOf(d));
  const t = renderText(d);
  ok('纯文本含核心要点', t.includes('【核心要点】'));
  ok('纯文本含来源链接', t.includes('https://linux.do/t/topic/1'));
  ok('纯文本含审计区', t.includes('【来源状态与过滤审计】'));
}

console.log('\n补录标注（PRD 6.3）：\n');
{
  const d = data({ sections: [{ id:'ai_tech', title:'A', items:[{
    title:'延迟条目', conclusion:'c', summarySentences:['a。','b。'],
    sourceName:'V2EX', sourceUrl:'https://v2ex.com/t/1',
    lateDiscovery: { originWindow:'2026-08-23:noon', publishedAt:'2026-08-23 09:24', firstSeenAt:'2026-08-23 12:20' },
  }] }] });
  const html = renderHtml(d), text = renderText(d);
  ok('HTML 标明「补录（RSS 延迟）」', html.includes('补录（RSS 延迟）'));
  ok('HTML 展示原发布/原窗口/首次发现',
     html.includes('原发布') && html.includes('原窗口') && html.includes('首次发现'));
  ok('纯文本同样标注', text.includes('[补录（RSS 延迟）]') && text.includes('原窗口'));
}

console.log('\n审计区（PRD 9.3）：\n');
{
  const d = data({ audit: {
    mandatoryMisses: [{ title:'某开源项目', url:'https://linux.do/t/topic/9', reason:'人工判定为重复' }],
    counts: [{ label:'已过滤', count:12 }, { label:'无更新', count:3 }],
    sourceIssues: [{ source:'x_claudeai', status:'抓取失败', detail:'HTTP 404，连续 2 次' },
                   { source:'jike', status:'来源异常', detail:'200 但解析出 0 条' }],
  } });
  const html = renderHtml(d), text = renderText(d);
  ok('强制保留未收录项逐条列出（含链接与原因）',
     html.includes('某开源项目') && html.includes('人工判定为重复'));
  ok('抓取失败与来源异常分别标明',
     html.includes('抓取失败') && html.includes('来源异常'));
  ok('抓取失败未被写成「无更新」', !/x_claudeai[\s\S]{0,80}无更新/.test(html));
  ok('普通过滤按类别计数', html.includes('已过滤 12'));
  ok('纯文本含全部审计信息',
     text.includes('某开源项目') && text.includes('抓取失败') && text.includes('来源异常'));
}

console.log('\ncheckEmail 拦截：\n');
{
  ok('超大 HTML 被拦', checkEmail('x'.repeat(110*1024), 't').some(e => e.includes('100 KB')));
  ok('含 script 被拦', checkEmail('<script>a</script>', 't').some(e => e.includes('script')));
  ok('含 img 被拦', checkEmail('<img src=x>', 't').some(e => e.includes('图片')));
  ok('http 链接被拦', checkEmail('<a href="http://a.com">x</a>', 't').some(e => e.includes('非 HTTPS')));
  ok('纯文本为空被拦', checkEmail('<p>a</p>', '  ').some(e => e.includes('纯文本')));
  ok('正常内容通过', checkEmail(renderHtml(data()), renderText(data())).length === 0);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
