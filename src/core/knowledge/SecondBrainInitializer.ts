import type { App, DataAdapter } from 'obsidian';

const STATE_PATH = '.second-brain/onboarding.json';

export const SECOND_BRAIN_PATHS = {
  coreCoordinate: '000_元数据/000_元数据：核心坐标.md',
  iterationLog: '000_元数据/001_大脑迭代日志/001_大脑迭代日志.md',
  guide: '000_元数据/002_第二大脑使用指南.md',
  inbox: '010_收件箱/010_Inbox.md',
  rawInbox: '010_收件箱/原始输入_raw',
  sourceInbox: '010_收件箱/来源资料_sources',
  activeProjects: '020_行动系统/活跃项目',
  projectList: '020_行动系统/项目清单.md',
  nextActions: '020_行动系统/下一步行动.md',
  waiting: '020_行动系统/等待与委托.md',
  decisions: '020_行动系统/决策记录.md',
  areas: '100_领域与职责',
  dailyNotes: '300_复盘与日志/310_每日笔记',
  reflections: '300_复盘与日志/320_心智复盘',
  permanentNotes: '500_永久笔记与知识资产',
  outputs: '600_输出与作品',
  archive: '700_归档',
  templates: '900_模板',
} as const;

export type OnboardingStatus = 'pending' | 'dismissed' | 'completed';

interface OnboardingState {
  version: 1;
  status: Exclude<OnboardingStatus, 'pending'>;
  updatedAt: string;
}

export interface InitializationInspection {
  missingFolders: string[];
  missingFiles: string[];
  existingFiles: string[];
}

export interface InitializationResult extends InitializationInspection {
  createdFolders: string[];
  createdFiles: string[];
}

const DAILY_TEMPLATE = `---
type: daily-note
date: {{date}}
status: active
---

# {{date}}

## 今天做了什么

- 

## 今天没做到什么

- 

## 今天的想法

- 

## 待处理的事务

- [ ] 

## 行为与状态

- 精力：
- 情绪：
- 睡眠：

## 收尾

### 做事的前因后果

- 

### 遇到的困难

- 

### 学到或想明白了什么

- 

## 明日规划

- [ ] 

## 沉淀与回流

- 永久笔记候选：
- 需要回到项目或领域的内容：
- 仍需核实的问题：
`;

const PERMANENT_TEMPLATE = `---
type: permanent
status: active
created: {{date}}
source_note: ""
---

# {{title}}

## 核心判断


## 为什么成立


## 适用条件


## 失效条件或反例


## 来源与连接

- 来源：
- 相关笔记：
`;

const WEEKLY_TEMPLATE = `---
type: weekly-review
status: active
week: {{week}}
---

# 第 {{week}} 周回顾

## 本周实际发生了什么

- 

## 有效做法与反复阻塞

- 

## 项目与行动更新

- 

## 值得沉淀的内容

- 

## 下周三个优先事项

1. 
2. 
3. 

## 停止或暂缓

- 
`;

export const SKELETON_FOLDERS = [
  '000_元数据/001_大脑迭代日志',
  SECOND_BRAIN_PATHS.rawInbox,
  SECOND_BRAIN_PATHS.sourceInbox,
  '010_收件箱/微信附件',
  SECOND_BRAIN_PATHS.activeProjects,
  SECOND_BRAIN_PATHS.areas,
  SECOND_BRAIN_PATHS.dailyNotes,
  SECOND_BRAIN_PATHS.reflections,
  SECOND_BRAIN_PATHS.permanentNotes,
  SECOND_BRAIN_PATHS.outputs,
  SECOND_BRAIN_PATHS.archive,
  SECOND_BRAIN_PATHS.templates,
] as const;

