# 错误信息卫生 + Telegram 完整性 设计（第 3 版 · 定稿）

用户 2026-11-09 决定另立任务处理两个「严重 × 现实」的原有问题；2026-11-10 的取舍（不推翻）：
1. 要点有群组分块失败时：照常发布，在**结尾说明哪些群组没有正常汇总**（不做自动补全）。
2. 已有的错误记录：**清理成只留错误类型**（清理前完整备份）。
3. 失败的图片：**保留 7 天，模型恢复正常后在后台自动重试**。

**第 3 版为什么简化**：前两轮审查里，「按时间边界清理」与「图片按轮次重试」这两类问题连续两轮在补丁后冒出新边缘情况，按开发流程第 4 条回到设计层面：清理改为一次性全量改写（不再判断新旧）；图片保留改为固定间隔重试到满 7 天（不再分轮次、不再有本轮计数）；图片识别加跨进程租约；「未正常汇总」的范围就是本期实际参与生成的群。

## A. 错误信息卫生（问题 1）

### A1 源头：错误对象只携带受控字段
`ProviderError` 增加 `code?: string`。message 只由**我们写死的文案 + 白名单字段 + 校验过的数字**构成：
- **上游错误码白名单**：OpenAI 类 `rate_limit_exceeded / insufficient_quota / invalid_api_key / model_not_found / context_length_exceeded / invalid_request_error / server_error / content_filter`；Anthropic `invalid_request_error / authentication_error / permission_error / not_found_error / request_too_large / rate_limit_error / api_error / overloaded_error`；Gemini `INVALID_ARGUMENT / FAILED_PRECONDITION / PERMISSION_DENIED / NOT_FOUND / RESOURCE_EXHAUSTED / INTERNAL / UNAVAILABLE / DEADLINE_EXCEEDED`；其余记 `other`。
- **网络错误**：`网络错误（<code>）`，code 只取白名单 `ECONNRESET / ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EAI_AGAIN / EPIPE / EHOSTUNREACH / ENETUNREACH / UND_ERR_*`（固定前缀 + 大写字母数字），否则写 `other`。不使用 `e.name` 与原始 message。
- **计数字段**只接受有限整数，否则写「?」；**非 JSON 输出**写 `响应不是合法 JSON（N 字）`；**拒答**只写「模型拒答」。
- **Retry-After**：三家适配器都在丢弃正文前解析：响应头有效优先，头缺失或无效时按原正则从正文取；Gemini 429 也传响应头。`retry.ts` 只看 `retryAfterSec`。
- **Schema 错误**：枚举值、额外字段名、复核里的未知 `candidate_id` 只给位置和数量。
- `registry.ts` 的「未知供应商」不再拼配置值。
- **拒答不重试**：Anthropic / Gemini 的拒答错误也打上 `contentFiltered` 标记（与 OpenAI 兼容的过滤一致），Telegram 总结与要点不再反复请求明确拒答的内容。
- 依赖文本的现有判断都用我们自己的文案（`图片识别结构无效`、`截止`），不受影响；截断看 `kind`、过滤看标记。
- 旧配置路径的 Anthropic 客户端固定 `logLevel: 'warn'`。

### A2 输出出口 `errorText(e)`
`packages/ai/src/errors.ts`：`ProviderError` → `${kind}${ HTTP status}${ code}：${message}`；带 `publicMessage`（只由我们写死的文案设置）→ 它；其他一切 → 受控类名（`TypeError / RangeError / SyntaxError / Error`，其余记 `Error`），**不输出 message**。只用于输出，判断仍用原错误对象。

接入点（实施时 grep 全量列出并逐一测试）：Telegram 总结、要点、图片识别的落库与日志；`daily.ts` 分块与分类合并失败日志（分类名来自模型，日志改用序号）；triage / review / compose 的 `lastErr`；`digest/ai.ts` 六处；`fact-trace`；`semantic-dedup`；来源画像的提案错误与审计；`brief.ts` / `run.ts` 写 `runs.error` 处。Python 采集器历史回填日志不再打印 `reference`（私群邀请链接含令牌），改为来源 ID。

