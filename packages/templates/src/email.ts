/**
 * 简报邮件渲染（PRD 9.4 / 9.5 / 17.3）。
 *
 * 安全前提：所有来源文本都是不可信数据。标题、结论、摘要一律 HTML 转义；
 * 链接只允许 https 且由 URL 解析器重建，绝不把来源正文里的
 * script / style / 事件处理器 / iframe 带进邮件。
 *
 * 格式约束：全部 CSS 内联，无 JavaScript、无外部字体、无远程样式表、
 * 无追踪像素、无装饰性图片；最大内容宽度 760px；总大小控制在 100 KB 内
 * （超过 Gmail 易截断）。
 */

export type BriefItem = {
  title: string;
  conclusion: string;
  summarySentences: string[];
  sourceName: string;
  sourceUrl: string | null;
  /** 补录条目需标注（PRD 6.3），不得写成当前窗口的新发布 */
  lateDiscovery?: { originWindow: string; publishedAt: string; firstSeenAt: string } | null;
  /** 实质更新的条目标「更新」（PRD 7.3） */
  isUpdate?: boolean;
  /** 其他渠道贡献（PRD 7.4） */
  otherSources?: string[];
};

export type AuditEntry = { title: string; url?: string | null; reason: string };

export type BriefData = {
  date: string;              // YYYY-MM-DD
  windowLabel: string;       // 早报 / 午报 / 晚报
  windowRange: string;       // 人读的窗口区间
  highlights: string[];      // 核心要点 5–8 条
  sections: Array<{ id: string; title: string; items: BriefItem[] }>;
  audit: {
    /** 强制保留候选未收录时必须逐条列出（PRD 9.3） */
    mandatoryMisses: AuditEntry[];
    /** 其余按类别计数 */
    counts: Array<{ label: string; count: number }>;
    /** 抓取失败与来源异常必须与「无更新」区分开 */
    sourceIssues: Array<{ source: string; status: string; detail: string }>;
  };
};

// ---------- 安全原语 ----------

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 只放行 https 链接，且经 URL 解析器重建。
 * javascript:、data:、http:、以及畸形 URL 一律返回 null。
 */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return u.toString();
}

// ---------- 配色（兼顾深色模式，不依赖颜色表达唯一含义） ----------
const C = {
  bg: '#f4f6f8', card: '#ffffff', border: '#dfe4ea',
  text: '#1f2933', muted: '#5b6875', link: '#1b5fa8',
  accent: '#e8eef5', auditBg: '#eceff2',
};

const wrap = (inner: string, title: string) => `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
<tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
 style="max-width:760px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:${C.text};font-size:15px;line-height:1.65;">
${inner}
</table></td></tr></table></body></html>`;

function renderItem(it: BriefItem): string {
  const url = safeUrl(it.sourceUrl);
  const badges: string[] = [];
  if (it.lateDiscovery)
    badges.push(`<span style="display:inline-block;padding:1px 7px;margin-right:6px;border:1px solid ${C.border};border-radius:3px;font-size:12px;color:${C.muted};">补录（RSS 延迟）</span>`);
  if (it.isUpdate)
    badges.push(`<span style="display:inline-block;padding:1px 7px;margin-right:6px;border:1px solid ${C.border};border-radius:3px;font-size:12px;color:${C.muted};">更新</span>`);

  const late = it.lateDiscovery
    ? `<div style="margin:6px 0 0;font-size:12px;color:${C.muted};">原发布 ${esc(it.lateDiscovery.publishedAt)}
       · 原窗口 ${esc(it.lateDiscovery.originWindow)} · 首次发现 ${esc(it.lateDiscovery.firstSeenAt)}</div>` : '';

  const others = it.otherSources?.length
    ? `<div style="margin:6px 0 0;font-size:12px;color:${C.muted};">其他渠道：${it.otherSources.map(esc).join(' · ')}</div>` : '';

  return `<tr><td style="padding:0 0 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
   style="background:${C.card};border:1px solid ${C.border};border-radius:6px;">
  <tr><td style="padding:14px 16px;">
    ${badges.join('')}
    <div style="font-size:16px;font-weight:600;line-height:1.45;">${esc(it.title)}</div>
    <div style="margin:8px 0 0;color:${C.text};">${esc(it.conclusion)}</div>
    <div style="margin:8px 0 0;color:${C.muted};">${it.summarySentences.map(esc).join(' ')}</div>
    ${late}${others}
    <div style="margin:10px 0 0;font-size:13px;">
      <span style="color:${C.muted};">${esc(it.sourceName)}</span>
      ${url ? ` · <a href="${esc(url)}" style="color:${C.link};text-decoration:underline;">查看来源</a>`
            : ` · <span style="color:${C.muted};">（原文链接不可用）</span>`}
    </div>
  </td></tr></table></td></tr>`;
}

