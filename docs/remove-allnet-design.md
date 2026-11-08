# 删除「全网热点」功能与数据 设计（第 2 版，已按 2026-11-08 设计审查修订）

用户 2026-11-08 决定：全网热点的代码和数据全部删除（删除前备份，删除后不可恢复，除非从备份还原）。

## 1. 现状（生产只读盘点）

- 8 个订阅（知乎热搜、微博热搜、美团社区、天涯海外版、美卡论坛、奶昔论坛、NodeSeek、NodeLoc），`sources.enabled=0`（不参与日报），但 `allnet_subscriptions.collection_enabled=1`，仍在采集并消耗 API 调用。
- 数据：feed_items 41,549 条、item_versions 41,658 条、fetch_attempts 9,764 条、raw_snapshots 399 行（及对应快照文件）、allnet_usage 104 行；candidates / cluster_members 引用 0 条。
- 外键：feed_items→sources（NO ACTION）、item_versions→feed_items（CASCADE）、candidates→item_versions（NO ACTION）、cluster_members / story_clusters→item_versions（NO ACTION）、appendix_seen→item_versions（CASCADE）、fetch_attempts / raw_snapshots→sources（NO ACTION）、source_endpoints / source_observation_metrics / allnet_subscriptions→sources（CASCADE）、source_onboarding_proposals→sources（SET NULL）。
- 代码引用：采集（harvest.ts 的 allnet 模式、connectors/allnet.ts）、后台「全网热点」页与路由、来源页的开关与令牌、设置页 ALLNET_API_KEY、独立 RSS 路由 /rss/allnet、共用的条目资格 SQL（eligibility.ts）与查询（queries.ts）、actions.ts、scripts/setup-allnet.ts、3 个测试文件、README。

## 2. 方案

**代码**：删除上述全部全网热点代码与测试；eligibility / queries 去掉对 allnet_subscriptions 的引用（其余来源的资格判断不变）；SECRET_NAMES 去掉 ALLNET_API_KEY；README 删除相关章节。

**数据（迁移 018_remove_allnet.sql，只追加）**：在一个事务里按外键顺序删除：
1. 记下目标来源：`SELECT source_id FROM allnet_subscriptions`（若表不存在则迁移只做 DROP IF EXISTS，保证首次安装可执行）。
2. 删除引用这些条目版本的 candidates（及级联 evaluations）、cluster_members、置空 story_clusters.best_origin_item_version_id（当前均为 0 条，防御性处理）。
3. 删除 feed_items（级联 item_versions、appendix_seen）、fetch_attempts、raw_snapshots 行。
4. 删除 sources 行（级联 source_endpoints、source_observation_metrics、allnet_subscriptions；proposals 置空）。
5. `DROP TABLE IF EXISTS` allnet_subscriptions、allnet_usage、allnet_lock、allnet_cache。
- 迁移 010/011/013 保留不改（只追加原则）；全新安装会先建表再由 018 删除，结果一致。
- 已发布日报（briefs.digest_json / html）中出现过的全网热点内容不改（日报是不可变记录）。
- 快照文件：DB 行删除后，磁盘上的快照文件由 brief-maintain 现有的过期清理自然删除（不在迁移里删文件）。
- 保管库中的 ALLNET_API_KEY：部署后在后台清除（或用脚本删除该键），不写进迁移。

**与语义去重分支的关系**：该分支已占用迁移号 018，合并时改为 019。

## 3. 部署顺序（需用户确认后执行）

1. 停 brief-harvest.timer、brief-run.timer（避免采集或日报在迁移与代码切换之间运行）；确认没有运行中的任务。
2. 备份 brief.db（`.backup` + `integrity_check`）与 secrets.enc。
3. 快进合并代码，运行迁移（`npm run migrate`），核对：allnet 表不存在、目标来源与条目计数为 0、`PRAGMA foreign_key_check` 为空、`integrity_check` 为 ok。
4. 重启 brief-web，恢复两个定时器；检查后台页面、日报 RSS、采集一轮正常。
5. 清除保管库中的 ALLNET_API_KEY。
6. 删除的空间不会自动归还文件系统；是否 VACUUM（需短暂停写）另行决定。

## 4. 失败与回滚

- 迁移在单个事务中执行，失败整体回滚，代码未切换前不重启服务。
- 迁移成功但新代码异常：从第 2 步的备份还原 brief.db 并回退代码到上一提交。

## 5. 测试

