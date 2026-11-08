# 全局模型供应商 设计（第 3 版 · 定稿）

用户 2026-11-08 决定：在设置里把「模型供应商」作为配置项；所有需要调用模型的地方只选「供应商 + 模型」，不再各自填供应商、地址和密钥；模型列表通过供应商的 `/models` 接口自动拉取，也可手动补充；Telegram 总结与图片识别默认跟随 L1。

## 第 3 版为什么重做

前两轮设计审查的严重问题集中在两类，且第 2 版的补丁又引出新的边缘情况（按开发流程第 4 条，应回到设计层面）：

1. **把结构化配置存进加密保管库文件**：带来并发写（还有 `scripts/migrate-telegram.mjs` 这个既有写入方）、临时文件与 fsync、文件丢失与「从未建立」无法区分、结构版本、备份另加入口、审计与配置不在同一次提交等一串问题。
2. **每个使用方单独决定「走新分配还是走旧配置」**：带来 follow 指向旧配置、旧配置与新约束谁优先、快照里要冻结旧解析逻辑、后台与 worker 看到的旧配置不一致等问题。

第 3 版的两个根本改变：

- **供应商与分配存进 brief.db**（SQLite 事务、外键、迁移、现有备份全部现成）；密钥用 `APP_ENCRYPTION_KEY` 逐条 AES-GCM 加密后存同一行。**不再写保管库文件**，保管库现有用途（Telegram API ID 等）不变。
- **整体一次切换**：库里有一个开关。关着 = 全部使用方走今天的代码，零变化；导入成功时在同一事务里打开 = 全部使用方只从库里解析，**不再读任何旧配置**（env 的 `AI_*`、`telegram_settings` 的模型列、保管库的模型设置）。没有逐使用方混用。

## 0. 前提与范围

- 单管理员（共享登录 + 只读演示模式），审计主体 `owner`，不提供多用户隔离。
- 模型调用保持「至少一次」语义：超时后重试可能重复计费，不变。
- **上游返回的失败（密钥失效、模型不存在、拒答、限流、部分分块失败）怎样处理，本次不改**：今天填错 env 里的密钥会发生什么，切换后填错后台的密钥就发生同样的事。本次只保证「本地就能判定的配置错误」（开关打开但供应商缺失、密钥无法解密、能力不符）不消耗重试、不产生终态。
- 威胁模型：只有已登录管理员能设置供应商地址与密钥；后台只监听 `127.0.0.1`，经本机 nginx 访问。

## 1. 现有入口（全部要改）

| 使用方 | 入口 |
|---|---|
| L1 / L2 | `brief-digest.ts`（新流程 `createTierEnv`、旧流程 digest）、`preview.ts`（新旧两条）、`triage.ts`、`brief.ts` |
| L1 / L2 / L3 | `review.ts`（含「L2/L3 不可用退回 L1」） |
| 向量 | `brief-digest.ts`、`preview.ts`（`resolveEmbeddingConfig`） |
| Telegram 总结 / 跨频道要点 | `telegram-summarize.ts` → `runDueSummaries` / `runDueDigests` |
| Telegram 图片识别 | `telegram-vision.ts` → `runOneVisionTask` |
| Telegram 要点预览 | `telegram-daily-preview.ts` |
| 来源画像 | `actions.ts`（实际调用）、`server.ts`（保存时探测） |
| 后台测试按钮 | `server.ts` |

不接入：`scripts/golden-eval.mjs`（开发评估工具，继续读 env，在后台与文档注明）。

## 2. 数据模型（brief.db 迁移 019）