export function renderHtml(d: BriefData): string {
  const subject = `十六源简报｜${d.date} ${d.windowLabel}`;
  const parts: string[] = [];

  parts.push(`<tr><td style="padding:4px 0 14px;">
    <div style="font-size:20px;font-weight:700;">十六源简报 · ${esc(d.windowLabel)}</div>
    <div style="margin:4px 0 0;font-size:13px;color:${C.muted};">${esc(d.date)} · 窗口 ${esc(d.windowRange)}</div>
  </td></tr>`);

  if (d.highlights.length) {
    parts.push(`<tr><td style="padding:0 0 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:${C.accent};border:1px solid ${C.border};border-radius:6px;">
      <tr><td style="padding:14px 16px;">
        <div style="font-size:14px;font-weight:600;margin:0 0 8px;">核心要点</div>
        <ul style="margin:0;padding-left:18px;">
          ${d.highlights.map(h => `<li style="margin:0 0 5px;">${esc(h)}</li>`).join('')}
        </ul>
      </td></tr></table></td></tr>`);
  }

  for (const s of d.sections) {
    if (!s.items.length) continue;
    parts.push(`<tr><td style="padding:6px 0 8px;">
      <div style="font-size:15px;font-weight:600;border-left:3px solid ${C.link};padding-left:8px;">${esc(s.title)}</div>
    </td></tr>`);
    parts.push(s.items.map(renderItem).join(''));
  }

  // 审计区：浅灰背景，保持可读而非隐藏（PRD 9.3）
  const a = d.audit;
  const issues = a.sourceIssues.map(i =>
    `<li style="margin:0 0 4px;">${esc(i.source)} — <strong>${esc(i.status)}</strong>：${esc(i.detail)}</li>`).join('');
  const misses = a.mandatoryMisses.map(m => {
    const u = safeUrl(m.url);
    return `<li style="margin:0 0 4px;">${esc(m.title)}${u ? ` · <a href="${esc(u)}" style="color:${C.link};">链接</a>` : ''} — ${esc(m.reason)}</li>`;
  }).join('');

  parts.push(`<tr><td style="padding:10px 0 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
     style="background:${C.auditBg};border:1px solid ${C.border};border-radius:6px;">
    <tr><td style="padding:14px 16px;font-size:13px;color:${C.text};">
      <div style="font-weight:600;margin:0 0 8px;">来源状态与过滤审计</div>
      ${a.counts.length ? `<div style="margin:0 0 8px;color:${C.muted};">${
        a.counts.map(c => `${esc(c.label)} ${c.count}`).join(' · ')}</div>` : ''}
      ${issues ? `<div style="margin:8px 0 4px;font-weight:600;">来源异常与抓取失败</div><ul style="margin:0;padding-left:18px;">${issues}</ul>` : ''}
      ${misses ? `<div style="margin:8px 0 4px;font-weight:600;">强制保留候选未收录</div><ul style="margin:0;padding-left:18px;">${misses}</ul>` : ''}
    </td></tr></table></td></tr>`);

  return wrap(parts.join('\n'), subject);
}

/** multipart/alternative 的纯文本备用正文（PRD 9.4）。 */
export function renderText(d: BriefData): string {
  const L: string[] = [];
  L.push(`十六源简报 · ${d.windowLabel}`);
  L.push(`${d.date} · 窗口 ${d.windowRange}`);
  L.push('');
  if (d.highlights.length) {
    L.push('【核心要点】');
    d.highlights.forEach((h, i) => L.push(`${i + 1}. ${h}`));
    L.push('');
  }
  for (const s of d.sections) {
    if (!s.items.length) continue;
    L.push(`【${s.title}】`);
    for (const it of s.items) {
      const tags = [it.lateDiscovery ? '[补录（RSS 延迟）]' : '', it.isUpdate ? '[更新]' : '']
        .filter(Boolean).join('');
      L.push(`${tags}${it.title}`);
      L.push(`  ${it.conclusion}`);
      L.push(`  ${it.summarySentences.join(' ')}`);
      if (it.lateDiscovery)
        L.push(`  原发布 ${it.lateDiscovery.publishedAt} · 原窗口 ${it.lateDiscovery.originWindow} · 首见 ${it.lateDiscovery.firstSeenAt}`);
      const u = safeUrl(it.sourceUrl);
      L.push(`  来源：${it.sourceName}${u ? ` ${u}` : '（原文链接不可用）'}`);
      L.push('');
    }
  }
  L.push('【来源状态与过滤审计】');
  if (d.audit.counts.length)
    L.push(d.audit.counts.map(c => `${c.label} ${c.count}`).join(' · '));
  for (const i of d.audit.sourceIssues) L.push(`- ${i.source} — ${i.status}：${i.detail}`);
  if (d.audit.mandatoryMisses.length) {
    L.push('强制保留候选未收录：');
    for (const m of d.audit.mandatoryMisses) {
      const u = safeUrl(m.url);
      L.push(`- ${m.title}${u ? ` ${u}` : ''} — ${m.reason}`);
    }
  }
  return L.join('\n');
}

export const subjectOf = (d: BriefData) => `十六源简报｜${d.date} ${d.windowLabel}`;

/** 渲染后的硬性校验（PRD 9.4 / 17.3）。任一项失败都不得发送。 */
export function checkEmail(html: string, text: string): string[] {
  const errs: string[] = [];
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > 100 * 1024) errs.push(`HTML ${Math.round(bytes / 1024)} KB 超过 100 KB 上限`);
  if (/<script/i.test(html)) errs.push('HTML 含 <script>');
  if (/<iframe/i.test(html)) errs.push('HTML 含 <iframe>');
  // 只在真实标签内部查事件处理器。被转义的正文里出现 "onerror=" 属于
  // 纯文本、无害，若在全文范围匹配会把安全内容误判为危险。
  for (const t of html.matchAll(/<[a-z][^>]*>/gi))
    if (/\son[a-z]+\s*=/i.test(t[0])) { errs.push('HTML 含事件处理器属性'); break; }
  if (/<link[^>]+stylesheet/i.test(html)) errs.push('HTML 含远程样式表');
  if (/@import|url\(\s*https?:/i.test(html)) errs.push('CSS 含远程资源引用');
  if (/<img/i.test(html)) errs.push('HTML 含图片（禁止装饰性图片与追踪像素）');
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const h = m[1] ?? '';
    if (!/^https:\/\//.test(h.replace(/&amp;/g, '&')))
      errs.push(`存在非 HTTPS 链接: ${h.slice(0, 60)}`);
  }
  if (!text.trim()) errs.push('纯文本备用正文为空');
  return errs;
}