export const SKELETON_FILES: Readonly<Record<string, string>> = {
  [SECOND_BRAIN_PATHS.coreCoordinate]: `---
type: system-coordinate
status: active
---

# 核心坐标

这里只维护较稳定、会影响长期协作的信息，不存放日常记录或临时情绪。

## 稳定画像

- 长期重视的事情：
- 已确认的优势：
- 需要长期管理的风险：

## 当前阶段

- 当前主线：
- 次要项目：
- 维护型习惯：
- 当前约束：

## 与 AI 和第二大脑的协作方式

- 希望 AI 如何表达：
- 哪些写入必须先确认：
- 哪些信息不应进入长期记忆：
`,
  [SECOND_BRAIN_PATHS.iterationLog]: `---
type: system-log
status: active
---

# 大脑迭代日志

只记录结构、规则和插件的重要变化，不记录普通笔记修改。
`,
  [SECOND_BRAIN_PATHS.guide]: `---
type: system-guide
status: active
---

# 第二大脑使用指南

1. 日常事实写入每日笔记。
2. 无法立即判断去向的内容先进入收件箱。
3. 使用“消化收件箱”生成建议，修改并确认后再归位。
4. 多步结果进入项目，单步动作进入下一步行动。
5. 跨事件可复用且条件清楚的判断，才沉淀为永久笔记。
6. 每周检查项目、阻塞、永久笔记候选和下周重点。

插件只补建缺失文件，不覆盖已有内容。
`,
  [SECOND_BRAIN_PATHS.inbox]: `---
type: inbox
status: active
---

# Inbox

临时内容可以写在这里，也可以通过插件通用输入框存入“原始输入_raw”。
`,
  [`${SECOND_BRAIN_PATHS.rawInbox}/README.md`]: `# 原始输入

插件的通用输入和微信文字会先原样保存在这里，确认分流后仍保留来源记录。
`,
  [`${SECOND_BRAIN_PATHS.sourceInbox}/README.md`]: `# 来源资料

保存尚未充分消化的文章、网页、书摘和外部资料。
`,
  [`${SECOND_BRAIN_PATHS.activeProjects}/README.md`]: `# 活跃项目

一个项目应有明确结果、当前状态和至少一个下一步行动。
`,
  [SECOND_BRAIN_PATHS.projectList]: `---
type: project-index
status: active
---

# 项目清单

## 活跃

- 

## 等待

- 

## 已完成

- 
`,
  [SECOND_BRAIN_PATHS.nextActions]: `---
type: action-list
status: active
---

# 下一步行动

- [ ] 
`,
  [SECOND_BRAIN_PATHS.waiting]: `---
type: waiting-list
status: active
---

# 等待与委托

- [ ] 等待事项｜责任人｜检查日期
`,
  [SECOND_BRAIN_PATHS.decisions]: `---
type: decision-index
status: active
---

# 决策记录

- 日期｜决策｜依据｜复查条件
`,
  [`${SECOND_BRAIN_PATHS.areas}/README.md`]: `# 领域与职责

这里保存需要长期维护、但没有明确结束日期的责任和知识领域。
`,
  [`${SECOND_BRAIN_PATHS.permanentNotes}/README.md`]: `# 永久笔记与知识资产

永久笔记应表达一个可复用判断，并写明依据、适用条件和失效条件。
`,
  [`${SECOND_BRAIN_PATHS.outputs}/README.md`]: `# 输出与作品

保存准备发布、交付或展示的成品。
`,
  [`${SECOND_BRAIN_PATHS.archive}/README.md`]: `# 归档

保存已经结束且不需要继续行动的材料。
`,
  [`${SECOND_BRAIN_PATHS.templates}/每日笔记模板.md`]: DAILY_TEMPLATE,
  [`${SECOND_BRAIN_PATHS.templates}/永久笔记模板.md`]: PERMANENT_TEMPLATE,
  [`${SECOND_BRAIN_PATHS.templates}/每周回顾模板.md`]: WEEKLY_TEMPLATE,
};

function timestamp(): string {
  return new Date().toISOString();
}

async function writeState(adapter: DataAdapter, status: Exclude<OnboardingStatus, 'pending'>): Promise<void> {
  const state: OnboardingState = { version: 1, status, updatedAt: timestamp() };
  await adapter.write(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export class SecondBrainInitializer {
  constructor(private app: App) {}

  async getStatus(): Promise<OnboardingStatus> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(STATE_PATH))) return 'pending';
    try {
      const state = JSON.parse(await adapter.read(STATE_PATH)) as Partial<OnboardingState>;
      return state.status === 'completed' || state.status === 'dismissed' ? state.status : 'pending';
    } catch {
      return 'pending';
    }
  }

  async inspect(): Promise<InitializationInspection> {
    const adapter = this.app.vault.adapter;
    const missingFolders: string[] = [];
    const missingFiles: string[] = [];
    const existingFiles: string[] = [];

    for (const folder of SKELETON_FOLDERS) {
      if (!(await adapter.exists(folder))) missingFolders.push(folder);
    }
    for (const path of Object.keys(SKELETON_FILES)) {
      if (await adapter.exists(path)) existingFiles.push(path);
      else missingFiles.push(path);
    }
    return { missingFolders, missingFiles, existingFiles };
  }

  async initialize(): Promise<InitializationResult> {
    const adapter = this.app.vault.adapter;
    const inspection = await this.inspect();
    const createdFolders: string[] = [];
    const createdFiles: string[] = [];

    for (const folder of SKELETON_FOLDERS) {
      await this.ensureFolder(adapter, folder, createdFolders);
    }
    for (const [path, content] of Object.entries(SKELETON_FILES)) {
      if (await adapter.exists(path)) continue;
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent) await this.ensureFolder(adapter, parent, createdFolders);
      await adapter.write(path, content);
      createdFiles.push(path);
    }

    await writeState(adapter, 'completed');
    return { ...inspection, createdFolders, createdFiles };
  }

  async dismiss(): Promise<void> {
    await writeState(this.app.vault.adapter, 'dismissed');
  }

  async markCompletedIfReady(): Promise<boolean> {
    const inspection = await this.inspect();
    const ready = inspection.missingFolders.length === 0 && inspection.missingFiles.length === 0;
    if (ready) await writeState(this.app.vault.adapter, 'completed');
    return ready;
  }

  private async ensureFolder(adapter: DataAdapter, path: string, created: string[]): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await adapter.exists(current)) continue;
      await adapter.mkdir(current);
      created.push(current);
    }
  }
}