```sql
CREATE TABLE model_config_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0,      -- 0 = 全部走旧配置；1 = 全部走本表
  revision INTEGER NOT NULL DEFAULT 0,     -- 任何供应商 / 分配变更 +1（乐观锁）
  enabled_at TEXT
);
INSERT INTO model_config_state(singleton) VALUES (1);

CREATE TABLE model_providers (
  id TEXT PRIMARY KEY CHECK (length(id) = 10 AND substr(id,1,2) = 'p_' AND substr(id,3) NOT GLOB '*[^a-z0-9]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  type TEXT NOT NULL CHECK (type IN ('openai_compatible','openai','deepseek','qwen','anthropic','gemini')),
  base_host TEXT NOT NULL DEFAULT '',      -- 只存主机名（显示、审计用）；留空 = 官方地址
  url_ct TEXT, url_iv TEXT, url_tag TEXT,  -- 完整 Base URL 加密存放（路径里可能带网关令牌），附加认证数据 = id
  config_version INTEGER NOT NULL DEFAULT 1,  -- type / base_url / 密钥任一变化 +1
  key_ct TEXT, key_iv TEXT, key_tag TEXT,  -- AES-256-GCM，附加认证数据 = id（密文不能挪到别的供应商）
  key_hint TEXT,                           -- 长度 ≥16 时为末四位，否则 NULL
  models_json TEXT NOT NULL DEFAULT '[]',  -- 最近一次完整成功拉取的模型 ID
  models_for INTEGER,                      -- 该列表对应的 config_version；≠ 当前 → 页面标「已过期」
  models_truncated INTEGER NOT NULL DEFAULT 0,
  manual_models_json TEXT NOT NULL DEFAULT '[]',
  models_fetched_at TEXT, models_error_json TEXT,
  models_next_allowed_at TEXT, models_next_allowed_for INTEGER,   -- 限流时间只对该 config_version 有效
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE model_assignments (
  consumer TEXT PRIMARY KEY CHECK (consumer IN ('l1','l2','l3','telegramSummary','telegramVision','sourceProfiler','embedding')),
  provider_id TEXT REFERENCES model_providers(id) ON DELETE RESTRICT,
  model TEXT,
  strictness TEXT CHECK (strictness IN ('strict','json','none')),   -- NULL = 按类型默认
  follow TEXT CHECK (follow IN ('l1','l2')),
  disabled INTEGER NOT NULL DEFAULT 0,
  CHECK ((provider_id IS NOT NULL AND model IS NOT NULL AND follow IS NULL AND disabled = 0)
      OR (provider_id IS NULL AND model IS NULL AND follow IS NOT NULL AND disabled = 0)
      OR (provider_id IS NULL AND model IS NULL AND follow IS NULL AND disabled = 1))
);
```

- 外键 `ON DELETE RESTRICT`：被引用的供应商删不掉（数据库保证，不靠检查后再删）。
- follow 规则（写入时校验）：l2→l1；l3→l1 或 l2；telegramSummary / telegramVision→l1；其他不能 follow。l1 必须是显式分配。`disabled` 只允许 sourceProfiler（= mock）与 embedding（= 不启用）。开关打开时 7 个使用方**都必须有一行**（导入与保存都校验），所以 follow 不会指向「未分配」。
- 向量的启用开关、维度、阈值，Telegram 的时段与提示词，画像的温度 / 超时等**不属于供应商**，留在原处。

## 3. 解析

`loadModelSnapshot(db)`：一次只读事务读出开关、全部供应商、全部分配，解密需要的密钥，得到不可变快照（含 revision）。

- **开关关着**：快照为 `legacy`，各入口调用今天的代码，原样不动（包括 `hydrateEnv`、`providerFromEnv`、`telegram_settings`）。
- **开关打开**：`resolveModel(snapshot, consumer)` 只看快照，不读 env、不读 `telegram_settings` 模型列、不读保管库模型设置。返回：

```ts
| { ok: true; cfg: ProviderConfig; providerId: string; fingerprint: string }
| { ok: true; disabled: true }
| { ok: false; error: 'key_unreadable' | 'key_missing' | 'capability' }
```

- `fingerprint` = sha256(providerId + config_version + model + strictness) 前 16 位（包含供应商身份，密钥变化会使 config_version 变化）。
- follow 按规则展开成被跟随者的完整配置（供应商、地址、密钥、模型、strictness 整体复制，不按字段拼接）。
- **review 的回退**：L2/L3 解析失败时退回**完整的** L1 配置；不再像今天的 `pick()` 那样保留 L2/L3 的供应商与地址、只借 L1 的密钥。
- `key_unreadable`：主密钥缺失或不匹配、密文被改。**不回退**到旧配置。
- 迁移 019 不存在（新代码跑在没迁移的库上）：入口直接报错退出，与今天缺迁移 018 的处理一致。

