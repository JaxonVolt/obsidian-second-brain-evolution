# 安全策略

## 报告问题

请不要在公开 Issue 中提交访问令牌、微信凭据、二维码、完整日志或真实笔记。安全问题优先使用 GitHub Security Advisory 的私密报告功能。

报告中请包含：

- 受影响版本。
- 可复现步骤。
- 预期与实际行为。
- 已脱敏的最小日志。

## 支持范围

当前维护版本为 `5.7.x`。安全修复优先进入最新版本。

## 用户侧保护

- 只从本仓库 Releases 获取构建文件。
- 不要公开 `.obsidian/plugins/second-brain-evolution/data.json`。
- 定期更新 Obsidian、Codex CLI 和插件。
- 自定义模型密钥优先使用设置页的 Obsidian 密钥库保存，不要写入 URL、笔记或公开 Issue。
- 在确认分流结果前，不要批量写入长期笔记。
