import { loadRules, re } from './rules.ts';

export type SignalMap = Record<string, boolean>;
export type SignalDetail = { signals: SignalMap; links: string[]; repos: string[]; officialLinks: string[] };

const URL_RE = /https?:\/\/[^\s<>"')\]，。；]+/g;

const hostOf = (u: string): string => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const matchHost = (h: string, list: string[]) =>
  list.some(x => h === x || h.endsWith('.' + x));

/** 把 official_domains 的分组结构拍平。 */
let _official: string[] | null = null;
function officialDomains(): string[] {
  if (_official) return _official;
  const flat = (o: unknown): string[] =>
    Array.isArray(o) ? o.flatMap(flat)
      : (o && typeof o === 'object') ? Object.values(o).flatMap(flat)
      : typeof o === 'string' ? [o] : [];
  _official = flat(loadRules().official_domains);
  return _official;
}

/**
 * 抽取 13 个确定性信号（rules.yaml signals）。
 * 这些结果既用于 A–D 预判，也作为紧凑事实传给 Luna
 * —— PRD 15.2「已抽取代码仓库/步骤/官方链接」，模型不必自己找。
 */
export function extractSignals(text: string, html: string, sourceHost = ''): SignalDetail {
  const S = loadRules().signals;
  const both = `${html}\n${text}`;
  const links = [...new Set([...both.matchAll(URL_RE)].map(m => m[0].replace(/[.,;:]+$/, '')))];
  const hosts = links.map(hostOf);
  const OFF = officialDomains();

  const repos = links.filter(u => matchHost(hostOf(u), S.repo_url.url_host_any));
  const officialLinks = links.filter(u => matchHost(hostOf(u), OFF));

  const anyRegex = (d: any): boolean => {
    if (d?.regex) return re(d).test(text);
    if (d?.any_of) return d.any_of.some((r: any) => r.regex && re(r).test(text));
    return false;
  };

  const signals: SignalMap = {
    repo_url: repos.length > 0,
    demo_link: links.some(u =>
      matchHost(hostOf(u), S.demo_link.url_host_any) ||
      (S.demo_link.or_path_regex && new RegExp(S.demo_link.or_path_regex).test(u))),
    official_link: officialLinks.length > 0,
    external_link: links.filter(u => !sourceHost || hostOf(u) !== sourceHost).length >= (S.external_link.min_count ?? 1),
    code_block: anyRegex(S.code_block),
    command_line: anyRegex(S.command_line),
    config_block: anyRegex(S.config_block),
    install_hint: anyRegex(S.install_hint),
    policy_mention: anyRegex(S.policy_mention),
    price_mention: anyRegex(S.price_mention),
    invite_code: anyRegex(S.invite_code),
    step_markers: (() => {
      const n = S.step_markers.min_count ?? 1;
      return S.step_markers.any_of.some((r: any) =>
        (text.match(re(r, 'g')) ?? []).length >= n);
    })(),
    aff_link: (() => {
      const d = S.aff_link;
      const hostList = d.any_of.find((x: any) => x.url_host_any)?.url_host_any ?? [];
      if (links.some(u => matchHost(hostOf(u), hostList))) return true;
      const params: string[] = d.any_of.find((x: any) => x.url_query_param_any)?.url_query_param_any ?? [];
      if (links.some(u => { try { const q = new URL(u).searchParams; return params.some(p => q.has(p)); } catch { return false; } }))
        return true;
      const rx = d.any_of.find((x: any) => x.regex);
      return rx ? re(rx).test(text) : false;
    })(),
  };
  void hosts;
  return { signals, links, repos, officialLinks };
}

/**
 * 强制保留 A–D 程序预判（rules.yaml mandatory_retention.classes）。
 * 只判断「有没有硬证据」；「是不是那个类别」交给 AI 语义确认。
 */
export function prescreenMandatory(s: SignalMap): string[] {
  const hit: string[] = [];
  if (s.repo_url || s.demo_link || (s.code_block && s.install_hint)) hit.push('A');
  if (s.code_block || s.command_line || s.config_block || (s.step_markers && s.external_link)) hit.push('B');
  if (s.official_link && (s.price_mention || s.policy_mention)) hit.push('C');
  if (s.step_markers && s.external_link && !s.aff_link && !s.invite_code) hit.push('D');
  return hit;
}

/** 全文抓取门（rules.yaml source_specific.forum_fulltext.fetch_gate）。 */
export function needsFulltext(
  sourceId: string, title: string, excerpt: string, isExcerpt: boolean, s: SignalMap,
): { need: boolean; reason: string } {
  const cfg = loadRules().source_specific?.forum_fulltext;
  if (!cfg?.applies_to_sources?.includes(sourceId)) return { need: false, reason: 'not_applicable' };

  const hints: string[] = cfg.hint_keywords ?? [];
  const hay = `${title}\n${excerpt}`;
  const hitHint = hints.find(k => hay.includes(k));
  if (hitHint) return { need: true, reason: `hint:${hitHint}` };

  // 摘要里已经露出任一信号 → 全文大概率有更多证据
  if (isExcerpt && Object.values(s).some(Boolean))
    return { need: true, reason: 'excerpt_truncated_and_any_signal' };

  return { need: false, reason: 'no_gate_hit' };
}
