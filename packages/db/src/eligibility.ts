import { type DB, sha256 } from './index.ts';

/** Shared by candidate selection, AI stages, composition and deduplication. */
export function itemEligibleSql(item = 'f'): string {
  return `EXISTS (SELECT 1 FROM sources eligibility_source
    LEFT JOIN allnet_subscriptions eligibility_allnet ON eligibility_allnet.source_id=eligibility_source.id
    WHERE eligibility_source.id=${item}.source_id AND eligibility_source.enabled=1
      AND (eligibility_allnet.briefing_enabled_since IS NULL
        OR ${item}.first_seen_at>=eligibility_allnet.briefing_enabled_since))`;
}
export function candidateEligibleSql(candidate = 'c'): string {
  return `EXISTS (SELECT 1 FROM item_versions eligibility_version
    JOIN feed_items eligibility_item ON eligibility_item.id=eligibility_version.item_id
    WHERE eligibility_version.id=${candidate}.item_version_id AND ${itemEligibleSql('eligibility_item')})`;
}
/** Persisted with the immutable brief; detects changes during composition and retry waits. */
export function eligibilitySignature(db: DB, runId: number): string {
  return sha256(JSON.stringify(db.prepare(`SELECT DISTINCT s.id,s.enabled,a.briefing_enabled_since
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN feed_items f ON f.id=v.item_id JOIN sources s ON s.id=f.source_id
    LEFT JOIN allnet_subscriptions a ON a.source_id=s.id WHERE c.run_id=? ORDER BY s.id`).all(runId)));
}
export function assertEligibilityUnchanged(db: DB, runId: number, signature: string): void {
  if (eligibilitySignature(db, runId) !== signature) throw new Error('来源日报资格已变化，本轮已中止，请重新运行以生成最新内容');
}