开关是库里的一行，不随保管库文件存在与否变化，所以「文件丢了被当成从未建立而回退」的问题不再存在。

### 3.1 Anthropic SDK 不读 env

开关打开时，Anthropic 适配器显式传入 `baseURL`（自定义或官方 `https://api.anthropic.com`）和 `apiKey`，并显式传 `authToken: null`，使 SDK 不读 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`。测试在设置了这两个环境变量时检查实际请求地址与鉴权头。

## 4. 本地配置错误的处理（只在开关打开时出现）

在**领取任务 / 派发请求之前**判定，不进入适配器、不计入重试、不产生终态。

| 使用方 | 解析时机 | 配置错误时 |
|---|---|---|
| 日报新流程 L1/L2 | 每次构建尝试开始 | `createTierEnv` 接收已解析结果；失败的层标记不可用，`deadReason` 与 `lastErrorKind` 都设为错误类型 → 条目未判定 → 推迟发布（每 15 分钟重试，两小时后停止并显示错误）。缓存标识用快照里的 fingerprint，该层不可用时用 `unavailable:<错误类型>`。 |
| 日报旧流程 / triage / brief / review / 预览 | 进程开始 | 非零退出并打印错误类型（与今天缺密钥一致）。 |
| 向量 | 每次构建尝试开始 | 与今天「向量未配置」相同：本期不做向量合并，原因写进 `embeddingNote`。 |
| Telegram 总结 / 要点 / 图片识别 | **每个任务领取之前**重新加载快照 | 不领取（状态、attempts 不变，不删图片、不暂停队列），本轮结束。 |
| 来源画像 | 每次操作开始解析一次，探测、profile 版本、实际调用共用 | 页面显示错误。 |

- `capability`：图片识别解析到 Anthropic / Gemini（现有适配器不传图片）；向量解析到非 OpenAI 兼容协议（向量客户端固定 `/embeddings` + Bearer）。写入分配时就拒绝，解析时再查一次。
- 自动恢复只保证在 Telegram 原始消息保留期内（`raw_retention_days`）：配置坏了超过保留期，过期消息照常被维护任务清理。后台首页对配置错误显示红色提示。

## 5. 写入

- 所有写操作在一个 better-sqlite3 事务（IMMEDIATE）内完成：校验 → `UPDATE model_config_state SET revision = revision + 1 WHERE revision = ?`（表单带的 revision；0 行 = 有人先改了 → 回滚并提示刷新）→ 修改 → **审计写在同一事务里**。配置与审计要么都成功，要么都不发生；多进程、多窗口都由 SQLite 保证。
- 供应商密钥：编辑留空 = 保留；「清除密钥」勾选项；**type 或 base_url 变化时必须重填密钥**，否则拒绝。密钥变化、type、base_url 变化时 `config_version + 1`。
- 删除供应商：外键阻止删除被引用者，页面列出引用它的使用方。
- 审计只记录供应商 ID、名称、类型、地址主机名、模型名、分配变化，不记录密钥或地址路径。
- 停用开关（回到旧配置）：后台「停用全局模型供应商」按钮，同一事务把 `enabled` 置 0 并审计。供应商与分配保留，可再次启用（启用时校验 7 行齐全）。这是不改代码的回滚手段，前提是 env 旧配置仍在（第 9 节）。

## 6. 校验

- **Base URL**：`https://` only；无用户名密码、查询、片段；≤300 字；主机不能是 IP 字面量（IPv4、IPv6 全部拒绝，含映射地址），不能是 `localhost` 或 `.local` / `.internal` / `.localhost` 结尾。**不做 DNS 校验**：只有管理员能设置地址，域名解析结果被改需要先控制该域名或本机 DNS，按威胁模型不防护（第 0 节）。`/models` 拉取 `redirect: 'error'`。
- 规范化：协议与主机小写，去默认端口与末尾 `/`，路径保留大小写；官方类型留空与显式填写官方地址视为相同。
- **模型 ID**：`^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,199}$`；OpenAI 兼容类允许最多一个 `/`（如 `vendor/model`），不允许 `..`。Gemini 不允许 `/`，适配器拼路径时 `encodeURIComponent`。
- 地址在后台页面对管理员完整显示；日志、审计、来源画像版本表（`ai_model_profiles.base_url`）只存主机名或供应商 ID。

