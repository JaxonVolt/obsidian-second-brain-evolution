/* eslint-disable simple-import-sort/imports */
import { spawn } from 'child_process';
import * as readline from 'readline';
import type { App, TFile } from 'obsidian';

import type SecondBrainPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import { buildCodexRuntimeProfile, getModelProviderRuntimeEnvironment } from '../model';
import { actionDecisionLabel, parseActionRecord } from './ActionWorkbenchService';
import { runAnalysisJob } from './AnalysisJobCoordinator';
import { formatLocalTimestamp } from './InboxCaptureService';
import { type OwnedTextChange, rollbackOwnedChanges, serializeVaultOperation, writeTextIfUnchanged } from './VaultMutation';

const ACTION_STATE_PATH = '.second-brain/runtime/action-lifecycle-state.json';
const ACTION_ROOT = '020_行动系统';
const NEXT_ACTIONS_PATH = `${ACTION_ROOT}/下一步行动.md`;
const PROJECT_INDEX_PATH = `${ACTION_ROOT}/项目清单.md`;
const WAITING_PATH = `${ACTION_ROOT}/等待与委托.md`;
const ACTIVE_PROJECTS_PREFIX = `${ACTION_ROOT}/活跃项目/`;
const WORKBENCH_ACTIONS_PREFIX = `${ACTION_ROOT}/行动记录/进行中/`;
const MAX_BATCH_FILES = 20;
const MAX_SIGNALS = 80;
const MAX_SIGNALS_PER_FILE = 8;

export type ActionLifecycleCategory = 'discovery' | 'progress';
export type ActionLifecycleStatus = 'pending' | 'snoozed' | 'kept' | 'dismissed' | 'applied' | 'invalidated';
export type ActionFeedbackReason = 'outdated' | 'incorrect' | 'not-action' | 'duplicate';
export type ActionProgressStatus =
  | 'not-started'
  | 'in-progress'
  | 'partial'
  | 'completed'
  | 'postponed'
  | 'waiting'
  | 'adjust-next'
  | 'abandoned';
export type ActionTemporalScope = 'now' | 'later' | 'conditional' | 'inspiration';
export type ActionSuggestionKind =
  | 'add-today'
  | 'add-week'
  | 'create-project'
  | 'remind'
  | 'keep'
  | 'dismiss'
  | 'complete'
  | 'partial'
  | 'postpone'
  | 'waiting'
  | 'adjust'
  | 'abandon';

type ProgressSuggestionKind = Extract<
  ActionSuggestionKind,
  'complete' | 'partial' | 'postpone' | 'waiting' | 'adjust' | 'abandon'
>;

export interface ActionLifecycleSettings {
  enabled: boolean;
  viewportItems: number;
}

export interface ActionEvidence {
  sourcePath: string;
  sourceLine: number;
  quote: string;
  contentSignature: string;
}

export interface ActionSuggestion {
  kind: ActionSuggestionKind;
  label: string;
  actionText?: string;
  projectName?: string;
  reminderDays?: number;
}

export interface ActionLocation {
  path: string;
  line: number;
  rawLine: string;
  section: string;
}

export interface ActionCatalogItem {
  id: string;
  persistent: boolean;
  text: string;
  section: string;
  status: ActionProgressStatus;
  signature: string;
  locations: ActionLocation[];
  projectPath?: string;
  context?: string;
}

export interface ActiveProjectSummary {
  path: string;
  name: string;
  goal: string;
  nextAction: string;
}

export interface ActionLifecycleRecord {
  id: string;
  localCandidateId: string;
  category: ActionLifecycleCategory;
  title: string;
  summary: string;
  rationale: string;
  confidence: number;
  temporalScope: ActionTemporalScope;
  evidence: ActionEvidence;
  actionText: string;
  projectName: string;
  nextActionText: string;
  progressStatus?: ActionProgressStatus;
  matchedActionId?: string;
  matchedActionSignature?: string;
  matchedProjectPath?: string;
  suggestions: ActionSuggestion[];
  status: ActionLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  snoozedUntil?: string;
  invalidatedReason?: 'source-missing-or-moved' | 'source-changed' | 'target-changed';
  appliedSuggestion?: ActionSuggestionKind;
  appliedPaths?: string[];
  snapshotPath?: string;
  feedbackReason?: ActionFeedbackReason;
  feedbackNote?: string;
}

interface NoteIndexRecord {
  mtime: number;
  size: number;
  fingerprint: string;
  analyzedFingerprint?: string;
}

interface ActionLifecycleStateFile {
  version: 1;
  initialized: boolean;
  notes: Record<string, NoteIndexRecord>;
  pendingPaths: string[];
  records: Record<string, ActionLifecycleRecord>;
  lastIndexedAt?: string;
  lastAnalysisDate?: string;
}

export interface LocalActionSignal {
  id: string;
  sourcePath: string;
  sourceLine: number;
  section: string;
  quote: string;
  context: string;
  hint: 'intent' | 'progress' | 'task';
  contentSignature: string;
}

export interface ActionLifecycleAnalysisResult {
  generated: number;
  processedNotes: number;
  remainingNotes: number;
  invalidated: number;
  records: ActionLifecycleRecord[];
}

export interface ActionLifecycleCenterResult {
  discoveries: ActionLifecycleRecord[];
  progress: ActionLifecycleRecord[];
  actions: ActionCatalogItem[];
  counts: {
    discoveries: number;
    progress: number;
    actions: number;
  };
  pendingNotes: number;
  viewportItems: number;
  initialized: boolean;
  analyzedNotes: number;
  invalidated: number;
}

export interface ActionPlanOverrides {
  actionText?: string;
  projectName?: string;
  reminderDate?: string;
  statusNote?: string;
  nextActionText?: string;
}

export interface ActionRecordEdits {
  title: string;
  summary: string;
  rationale: string;
  actionText: string;
  projectName: string;
  nextActionText: string;
}

export interface ActionPlanChange {
  operation: 'create' | 'modify';
  path: string;
  existed: boolean;
  before: string;
  after: string;
  baselineSignature: string;
}

export interface PreparedActionPlan {
  id: string;
  candidateId: string;
  suggestion: ActionSuggestionKind;
  title: string;
  summary: string;
  preview: string;
  changes: ActionPlanChange[];
  createdFolders: string[];
  reminderDate?: string;
}

export interface ActionPlanApplyResult {
  changedPaths: string[];
  snapshotPath?: string;
}

interface ModelActionResult {
  candidateId: string;
  type: ActionLifecycleCategory;
  title: string;
  summary: string;
  rationale: string;
  evidenceQuote: string;
  confidence: number;
  temporalScope: ActionTemporalScope;
  actionText: string;
  projectName: string;
  nextActionText: string;
  progressStatus?: ActionProgressStatus;
  matchedActionId?: string;
  matchedProjectPath?: string;
}

type ModelRunner = (prompt: string, mode: 'fast' | 'deep') => Promise<string>;

