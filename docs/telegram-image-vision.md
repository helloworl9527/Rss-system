# Telegram 图片识别运维

图片识别仅适用于普通 Telegram 来源。迁移 `004_image_vision.sql` 的应用时间是功能起点；更早的历史图片不会创建任务，URL 类型来源不会保存正文或媒体。

## 上线顺序

1. 停止 Telegram collector、summary 与 web，避免迁移期间出现新写入。
2. 运行 `npm run telegram:migrate-schema`。此命令先在线备份 Telegram SQLite，再应用迁移并执行 `integrity_check`。
3. 确认 `/var/lib/briefing/telegram-media` 由 `brief:brief` 持有且权限为 `0700`。该目录不属于备份目标。
4. 安装 `brief-telegram-vision.service` 与 `.timer`，执行 `systemctl daemon-reload`。
5. 先启动 collector，并从一个普通来源发送一张新测试图；手动运行一次 vision service，检查管理页结果与 `npm run telegram:vision-status`。
6. 确认临时文件已删除、SQLite `integrity_check=ok` 后，再启用 vision timer 及其余 Telegram 服务。

## 故障处置

- 401/403 会暂停整个视觉队列，管理页显示原因。修复凭证后用管理页按钮恢复。
- 429、超时与 5xx 按 5、20、60 分钟退避；达到上限后删除临时图片并保留失败审计行。
- 每日新图达到 300 张时任务保留为 pending，次日继续；重试不占用新的图片名额。
- 每次 worker 启动会回收超过两小时且没有活跃任务引用的孤儿文件。
- 已发布的总结不会因迟到的图片识别结果而重写。

不要在日志、管理页或工单中输出 API Key、私群图片、原始私群消息正文或临时文件内容。
