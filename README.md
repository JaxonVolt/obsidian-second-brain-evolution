# 第二大脑 · 知识演化

一个面向 Obsidian 桌面端的中文知识演化插件。它以本机 Codex CLI 为智能执行入口，把快速收集、人工确认分流、今日笔记、知识库问答、复盘和微信远程收集集中到一个侧边栏中。

> 当前公开版本：`3.2.0`

## 核心能力

- 通用输入框：混合记录想法、行动、资料和复盘，先统一进入收件箱。
- 人工确认分流：Codex 生成可编辑建议，用户确认后才写入目标目录。
- 今日笔记：从命令面板或插件首页打开、创建当天笔记。
- 知识工作流：驾驶舱、消化、问库、费曼解释、周回顾、记忆审核等场景命令。
- 微信远程入口：通过 Weixin iLink 扫码连接，接收文本、图片和文件并保存到本地知识库。
- 本地优先：笔记、会话和运行账本保存在用户自己的 vault 中。

## 运行要求

- Obsidian `1.8.9` 或更高版本
- Windows、macOS 或 Linux 桌面端
- 已安装并登录 [Codex CLI](https://developers.openai.com/codex/cli/)
- 微信远程入口目前建议在 Windows 上使用

## 安装

从 GitHub Releases 下载以下三个文件：

```text
main.js
manifest.json
styles.css
```

将它们放入：

```text
<你的仓库>/.obsidian/plugins/second-brain-evolution/
```

然后在 Obsidian 的“设置 → 第三方插件”中启用“第二大脑 · 知识演化”。

## 基本使用

1. 打开插件设置，确认 Codex CLI 已被识别。
2. 点击左侧脑形图标打开第二大脑。
3. 日常记录可直接使用“打开或创建今日日记”。
4. 零散输入先放进通用输入框，再运行“消化收件箱”。
5. 检查并修改分流建议，确认后再一键归位。

## 微信远程入口

1. 在插件设置中点击“扫码连接”。
2. 使用微信扫码并确认登录。
3. 向新出现的聊天发送文字、图片或文件。
4. 回到 Obsidian 使用“消化收件箱”检查并分流。

微信转发卡片的结构会随客户端变化，插件采用尽力解析；无法提取正文时会保留可识别的标题、摘要和原始信息。首次公开使用前请阅读 [隐私与安全说明](docs/PRIVACY.md)。

## 从源码构建

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

构建产物为 `main.js`、`manifest.json` 和 `styles.css`。

## 隐私原则

仓库不包含作者或用户的个人画像、真实笔记、微信凭据、Codex 会话和本机路径。插件不会自动把 vault 上传到本仓库；但发送给 Codex 的内容会按用户自己的 Codex 配置处理。详见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 开源与归属

本项目采用 MIT License。它包含并改写了其他 MIT 项目的代码，完整归属见 [NOTICE.md](NOTICE.md)。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 处理。
