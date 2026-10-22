/**
 * 新版日报渲染。邮件与 RSS 用同一份 DigestData，结构完全一致：
 *   头部（日期 + 北京时间窗口）→ 一、官方动态（按厂商）→ 二、开源项目 → 三、时政速览
 * 安全：所有文本转义；链接只放行 https（safeUrl 重建）。不使用星标等评分符号。
 */
import { esc, safeUrl } from '../../templates/src/email.ts';
import type { DigestData, DigestLink } from './core.ts';

export const NO_POLITICS = '本时段暂无值得关注的时政动态。';
/** 兼容旧数据：politics 曾是一段字符串。 */
export const politicsList = (d: DigestData): string[] =>
  Array.isArray(d.politics) ? d.politics : (d.politics ? [String(d.politics)] : []);
export const TG_PENDING = '群组要点生成中，稍后可在 Telegram 跨频道要点 RSS 查看。';
const TG_TITLE = '四、Telegram 群组要点';
const tgRange = (t: NonNullable<DigestData['telegram']>) => {
  if (!t.windowStart || !t.windowEnd) return '';
  const f = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  return `北京时间 ${f(t.windowStart)}–${f(t.windowEnd)}`;
};
export function digestSubject(d: DigestData): string {
  return `十六源日报｜${d.date} ${d.windowLabel}`;
}
const header = (d: DigestData) => `${d.date} ${d.windowLabel} · 北京时间 ${d.windowRange}`;
const emptyLine = (d: DigestData) => d.emptyVendors.length ? `${d.emptyVendors.join('、')}：本期无更新` : '';

