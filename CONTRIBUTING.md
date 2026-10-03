# 贡献指南

## 开发环境

- Node.js 24
- npm
- Obsidian 桌面端

安装依赖并运行检查：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run check:public
```

`npm test` 运行当前公开版的核心回归测试。`npm run test:all` 会额外运行继承自上游的历史兼容测试，其中部分断言仍对应旧英文界面、旧存储路径和旧引擎行为，正在逐步迁移。

## 提交要求

- 一次提交只处理一个清晰问题。
- 用户可见文字默认使用中文，并避免硬编码个人背景。
- 新增写入行为时，必须说明写入位置、确认机制和失败回滚方式。
- 新增网络能力时，必须更新隐私说明。
- 不得提交真实 vault、截图中的个人内容、账号、令牌、Cookie、二维码或 `data.json`。

## Pull Request

请在说明中写清：

- 修改了什么以及为什么修改。
- 对用户数据和现有行为的影响。
- 已运行的测试。
- 涉及界面时附上脱敏截图。
