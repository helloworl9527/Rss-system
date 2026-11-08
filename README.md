# 十六源智能日报系统

这是按《十六源智能日报系统 PRD 与服务器端设计方案 V1.0》实现的模块化单体：Web 管理后台与独立 Worker 共用 SQLite/WAL，采集、固定窗口、去重、筛选、AI 分级判定、简报生成、投递和审计均可重跑。

当前日报 Feed 链接和 Telegram 订阅名称见 [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md)，生产环境每 5 分钟自动同步更新。

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
