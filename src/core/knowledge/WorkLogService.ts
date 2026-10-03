import type { App } from 'obsidian';

export const WORK_LOG_ROOT = '100_领域与职责/140_工作日志';
export const WORK_LOG_INDEX = `${WORK_LOG_ROOT}/140_工作日志.md`;
export const WORK_LOG_TEMPLATE = '900_模板/11_工作日志模板.md';

export const DEFAULT_WORK_LOG_TEMPLATE = `---
type: "work-log"
status: "active"
area: "career-tech"
date: "{{date:YYYY-MM-DD}}"
created: "{{date:YYYY-MM-DD}}"
updated: "{{date:YYYY-MM-DD}}"
---

# {{date:YYYY-MM-DD}} 工作日志

> [!tip] 最低完成线
> 忙的时候只写“今天做了什么”和“下次继续什么”。

## 基本信息

- 班次：
- 岗位：
- 参与程度：旁观 / 协助 / 在指导下完成 / 独立完成

## 今天做了什么

-

## 学到或注意到什么

-

## 安全与授权

- 今天确认的要求：
- 仍需询问或确认：

## 问题与待办

- [ ]

## 下次继续

-

## 沉淀与回流

- 加入行动工作台：
- 更新技能或项目：
- 值得单独整理的故障：
- 其他可复用内容：

[[300_复盘与日志/310_每日笔记/{{date:YYYY-MM}}/{{date:YYYY-MM-DD}}|今日日记]]
`;

export const DEFAULT_WORK_LOG_INDEX = `---
type: "work-log-index"
status: "active"
area: "career-tech"
---

# 140_工作日志

这里按日期记录每天实际完成的工作、学到的内容、待处理问题和下一步。

- 每天一篇，按月份存放。
- 忙的时候只写“今天做了什么”和“下次继续什么”。
- 值得完整复盘的问题另行整理为有来源链接的专题笔记。
`;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatWorkLogDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatWorkLogPath(date: Date): string {
  const day = formatWorkLogDate(date);
  return `${WORK_LOG_ROOT}/${day.slice(0, 7)}/${day}.md`;
}

function renderTemplate(template: string, day: string): string {
  return template
    .replace(/\{\{date:YYYY-MM-DD\}\}/gu, day)
    .replace(/\{\{date:YYYY-MM\}\}/gu, day.slice(0, 7));
}

export interface WorkLogOpenResult {
  path: string;
  created: boolean;
}

export class WorkLogService {
  constructor(private app: App) {}

  async openOrCreate(now = new Date()): Promise<WorkLogOpenResult> {
    const adapter = this.app.vault.adapter;
    const path = formatWorkLogPath(now);
    const day = formatWorkLogDate(now);

    await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
    await this.ensureSupportingFiles();

    const created = !(await adapter.exists(path));
    if (created) {
      const template = await adapter.read(WORK_LOG_TEMPLATE);
      await adapter.write(path, renderTemplate(template, day));
    }

    await this.app.workspace.openLinkText(path, '', false);
    return { path, created };
  }

  private async ensureSupportingFiles(): Promise<void> {
    const adapter = this.app.vault.adapter;
    await this.ensureFolder(WORK_LOG_ROOT);
    await this.ensureFolder(WORK_LOG_TEMPLATE.slice(0, WORK_LOG_TEMPLATE.lastIndexOf('/')));
    if (!(await adapter.exists(WORK_LOG_TEMPLATE))) {
      await adapter.write(WORK_LOG_TEMPLATE, DEFAULT_WORK_LOG_TEMPLATE);
    }
    if (!(await adapter.exists(WORK_LOG_INDEX))) {
      await adapter.write(WORK_LOG_INDEX, DEFAULT_WORK_LOG_INDEX);
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    let current = '';
    for (const segment of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }
}
