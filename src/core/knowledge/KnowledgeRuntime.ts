import type { App, DataAdapter } from 'obsidian';

const RUNTIME_DIR = '.second-brain';

const PROFILE = `# 画像兼容入口

个人画像的唯一权威来源：000_元数据/000_元数据：核心坐标.md。

读取其中的“稳定画像、当前阶段、与 AI 和第二大脑的协作方式”。不要在本文件重复维护画像；画像候选经用户确认后，直接更新核心坐标。
`;

const CURRENT_CONTEXT = `# 当前阶段兼容入口

当前阶段的唯一权威来源：000_元数据/000_元数据：核心坐标.md 的“当前阶段”。

阶段事实发生变化时，经用户确认后更新核心坐标，不在本文件建立副本。
`;

const GOALS = `# 目标评估规则

具体阶段目标以 000_元数据/000_元数据：核心坐标.md 的“当前阶段”和活跃项目为准。本文件只保留目标判断方法：

1. 区分可控过程、外部结果、最低成功线、现实目标和挑战目标。
2. 优先推动当前绝对主线，并要求产生可验证成果。
3. 职务、收入和评价受外部条件影响，不能包装成必然结果。
4. 同时只保留一个绝对主线、一个次要项目和少量维护型习惯。
5. 连续数周只有计划和系统整理、没有实操或输出时，停止扩建系统并回到现实任务。
`;

const WORK_MODE = `# 协作方式兼容入口

协作方式的唯一权威来源：000_元数据/000_元数据：核心坐标.md 的“与 AI 和第二大脑的协作方式”。

不要在本文件重复维护沟通偏好和执行规则。
`;

const MEMORY_POLICY = `# 记忆写入政策

1. 原始输入、外部资料和单次情绪不自动进入长期记忆。
2. 画像、永久笔记、项目与决策的写入必须先给出来源、用途和失效条件。
3. 未经用户明确确认，不移动、删除、合并或大改已有笔记。
4. 矛盾应保留双方证据并标为待核实，不自动裁决。
5. 获准写入后只执行最小范围改动，并列出文件清单。
`;

async function ensureFile(adapter: DataAdapter, path: string, content: string): Promise<void> {
  if (!(await adapter.exists(path))) {
    await adapter.write(path, content);
  }
}

export async function ensureKnowledgeRuntime(app: App): Promise<void> {
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(RUNTIME_DIR))) {
    await adapter.mkdir(RUNTIME_DIR);
  }

  await ensureFile(adapter, `${RUNTIME_DIR}/profile.md`, PROFILE);
  await ensureFile(adapter, `${RUNTIME_DIR}/current-context.md`, CURRENT_CONTEXT);
  await ensureFile(adapter, `${RUNTIME_DIR}/goals.md`, GOALS);
  await ensureFile(adapter, `${RUNTIME_DIR}/work-mode.md`, WORK_MODE);
  await ensureFile(adapter, `${RUNTIME_DIR}/memory-policy.md`, MEMORY_POLICY);
}
