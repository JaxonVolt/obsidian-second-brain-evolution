import type { SlashCommand } from '../types';

const GOVERNANCE = `
你正在操作一个 Obsidian 外置第二大脑。当前仓库根目录就是 Obsidian vault。

运行纪律：
1. 先读取 000_元数据/000_元数据：核心坐标.md、.second-brain/memory-policy.md、.second-brain/goals.md 和完成任务所必需的笔记，避免无范围地扫描整个库。
2. 分清事实、来源、推断和建议；每个重要结论都给出对应笔记路径。
3. 默认只生成分析和建议，不移动、删除、重命名、合并或改写笔记。
4. 永久笔记、项目、决策和 000_元数据/000_元数据：核心坐标.md 属于长期记忆，必须等用户明确确认后才能写入。
5. 发现矛盾时并列原文与证据，表述为待核实问题，不擅自裁决。
6. 任何获准写入都应保持最小范围，并在完成后列出修改文件。
`.trim();

function prompt(task: string): string {
  return `${GOVERNANCE}

任务：
${task}`;
}

function defineCommand(
  name: string,
  description: string,
  task: string,
  argumentHint?: string,
): SlashCommand {
  return {
    id: `knowledge:${name}`,
    name,
    description,
    argumentHint,
    content: prompt(task),
    source: 'plugin',
    userInvocable: true,
  };
}

