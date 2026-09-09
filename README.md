# 十六源智能日报系统

这是按《十六源智能日报系统 PRD 与服务器端设计方案 V1.0》实现的模块化单体：Web 管理后台与独立 Worker 共用 SQLite/WAL，采集、固定窗口、去重、筛选、AI 分级判定、简报生成、投递和审计均可重跑。

## 本地启动

```bash
npm install
npm run migrate
npm run sync
npm run web
```

首次启动 Web 会自动应用迁移；健康检查位于 `http://127.0.0.1:3000/health/live`。未设置 `ADMIN_PASSWORD_HASH` 时为只读演示模式，写操作会被拒绝。

## 生产配置

复制 `.env.example`，至少设置 `ADMIN_PASSWORD_HASH`、`APP_ENCRYPTION_KEY` 和 `DATABASE_PATH`。使用 `node scripts/admin-setup.mjs '<长度足够的口令>'` 生成后台凭证。

后台“设置”页支持按 L1/L2/L3 分别配置供应商、任意模型 ID，以及 OpenAI 兼容 API 端点；密钥和设置加密存储在 `SECRETS_PATH`。来源页支持测试并直接新增 RSS/Atom、Telegram 网页或 DeepSeek 日志来源，新增来源不会被 `config/sources.yaml` 同步覆盖。

## 常用命令

```bash
npm run harvest       # 按采集档抓取来源
npm run run -- --no-send
npm run status
npm test
```

## Nginx 公网入口

`deploy/nginx/brief.xmcode.tech.conf` 已配置 `brief.xmcode.tech` 的 HTTP→HTTPS 跳转、Let's Encrypt 证书路径与 `127.0.0.1:3000` 上游。部署后用 `nginx -t`、`systemctl reload nginx`，再访问 `/health/live` 和 `/login` 验证。

## 全网热点

在后台设置页加密保存 `ALLNET_API_KEY`，然后在全网热点页输入网站已有的来源名称。唯一精确匹配会测试并直接订阅；其他匹配列出候选。来源独立生成本地 ID，按上游 ID 去重，已有订阅和手动分组不会被配置同步覆盖。相对链接可补充原站 HTTPS 地址。

知乎热搜（76）和微博-热搜（9）每 20 分钟只取返回顺序前 15 项，无效条目不补位；美团社区-最新（864）每 60 分钟获取第一页、最多 100 条。百度热搜仅保留暂不可用位置。无原文时间的热搜按首次发现时间进入候选窗口，原文发布时间留空。美团尝试提取原文内容和时间，日期链接作为后备；旧文沿用存量规则，无日期条目不会按当天新闻发送。

每条来源展示可复制 RSS URL，独立令牌可重置或撤销。RSS 只读取最近成功快照，失败保留旧快照并标注错误和时间；不消耗上游调用。API 请求只发至固定 HTTPS 主机，拒绝重定向，统一串行限速、短期缓存及每日 2,000 次调用上限。反向代理必须同步发布 RSS 日志隐藏配置。

一次性初始化：`node --env-file=/etc/briefing/env scripts/setup-allnet.ts /path/to/key-file`。不会生成或补发日报。生产发布前备份 SQLite、密钥保管库和部署配置，运行迁移后重启 Web；worker 下次运行读取新密钥。

### 独立采集与参与日报

“全网热点”页管理名称订阅、独立采集开关、采集健康、RSS 地址和令牌，不展示榜单预览。来源页的对应开关只控制“参与日报”。任一开关启用都会继续采集；两边都关闭才停止，令牌有效时 RSS 仍能读取最后成功快照。

新增全网热点订阅默认只供 RSS。来源页重新启用参与日报后，只接纳此后首次发现的内容，停用期间的存量和重新上榜条目不会补入。已有候选、日报正文和附录统一检查资格；生成或发送重试期间资格变化会中止本轮并记录原因，需要重新运行生成最新内容。已提交发送的邮件无法撤回。

## Telegram 订阅

Telegram 使用独立的 `data/telegram.sqlite3`，不会进入日报候选、邮件或投递流程。后台 `/telegram` 管理登录、普通总结来源、仅 URL 来源、总结时段与独立 RSS 令牌。验证码和 2FA 密码只经 `data/telegram-login.sock` 传给 Python/Telethon worker，不落盘；API ID、Hash、手机号和 AI key 使用同一 AES-GCM 保管库。

本地初始化与运行：

```bash
cd telegram-worker && /home/Roots/.tools/uv sync --dev && cd ..
npm run telegram:collector
npm run telegram:summarize
```

原采集器迁移命令为 `npm run telegram:migrate -- /home/Roots/Telegram-channel-compact`。它会先校验共享密钥槽、备份原数据库与会话，再幂等迁移消息、版本和同步游标；任何密钥冲突都会在写目标数据前停止。必须先通过环境提供 `APP_ENCRYPTION_KEY` 与 `SECRETS_PATH`。原项目目录不会删除。

仓库提供 collector service 和每分钟检查窗口的 timer，但本地合并不会安装、启用或发布这些单元；生产启用需另行批准。