const INTENT_CUES = /想要|想做|一直想|打算|计划|准备|希望|有空|闲暇|之后|以后|明天|下周|下个月|需要|应该|记得|尝试|复刻|学习|完成|推进|优化|改进|后续/iu;
const PROGRESS_CUES = /已经完成|已完成|完成了|做完|推进了|开始了|进行中|部分完成|没做到|未完成|卡住|受阻|延期|推迟|等待|暂停|放弃|不再|改为|调整|取消|结束/iu;
const TEMPLATE_PLACEHOLDER = /^(?:[-*]\s*)?(?:未做到|原因|后续处理|起因|我做了|结果\s*\/\s*影响|困难|第一小步|明日最重要的一件事|明天明确不做|永久笔记|回到项目、领域或旧笔记|需要继续消化或核实|可以发展成输出)[：:]?\s*(?:继续\s*\/\s*调整\s*\/\s*放弃)?\s*$/u;
const ACTION_ID_PATTERN = /<!--\s*sb-action:(A-\d{8}-\d{3})\s*-->/iu;
const ACTION_STATUS_PATTERN = /<!--\s*sb-status:([a-z-]+)(?:;[^>]*)?\s*-->/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function computeActionContentSignature(content: string): string {
  return stableHash(content.replace(/\r\n/gu, '\n'));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/<!--[^>]*-->/gu, '')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/gu, '$1')
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()[\]【】<>《》_~`*#-]+/gu, '')
    .trim();
}

function cleanSingleLine(value: string, fallback: string): string {
  const cleaned = value.replace(/\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim();
  return (cleaned || fallback).slice(0, 180);
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|#^[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '');
  return cleaned.slice(0, 60) || '待命名项目';
}

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function compactDateKey(date: Date): string {
  return localDateKey(date).replace(/-/gu, '');
}

function snapshotStamp(date: Date): string {
  return formatLocalTimestamp(date).replace(/[-:T]/gu, '').slice(0, 14);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function parseDate(value: string | undefined): Date | null {
  const match = value?.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function stripActionMetadata(value: string): string {
  return value
    .replace(/<!--\s*sb-(?:action|status):[^>]+-->/giu, '')
    .replace(/\s*（来源：\[\[[^\]]+\]\]）\s*$/u, '')
    .trim();
}

function progressStatusFromLine(line: string, checked: boolean): ActionProgressStatus {
  const marker = line.match(ACTION_STATUS_PATTERN)?.[1];
  const allowed: ActionProgressStatus[] = [
    'not-started', 'in-progress', 'partial', 'completed', 'postponed', 'waiting', 'adjust-next', 'abandoned',
  ];
  if (marker && allowed.includes(marker as ActionProgressStatus)) return marker as ActionProgressStatus;
  return checked ? 'completed' : 'not-started';
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim());
}

function isTableDivider(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function updateFrontmatterDate(content: string, now: Date): string {
  const date = localDateKey(now);
  if (/^updated:\s*["']?\d{4}-\d{2}-\d{2}["']?\s*$/mu.test(content)) {
    return content.replace(/^updated:\s*["']?\d{4}-\d{2}-\d{2}["']?\s*$/mu, `updated: "${date}"`);
  }
  return content;
}

function sectionBounds(lines: string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s+/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function insertIntoSection(content: string, heading: string, line: string, subsection?: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/gu, '\n').split('\n');
  let bounds = sectionBounds(lines, heading);
  if (!bounds) {
    if (lines.at(-1)?.trim()) lines.push('');
    lines.push(`## ${heading}`, '', line, '');
    return lines.join(eol);
  }
  if (subsection) {
    const subsectionHeading = `### ${subsection}`;
    let subsectionStart = -1;
    for (let index = bounds.start + 1; index < bounds.end; index++) {
      if (lines[index].trim() === subsectionHeading) {
        subsectionStart = index;
        break;
      }
    }
    if (subsectionStart >= 0) {
      let insertAt = bounds.end;
      for (let index = subsectionStart + 1; index < bounds.end; index++) {
        if (/^###\s+/u.test(lines[index])) {
          insertAt = index;
          break;
        }
      }
      while (insertAt > subsectionStart + 1 && !lines[insertAt - 1].trim()) insertAt--;
      lines.splice(insertAt, 0, line);
      return lines.join(eol);
    }
    bounds = sectionBounds(lines, heading);
    const insertAt = bounds?.end ?? lines.length;
    lines.splice(insertAt, 0, '', subsectionHeading, '', line, '');
    return lines.join(eol);
  }
  let insertAt = bounds.end;
  while (insertAt > bounds.start + 1 && !lines[insertAt - 1].trim()) insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join(eol);
}

function appendProgressEntry(content: string, entry: string): string {
  return insertIntoSection(content, '进展记录', entry);
}

function replaceLine(content: string, lineNumber: number, expected: string, replacement: string | null): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/gu, '\n').split('\n');
  const expectedIndex = lineNumber - 1;
  const index = expectedIndex >= 0 && expectedIndex < lines.length && lines[expectedIndex] === expected
    ? expectedIndex
    : lines.findIndex((line) => line === expected);
  if (index < 0) throw new Error('目标行动已变化，请重新扫描后再执行。');
  if (replacement === null) lines.splice(index, 1);
  else lines[index] = replacement;
  return lines.join(eol);
}

function taskLine(text: string, actionId: string, sourcePath: string, status: ActionProgressStatus = 'not-started'): string {
  const source = sourcePath.replace(/\.md$/iu, '');
  const statusMarker = status === 'not-started' ? '' : ` <!-- sb-status:${status} -->`;
  return `- [ ] ${cleanSingleLine(text, '确认下一步')}（来源：[[${source}|来源]]） <!-- sb-action:${actionId} -->${statusMarker}`;
}

function compactPreview(changes: ActionPlanChange[]): string {
  const blocks: string[] = [];
  for (const change of changes) {
    if (!change.existed) {
      blocks.push(`${change.path}\n+ 新建文件\n${change.after.slice(0, 700)}`);
      continue;
    }
    const beforeLines = change.before.replace(/\r\n/gu, '\n').split('\n');
    const afterLines = change.after.replace(/\r\n/gu, '\n').split('\n');
    let first = 0;
    while (first < beforeLines.length && first < afterLines.length && beforeLines[first] === afterLines[first]) first++;
    let beforeEnd = beforeLines.length - 1;
    let afterEnd = afterLines.length - 1;
    while (beforeEnd >= first && afterEnd >= first && beforeLines[beforeEnd] === afterLines[afterEnd]) {
      beforeEnd--;
      afterEnd--;
    }
    const beforePart = beforeLines.slice(Math.max(0, first - 1), Math.min(beforeLines.length, beforeEnd + 2));
    const afterPart = afterLines.slice(Math.max(0, first - 1), Math.min(afterLines.length, afterEnd + 2));
    blocks.push([
      change.path,
      ...beforePart.map((line) => `- ${line}`),
      ...afterPart.map((line) => `+ ${line}`),
    ].join('\n').slice(0, 1200));
  }
  return blocks.join('\n\n');
}

function clampConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function asTemporalScope(value: unknown): ActionTemporalScope {
  return value === 'now' || value === 'later' || value === 'conditional' || value === 'inspiration'
    ? value
    : 'later';
}

function asProgressStatus(value: unknown): ActionProgressStatus | undefined {
  const allowed: ActionProgressStatus[] = [
    'not-started', 'in-progress', 'partial', 'completed', 'postponed', 'waiting', 'adjust-next', 'abandoned',
  ];
  return typeof value === 'string' && allowed.includes(value as ActionProgressStatus)
    ? value as ActionProgressStatus
    : undefined;
}

function suggestion(kind: ActionSuggestionKind, label: string, extra: Partial<ActionSuggestion> = {}): ActionSuggestion {
  return { kind, label, ...extra };
}

function discoverySuggestions(result: ModelActionResult): ActionSuggestion[] {
  const actionText = cleanSingleLine(result.actionText, result.title);
  const projectName = sanitizeFileName(result.projectName || result.title);
  if (result.temporalScope === 'conditional' || result.temporalScope === 'later') {
    return [
      suggestion('remind', '稍后提醒', { reminderDays: result.temporalScope === 'conditional' ? 30 : 7 }),
      suggestion('add-week', '加入本周', { actionText }),
      suggestion('keep', '保留为灵感'),
      suggestion('dismiss', '不是行动'),
    ];
  }
  if (result.temporalScope === 'inspiration') {
    return [
      suggestion('keep', '保留为灵感'),
      suggestion('add-week', '做一次 25 分钟验证', { actionText }),
      suggestion('create-project', '建立项目', { actionText, projectName }),
      suggestion('dismiss', '不是行动'),
    ];
  }
  return [
    suggestion('add-today', '加入今天', { actionText }),
    suggestion('add-week', '加入本周', { actionText }),
    suggestion('create-project', '建立项目', { actionText, projectName }),
    suggestion('dismiss', '不是行动'),
  ];
}

function progressSuggestions(result: ModelActionResult): ActionSuggestion[] {
  const preferred = result.progressStatus ?? 'partial';
  const orderByStatus: Record<ActionProgressStatus, ProgressSuggestionKind[]> = {
    'not-started': ['adjust', 'postpone', 'waiting', 'abandon'],
    'in-progress': ['partial', 'complete', 'adjust', 'postpone'],
    partial: ['partial', 'adjust', 'postpone', 'complete'],
    completed: ['complete', 'partial', 'adjust', 'postpone'],
    postponed: ['postpone', 'adjust', 'waiting', 'abandon'],
    waiting: ['waiting', 'postpone', 'adjust', 'abandon'],
    'adjust-next': ['adjust', 'partial', 'postpone', 'abandon'],
    abandoned: ['abandon', 'postpone', 'adjust', 'partial'],
  };
  const labels: Record<ProgressSuggestionKind, string> = {
    complete: '确认完成',
    partial: '同步部分进度',
    postpone: '延期处理',
    waiting: '转为等待',
    adjust: '调整下一步',
    abandon: '放弃该行动',
  };
  return orderByStatus[preferred].map((kind) => suggestion(kind, labels[kind], {
    actionText: cleanSingleLine(result.nextActionText || result.actionText, result.title),
  }));
}