## 7. 模型列表拉取（`/models`）

| 类型 | 请求 | 分页 |
|---|---|---|
| openai / openai_compatible / deepseek / qwen | `GET {base}/models`，Bearer | 无 |
| anthropic | `GET {base}/v1/models`，`x-api-key` + `anthropic-version` | `has_more` + `after_id` |
| gemini | `GET {base}/v1beta/models`，`x-goog-api-key` 头 | `nextPageToken` |

- 地址解析与推理适配器共用同一个函数。Gemini 去掉 `models/` 前缀，只保留支持 `generateContent` 的项。
- 上限：整次操作 20 秒（含读响应体）、每页响应 1 MB、最多 5 页、最多 500 个 ID。
- **结果只有两种**：
  - 成功：所有请求的页都完整读完（因 5 页或 500 个上限而停在页与页之间也算成功，`models_truncated = 1`）→ 替换 `models_json`、`models_for = 请求开始时的 config_version`、清空错误。
  - 失败：任何一页超时、超 1 MB、非 JSON、HTTP 错误、网络错误 → **整次丢弃**，保留旧列表，只写 `models_error_json`（kind + status）。`not_found` / `forbidden` 提示「该网关不提供模型目录，请手动添加」。429 且有 `Retry-After` → 写 `models_next_allowed_at`。
- 回写在事务里比对 `id + config_version`：供应商已删或已改 → 丢弃结果（包括错误与限流时间），不影响新配置。回写不改 revision（不与管理员的表单冲突）。
- 时机：保存供应商且本次填了密钥后自动拉一次；页面「刷新」按钮；同一供应商 10 秒内最多一次（以及 `models_next_allowed_at` 之前不拉）。失败**从不影响分配、不停用供应商**。
- 选择模型：候选 = 拉取的 + 手动的；也可直接输入（同样校验）。

## 8. 首次导入（只在后台）

「从当前配置导入」按钮，仅开关关着且没有供应商时显示。

- 收集「worker 实际会用的」旧配置：用 `providerFromEnv` 的可注入环境版本，传入「`process.env` + 保管库 hydrate 的结果（只补 env 未设置的键）」的副本，与 worker 启动时 `hydrateEnv()` 后看到的完全一致；Telegram 用 `telegram_settings` + `resolveSecret`；画像、向量用现有解析函数。
- 去重身份 (类型, 规范化地址, 密钥 sha256) → 每组一个供应商。
- 分配：l1 显式；l2 与 l1 完全相同（供应商、模型、strictness）→ `follow l1`，否则显式；l3 与 l1 相同 → `follow l1`，与 l2 相同 → `follow l2`，否则显式；Telegram 两项与 l1 相同 → `follow l1`，否则显式；画像为 mock → `disabled`，否则显式；向量未启用或不完整 → `disabled`，否则显式（必须是 OpenAI 兼容）。
- **任一使用方无法导入就整体不导入**（旧配置是 mock 而该使用方不允许 disabled、缺密钥、图片识别旧配置是 Gemini / Anthropic、strictness 无法表示等），结果页列出原因，让管理员先改好旧配置或手动建供应商后用「启用」按钮。
- 一个事务内：再次确认开关关着且没有供应商 → 插入供应商与 7 行分配 → 用新数据做一次快照解析，与旧解析结果逐项比对（类型、规范化地址、密钥、模型、strictness）→ 任何不同就回滚并报告差异 → 打开开关、审计。重复点击或响应丢失后重试只会看到「已导入」。
- 导入不改 env、不改 `telegram_settings`、不写保管库。

## 9. 部署、备份、回滚