function links(ls: DigestLink[], style: string): string {
  return ls.map(l => { const u = safeUrl(l.url); return u ? `<a href="${esc(u)}" style="${style}">${esc(l.label)}</a>` : esc(l.label); }).join(' · ');
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const C = { page: '#eef1f5', card: '#ffffff', line: '#e2e7ee', ink: '#161b22', body: '#39424e', muted: '#6b7684', accent: '#1c5fa8' };
const A = `color:${C.accent};text-decoration:none;`;

function tgHtml(t: NonNullable<DigestData['telegram']>): string {
  if (t.status !== 'ready') return `<p style="margin:0;color:${C.muted};">${esc(TG_PENDING)}</p>`;
  if (!t.categories.length) return `<p style="margin:0;color:${C.muted};">本日没有值得关注的群组要点。</p>`;
  return `<div style="font-size:12px;color:${C.muted};">${esc(tgRange(t))}</div>` + t.categories.map(c =>
    `<h3 style="margin:14px 0 6px;font-size:15px;color:${C.accent};">${esc(c.name)}</h3><ul style="margin:0;padding-left:20px;">` +
    c.items.map(i => `<li style="margin:0 0 6px;">${esc(i.text)}${i.groups.length ? ` <span style="font-size:12px;color:${C.muted};">〔${esc(i.groups.join('、'))}〕</span>` : ''}</li>`).join('') + '</ul>').join('');
}

export function renderDigestHtml(d: DigestData): string {
  const h2 = (t: string) => `<h2 style="margin:28px 0 12px;font-size:18px;color:${C.ink};border-bottom:2px solid ${C.line};padding-bottom:6px;">${esc(t)}</h2>`;
  const official = d.vendors.map(v => `<h3 style="margin:18px 0 8px;font-size:15px;color:${C.accent};">${esc(v.name)}</h3>` +
    v.events.map(e => `<div style="margin:0 0 12px;padding:10px 14px;background:${C.card};border:1px solid ${C.line};border-radius:8px;">
<div style="font-weight:700;color:${C.ink};">${esc(e.title)}</div>
<div style="margin:4px 0;">${esc(e.summary)}</div>
<div style="font-size:12px;color:${C.muted};">原文：${links(e.links, A)}</div></div>`).join('')).join('')
    + (d.emptyVendors.length ? `<p style="margin:12px 0 0;font-size:13px;color:${C.muted};">${esc(emptyLine(d))}</p>` : '')
    + (!d.vendors.length && !d.emptyVendors.length ? `<p style="color:${C.muted};">本期无官方动态。</p>` : '');
  const projects = d.projects.length ? `<ul style="margin:0;padding-left:20px;">` + d.projects.map(p => {
    const u = safeUrl(p.url);
    return `<li style="margin:0 0 8px;"><a href="${esc(u ?? '')}" style="${A}font-weight:700;">${esc(p.repo)}</a> — ${esc(p.description)}
<span style="font-size:12px;color:${C.muted};">（提及：${links(p.mentionedBy, `color:${C.muted};`)}）</span></li>`;
  }).join('') + '</ul>' : `<p style="color:${C.muted};">本期无新的开源项目。</p>`;
  const pl = politicsList(d);
  const pol = pl.length ? `<ul style="margin:0;padding-left:20px;">${pl.map(b => `<li style="margin:0 0 6px;">${esc(b)}</li>`).join('')}</ul>`
    : `<p style="margin:0;color:${C.muted};">${NO_POLITICS}</p>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(digestSubject(d))}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="max-width:760px;margin:0 auto;padding:24px 16px 40px;font-family:${FONT};color:${C.body};font-size:15px;line-height:1.7;">
<h1 style="margin:0 0 4px;font-size:22px;color:${C.ink};">十六源日报</h1>
<div style="font-size:13px;color:${C.muted};">${esc(header(d))}</div>
${h2('一、官方动态')}${official}
${h2('二、开源项目')}${projects}
${h2('三、时政速览')}${pol}
${d.telegram ? h2(TG_TITLE) + tgHtml(d.telegram) : ''}
</div></body></html>`;
}

export function renderDigestText(d: DigestData): string {
  const L: string[] = ['十六源日报', header(d), '', '一、官方动态'];
  for (const v of d.vendors) {
    L.push('', `【${v.name}】`);
    for (const e of v.events) { L.push(`• ${e.title}`, `  ${e.summary}`); for (const l of e.links) L.push(`  ${l.label}: ${l.url}`); }
  }
  if (d.emptyVendors.length) L.push('', emptyLine(d));
  L.push('', '二、开源项目');
  if (!d.projects.length) L.push('本期无新的开源项目。');
  for (const p of d.projects) L.push(`• ${p.repo} — ${p.description}（提及：${p.mentionedBy.map(m => m.label).join('、')}）`, `  ${p.url}`);
  const pl = politicsList(d);
  L.push('', '三、时政速览', ...(pl.length ? pl.map(b => `• ${b}`) : [NO_POLITICS]), '');
  if (d.telegram) {
    const t = d.telegram;
    L.push(TG_TITLE);
    if (t.status !== 'ready') L.push(TG_PENDING);
    else if (!t.categories.length) L.push('本日没有值得关注的群组要点。');
    else { L.push(tgRange(t)); for (const c of t.categories) { L.push('', `【${c.name}】`); for (const i of c.items) L.push(`• ${i.text}${i.groups.length ? `〔${i.groups.join('、')}〕` : ''}`); } }
    L.push('');
  }
  return L.join('\n');
}

/** RSS 阅读器正文：语义化 HTML，无内联样式；结构与邮件一致。 */
export function renderDigestFeedHtml(d: DigestData): string {
  const ln = (ls: DigestLink[]) => ls.map(l => { const u = safeUrl(l.url); return u ? `<a href="${esc(u)}">${esc(l.label)}</a>` : esc(l.label); }).join(' · ');
  let h = `<p>${esc(header(d))}</p><h2>一、官方动态</h2>`;
  for (const v of d.vendors) {
    h += `<h3>${esc(v.name)}</h3>`;
    for (const e of v.events) h += `<p><strong>${esc(e.title)}</strong><br>${esc(e.summary)}<br><small>原文：${ln(e.links)}</small></p>`;
  }
  if (d.emptyVendors.length) h += `<p><small>${esc(emptyLine(d))}</small></p>`;
  h += `<h2>二、开源项目</h2>`;
  h += d.projects.length ? '<ul>' + d.projects.map(p => `<li><a href="${esc(safeUrl(p.url) ?? '')}"><strong>${esc(p.repo)}</strong></a> — ${esc(p.description)} <small>（提及：${ln(p.mentionedBy)}）</small></li>`).join('') + '</ul>'
    : '<p>本期无新的开源项目。</p>';
  const pl = politicsList(d);
  h += `<h2>三、时政速览</h2>` + (pl.length ? `<ul>${pl.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : `<p>${NO_POLITICS}</p>`);
  if (d.telegram) {
    const t = d.telegram;
    h += `<h2>${TG_TITLE}</h2>`;
    if (t.status !== 'ready') h += `<p>${esc(TG_PENDING)}</p>`;
    else if (!t.categories.length) h += '<p>本日没有值得关注的群组要点。</p>';
    else h += `<p><small>${esc(tgRange(t))}</small></p>` + t.categories.map(c => `<h3>${esc(c.name)}</h3><ul>` +
      c.items.map(i => `<li>${esc(i.text)}${i.groups.length ? ` <small>〔${esc(i.groups.join('、'))}〕</small>` : ''}</li>`).join('') + '</ul>').join('');
  }
  return h;
}

export function digestCount(d: DigestData): number {
  return d.vendors.reduce((n, v) => n + v.events.length, 0) + d.projects.length
    + (d.telegram?.categories ?? []).reduce((n, c) => n + c.items.length, 0);
}
export function digestTitles(d: DigestData): string[] {
  return [...d.vendors.flatMap(v => v.events.map(e => e.title)), ...d.projects.map(p => p.repo)];
}