### A3 一次性清理已有记录（用户决定）
`scripts/scrub-error-text.mjs`，默认只统计，`--apply` 才写。**不判断新旧：把范围内所有还没清理过的值改写一次**；以 `[已清理]` 开头的跳过（因此可重复执行，第二次 0 行）。新代码写的值本来就只有类型与固定文案，被改写只损失固定文案，可以接受。
- 范围（按代码实际落库位置）：
  - Telegram 库：`telegram_summary_jobs.error`、`telegram_digests.error`、`telegram_media_tasks.error_message`（排除 `error_type` 为采集器自己的类型：`download_error / too_large / media_removed / message_deleted`）。
  - 日报库：`evaluations.result_json` 的 `$.error`、`runs.error`、`source_onboarding_proposals.error`（**只限 `status='AI_ANALYSIS_FAILED'`**，人工拒绝理由不动）、`audit_events.payload_json` 顶层 `$.error` 为字符串的行（实施时列出全部 action 名）。
- 改写为 `[已清理] ${类型}${ HTTP 状态}`：类型取同行 `error_type`，或原文开头匹配固定的错误类型名单（`rate_limited / auth / timeout / bad_request / server / network / truncated / refusal`），状态取原文 `HTTP (\d{3})`；都没有就只写 `[已清理]`。JSON 用 `json_set` 只改 error 键。
- 执行约束：以 systemd `EnvironmentFile` 加载生产环境；库路径必须是绝对路径且文件已存在；执行前 SQLite 在线备份（含 WAL 已提交内容）到私有目录（0700/0600）并 `integrity_check`；每张表一个事务；只输出每列改写行数。
- 时机：新代码上线、所有进程重启之后执行（之后再也不会写入旧格式）；即使有并发写入的新值被改写，也只是损失固定文案。
- **隐私边界**：只覆盖两个在用的库。清理前备份、此前的本机与 Google Drive 每日备份、journald 仍有旧内容；SQL 改写不擦除 WAL 与空闲页里的旧字节。清理前备份由用户决定保留期限（交接文档列为待办，默认观察 30 天后删除）。抓取模块（`harvest` / `fulltext`）的错误不在本次范围（来自网页抓取；curl 失败时错误里可能含订阅网址，列为残余风险）。

## B. Telegram 完整性（问题 2）

### B1 要点结尾说明未正常汇总的群组
- **范围 = 本期实际参与生成的群**：与 `loadWindowMessages` 相同的来源集合（启用、正常的群）。用户主动停用的群不在范围内，不算「未正常」。
- **一致快照**：消息、来源集合、各来源的 `telegram_sync_progress.covered_until` 在**同一个只读事务**里读取。
- **原因**：`issues: Array<{ sourceId, group, reasons: Reason[] }>`，同一来源可有多个原因。Reason：
  - `collection_incomplete`：`covered_until` 为 NULL 或早于窗口结束（本期可能缺消息）；
  - `generation_failed`（整群所有分块失败）/ `partial_failed`（部分分块失败）；
  - `filtered` / `partial_filtered`（被模型过滤或拒答）。
- **文案**：一句，放在所有内容之后：「本期以下群组未正常汇总：A（生成失败）；B（部分内容被模型过滤）；C（消息采集未完成，可能缺少部分消息）」。存入 `notes`（兼容现有出口）与结构化 `issues`。
- **所有出口都放在最后、分类为空时也显示**：邮件 HTML、纯文本、日报 RSS、Telegram RSS、后台；`digestHtml` 的「涉及群组」挪到说明之前。
- **兜底**：
  - 全部群提取失败（`composeDaily` 抛出，错误带 `issues`）→ 3 次后拼接兜底，说明用真实原因；
  - 生成前失败（创建供应商失败等，没有 issues）→ 3 次后兜底，范围内所有群记 `generation_failed`。
- **不在本次范围**：所有来源都停采、没有任何单群总结的时段不会生成要点（日报显示「Telegram 要点生成中」，这是现有的未就绪提示）；已完成的要点不会因补采重建；后来识别成功的图片只进入之后首次生成、且包含该消息的窗口。

