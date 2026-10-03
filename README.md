# 第二大脑 · 知识演化

面向 Obsidian 桌面端的中文、本地优先第二大脑插件。把日记、工作日志、收件箱、行动工作台、知识库问答与记忆管家放在同一套工作流中，笔记仍是可编辑的 Markdown 文件。

当前公用版本：**5.7.0**。下载入口：[GitHub Releases](https://github.com/JaxonVolt/obsidian-second-brain-evolution/releases/latest)。

## 能力

- 快速捕获文本、想法和附件；收件箱分流先给建议，确认后写入。
- 日记包含离线生成的星期、农历与今日信息，支持 Obsidian 每日笔记设置。
- 独立工作日志按日期建立，已有内容不会被覆盖。
- 行动工作台支持今天、计划、等待、项目和已完成视图，独立行动文件是状态主记录。
- 记忆管家提供复盘、行动发现、经验沉淀与待验证判断；自动模型分析默认关闭。
- 对话按相关性查找笔记并标注来源，不把检索失败当成没有资料。
- 可选 LLM Wiki 联合检索，程序与知识项目路径由用户填写，默认关闭。
- 可选微信 iLink 入口，扫码后收集文字、图片和文件；管家定时外发默认关闭。
- 模型可使用 Codex 账户、Ollama、LM Studio 或兼容 Responses API 的自定义服务。

## 要求与边界

- Obsidian **1.11.5 或更新版本**，仅桌面端。
- AI 功能需要安装并配置 [Codex CLI](https://developers.openai.com/codex/cli/)。不用 AI 时，日志、捕获和行动工作台仍可使用。
- 本地与自定义模型必须满足 Codex CLI 的协议、流式输出和工具调用要求。仅能读取模型列表不代表完整工作流兼容。
- LLM Wiki 是独立应用，不包含在插件安装包内。接口不兼容或不可用时会明确显示状态。
- 微信接入依赖外部服务；Windows 凭据保护已有实现，其他平台与完整外部服务流程需要使用者在自己的环境验证。
- 插件不是 Obsidian 手机端插件，也不是 GitHub 双向同步工具。此公开发布不附带任何用户的备份库、同步任务或知识资料。

## 安装

1. 从 [最新发布](https://github.com/JaxonVolt/obsidian-second-brain-evolution/releases/latest) 下载 `second-brain-evolution-5.7.0.zip`。
2. 将压缩包中的 `second-brain-evolution` 文件夹放入你的库的 `.obsidian/plugins/`。
3. 在 Obsidian 设置的“第三方插件”中启用“第二大脑 · 知识演化”。

也可单独下载 `main.js`、`manifest.json` 和 `styles.css`，放入 `.obsidian/plugins/second-brain-evolution/`。发布页提供 `SHA256SUMS.txt` 供校验。

这次发布是 GitHub 手动安装版，不代表已经进入 Obsidian 社区插件商店。

## 首次使用

1. 用一个空白测试库启用插件，预览初始化向导；点击确认后才补建通用目录和模板，已有文件不会覆盖。
2. 打开左侧脑形入口，创建日记或工作日志，尝试捕获一条临时记录。
3. 在插件设置检查 Codex CLI 和模型连接；第一次 AI 测试先做只读问答。
4. 运行“消化收件箱”，检查建议与目的地，确认后再归位。
5. 通过行动工作台管理行动；通过记忆管家审核经验候选，不把待验证判断直接当作事实。
6. 微信、自动洞察、管家外发和 LLM Wiki 按需要单独启用。

通用默认目录：

```text
000_元数据/
010_收件箱/
020_行动系统/
100_领域与职责/140_工作日志/
300_复盘与日志/310_每日笔记/
500_永久笔记与知识资产/
600_输出与作品/
700_归档/
900_模板/
```

日记路径优先采用 Obsidian 内置每日笔记设置。工作日志使用上面单独的目录，初次创建时补建模板与索引。公用版不迁移已有库的个人目录，升级前请先备份并在测试库核对。

## 隐私与写入

此仓库只有通用插件源码、合成测试和发布说明，没有真实笔记、画像、附件、凭据或私有仓库历史。插件本身不会上传库到此 GitHub 仓库。

AI 请求会将所需上下文发送给你选择的服务；自动洞察启用后也会调用模型。微信外发仅在绑定与配置后运行。问库默认只读，分流与长期记忆修改应先审阅建议和确认。模型提示规则不能替代用户备份或底层权限约束。

细节见 [隐私说明](docs/PRIVACY.md) 和 [模型接入指南](docs/MODEL_PROVIDERS.md)。

## 开发与验证

使用 Node.js 24 与 npm：

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run check:public
```

`npm test` 运行维护中的核心、优化与公用版回归。`npm run test:all` 包含尚未全部迁移的上游历史测试，不是当前发布门禁；其已知边界见 [发布说明](docs/RELEASE_5.7.0.md)。

生产构建不自动安装到任何 Vault。需要开发热更新时显式设置自己的 `OBSIDIAN_VAULT`，仅开发构建会复制产物。

## 开源

MIT License，保留上游版权与归属，见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。贡献与安全报告见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)。