export function extractLocalActionSignals(path: string, content: string): LocalActionSignal[] {
  const lines = content.replace(/\r\n/gu, '\n').split('\n');
  const signature = computeActionContentSignature(content);
  const signals: LocalActionSignal[] = [];
  const seen = new Set<string>();
  let section = '';
  let inFrontmatter = lines[0]?.trim() === '---';
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (index === 0 && inFrontmatter) continue;
    if (inFrontmatter) {
      if (raw.trim() === '---') inFrontmatter = false;
      continue;
    }
    const heading = raw.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('<!--') || trimmed.startsWith('> [!') || TEMPLATE_PLACEHOLDER.test(trimmed)) continue;
    const unchecked = trimmed.match(/^[-*]\s+\[\s\]\s+(.+?)\s*$/u);
    const quote = (unchecked?.[1] ?? trimmed.replace(/^[-*]\s+/u, '')).trim();
    if (quote.length < 4 || /^\[\[[^\]]+\]\](?:\s*[·|]\s*\[\[[^\]]+\]\])*$/u.test(quote)) continue;
    const hint = unchecked ? 'task' : PROGRESS_CUES.test(quote) ? 'progress' : INTENT_CUES.test(quote) ? 'intent' : null;
    if (!hint) continue;
    const normalized = normalizeText(quote);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const nearby = [lines[index - 1], raw, lines[index + 1]]
      .filter((line): line is string => Boolean(line?.trim()) && !line.trim().startsWith('<!--'))
      .join('\n')
      .slice(0, 700);
    signals.push({
      id: `signal-${stableHash(`${path}|${index + 1}|${normalized}`)}`,
      sourcePath: path,
      sourceLine: index + 1,
      section,
      quote: quote.slice(0, 360),
      context: nearby,
      hint,
      contentSignature: signature,
    });
    if (signals.length >= MAX_SIGNALS_PER_FILE) break;
  }
  return signals;
}