1. 部署前：用户把 `APP_ENCRYPTION_KEY` 存入 1Password（我不碰 1Password）。开关打开后主密钥丢失 = 供应商密钥全部不可解密（可在后台重填恢复，不会丢其他数据）。
2. 备份：密钥随 brief.db 进入现有本机与 Google Drive 备份，是密文；主密钥只在 `/etc/briefing/env` 与 1Password，**任何备份包都不含 env**（现有 Google Drive 脚本只打包两个库，已核实；部署前的 env 备份只在服务器本地 `/var/lib/briefing/backups/`，权限 0600 root）。恢复验收：在恢复出的库上跑 `GET /health/models` 能解析全部使用方。
3. 部署顺序：备份 → 停 `brief-run` / `brief-telegram-*` 定时器并等正在运行的任务结束 → 迁移 019 → 上线代码 → 启动服务与定时器（开关关着，行为不变）→ 后台导入 → 逐个「测试」→ 观察。导入在新代码全部上线后才做，不存在旧 worker 读新配置的混合期；旧 worker 本来就不认识新表。
4. 观察期：至少两期日报与 Telegram 要点正常。期间 env 的 `AI_*` 与密钥行保留、旧密钥不撤销——这是停用开关与回退旧代码的前提。
5. 观察期后由用户决定是否删除 env 中的模型相关行（逐项核对：所有使用方都已来自库、`golden-eval` 是否还需要）。删除后若要回退，先从本地 env 备份恢复。
6. `GET /health/models`（需登录）与后台首页：显示开关、revision、每个使用方的解析结果（来源、类型、主机、模型、错误类型），不含密钥。`/health/ready` 不变。

## 10. 后台界面

- **设置 → 模型供应商**：列表（名称、类型、地址、密钥提示、模型数 / 已过期 / 不完整、最近拉取与错误、被谁引用）；新增 / 编辑 / 删除 / 刷新；导入；启用 / 停用开关。
- **设置 → 模型分配**：7 行，每行供应商下拉（含「跟随 L1」等、两行有「停用」）+ 模型（带候选）+ 测试；整表一次保存（带 revision）。开关关着时页面显示「当前使用旧配置」及旧配置的生效值（只读）。
- 开关打开后，原来分散的模型输入（日报 L1/L2/L3、Telegram 与图片识别的 provider/model/base_url/credential_ref、画像的 provider/model/base_url/credential_ref、向量的地址/模型/密钥）隐藏；对应保存函数只更新仍归它管的字段（`updateTelegramSettings` 不再重置模型列）。
- 所有新增接口登录才能访问；写操作要 CSRF、拒绝只读模式。供应商 ID 不是凭证；公开 RSS 不读这些表。
- 顺带修复：`trustProxy` 只信任 `127.0.0.1`，Origin 精确比较（附测试）。

## 11. 本次不处理（记录在案）

| 问题 | 归类 | 理由 |
|---|---|---|
| 模型返回非 JSON 或上游报错时，异常里带出正文片段（可能含消息摘录），写进 Telegram 库、日志或页面 | 严重 × 现实 | **今天已存在、与本次无关**；修法是统一结构化错误并隔离内容，涉及全部适配器与 Telegram 落库，**列给用户决定是否另立任务** |
| 上游拒绝类错误（密钥失效、模型不存在）在 Telegram 里消耗次数、最终停止或生成兜底；要点部分分块临时失败仍标记完成 | 中等 × 现实 | 今天已存在；切换不改变其概率。另立任务 |
| Telegram 总结 / 要点 / 图片识别没有跨进程租约：重复进程可能把已完成任务改回失败、重复请求；崩溃后停在 `running`；图片先删文件后改状态；`recoverVisionFiles` 无条件恢复 | 中等 × 现实 | 今天已存在，需要单独的任务领取设计。另立任务 |
| 图片识别鉴权失败暂停整个队列，换密钥后迟到的旧请求也可能触发 | 中等 × 巧合 | 管理员在后台点恢复即可 |
| Anthropic / Gemini 适配器：拒答在 Telegram 里会重试、Gemini 超时只覆盖响应头且未禁重定向、两者未透传取消信号、Anthropic 未用配置的超时 | 中等 × 现实（仅当选用这两类） | 生产不用；本次已限制图片识别与向量的类型。另立任务 |
| `packages/connectors/src/ssrf.ts` 未识别 `::ffff:7f00:1` 形式的映射地址与 `fe80::/10` 全段 | 中等 × 巧合（采集来源只能由管理员添加） | 与本次无关但修复便宜，**本次顺手修**并补测试 |
| 主密钥强度校验与轮换 | 中等 × 巧合 | 生产主密钥已存在 |
| 配置错误跨过 Telegram 原始消息保留期后不能补回 | 中等 × 巧合 | 后台首页红色提示，管理员有保留期天数的时间处理 |