- 迁移：在含全网热点数据的库（由 010/011/013 + 插入样本构造）上执行 018 后，相关行与表全部消失、其他来源数据不变、foreign_key_check 为空；空库全量迁移可执行；重复执行无副作用（迁移记录保证只跑一次）。
- 回归：全部现有测试（去掉 3 个全网热点测试）、类型检查；后台页面不再出现全网热点入口；/rss/allnet/* 返回 404。


## 6. 第 2 版修订（按设计审查，必须在实现中落实）

**改为两阶段上线**
- 阶段一（代码）：上线不再读写 allnet 表的新代码，表与数据原样保留；确认其他来源采集、日报、RSS、后台一切正常。
- 阶段二（数据，维护窗口）：执行删除迁移与快照文件清理。两阶段之间可以随时回退代码而不涉及数据。

**维护窗口（阶段二）**：暂停 brief-harvest / brief-fulltext / brief-run / brief-maintain 的 timer，等运行中的任务结束；停止 brief-web 与其他写主库的服务；确认没有待执行的重试与后台重跑请求（REQUEST_DIR 为空）。迁移命令显式加载生产环境（systemd-run + EnvironmentFile，以 brief 身份），并先打印核对 DATABASE_PATH。验收通过后才恢复调度。

**回滚窗口**：整库还原只允许在恢复写入、发布、发送之前；窗口内数据库与旧代码成对还原，连同 WAL 一起处理。恢复写入后只做前向修复。备份内容：brief.db（.backup + integrity_check + 能打开）、secrets.enc（核对能用现主密钥解密）、待删快照文件清单与文件本身、部署前的代码提交号。

**快照文件**：删除 fetch_attempts（会级联删除 raw_snapshots）之前，导出目标来源的 storage_path 清单并备份文件；事务提交后按清单清理，清理前核对没有剩余 raw_snapshots 行仍引用同一路径（文件名按内容哈希生成，可能与其他来源共用）。清理脚本可重复执行。

**资格 SQL 必须保持原样**（packages/db/src/eligibility.ts、queries.ts）
- 去掉 allnet_subscriptions 的 JOIN，但 eligibilitySignature 保留 `NULL AS briefing_enabled_since`、原字段顺序、来源排序与哈希方式，普通来源的历史签名不变（旧版简报复用与投递重试依赖它）。不改写 briefs.eligibility_signature。
- itemEligibleSql 保留「来源存在且 enabled=1」；candidateEligibleSql 保留版本→条目→来源检查。
- 重复 URL 子查询继续应用资格过滤。
- 两处 allnet 专属时间 CASE 删除后直接比较 published_at（不得改成 coalesce(published_at, first_seen_at)，否则缺发布时间的普通 RSS 条目会新增入选）。
- 补录查询只移除 allnet 启用时间限制，保留成功抓取证明、已发送排除与窗口边界。
- 新版日报 build.ts 的独立时间筛选不动。
- 从 tests/allnet-controls.test.ts 迁出并保留：普通来源去重、候选资格、发送重试期间停用来源的回归测试；再删除 3 个全网热点专属测试文件。

**删除范围逐项声明**
- 删除：8 个来源及其 feed_items / item_versions / appendix_seen、fetch_attempts / raw_snapshots（含文件）、source_endpoints / source_observation_metrics、allnet_subscriptions / allnet_usage / allnet_lock / allnet_cache；指向这些来源的 source_onboarding_proposals 与 source_tests（实施时按来源 ID 与 URL 精确统计后列给用户）。
- 保留：audit_events（审计记录）、briefs 与 deliveries（不可变日报与投递记录）、usage_ledger（费用账本）。
- 迁移以临时表固定目标来源 ID 与版本 ID；不按 URL、域名、分组、run 或 cluster 扩大范围。迁移开头断言 candidates / cluster_members / story_clusters 引用为 0，不为 0 则中止（RAISE），转人工审查。
- 迁移不写条件分支：首次安装时 010/011/013 已建表，018 正常执行；「记录已应用但表缺失」视为异常并中止。SQL 文件内不写 BEGIN/COMMIT（迁移器已包事务）。最终迁移号在合并时确定（语义去重分支已占 018）。

**密钥与其他代码清单**
- 在备份之后、上线阶段一代码之前，用一次性脚本清除保管库中的 ALLNET_API_KEY（阶段一上线后后台不再接受这个键名），并核对生产环境变量里有没有覆盖值。
- 代码清单补充：SecretName 类型、/feeds 中的全网热点订阅、/sources/allnet/* 旧别名路由、来源页启停 / 删除操作里的 allnet SQL（actions.ts）、package.json 中的 3 个测试命令、今日页 `allnet_json` 过滤。

**验收**：完整迁移链（001 起）在含混合来源样本的库上执行；比较普通来源的行内容、资格签名、历史日报与投递记录前后一致；foreign_key_check 为空；/rss/allnet/* 返回 404；后台无全网热点入口。