### B2 失败图片保留 7 天、定时自动重试
**Telegram 迁移**（每个文件一条 ALTER）：`008 held_until TEXT`、`009 held_next_at TEXT`、`010 held_fingerprint TEXT`、`011 telegram_settings.vision_lease_until TEXT`。
**Python 迁移改为原子**：执行器改为 `executescript("BEGIN;" + sql + "; INSERT INTO telegram_schema_migrations ...; COMMIT;")`（SQLite 的 ALTER 可在事务内），中断时整体回滚。部署时 Node 端先统一执行迁移，再重启采集器与其他进程。

**跨进程租约**：每次图片识别运行开始 `UPDATE telegram_settings SET vision_lease_until=now+150s WHERE vision_lease_until IS NULL OR vision_lease_until<now`，影响 0 行就退出（另一个进程在跑）；运行结束清空。150 秒 > 服务超时 120 秒，被杀的进程租约自然过期。孤儿恢复、清理、领取都只在持有租约时执行。

**保留状态**：`held_until IS NOT NULL AND temp_state='ready'`。
- **进入保留**（`status='failed'`、不删文件）：非鉴权的不可重试错误；首次生命周期里的临时故障用完现有 3 次重试（`RETRY_MINUTES` 不变）；本地读文件的非 ENOENT 错误按临时故障处理；被杀的任务（见下）。首次进入设 `held_until = now + 7 天`（不顺延）；每次进入设 `held_next_at = now + 12 小时`、`held_fingerprint = 当前配置指纹`。
- **不保留、直接终态并删除**：图片本身无效（大小为 0 或超过 10 MB）；文件已不存在（ENOENT）；所属消息被删除 / 媒体被替换（Python 处理，与现在一致）。
- **定时重试**：`held_next_at <= now`，或当前配置指纹 ≠ `held_fingerprint`（管理员改了模型或密钥）→ 放回 `status='retry'`、`next_attempt_at=now`。保留中的重试**只请求一次**：成功即完成；任何失败都回到保留（`held_next_at = now + 12 小时`）。到 `held_until` 为止，最多约 14 次。
- **到期**：`held_until` 到达 → 终态并删除文件。
- **容量安全阀**：保留中文件总大小超过 1 GB 时从最早的开始删除（磁盘写满会危及数据库）。这是对「保留 7 天」的唯一例外，后台显示被提前删除的数量。
- **执行顺序**：入口拿到租约后，先做孤儿恢复与到期 / 容量清理，再判断配置错误与暂停（清理不受这两者影响）。
- **鉴权失败**：现有的整队暂停不变（图片保持 pending、文件保留）。
- **领取与派发前确认**：领取 `UPDATE ... SET status='running' WHERE id=? AND status IN ('pending','retry') AND superseded_at IS NULL`；创建供应商之后、发出请求之前，再用条件更新写 `first_requested_at`（`WHERE status='running' AND superseded_at IS NULL`），影响 0 行就放弃本次请求。
- **所有状态转换先提交、再动文件**：成功、失败、保留、终态、到期的 UPDATE 都带 `status='running'`（或清理时的期望状态）与 `superseded_at IS NULL`；只有影响 1 行时才删文件或改全局暂停。成功路径：先写结果与 `temp_state='deleted'`，再在单独的 try 里删文件（失败交给孤儿扫描，不进入失败处理）。
- **被杀的任务**：孤儿恢复（持租约）发现遗留的 `running` → 按一次 `timeout` 失败走同一个失败处理（计入 attempts、首次生命周期内按退避重试、用完进入保留；保留中被杀则回到保留）。不会无限循环。
- **不再叠加进程内重试**：图片识别的供应商用 `{ retry: false }`；任务退避取 `max(RETRY_MINUTES[i], retryAfterSec)`。
- **每日额度**：额度用完时只领取 `first_requested_at` 非空的任务；新图片顺延。
- 来源停用后的图片：沿用现有行为（已下载的照常识别；保留中的照常重试到期）。
- 后台图片识别区显示保留中数量与提前删除数量（只读）。

## 顺带修复（便宜）
- `fact-trace` 的 SSRF：重定向改为手动逐跳（最多 5 跳），每跳都用现有 `checkUrlSafe` 校验。这是可被主动触发的安全问题（控制公开网址的一方返回到内网的重定向），修复只需几十行。

## 不处理（记录在案）