export const KNOWLEDGE_COMMANDS: readonly SlashCommand[] = [
  defineCommand(
    'dashboard',
    '今日驾驶舱：聚焦目标、行动和知识提醒',
    `生成今天的轻量驾驶舱。

优先读取：
- 000_元数据/000_元数据：核心坐标.md
- 020_行动系统/项目清单.md
- 020_行动系统/下一步行动.md
- 020_行动系统/等待与委托.md
- 今天和昨天的每日笔记（如果存在）

只输出：
- 今日唯一主目标
- 三个可以直接开始的动作
- 一个阻塞或等待事项
- 一个值得沉淀的判断候选
- 一个今天明确不做的事项

保持简短，不修改文件。`,
  ),
  defineCommand(
    'digest',
    '消化 Inbox：生成分流建议和下一步',
    `读取 010_收件箱/010_Inbox.md 以及 010_收件箱中尚未处理的普通笔记。

逐条输出建议表，字段为：编号、内容摘要、类型、为什么值得留下、建议去向、最小下一步、置信度。
类型只使用：立即行动、项目、领域或资料、永久笔记候选、输出候选、等待信息、可删除。
不要移动、删除或改写任何文件，等待用户按编号确认。`,
  ),
  defineCommand(
    'ask-vault',
    '问库：基于笔记回答并标注依据',
    `回答用户的问题：$ARGUMENTS

先搜索相关笔记，再给出：
- 直接回答
- 依据笔记及其路径
- 现有笔记中的不同观点或矛盾
- 当前知识缺口
- 一个最值得继续追问的问题

没有证据时明确说“库中没有足够依据”，不要用常识伪装成库内记忆。`,
    '<问题>',
  ),
  defineCommand(
    'feynman',
    '费曼检验：找出理解缺口并生成练习',
    `围绕当前打开的笔记或用户指定主题 $ARGUMENTS 进行费曼检验。

要求用户先用自己的话解释；如果当前笔记已经包含解释，则直接分析。
输出：一句话解释、关键机制、解释跳跃、容易混淆点、三个检验问题、一个最小实践练习。
不重写原笔记，除非用户确认。`,
    '[主题]',
  ),
  defineCommand(
    'review-note',
    '看看这篇：审阅当前笔记的清晰度与证据',
    `审阅当前打开的笔记。

检查：核心问题是否清楚、事实与判断是否分离、证据是否可追溯、结构是否便于复用、是否存在重复或矛盾、可以连接哪些现有笔记。
输出“保留、改进、连接、待核实”四部分，并给出最小修改清单。
只提建议，不直接改写。`,
  ),
  defineCommand(
    'route',
    '路由：判断内容应该进入哪里',
    `为以下内容判断最合适的去向：$ARGUMENTS

可选去向仅限 Inbox、下一步行动、活跃项目、对应领域、来源资料、永久笔记、输出与作品、归档。
输出推荐去向、理由、建议路径和最小下一步。
如果信息不足，保留在 Inbox 并明确还缺什么信息。`,
    '<内容>',
  ),
  defineCommand(
    'weekly',
    '周回顾：综合一周事实、模式和下周重点',
    `综合最近七天的每日笔记、项目变化、完成事项、阻塞和 Git 记录（如果可用）。

输出：
- 本周实际发生的 3-5 件事
- 哪些活动服务当前主线，哪些发生偏移
- 反复出现的模式、阻塞或有效做法
- 未沉淀的成果和永久笔记候选
- 下周三个优先事项
- 一个应停止或暂缓的事项

这是分析，默认不创建周报文件；先询问用户是否保存。`,
  ),
  defineCommand(
    'memory-audit',
    '记忆审核：检查陈旧、矛盾和低价值记忆',
    `审核用户指定范围 $ARGUMENTS；未指定时审核最近 30 天修改的长期记忆。

检查：来源缺失、事实过期、结论条件变化、重复观点、相互矛盾、孤立笔记、没有现实用途的内容。
每项给出证据路径、问题、建议动作和风险。
只生成报告，不改文件。`,
    '[范围]',
  ),
  defineCommand(
    'memory-merge',
    '记忆合并：比较重复笔记并提出保留方案',
    `比较用户指定的笔记：$ARGUMENTS

输出共同内容、关键差异、各自适用条件、应保留的证据、推荐的主笔记、候选合并结构和可能丢失的信息。
不执行合并，等待确认。`,
    '<笔记或主题>',
  ),
  defineCommand(
    'profile-distill',
    '画像自蒸馏：提出待确认的稳定画像候选',
    `只从用户已经确认的笔记和长期行为证据中提炼画像候选。

读取 000_元数据/000_元数据：核心坐标.md，避免重复，并区分稳定画像与当前阶段。
每个候选包含：内容、证据路径、适用范围、失效条件、写入画像后会改善什么。
禁止从单次情绪或一次对话推断稳定人格；只提出候选，不写入画像。`,
  ),
  defineCommand(
    'discover',
    '发现式建档：发现值得建立的新主题',
    `在用户指定材料或最近笔记中寻找反复出现、且服务现实问题的主题：$ARGUMENTS

输出候选主题、涉及笔记、它解决的问题、为何不能只靠标签、建议的最小页面结构和现有相似页面。
避免为了分类而建档，不创建文件。`,
    '[范围]',
  ),
  defineCommand(
    'batch-clear',
    '批量清账：为积压内容制定分批处理清单',
    `分析用户指定目录或 Inbox 的积压内容：$ARGUMENTS

按“高价值低风险、高价值需确认、低价值可延后、明显噪音”分批。
列出每批文件、建议动作、预计收益和风险。
不得批量执行，等待用户选择批次。`,
    '[目录或范围]',
  ),
  defineCommand(
    'health-check',
    '系统体检：检查结构、属性、链接和知识回流',
    `对当前 vault 做只读体检。

检查：
- 主控台、每日笔记、Inbox、项目和永久笔记入口是否可达
- Markdown 属性是否完整且类型合理
- 失效链接、孤立笔记和空索引
- 活跃项目是否有下一步
- 最近两周是否产生知识回流
- 核心画像与 .second-brain 运行策略是否存在

输出健康项、风险项、证据路径，以及最多三个最值得修复的动作。
不要在体检过程中自动修复。`,
  ),
];

const KNOWLEDGE_COMMAND_MAP = new Map(
  KNOWLEDGE_COMMANDS.map((command) => [command.name.toLowerCase(), command]),
);

export const KNOWLEDGE_QUICK_ACTIONS = [
  { command: 'today', icon: 'calendar-days', label: '打开今日日记', description: '最常用：直接开始今天的记录', requiresInput: false },
  { command: 'dashboard', icon: 'gauge', label: '今日驾驶舱', description: '聚焦今天最重要的事', requiresInput: false },
  { command: 'digest', icon: 'inbox', label: '消化收件箱', description: '检查建议后，一键分流归位', requiresInput: false },
  { command: 'ask-vault', icon: 'search', label: '问问知识库', description: '基于笔记回答问题', requiresInput: true },
  { command: 'weekly', icon: 'calendar-check', label: '每周回顾', description: '发现模式与下周重点', requiresInput: false },
] as const;

export function getKnowledgeCommandsForDropdown(): SlashCommand[] {
  return KNOWLEDGE_COMMANDS.map((command) => ({ ...command }));
}

export function findKnowledgeCommand(name: string): SlashCommand | null {
  return KNOWLEDGE_COMMAND_MAP.get(name.trim().toLowerCase()) ?? null;
}