## 12. 测试

- 开关关着：所有入口的调用参数与改动前逐字一致（L1/L2/L3 组合、`AI_BASE_URL`、strictness、L3 继承 L1、保管库 hydrate、Telegram 旧列）。
- 开关打开：不读 env / 旧列（设置干扰值验证）；Anthropic 在设置 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 时仍用库里的地址与密钥；follow 整体复制；review 回退用完整 L1；主密钥错误 / 密文被改 → `key_unreadable` 不回退；能力不符被拒。
- 快照：解析期间另一连接改了配置，同一任务单元结果来自同一 revision。
- 配置错误契约：日报推迟且 `lastErrorKind` 正确；Telegram 三类任务不领取、attempts 不变、不删图不暂停，修好后自动继续。
- 写入：两个连接同 revision 并发保存只有一个成功；审计与配置同事务（让审计插入失败 → 配置不变）；删除被引用供应商被外键拒绝；改地址不重填密钥被拒；密文绑定供应商 ID（挪到另一行解不开）；fingerprint 区分同类型同地址同模型的两个供应商。
- 导入：生产形态（三层同一网关、Telegram 同一密钥、画像 mock、向量未启用）→ 1 个供应商、l2/l3/Telegram follow l1、画像与向量 disabled；L1=L3≠L2；任一不可导入则整体不导入；比对不一致回滚；重复点击不重复；后台导入看到的旧配置与 worker（hydrateEnv 后）一致；不改 env、telegram_settings、保管库。
- 停用 / 启用：停用后回到旧配置逐字一致；启用时 7 行不齐被拒。
- 模型列表：各类型格式与分页；Gemini 前缀与方法过滤；页数 / 数量上限 → 成功且 truncated；单页超限 / 超时 / 后续页失败 → 整次丢弃保留旧列表；重定向拒绝；IP 字面量与 localhost 地址拒绝；错误只存 kind/status；请求期间供应商被改或删 → 结果与限流时间都丢弃；Retry-After。
- 校验：模型 ID `..` / Gemini 含 `/` 被拒；地址路径不进日志、审计、画像版本表；短密钥不显示末四位。
- 表单：Telegram 设置保存后模型列不变。
- 后台：新路由未登录被拒、缺 CSRF 被拒、只读模式被拒；`trustProxy` 与 Origin。
- SSRF 修复：映射地址与 `fe80::/10` 全段被拒。
- 迁移：首次安装与在现有库上升级都能跑通；迁移后开关关着。

## 13. 第 3 轮设计审查后的定稿修改

第 3 轮确认存储与切换的结构性问题已消除。以下具体缺口按此定稿，不再送设计审查（本项改动已用 3 轮，剩 2 轮给代码审查），实现时照此执行并写进测试。

**泄漏**
- 完整 Base URL 加密存放（`url_ct`），明文只存主机名（第 2 节已改）。备份里只有密文。
- 导入差异报告只列「使用方 + 字段名 + 不同」，不输出任何一侧的值。
- Anthropic 在开关打开时：构造参数 `logLevel: 'off'`；并传入自定义 `fetch`：只允许请求以库里地址开头的 URL、`redirect: 'error'`，按白名单重建请求头（content-type、accept、user-agent、anthropic-version、anthropic-beta、x-stainless-*），由我们设置 `x-api-key`，丢弃其余（`authorization`、`ANTHROPIC_CUSTOM_HEADERS` 注入的任何头）。测试在同时设置 `ANTHROPIC_BASE_URL / AUTH_TOKEN / CUSTOM_HEADERS / LOG=debug` 时验证实际请求的地址、头与无日志输出。