| 问题 | 归类 | 理由 |
|---|---|---|
| OpenAI 兼容「HTTP 200 但无 choices」视为内容过滤 | 中等 × 现实 | 针对实际出现过的刷屏过滤；改成重试会反复请求真正被过滤的内容 |
| `insufficient_quota` 与普通限流同为 rate_limited | 中等 × 现实 | 只多花几次失败请求；另立任务 |
| Gemini / Anthropic：输出上限未统一映射 truncated、Gemini 读正文不受超时保护、Anthropic 旧配置未用 timeoutMs | 中等 × 现实（选用这两类时；Telegram 总结可选） | 生产不用；另立任务 |
| Python 慢下载重新领取时旧下载覆盖新路径 | 中等 × 现实 | 采集器竞态，另立任务 |
| 消息时间精度（Python 六位小数 / Node 三位）导致边界消息错分窗口 | 中等 × 现实 | 原有问题，另立任务 |
| 要点调度在单群总结之后串行执行，供应商持续超时时兜底可能延后 | 中等 × 现实 | 原有调度问题，另立任务 |
| 全部来源停采时不生成要点 | 轻微 × 现实 | 日报显示「生成中」作为提示 |
| 鉴权暂停期间新下载的图片不受容量阀约束 | 轻微 × 巧合 | 暂停有首页告警，管理员会处理 |
| 抓取模块错误可能含订阅网址 | 中等 × 巧合 | 来自 curl 无 stderr 的少见路径；另立任务 |

## 自查清单
1. **泄露**：源头只放白名单字段；出口不输出未知错误的 message；清理脚本不输出原值；残留位置写明。
2. **失败分类**：重试 / 终态判断基本不变；拒答不再重试；图片临时故障与不可重试错误都不立即删除。
3. **重复执行**：清理脚本以 `[已清理]` 前缀幂等；图片放回带条件更新、租约下单进程执行。
4. **并发**：图片识别跨进程租约；所有图片状态回写带期望状态与 `superseded_at IS NULL`；文件操作在提交成功之后。
5. **执行时前提**：领取与派发前各确认一次；清理在配置 / 暂停判断之前。
6. **崩溃**：成功路径先提交后删文件；被杀任务走正常失败处理；Python 迁移原子化；租约过期自动释放。
7. **冒用 / 隔离**：无新增写接口；fact-trace 逐跳校验重定向。
8. **部署**：Node 端先执行迁移 008–011，再重启所有进程；清理脚本在新代码上线后以生产环境、绝对路径、在线备份后执行。

## 测试
- 适配器 / Schema / registry：正文、非白名单码、字符串计数、拒答说明、SDK 错误、网络错误名与码 → 输出不含标记；白名单码与 `retryAfterSec`（头有效 / 无效回退正文 / 无头）；拒答带 `contentFiltered`。
- `errorText`：各类错误；未知错误只有类名。
- 接入点：Telegram 三类、triage / review / compose、digest/ai、来源画像落库后不含标记。
- 清理脚本：dry-run 不写；改写范围内所有未清理值；人工拒绝理由与采集器错误不动；JSON 只改 error 键；第二次 0 行；输出不含原值；路径不存在拒绝；Python 迁移执行器中断后可重跑。
- B1：一致快照；覆盖水位 NULL / 落后；部分失败、整群失败、过滤、拒答；同一群多个原因；兜底两种；所有出口末尾、空分类显示。
- B2：租约互斥（第二个进程退出）；进入保留不删文件；12 小时放回、配置变化立即放回；保留重试失败回到保留；到期删除；1 GB 安全阀；无效图片与 ENOENT 直接删除；条件回写（Python 期间标 skipped 后 Node 不覆盖、不删文件）；派发前确认；成功路径顺序与删除失败隔离；被杀任务进入正常失败处理；`retry:false` 与 retryAfter 退避；额度用完只领已请求的任务；清理先于配置与暂停判断。
- fact-trace：重定向到内网被拒、多跳上限。

## 第 3 轮设计审查后的定稿修改

第 3 轮确认 A3 全量清理、B1 范围与一致快照无问题；以下具体缺口按此定稿，不再送设计审查（本项改动已用 3 轮，剩 2 轮给代码审查）。

