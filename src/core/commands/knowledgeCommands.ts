import type { SlashCommand } from '../types';

const GOVERNANCE = `
你正在操作一个 Obsidian 外置第二大脑。当前仓库根目录就是 Obsidian vault。

运行纪律：
1. 按需读取 000_元数据/000_元数据：核心坐标.md 中的稳定画像和协作方式；当前进度读取 000_元数据/现状.md，再沿链接读取项目、行动、岗位待确认事项或技能地图的主记录。遵守 .second-brain/memory-policy.md 和 .second-brain/goals.md，避免无范围扫描整个库。
2. 分清事实、来源、推断和建议；每个重要结论都给出对应笔记路径。
3. 只读问题默认只生成分析和建议；用户已明确授权的修改任务在确认范围内直接执行，不重复索取同一批准。
4. 永久笔记、项目、决策和核心坐标属于长期记忆；没有当前任务的明确授权时不得写入。仅在实质信息缺口、扩大范围或新增权限时询问；写入前保留快照并检查同期修改。
5. 发现矛盾时并列原文与证据，表述为待核实问题，不擅自裁决。
6. 任何获准写入都应保持最小范围，并在完成后列出修改文件。
`.trim();

function prompt(task: string): string {
  return `${GOVERNANCE}

任务：
${task}`;
}

const NATURAL_KNOWLEDGE_INTENT_PATTERNS = [
  /(?:根据|结合|参考|检索|搜索|查找|查看|读取)(?:一下)?(?:我的|现有|已有|本地)?(?:笔记|第二大脑|知识库|资料库|Obsidian)/iu,
  /(?:从|在)(?:我的|现有|已有|本地)?(?:笔记|第二大脑|知识库|资料库|Obsidian)(?:里|中|内)/iu,
  /(?:我的|本地)(?:笔记|第二大脑|知识库|资料库)(?:里|中|内|记录的|已有的)/iu,
] as const;

const NATURAL_KNOWLEDGE_INSTRUCTIONS = `
用户明确要求依据自己的笔记、第二大脑或知识库回答。请自动进入问库模式：
1. 先检索与问题直接相关的 Vault 笔记，不无范围扫描全库。
2. 先直接回答，再列出支撑结论的笔记路径和对应事实。
3. 并列现有笔记中的冲突、过期信息或适用边界。
4. 没有足够库内证据时明确说明，不得用常识伪装成用户记忆。
5. 默认只回答，不修改文件；用户明确要求修改时仍遵守确认与快照规则。
`.trim();

export function shouldUseNaturalKnowledgeMode(input: string): boolean {
  const normalized = input.replace(/\s+/gu, ' ').trim();
  return NATURAL_KNOWLEDGE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function appendNaturalKnowledgeInstructions(input: string, content: string): string {
  if (!shouldUseNaturalKnowledgeMode(input)) return content;
  return `${content}\n\n${NATURAL_KNOWLEDGE_INSTRUCTIONS}`;
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
    'digest',
    '消化 Inbox：生成分流建议和下一步',
    `读取 010_收件箱/010_Inbox.md 以及 010_收件箱中尚未处理的普通笔记。

逐条输出建议表，字段为：编号、内容摘要、类型、为什么值得留下、建议去向、最小下一步、置信度。
类型只使用：立即行动、项目、领域或资料、永久笔记候选、输出候选、等待信息、可删除。
不要移动、删除或改写任何文件，等待用户按编号确认。`,
  ),
  defineCommand(
    'organize-recent-logs',
    '整理近期日志：同步整理个人日志与工作日志',
    `同时整理以下两个彼此独立的日志范围：

1. 个人每日行为日志：300_复盘与日志/310_每日笔记。
2. 工作日志：100_领域与职责/140_工作日志。

对两个范围分别定位最近一篇已完整填写各自四项“沉淀与回流”的日志，以其下一篇为起点，直到今天；不得把同一天的个人日志与工作日志合并。空白模板和只有模板占位符的文件不纳入。工作日志尚无已整理基准时，从第一篇非空工作日志开始。若任一范围的起点无法可靠判断，先列出该范围的候选文件和判断依据。

严格遵守系统中的 Daily Log Organization Contract，并把以下白名单视为本次命令的自包含强制规则：

- 个人日志只允许修改 frontmatter 的 updated、“沉淀与回流”中的“永久笔记、回到项目、领域或旧笔记、需要继续消化或核实、可以发展成输出”，以及目标笔记确实同步写入证据时追加的双向链接。
- 工作日志只允许修改 frontmatter 的 updated，以及“沉淀与回流”中的“加入行动工作台、更新技能或项目、值得单独整理的故障、其他可复用内容”。
- 工作日志中的班次、岗位、参与程度、安全与授权、今天做了什么、学到或注意到什么、问题与待办和下次继续全部保持原样；个人日志原有正文保护规则保持不变。
- 没有合理去向的回流项填写“暂无”，不得空置；不得创建月度索引或替代性汇总笔记。
- 需要创建行动、项目、技术排障笔记、永久笔记或修改其他长期记录时另列建议，不得夹带执行，也不得把“建议”写成“已完成”。

写入前建立快照，完成后按个人日志和工作日志分别执行逐文件差异校验。报告两个扫描范围、两类实际修改文件、未改正文验证、待确认建议、未解决项和回滚位置。`,
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
    'current-status',
    '分析现状：分析增量变化并提出全局进度同步方案',
    `依据库内现状、项目、行动与用户指定的近期日志分析新增事实，不依赖额外Skill。

先查明上次记录边界；缺少同步日期时明确所采用的时间范围，不声称全量扫描。输出来源路径、已确认变化、待核实冲突、带编号的全局进度差异表与建议修改的文件。
同一事件只计算一次，区分用户原文、推断和建议；不要从单次情绪推断人格或心理诊断。

不修改任何文件，也不推进同步游标。等待用户明确选择需要同步的项目，获批后只修改对应文件并核对链接。`,
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
  { command: 'work-log', icon: 'briefcase-business', label: '打开工作日志', description: '没有时自动创建今天的工作记录', requiresInput: false },
  { command: 'organize-recent-logs', icon: 'notebook-tabs', label: '整理近期日志', description: '同步整理个人日志与工作日志', requiresInput: false },
  { command: 'digest', icon: 'inbox', label: '消化收件箱', description: '检查建议后，一键分流归位', requiresInput: false },
  { command: 'current-status', icon: 'scan-search', label: '分析现状', description: '先分析变化，再确认同步进度', requiresInput: false },
] as const;

export function getKnowledgeCommandsForDropdown(): SlashCommand[] {
  return KNOWLEDGE_COMMANDS.map((command) => ({ ...command }));
}

export function findKnowledgeCommand(name: string): SlashCommand | null {
  return KNOWLEDGE_COMMAND_MAP.get(name.trim().toLowerCase()) ?? null;
}