**导入**
- 导入全程同步执行（收集 → 事务 → 比对 → 提交，中间没有 await），后台进程内不会穿插其他请求；Telegram 设置与保管库只由后台写（`migrate-telegram.mjs` 是一次性人工脚本，与导入同时运行归「巧合」）。
- 所有旧配置解析器（`providerFromEnv`、`resolveSettings`/`resolveEmbeddingConfig`、画像、Telegram 密钥）都使用同一份「`process.env` + 保管库 hydrate（只补未设置的键）」构造的环境副本，与 worker 启动后看到的一致。
- 比较的是**最终端点与鉴权来源**：环境里设置了任何 SDK 会隐式读取的变量（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`）且有使用方是 anthropic 类型 → 拒绝导入并说明原因。

**地址约定**：gemini 的 Base URL 含版本路径（默认 `https://generativelanguage.googleapis.com/v1beta`，与现有适配器一致），目录 = `{base}/models`；anthropic 的 Base URL 是站点根（SDK 追加 `/v1`），目录 = `{base}/v1/models`；OpenAI 兼容类 Base URL 含 `/v1`，目录 = `{base}/models`。导入、目录、推理共用一个函数。

**模型列表**
- 合法结构：OpenAI 类 `data: [{id}]`、Anthropic `data: [{id}]` + `has_more` 为真时必须有 `last_id`、Gemini `models: [{name, supportedGenerationMethods}]` + 可选 `nextPageToken`。结构不符、`has_more` 为真却无游标 → 失败，保留旧列表。合法但为空 → 成功（空列表）。
- 403 显示「当前密钥没有模型目录权限或网关不提供目录，可手动添加模型」；404 显示「网关不提供模型目录」。
- 限流时间带 `models_next_allowed_for`，config_version 变化即失效；`Retry-After` 只接受秒数，上限 1 小时。
- 同一供应商同时只允许一个拉取（后台进程内的在途集合，20 秒超时后必然释放），所以不会有同版本乱序回写。
- 单页超过剩余名额：读完整页后截取前若干个合法 ID，标 truncated。

**缓存隔离**：开关打开时，日报分层缓存、Telegram 总结缓存、向量缓存的键都加入 fingerprint（原有的提示词、维度等输入保留）。fingerprint = sha256(JSON.stringify([providerId, config_version, model, strictness])) 前 16 位。

**能力与引用**：每次写入（供应商改类型、分配保存、启用开关）都对 7 个使用方的完整引用图（含 follow 展开）重新校验能力与完整性，不通过则拒绝整次写入。

**向量**：开关打开时，向量是否启用只看分配（`disabled` 或显式），原处的「启用」勾选隐藏；维度与阈值仍在原处。

**图片识别暂停**（第 3 轮指出它是「中等 × 现实」，按矩阵必须修）：Telegram 迁移追加 `telegram_settings.vision_pause_fingerprint`。鉴权失败暂停时记录失败请求的 fingerprint（旧配置模式下 fingerprint = 旧配置的类型、地址、模型与密钥 sha256 的组合）；只有它等于本次任务领取前快照的 fingerprint 才暂停。领取任务时若队列已暂停但当前 fingerprint 与暂停时不同（管理员换了配置）→ 自动解除暂停并记日志。

**部署**（替换第 9 节第 3 步）：备份 → 停 `brief-requests.path`、各定时器（`brief-run.timer`、`brief-telegram-*.timer` 等）→ 等 `brief-run` / `brief-telegram-*` / `brief-requests` 服务都不在运行、也不处于自动重启等待 → 迁移 → 上线代码 → `systemctl restart brief-web` → 启动定时器与 path → 后台导入。env 回滚备份放到 root 专用目录 `/root/briefing-rollback/`（0700），不放应用可写的备份目录；恢复 env 后必须重启 brief-web，并以 `brief` 身份跑一次 `/health/models` 等价脚本核对。

**主密钥**：首次安装要求 `APP_ENCRYPTION_KEY` 为 32 字节随机数的 base64（`openssl rand -base64 32`），长度不足时后台首页提示；轮换另立任务。

**第 11 节归类更正**
- 采集器 IPv6 判断：移出「不处理」，本次修复。
- 图片识别暂停：本次修复（见上）。
- 以下两条「严重 × 现实」的原有问题，**列给用户决定是否另立任务**：① 异常 / SDK 调试日志带出上游正文与请求内容；② Telegram 要点部分分块临时失败仍标记完成（永久不完整），图片识别遇到「模型不存在」等错误进入终态并删除图片。
- Anthropic / Gemini 适配器的重定向会带凭据跳转：开关打开时 Anthropic 已由自定义 fetch 禁止；Gemini 适配器本次一并改为 `redirect: 'error'`（一行）。