**A**
- 网络错误码改为封闭名单（`UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT / UND_ERR_SOCKET / UND_ERR_CLOSED / UND_ERR_ABORTED` 及上面列出的系统码），其余 `other`。
- `daily.ts` 的成功进度日志也不打印分类名（用序号）。预览入口（`preview.ts`、`telegram-daily-preview.ts`）本身输出生成内容，属手动工具的隐私边界，不改。
- 拒答识别补齐：OpenAI 兼容 `choices[0].message.refusal` 非空；Gemini `promptFeedback.blockReason` 存在，或 `finishReason ∈ SAFETY / PROHIBITED_CONTENT / BLOCKLIST / SPII / RECITATION / IMAGE_SAFETY`；Anthropic `stop_reason='refusal'`。都抛 `refusal` 并带 `contentFiltered`。
- 范围外的错误出口补登记：后台来源测试 `source_tests.error`、邮件投递错误（SMTP / Gmail 响应）。

**B1**
- 全部群都被过滤 / 拒答时，直接带说明完成，不进入 3 次重试。
- 拼接兜底的输入、`source_ids`、说明都限定在本期参与生成的群（停用群的旧总结不进入兜底）。
- 本地配置预检失败（全局模型配置错误）：继续等待、不计次数、不兜底（首页已有红色告警）。

**B2**
- **租约有归属**：迁移追加 `telegram_settings.vision_lease_owner`、`telegram_media_tasks.claim_token`。取得租约时写随机 owner；领取任务时写 `claim_token = owner`；派发前确认、所有结果回写都带 `claim_token = owner`；释放租约 `WHERE vision_lease_owner = owner`。旧进程恢复后无法覆盖新进程的任务或释放新租约。
- **派发前确认**还要求 `held_until IS NULL OR held_until > now`。
- **保留指纹**记录失败请求实际使用的配置指纹（不是失败时的当前配置）。
- **保留阶段的等待** = `max(12 小时, retryAfterSec)`。
- **消息清理协调**：维护任务删除过期原消息时跳过「有保留中图片（`held_until > now`）」的消息，保证 7 天；生产为永久保留消息，不受影响。
- **磁盘硬上限**：按图片目录的**实际文件**统计（不依赖数据库状态，删除失败的文件也计入）。超过 1 GB 时：先删保留中最早的；仍超过时把最早的待识别图片标为 `skipped`（`error_type='disk_full'`）并删除。首页显示「图片目录接近上限」。
- 保留中的重试次数：配置稳定时约 14 次；配置变化会立即放回，因此可能更多（不设轮次上限，到期为止）。
- `attempts` 包含鉴权失败：解除鉴权暂停后，首次阶段可用的临时重试可能变少（之后进入保留仍会定时重试），接受。
- 模型请求仍是「至少一次」：请求已被处理、结果未提交时崩溃，恢复后会再请求一次（接受）。

**迁移**
- Node `migrateTelegram`：在 `BEGIN IMMEDIATE` 之后**重新检查**迁移登记，已应用则跳过（防并发重复 ALTER）。
- Python 执行器：`BEGIN IMMEDIATE` → 重新检查登记 → 用 `sqlite3.complete_statement` 逐条执行（兼容含触发器的旧迁移）→ 登记 → `COMMIT`；异常时 `ROLLBACK` 后再抛出。

**fact-trace**
- 逐跳校验之外：整次操作一个截止时间（不每跳重置）、响应体上限、中间响应体读取前关闭。DNS 校验与实际连接之间的变化（DNS rebinding）不在本次解决，登记为残余风险。

**不处理表补充 / 调整**
- 「全部来源停采或没有任何成功单群总结时不生成要点」调整为 **中等 × 现实**，另立任务（需要独立于总结的窗口枚举）。
- Telegram 总结对鉴权、模型不存在等错误仍按退避重试（中转网关曾出现短时鉴权失败，现有设计有意如此），中等 × 现实，保留。
- 单群总结被杀后停在 `running`、总结 / 要点两个实例重叠时的覆盖：原有问题，中等 × 现实，另立任务。
- 鉴权暂停 / 普通积压的磁盘占用：**已由磁盘硬上限覆盖**，从不处理表移除。
- 抓取错误含订阅网址、后台来源测试、邮件投递错误：中等 × 现实（条件性），另立任务。