export function extractActionLifecycleJson(
  text: string,
  candidates: ReadonlyMap<string, LocalActionSignal>,
  actions: ReadonlyMap<string, ActionCatalogItem>,
  projects: ReadonlyMap<string, ActiveProjectSummary>,
  now = new Date(),
): ActionLifecycleRecord[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const raw = (fenced ?? text).trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('模型没有返回可识别的行动结果。');
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('行动结果格式不正确。');
  const timestamp = now.toISOString();
  const records: ActionLifecycleRecord[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const candidateId = typeof item.candidateId === 'string' ? item.candidateId.trim() : '';
    const candidate = candidates.get(candidateId);
    if (!candidate) continue;
    const confidence = clampConfidence(item.confidence);
    if (confidence < 0.6) continue;
    const requestedType = item.type === 'progress' ? 'progress' : 'discovery';
    const matchedActionId = typeof item.matchedActionId === 'string' ? item.matchedActionId.trim() : '';
    const matchedAction = matchedActionId ? actions.get(matchedActionId) : undefined;
    if (requestedType === 'progress' && !matchedAction) continue;
    const matchedProjectPath = typeof item.matchedProjectPath === 'string' && projects.has(item.matchedProjectPath)
      ? item.matchedProjectPath
      : undefined;
    const title = cleanSingleLine(typeof item.title === 'string' ? item.title : '', candidate.quote);
    const summary = cleanSingleLine(typeof item.summary === 'string' ? item.summary : '', candidate.quote);
    const evidenceQuote = typeof item.evidenceQuote === 'string' && candidate.context.includes(item.evidenceQuote.trim())
      ? item.evidenceQuote.trim()
      : candidate.quote;
    const result: ModelActionResult = {
      candidateId,
      type: requestedType,
      title,
      summary,
      rationale: cleanSingleLine(typeof item.rationale === 'string' ? item.rationale : '', '模型根据原文判断。'),
      evidenceQuote,
      confidence,
      temporalScope: asTemporalScope(item.temporalScope),
      actionText: cleanSingleLine(typeof item.actionText === 'string' ? item.actionText : '', title),
      projectName: sanitizeFileName(typeof item.projectName === 'string' ? item.projectName : title),
      nextActionText: cleanSingleLine(typeof item.nextActionText === 'string' ? item.nextActionText : '', title),
      progressStatus: asProgressStatus(item.progressStatus),
      matchedActionId: matchedAction?.id,
      matchedProjectPath,
    };
    records.push({
      id: `action-${stableHash(candidate.id)}`,
      localCandidateId: candidate.id,
      category: result.type,
      title: result.title,
      summary: result.summary,
      rationale: result.rationale,
      confidence: result.confidence,
      temporalScope: result.temporalScope,
      evidence: {
        sourcePath: candidate.sourcePath,
        sourceLine: candidate.sourceLine,
        quote: result.evidenceQuote,
        contentSignature: candidate.contentSignature,
      },
      actionText: result.actionText,
      projectName: result.projectName,
      nextActionText: result.nextActionText,
      progressStatus: result.progressStatus,
      matchedActionId: matchedAction?.id,
      matchedActionSignature: matchedAction?.signature,
      matchedProjectPath,
      suggestions: result.type === 'progress' ? progressSuggestions(result) : discoverySuggestions(result),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return records;
}

export class ActionLifecycleService {
  private state: ActionLifecycleStateFile | null = null;

  constructor(
    private app: App,
    private plugin: SecondBrainPlugin,
    private getSettings: () => ActionLifecycleSettings,
    private modelRunner?: ModelRunner,
  ) {}

  async analyze(includeHistorical = false, now = new Date()): Promise<ActionLifecycleAnalysisResult> {
    return runAnalysisJob(this.app, `actions-${includeHistorical ? 'all' : 'new'}`, () => this.analyzePrepared(includeHistorical, now));
  }

  private async analyzePrepared(includeHistorical: boolean, now: Date): Promise<ActionLifecycleAnalysisResult> {
    await this.refreshIndex(includeHistorical, now);
    const state = await this.loadState();
    const selected = state.pendingPaths
      .map((path) => this.findMarkdownFile(path))
      .filter((file): file is TFile => Boolean(file))
      .sort((left, right) => right.stat.mtime - left.stat.mtime)
      .slice(0, MAX_BATCH_FILES);
    if (selected.length === 0) {
      const invalidated = await this.validatePending(now);
      return { generated: 0, processedNotes: 0, remainingNotes: 0, invalidated, records: [] };
    }

    const signals: LocalActionSignal[] = [];
    const processedPaths = new Set<string>();
    const sourceContents = new Map<string, string>();
    for (const file of selected) {
      const content = await this.app.vault.cachedRead(file);
      sourceContents.set(file.path, content);
      signals.push(...extractLocalActionSignals(file.path, content));
      processedPaths.add(file.path);
      if (signals.length >= MAX_SIGNALS) break;
    }
    if (signals.length === 0) {
      await this.markAnalyzed(processedPaths, now);
      const invalidated = await this.validatePending(now);
      return {
        generated: 0,
        processedNotes: processedPaths.size,
        remainingNotes: (await this.loadState()).pendingPaths.length,
        invalidated,
        records: [],
      };
    }

    const actions = await this.loadActionCatalog();
    const projects = await this.loadActiveProjects();
    const prompt = this.buildPrompt(signals.slice(0, MAX_SIGNALS), actions, projects);
    const response = await (this.modelRunner ?? ((value, mode) => this.askModel(value, mode)))(prompt, 'fast');
    for (const [path, content] of sourceContents) {
      if (await this.app.vault.adapter.read(path) !== content) throw new Error(`分析期间来源已变化，请重新检查：${path}`);
    }
    const parsed = extractActionLifecycleJson(
      response,
      new Map(signals.map((signal) => [signal.id, signal])),
      new Map(actions.map((action) => [action.id, action])),
      new Map(projects.map((project) => [project.path, project])),
      now,
    );
    const generated: ActionLifecycleRecord[] = [];
    for (const record of parsed) {
      const previous = state.records[record.id];
      const unchanged = previous?.evidence.contentSignature === record.evidence.contentSignature;
      if (unchanged && ['pending', 'snoozed', 'kept', 'dismissed', 'applied'].includes(previous.status)) continue;
      state.records[record.id] = {
        ...record,
        createdAt: previous?.createdAt ?? record.createdAt,
      };
      generated.push(state.records[record.id]);
    }
    await this.markAnalyzed(processedPaths, now);
    const invalidated = await this.validatePending(now);
    return {
      generated: generated.length,
      processedNotes: processedPaths.size,
      remainingNotes: (await this.loadState()).pendingPaths.length,
      invalidated,
      records: generated,
    };
  }

  async getCenter(now = new Date()): Promise<ActionLifecycleCenterResult> {
    await this.refreshIndex(false, now);
    const state = await this.loadState();
    const reactivated = this.reactivateSnoozed(state, now);
    const invalidated = await this.validatePending(now);
    if (reactivated) await this.saveState();
    const actions = (await this.loadActionCatalog())
      .filter((item) => item.status !== 'completed' && item.status !== 'abandoned')
      .sort((left, right) => left.section.localeCompare(right.section) || left.text.localeCompare(right.text));
    const pending = Object.values(state.records)
      .filter((record) => record.status === 'pending')
      .sort((left, right) => right.confidence - left.confidence || right.updatedAt.localeCompare(left.updatedAt));
    const discoveries = pending.filter((record) => record.category === 'discovery');
    const progress = pending.filter((record) => record.category === 'progress');
    return {
      discoveries,
      progress,
      actions,
      counts: { discoveries: discoveries.length, progress: progress.length, actions: actions.length },
      pendingNotes: state.pendingPaths.length,
      viewportItems: Math.max(1, Math.min(10, this.getSettings().viewportItems)),
      initialized: state.initialized,
      analyzedNotes: Object.values(state.notes).filter((note) => note.analyzedFingerprint === note.fingerprint).length,
      invalidated,
    };
  }

  async getPendingCount(): Promise<number> {
    const center = await this.getCenter();
    return center.counts.discoveries + center.counts.progress;
  }

  async updateRecord(
    candidateId: string,
    edits: ActionRecordEdits,
    now = new Date(),
  ): Promise<ActionLifecycleRecord> {
    const state = await this.loadState();
    const record = state.records[candidateId];
    if (!record || record.status !== 'pending') throw new Error('这条建议已处理或已经失效。');
    await this.assertEvidenceCurrent(record);

    const actionText = cleanSingleLine(edits.actionText, record.actionText || record.title);
    const projectSource = edits.projectName.trim() || record.projectName.trim();
    const projectName = projectSource ? sanitizeFileName(projectSource) : '';
    const nextActionText = cleanSingleLine(edits.nextActionText, record.nextActionText || actionText);
    record.title = cleanSingleLine(edits.title, record.title);
    record.summary = cleanSingleLine(edits.summary, record.summary);
    record.rationale = cleanSingleLine(edits.rationale, record.rationale);
    record.actionText = actionText;
    record.projectName = projectName;
    record.nextActionText = nextActionText;
    record.updatedAt = now.toISOString();
    delete record.feedbackReason;
    delete record.feedbackNote;
    record.suggestions = record.suggestions.map((suggestion) => ({
      ...suggestion,
      ...(['add-today', 'add-week', 'create-project', 'adjust'].includes(suggestion.kind)
        ? { actionText }
        : {}),
      ...(suggestion.kind === 'create-project' ? { projectName } : {}),
    }));
    await this.saveState();
    return { ...record, suggestions: record.suggestions.map((suggestion) => ({ ...suggestion })) };
  }

  async dismissRecord(
    candidateId: string,
    reason: ActionFeedbackReason,
    note = '',
    now = new Date(),
  ): Promise<void> {
    const state = await this.loadState();
    const record = state.records[candidateId];
    if (!record || record.status !== 'pending') return;
    record.status = 'dismissed';
    record.feedbackReason = reason;
    record.feedbackNote = cleanSingleLine(note, '');
    record.updatedAt = now.toISOString();
    delete record.snoozedUntil;
    await this.saveState();
  }

  async restoreRecord(candidateId: string, now = new Date()): Promise<void> {
    const state = await this.loadState();
    const record = state.records[candidateId];
    if (!record || record.status !== 'dismissed') return;
    record.status = 'pending';
    record.updatedAt = now.toISOString();
    delete record.feedbackReason;
    delete record.feedbackNote;
    await this.saveState();
  }

  async snoozeRecord(candidateId: string, days: number, now = new Date()): Promise<void> {
    const state = await this.loadState();
    const record = state.records[candidateId];
    if (!record || record.status !== 'pending') return;
    const until = addDays(now, Math.max(1, days));
    until.setHours(9, 0, 0, 0);
    record.status = 'snoozed';
    record.snoozedUntil = until.toISOString();
    record.updatedAt = now.toISOString();
    await this.saveState();
  }

  async markAppliedExternally(candidateId: string, path: string, now = new Date()): Promise<void> {
    const state = await this.loadState();
    const record = state.records[candidateId];
    if (!record || record.status !== 'pending') return;
    record.status = 'applied';
    record.appliedSuggestion = record.category === 'discovery' ? 'add-week' : 'adjust';
    record.appliedPaths = path ? [path] : [];
    record.updatedAt = now.toISOString();
    delete record.snoozedUntil;
    await this.saveState();
  }

  async preparePlan(
    candidateId: string,
    suggestionKind: ActionSuggestionKind,
    overrides: ActionPlanOverrides = {},
    now = new Date(),
  ): Promise<PreparedActionPlan> {
    const state = await this.loadState();
    const record = state.records[candidateId];
    if (!record || record.status !== 'pending') throw new Error('这条建议已处理或已经失效。');
    await this.assertEvidenceCurrent(record);
    const allowed = new Set(record.suggestions.map((item) => item.kind));
    if (!allowed.has(suggestionKind)) throw new Error('该操作不属于当前建议范围。');
    const selected = record.suggestions.find((item) => item.kind === suggestionKind)!;
    const actionText = cleanSingleLine(overrides.actionText ?? selected.actionText ?? record.actionText, record.title);
    const projectName = sanitizeFileName(overrides.projectName ?? selected.projectName ?? record.projectName);
    const nextActionText = cleanSingleLine(overrides.nextActionText ?? record.nextActionText, actionText);
    const statusNote = cleanSingleLine(overrides.statusNote ?? '', record.summary);

    if (suggestionKind === 'remind' || suggestionKind === 'keep' || suggestionKind === 'dismiss') {
      const defaultDate = localDateKey(addDays(now, selected.reminderDays ?? 7));
      const reminderDate = suggestionKind === 'remind' ? (overrides.reminderDate || defaultDate) : undefined;
      if (reminderDate && !parseDate(reminderDate)) throw new Error('提醒日期格式应为 YYYY-MM-DD。');
      return {
        id: `plan-${stableHash(`${candidateId}|${suggestionKind}|${reminderDate ?? ''}`)}`,
        candidateId,
        suggestion: suggestionKind,
        title: selected.label,
        summary: suggestionKind === 'remind' ? `将在 ${reminderDate} 重新提醒。` : selected.label,
        preview: suggestionKind === 'remind' ? `不修改笔记；${reminderDate} 重新进入“遗漏事项”。` : '不修改笔记，只更新本地处理状态。',
        changes: [],
        createdFolders: [],
        reminderDate,
      };
    }

    const allActionContent = await this.readActionSystemContent();
    const actionId = this.nextActionId(allActionContent, now);
    const changes = suggestionKind === 'add-today' || suggestionKind === 'add-week'
      ? await this.planAddAction(record, suggestionKind, actionText, actionId, now)
      : suggestionKind === 'create-project'
        ? await this.planCreateProject(record, projectName, actionText, actionId, now)
        : await this.planProgressUpdate(record, suggestionKind, actionText, statusNote, nextActionText, actionId, now);
    return {
      id: `plan-${stableHash(`${candidateId}|${suggestionKind}|${changes.map((change) => change.baselineSignature).join('|')}`)}`,
      candidateId,
      suggestion: suggestionKind,
      title: selected.label,
      summary: `将修改 ${changes.length} 个文件；执行前会再次核对并创建快照。`,
      preview: compactPreview(changes),
      changes,
      createdFolders: changes
        .filter((change) => change.operation === 'create')
        .map((change) => change.path.split('/').slice(0, -1).join('/'))
        .filter((path, index, values) => path && values.indexOf(path) === index),
    };
  }

  async applyPlan(plan: PreparedActionPlan, now = new Date()): Promise<ActionPlanApplyResult> {
    return serializeVaultOperation(this.app, 'action-plan-apply', () => this.applyPreparedPlan(plan, now));
  }

  private async applyPreparedPlan(plan: PreparedActionPlan, now: Date): Promise<ActionPlanApplyResult> {
    const state = await this.loadState();
    const record = state.records[plan.candidateId];
    if (!record || record.status !== 'pending') throw new Error('这条建议已处理或已经失效。');
    await this.assertEvidenceCurrent(record);
    if (plan.changes.length === 0) {
      if (plan.suggestion === 'remind') {
        const until = parseDate(plan.reminderDate);
        if (!until) throw new Error('提醒日期无效。');
        until.setHours(9, 0, 0, 0);
        record.status = 'snoozed';
        record.snoozedUntil = until.toISOString();
      } else if (plan.suggestion === 'keep') {
        record.status = 'kept';
      } else if (plan.suggestion === 'dismiss') {
        record.status = 'dismissed';
      } else {
        throw new Error('该操作缺少写入计划。');
      }
      record.updatedAt = now.toISOString();
      record.appliedSuggestion = plan.suggestion;
      await this.saveState();
      return { changedPaths: [] };
    }

    const adapter = this.app.vault.adapter;
    for (const change of plan.changes) {
      const exists = await adapter.exists(change.path);
      const current = exists ? await adapter.read(change.path) : '';
      if (exists !== change.existed || computeActionContentSignature(current) !== change.baselineSignature) {
        throw new Error(`目标文件在预览后发生变化，已停止执行：${change.path}`);
      }
    }
    const snapshotPath = `.second-brain/snapshots/${snapshotStamp(now)}-action-${plan.id.replace(/^plan-/u, '')}`;
    await this.ensureFolder(snapshotPath);
    for (let index = 0; index < plan.changes.length; index++) {
      const change = plan.changes[index];
      if (change.existed) {
        await adapter.write(`${snapshotPath}/before-${String(index + 1).padStart(2, '0')}.md`, change.before);
      }
    }
    await adapter.write(`${snapshotPath}/manifest.json`, JSON.stringify({
      version: 1,
      createdAt: formatLocalTimestamp(now),
      candidateId: plan.candidateId,
      suggestion: plan.suggestion,
      changes: plan.changes.map((change, index) => ({
        path: change.path,
        existed: change.existed,
        backup: change.existed ? `before-${String(index + 1).padStart(2, '0')}.md` : null,
      })),
    }, null, 2));

    const createdFolders: string[] = [];
    const attempted: OwnedTextChange[] = [];
    const previousRecord = { ...record };
    try {
      for (const folder of plan.createdFolders) {
        if (!(await adapter.exists(folder))) {
          await this.ensureFolder(folder);
          createdFolders.push(folder);
        }
      }
      for (const change of plan.changes) {
        if (change.operation === 'create' && await adapter.exists(change.path)) {
          throw new Error(`目标文件已经存在：${change.path}`);
        }
        const owned = { path: change.path, before: change.existed ? change.before : null, after: change.after };
        attempted.push(owned);
        await writeTextIfUnchanged(this.app, owned.path, owned.before, owned.after);
      }
      for (const change of plan.changes) {
        const current = await adapter.read(change.path);
        if (current !== change.after) throw new Error(`写入校验失败：${change.path}`);
      }
      record.status = 'applied';
      record.updatedAt = now.toISOString();
      record.appliedSuggestion = plan.suggestion;
      record.appliedPaths = plan.changes.map((change) => change.path);
      record.snapshotPath = snapshotPath;
      await this.saveState();
    } catch (error) {
      const rollbackErrors = await rollbackOwnedChanges(this.app, attempted);
      for (const folder of createdFolders.reverse()) {
        try {
          if (await adapter.exists(folder)) await adapter.rmdir(folder, false);
        } catch {
          // An empty project folder is harmless if the adapter cannot remove it.
        }
      }
      state.records[plan.candidateId] = previousRecord;
      if (rollbackErrors.length) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason}；自动回滚存在异常：${rollbackErrors.join('；')}`);
      }
      throw error;
    }
    return { changedPaths: plan.changes.map((change) => change.path), snapshotPath };
  }

  async openRecordSource(record: ActionLifecycleRecord): Promise<void> {
    await this.app.workspace.openLinkText(record.evidence.sourcePath, '', false);
  }

  private async refreshIndex(includeHistorical: boolean, now: Date): Promise<{ changed: number }> {
    const state = await this.loadState();
    const files = this.getEligibleFiles();
    const currentPaths = new Set(files.map((file) => file.path));
    const firstRun = !state.initialized;
    let changed = 0;
    for (const file of files) {
      const fingerprint = `${file.stat.mtime}:${file.stat.size}`;
      const previous = state.notes[file.path];
      const isChanged = Boolean(previous && previous.fingerprint !== fingerprint);
      const isNewAfterInitialization = Boolean(!previous && state.initialized);
      state.notes[file.path] = {
        mtime: file.stat.mtime,
        size: file.stat.size,
        fingerprint,
        analyzedFingerprint: previous?.fingerprint === fingerprint ? previous.analyzedFingerprint : previous?.analyzedFingerprint,
      };
      const shouldQueue = includeHistorical
        ? state.notes[file.path].analyzedFingerprint !== fingerprint
        : isChanged || isNewAfterInitialization;
      if (shouldQueue) {
        state.pendingPaths.push(file.path);
        changed++;
      }
    }
    for (const path of Object.keys(state.notes)) {
      if (!currentPaths.has(path)) delete state.notes[path];
    }
    state.pendingPaths = [...new Set(state.pendingPaths)].filter((path) => currentPaths.has(path));
    state.initialized = true;
    state.lastIndexedAt = now.toISOString();
    if (firstRun && !includeHistorical) state.pendingPaths = [];
    await this.saveState();
    return { changed };
  }

  private getEligibleFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles()
      .filter((file) => this.isEligiblePath(file.path))
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
  }

  private isEligiblePath(path: string): boolean {
    if (!path.endsWith('.md') || path.startsWith('.')) return false;
    if (path === 'AGENTS.md' || path === 'README.md' || path === '欢迎.md') return false;
    if (path.endsWith('/README.md')) return false;
    if (path.startsWith(`${ACTION_ROOT}/`)) return false;
    if (path.startsWith('700_归档/') || path.startsWith('900_模板/') || path.startsWith('999_附件/')) return false;
    if (path === '000_元数据/001_大脑迭代日志/001_大脑迭代日志.md') return false;
    if (path === '000_元数据/002_第二大脑使用指南.md' || path === '000_元数据/003_微信Bot使用指南.md') return false;
    return true;
  }

  private findMarkdownFile(path: string): TFile | null {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    return abstract && 'extension' in abstract && abstract.extension === 'md' ? abstract as TFile : null;
  }

  private async markAnalyzed(paths: Set<string>, now: Date): Promise<void> {
    const state = await this.loadState();
    for (const path of paths) {
      const note = state.notes[path];
      if (note) note.analyzedFingerprint = note.fingerprint;
    }
    state.pendingPaths = state.pendingPaths.filter((path) => !paths.has(path));
    state.lastAnalysisDate = localDateKey(now);
    await this.saveState();
  }

  private buildPrompt(
    signals: LocalActionSignal[],
    actions: ActionCatalogItem[],
    projects: ActiveProjectSummary[],
  ): string {
    const signalPayload = signals.map((signal) => ({
      candidateId: signal.id,
      sourcePath: signal.sourcePath,
      sourceLine: signal.sourceLine,
      section: signal.section,
      hint: signal.hint,
      quote: signal.quote,
      context: signal.context,
    }));
    const actionPayload = actions.slice(0, 100).map((action) => ({
      id: action.id,
      text: action.text,
      section: action.section,
      status: action.status,
      context: action.context,
      paths: action.locations.map((location) => location.path),
    }));
    const projectPayload = projects.slice(0, 30);
    return [
      '你是个人第二大脑的行动发现与进度核对器。只分析下面提供的候选片段、当前行动和活跃项目，不读取其他文件、不调用工具、不修改内容。',
      '',
      '任务一：发现用户在日志或笔记中表达、但尚未进入行动系统的真实意图、想法或待办。',
      '任务二：发现对现有行动的完成、部分进展、延期、等待、调整或放弃证据。只有能匹配当前行动 id 时才输出 progress。',
      '忽略一次性叙事、消费念头、情绪感叹、模板占位、已经被后文明确解决或替代的旧问题。',
      '“闲暇时复刻一下贾维斯”属于可保留或做最小验证的兴趣，不应直接排进今天。',
      '“想买杯咖啡”一类故事细节不是长期行动。',
      '“工作后再独立居住并学做饭”属于条件性长期事项，不应直接排进今天。',
      '模糊文字不得判定行动已完成。没有足够证据就跳过，不要凑数量。',
      '',
      '严格只返回 JSON 数组，不要 Markdown。每项字段：',
      'candidateId、type、title、summary、rationale、evidenceQuote、confidence、temporalScope、actionText、projectName、nextActionText、progressStatus、matchedActionId、matchedProjectPath。',
      'type 只能是 discovery 或 progress；confidence 为 0 到 1。',
      'temporalScope 只能是 now、later、conditional、inspiration。',
      'progressStatus 只能是 not-started、in-progress、partial、completed、postponed、waiting、adjust-next、abandoned。',
      'evidenceQuote 必须逐字来自候选 context。matchedActionId 和 matchedProjectPath 必须来自所给列表；不匹配则留空。',
      'actionText 应是 25-60 分钟内可启动的具体动作；nextActionText 是同步进度后项目清单应显示的新下一步。',
      '',
      `候选片段：${JSON.stringify(signalPayload)}`,
      `当前行动：${JSON.stringify(actionPayload)}`,
      `活跃项目：${JSON.stringify(projectPayload)}`,
    ].join('\n');
  }

  private async askModel(prompt: string, mode: 'fast' | 'deep'): Promise<string> {
    const codexPath = this.plugin.getResolvedCodexCliPath();
    const vaultPath = getVaultPath(this.app);
    if (!codexPath || !vaultPath) throw new Error('未找到 Codex CLI，请先在插件设置中确认运行路径。');
    const runtimeProfile = buildCodexRuntimeProfile(this.plugin.settings, mode);
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const providerEnv = getModelProviderRuntimeEnvironment(this.plugin.settings, this.app.secretStorage);
    const env = {
      ...process.env,
      ...customEnv,
      ...providerEnv,
      PATH: getEnhancedPath(customEnv.PATH, codexPath),
    };
    const args = [
      ...runtimeProfile.rootArgs,
      '-s', 'read-only', '-C', vaultPath,
      'exec', '--model', runtimeProfile.model,
      ...runtimeProfile.execConfigArgs,
      '--skip-git-repo-check', '--json', '-',
    ];
    return new Promise<string>((resolve, reject) => {
      const child = spawn(codexPath, args, { cwd: vaultPath, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const stdout = readline.createInterface({ input: child.stdout });
      const stderr: string[] = [];
      const messages: string[] = [];
      const timeout = window.setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('行动扫描超时，请稍后重试。'));
      }, 150000);
      child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
      stdout.on('line', (line) => {
        try {
          const event: unknown = JSON.parse(line);
          if (!isRecord(event) || event.type !== 'item.completed' || !isRecord(event.item)) return;
          if (event.item.type === 'agent_message' && typeof event.item.text === 'string') messages.push(event.item.text);
        } catch {
          // Ignore non-JSON progress output.
        }
      });
      child.once('error', (error) => {
        window.clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        window.clearTimeout(timeout);
        stdout.close();
        if (code !== 0) {
          reject(new Error(stderr.join('').trim() || `Codex 退出码：${code}`));
          return;
        }
        const response = messages.join('\n').trim();
        if (!response) {
          reject(new Error('模型没有返回行动分析结果。'));
          return;
        }
        resolve(response);
      });
      child.stdin.end(prompt);
    });
  }

  private async loadActionCatalog(): Promise<ActionCatalogItem[]> {
    const grouped = new Map<string, ActionCatalogItem>();
    const files = this.app.vault.getMarkdownFiles().filter((file) => (
      file.path === NEXT_ACTIONS_PATH
      || (file.path.startsWith(ACTIVE_PROJECTS_PREFIX) && file.path.endsWith('.md'))
      || (file.path.startsWith(WORKBENCH_ACTIONS_PREFIX) && file.path.endsWith('.md'))
    ));
    const projectPaths = new Map(
      files
        .filter((file) => file.path.startsWith(ACTIVE_PROJECTS_PREFIX))
        .map((file) => [file.basename, file.path]),
    );
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const workbench = parseActionRecord(file.path, content);
      if (workbench) {
        const status: ActionProgressStatus = workbench.status === 'waiting' ? 'waiting' : 'not-started';
        grouped.set(workbench.id, {
          id: workbench.id,
          persistent: true,
          text: workbench.title,
          section: workbench.status,
          status,
          signature: computeActionContentSignature(`${file.path}|${content}`),
          locations: [{ path: file.path, line: 1, rawLine: `# ${workbench.title}`, section: workbench.status }],
          projectPath: workbench.project ? projectPaths.get(workbench.project) : undefined,
          context: [
            workbench.decision ? `当前处理方式：${actionDecisionLabel(workbench.decision)}` : '',
            workbench.currentConclusion ? `当前结论：${workbench.currentConclusion}` : '',
            workbench.decisionReason ? `变化原因：${workbench.decisionReason}` : '',
            workbench.reopenCondition ? `重新激活条件：${workbench.reopenCondition}` : '',
          ].filter(Boolean).join('；'),
        });
        continue;
      }
      const lines = content.replace(/\r\n/gu, '\n').split('\n');
      let section = '';
      for (let index = 0; index < lines.length; index++) {
        const heading = lines[index].match(/^#{2,6}\s+(.+?)\s*$/u);
        if (heading) {
          section = heading[1].trim();
          continue;
        }
        const task = lines[index].match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/u);
        if (!task) continue;
        const checked = task[1].toLowerCase() === 'x';
        const text = stripActionMetadata(task[2]);
        if (!text) continue;
        const persistentId = lines[index].match(ACTION_ID_PATTERN)?.[1];
        const id = persistentId ?? `legacy-${stableHash(`${file.path}|${section}|${normalizeText(text)}`)}`;
        const location: ActionLocation = { path: file.path, line: index + 1, rawLine: lines[index], section };
        const existing = grouped.get(id);
        if (existing) {
          existing.locations.push(location);
          existing.signature = computeActionContentSignature(existing.locations.map((item) => `${item.path}|${item.rawLine}`).join('\n'));
          if (file.path.startsWith(ACTIVE_PROJECTS_PREFIX)) existing.projectPath = file.path;
          continue;
        }
        grouped.set(id, {
          id,
          persistent: Boolean(persistentId),
          text,
          section,
          status: progressStatusFromLine(lines[index], checked),
          signature: computeActionContentSignature(`${file.path}|${lines[index]}`),
          locations: [location],
          projectPath: file.path.startsWith(ACTIVE_PROJECTS_PREFIX) ? file.path : undefined,
        });
      }
    }
    const waiting = this.findMarkdownFile(WAITING_PATH);
    if (waiting) {
      const content = await this.app.vault.cachedRead(waiting);
      const lines = content.replace(/\r\n/gu, '\n').split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim().startsWith('|')) continue;
        const cells = parseTableRow(lines[index]);
        if (cells.length < 4 || cells[0] === '事项' || isTableDivider(cells) || !cells[0]) continue;
        const persistentId = lines[index].match(ACTION_ID_PATTERN)?.[1];
        const text = stripActionMetadata(cells[0]);
        const id = persistentId ?? `legacy-${stableHash(`${WAITING_PATH}|${normalizeText(text)}`)}`;
        grouped.set(id, {
          id,
          persistent: Boolean(persistentId),
          text,
          section: '等待与委托',
          status: 'waiting',
          signature: computeActionContentSignature(`${WAITING_PATH}|${lines[index]}`),
          locations: [{ path: WAITING_PATH, line: index + 1, rawLine: lines[index], section: '等待与委托' }],
        });
      }
    }
    return [...grouped.values()];
  }

  private async loadActiveProjects(): Promise<ActiveProjectSummary[]> {
    const projects: ActiveProjectSummary[] = [];
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(ACTIVE_PROJECTS_PREFIX) && file.path.endsWith('.md'));
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      if (!/^type:\s*["']?project["']?\s*$/mu.test(content) || !/^status:\s*["']?active["']?\s*$/mu.test(content)) continue;
      const goal = content.match(/^(?:-\s*)?(?:目标结果|目标)[：:]\s*(.+?)\s*$/mu)?.[1]?.trim() ?? '';
      const nextSection = content.match(/^##\s+(?:当前)?下一步\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/mu)?.[1] ?? '';
      const nextAction = nextSection.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/mu)?.[1]?.trim() ?? '';
      projects.push({ path: file.path, name: file.basename, goal: goal.slice(0, 240), nextAction: nextAction.slice(0, 240) });
    }
    return projects;
  }

  private async validatePending(now: Date): Promise<number> {
    const state = await this.loadState();
    const actions = new Map((await this.loadActionCatalog()).map((action) => [action.id, action]));
    let invalidated = 0;
    for (const record of Object.values(state.records)) {
      if (record.status !== 'pending' && record.status !== 'snoozed') continue;
      const source = this.findMarkdownFile(record.evidence.sourcePath);
      let reason: ActionLifecycleRecord['invalidatedReason'];
      if (!source) {
        reason = 'source-missing-or-moved';
      } else {
        const content = await this.app.vault.cachedRead(source);
        if (computeActionContentSignature(content) !== record.evidence.contentSignature) reason = 'source-changed';
      }
      if (!reason && record.category === 'progress' && record.matchedActionId) {
        const action = actions.get(record.matchedActionId);
        if (!action || action.signature !== record.matchedActionSignature) reason = 'target-changed';
      }
      if (!reason) continue;
      record.status = 'invalidated';
      record.invalidatedReason = reason;
      record.updatedAt = now.toISOString();
      delete record.snoozedUntil;
      invalidated++;
    }
    if (invalidated > 0) await this.saveState();
    return invalidated;
  }

  private async assertEvidenceCurrent(record: ActionLifecycleRecord): Promise<void> {
    const source = this.findMarkdownFile(record.evidence.sourcePath);
    if (!source) throw new Error('来源笔记已经删除或移动，请重新扫描。');
    const content = await this.app.vault.cachedRead(source);
    if (computeActionContentSignature(content) !== record.evidence.contentSignature) {
      throw new Error('来源笔记内容已经变化，请重新扫描。');
    }
    if (record.category === 'progress' && record.matchedActionId) {
      const action = (await this.loadActionCatalog()).find((item) => item.id === record.matchedActionId);
      if (!action || action.signature !== record.matchedActionSignature) {
        throw new Error('目标行动已经变化，请重新扫描。');
      }
    }
  }

  private reactivateSnoozed(state: ActionLifecycleStateFile, now: Date): boolean {
    let changed = false;
    for (const record of Object.values(state.records)) {
      if (record.status !== 'snoozed' || !record.snoozedUntil) continue;
      if (new Date(record.snoozedUntil).getTime() > now.getTime()) continue;
      record.status = 'pending';
      record.updatedAt = now.toISOString();
      delete record.snoozedUntil;
      changed = true;
    }
    return changed;
  }

  private async planAddAction(
    record: ActionLifecycleRecord,
    kind: 'add-today' | 'add-week',
    actionText: string,
    actionId: string,
    now: Date,
  ): Promise<ActionPlanChange[]> {
    const before = await this.readRequired(NEXT_ACTIONS_PATH);
    if (kind === 'add-today') {
      const lines = before.replace(/\r\n/gu, '\n').split('\n');
      const bounds = sectionBounds(lines, '今天');
      const openTasks = bounds
        ? lines.slice(bounds.start + 1, bounds.end).filter((line) => /^\s*[-*]\s+\[\s\]\s+/u.test(line)).length
        : 0;
      if (openTasks >= 3) throw new Error('“今天”已有 3 项未完成行动，请改为加入本周或先调整现有事项。');
    }
    const line = taskLine(actionText, actionId, record.evidence.sourcePath);
    const after = updateFrontmatterDate(
      insertIntoSection(before, kind === 'add-today' ? '今天' : '本周', line, kind === 'add-week' ? '复盘新增' : undefined),
      now,
    );
    return [this.change('modify', NEXT_ACTIONS_PATH, true, before, after)];
  }

  private async planCreateProject(
    record: ActionLifecycleRecord,
    projectName: string,
    actionText: string,
    actionId: string,
    now: Date,
  ): Promise<ActionPlanChange[]> {
    const folder = `${ACTIVE_PROJECTS_PREFIX}${projectName}`;
    const projectPath = `${folder}/${projectName}.md`;
    if (await this.app.vault.adapter.exists(projectPath)) throw new Error(`项目已存在：${projectName}`);
    const date = localDateKey(now);
    const projectContent = [
      '---',
      'type: project',
      'status: active',
      `created: "${date}"`,
      `updated: "${date}"`,
      '---',
      '',
      `# ${projectName}`,
      '',
      '## 目标结果',
      '',
      `- ${record.summary}`,
      '',
      '## 下一步',
      '',
      taskLine(actionText, actionId, record.evidence.sourcePath),
      '',
      '## 进展记录',
      '',
      `- ${date}：由行动与复盘中心从 [[${record.evidence.sourcePath.replace(/\.md$/iu, '')}|来源笔记]] 建立。`,
      '',
    ].join('\n');
    const nextBefore = await this.readRequired(NEXT_ACTIONS_PATH);
    const nextAfter = updateFrontmatterDate(
      insertIntoSection(nextBefore, '本周', `${taskLine(actionText, actionId, record.evidence.sourcePath)} [[${projectName}]]`, '复盘新增'),
      now,
    );
    const indexBefore = await this.readRequired(PROJECT_INDEX_PATH);
    const row = `| [[${projectName}]] | ${record.summary.replace(/\|/gu, '／')} | ${actionText.replace(/\|/gu, '／')} | 待确认 |`;
    const indexAfter = updateFrontmatterDate(this.insertProjectRow(indexBefore, row), now);
    return [
      this.change('create', projectPath, false, '', projectContent),
      this.change('modify', NEXT_ACTIONS_PATH, true, nextBefore, nextAfter),
      this.change('modify', PROJECT_INDEX_PATH, true, indexBefore, indexAfter),
    ];
  }

  private async planProgressUpdate(
    record: ActionLifecycleRecord,
    kind: Exclude<ActionSuggestionKind, 'add-today' | 'add-week' | 'create-project' | 'remind' | 'keep' | 'dismiss'>,
    actionText: string,
    statusNote: string,
    nextActionText: string,
    generatedActionId: string,
    now: Date,
  ): Promise<ActionPlanChange[]> {
    const catalog = await this.loadActionCatalog();
    const action = catalog.find((item) => item.id === record.matchedActionId);
    if (!action) throw new Error('没有找到要同步的行动。');
    const stableId = action.persistent ? action.id : generatedActionId;
    const contents = new Map<string, string>();
    for (const location of action.locations) {
      if (!contents.has(location.path)) contents.set(location.path, await this.readRequired(location.path));
    }
    const sourceLink = `[[${record.evidence.sourcePath.replace(/\.md$/iu, '')}|来源]]`;
    const date = localDateKey(now);
    const statusByKind: Record<typeof kind, ActionProgressStatus> = {
      complete: 'completed',
      partial: 'partial',
      postpone: 'postponed',
      waiting: 'waiting',
      adjust: 'adjust-next',
      abandon: 'abandoned',
    };
    for (const location of [...action.locations].sort((left, right) => right.line - left.line)) {
      const current = contents.get(location.path)!;
      const prefix = location.rawLine.match(/^(\s*[-*]\s+)\[[ xX]\]\s+/u)?.[1] ?? '- ';
      const marker = `<!-- sb-action:${stableId} --> <!-- sb-status:${statusByKind[kind]}; updated:${date} -->`;
      let replacement: string | null;
      if (kind === 'complete') {
        replacement = `${prefix}[x] ${action.text}（${date} 根据 ${sourceLink} 确认完成） ${marker}`;
      } else if (kind === 'partial') {
        replacement = `${prefix}[ ] ${action.text}（部分进度：${statusNote}；${sourceLink}） ${marker}`;
      } else if (kind === 'adjust') {
        replacement = `${prefix}[ ] ${actionText}（由 ${sourceLink} 调整） ${marker}`;
      } else if (location.path === NEXT_ACTIONS_PATH) {
        replacement = null;
      } else if (kind === 'abandon') {
        replacement = `${prefix}[x] ${action.text}（已放弃：${statusNote}；${sourceLink}） ${marker}`;
      } else {
        replacement = `${prefix}[ ] ${action.text}（${kind === 'waiting' ? '等待' : '延期'}：${statusNote}；${sourceLink}） ${marker}`;
      }
      contents.set(location.path, replaceLine(current, location.line, location.rawLine, replacement));
    }

    if (kind === 'postpone') {
      const before = contents.get(NEXT_ACTIONS_PATH) ?? await this.readRequired(NEXT_ACTIONS_PATH);
      contents.set(NEXT_ACTIONS_PATH, insertIntoSection(
        before,
        '等待之后再做',
        `${taskLine(action.text, stableId, record.evidence.sourcePath, 'postponed')}（延期：${statusNote}）`,
      ));
    } else if (kind === 'abandon') {
      const before = contents.get(NEXT_ACTIONS_PATH) ?? await this.readRequired(NEXT_ACTIONS_PATH);
      contents.set(NEXT_ACTIONS_PATH, insertIntoSection(
        before,
        '已完成',
        `- [x] ${action.text}（已放弃：${statusNote}；${sourceLink}） <!-- sb-action:${stableId} --> <!-- sb-status:abandoned; updated:${date} -->`,
      ));
    } else if (kind === 'waiting') {
      const waitingBefore = await this.readRequired(WAITING_PATH);
      const followUp = localDateKey(addDays(now, 7));
      const row = `| ${action.text} <!-- sb-action:${stableId} --> | ${statusNote.replace(/\|/gu, '／')} | ${date} | ${followUp} |`;
      contents.set(WAITING_PATH, this.insertWaitingRow(waitingBefore, row));
    }

    const projectPath = record.matchedProjectPath;
    if (projectPath) {
      const projectBefore = contents.get(projectPath) ?? await this.readRequired(projectPath);
      const progressLabel: Record<typeof kind, string> = {
        complete: '完成', partial: '部分完成', postpone: '延期', waiting: '等待', adjust: '调整下一步', abandon: '放弃行动',
      };
      const projectAfter = updateFrontmatterDate(
        appendProgressEntry(projectBefore, `- ${date}：${progressLabel[kind]}“${action.text}”。证据：${sourceLink}。${statusNote}`),
        now,
      );
      contents.set(projectPath, projectAfter);

      const indexBefore = await this.readRequired(PROJECT_INDEX_PATH);
      const projectName = projectPath.split('/').pop()?.replace(/\.md$/iu, '') ?? '';
      const fallback = kind === 'complete' ? '阶段动作已完成，待确认下一步' : nextActionText;
      contents.set(PROJECT_INDEX_PATH, updateFrontmatterDate(
        this.updateProjectNextAction(indexBefore, projectName, nextActionText || fallback),
        now,
      ));
    }

    const changes: ActionPlanChange[] = [];
    for (const [path, afterRaw] of contents) {
      const before = await this.readRequired(path);
      const after = path === NEXT_ACTIONS_PATH ? updateFrontmatterDate(afterRaw, now) : afterRaw;
      if (before !== after) changes.push(this.change('modify', path, true, before, after));
    }
    if (changes.length === 0) throw new Error('没有生成可执行的同步修改。');
    return changes;
  }

  private insertProjectRow(content: string, row: string): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.replace(/\r\n/gu, '\n').split('\n');
    const bounds = sectionBounds(lines, '活跃项目');
    if (!bounds) return `${content.trimEnd()}${eol}${eol}## 活跃项目${eol}${eol}| 项目 | 目标结果 | 下一步 | 关联领域 |${eol}| --- | --- | --- | --- |${eol}${row}${eol}`;
    let insertAt = bounds.start + 1;
    for (let index = bounds.start + 1; index < bounds.end; index++) {
      if (lines[index].trim().startsWith('|')) insertAt = index + 1;
    }
    lines.splice(insertAt, 0, row);
    return lines.join(eol);
  }

  private insertWaitingRow(content: string, row: string): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.replace(/\r\n/gu, '\n').split('\n');
    const released = lines.findIndex((line) => /^##\s+已解除\b/u.test(line));
    let insertAt = released >= 0 ? released : lines.length;
    while (insertAt > 0 && !lines[insertAt - 1].trim()) insertAt--;
    lines.splice(insertAt, 0, row, '');
    return lines.join(eol);
  }

  private updateProjectNextAction(content: string, projectName: string, nextAction: string): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.replace(/\r\n/gu, '\n').split('\n');
    const rowIndex = lines.findIndex((line) => line.includes(`[[${projectName}]]`) && line.trim().startsWith('|'));
    if (rowIndex < 0) return content;
    const cells = parseTableRow(lines[rowIndex]);
    if (cells.length < 4 || isTableDivider(cells)) return content;
    cells[2] = cleanSingleLine(nextAction, '待确认下一步').replace(/\|/gu, '／');
    lines[rowIndex] = `| ${cells.join(' | ')} |`;
    return lines.join(eol);
  }

  private nextActionId(contents: string[], now: Date): string {
    const prefix = `A-${compactDateKey(now)}-`;
    const pattern = new RegExp(`${prefix}(\\d{3})`, 'gu');
    const sequences = contents.flatMap((content) => [...content.matchAll(pattern)]
      .map((match) => Number(match[1])).filter(Number.isFinite));
    return `${prefix}${String((sequences.length ? Math.max(...sequences) : 0) + 1).padStart(3, '0')}`;
  }

  private async readActionSystemContent(): Promise<string[]> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${ACTION_ROOT}/`));
    const contents: string[] = [];
    for (const file of files) contents.push(await this.app.vault.cachedRead(file));
    return contents;
  }

  private async readRequired(path: string): Promise<string> {
    if (!(await this.app.vault.adapter.exists(path))) throw new Error(`未找到行动系统文件：${path}`);
    return this.app.vault.adapter.read(path);
  }

  private change(
    operation: ActionPlanChange['operation'],
    path: string,
    existed: boolean,
    before: string,
    after: string,
  ): ActionPlanChange {
    return { operation, path, existed, before, after, baselineSignature: computeActionContentSignature(before) };
  }

  private async loadState(): Promise<ActionLifecycleStateFile> {
    if (this.state) return this.state;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(ACTION_STATE_PATH)) {
      try {
        const parsed: unknown = JSON.parse(await adapter.read(ACTION_STATE_PATH));
        if (isRecord(parsed) && parsed.version === 1) {
          this.state = {
            version: 1,
            initialized: parsed.initialized === true,
            notes: isRecord(parsed.notes) ? parsed.notes as Record<string, NoteIndexRecord> : {},
            pendingPaths: Array.isArray(parsed.pendingPaths)
              ? parsed.pendingPaths.filter((path): path is string => typeof path === 'string')
              : [],
            records: isRecord(parsed.records) ? parsed.records as Record<string, ActionLifecycleRecord> : {},
            lastIndexedAt: typeof parsed.lastIndexedAt === 'string' ? parsed.lastIndexedAt : undefined,
            lastAnalysisDate: typeof parsed.lastAnalysisDate === 'string' ? parsed.lastAnalysisDate : undefined,
          };
          return this.state;
        }
      } catch {
        // Malformed runtime state is rebuilt without touching visible notes.
      }
    }
    this.state = { version: 1, initialized: false, notes: {}, pendingPaths: [], records: {} };
    return this.state;
  }

  private async saveState(): Promise<void> {
    const state = await this.loadState();
    await this.ensureFolder('.second-brain/runtime');
    await this.app.vault.adapter.write(ACTION_STATE_PATH, JSON.stringify(state, null, 2));
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }
}
