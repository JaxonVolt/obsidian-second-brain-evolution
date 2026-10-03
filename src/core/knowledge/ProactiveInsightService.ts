/* eslint-disable simple-import-sort/imports */
import { spawn } from 'child_process';
import * as readline from 'readline';
import type { App, TFile } from 'obsidian';

import type SecondBrainPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import { buildCodexRuntimeProfile, getModelProviderRuntimeEnvironment } from '../model';
import { formatLocalTimestamp } from './InboxCaptureService';
import { SECOND_BRAIN_PATHS } from './SecondBrainInitializer';
import { runAnalysisJob } from './AnalysisJobCoordinator';
import { serializeVaultOperation } from './VaultMutation';

const INSIGHT_STATE_PATH = '.second-brain/runtime/insight-state.json';
const MAX_BATCH_NOTES = 28;
const MAX_NOTE_EXCERPT = 1800;

export type InsightKind =
  | 'repeat-pattern'
  | 'goal-behavior-gap'
  | 'contradiction'
  | 'cross-domain-link'
  | 'permanent-candidate'
  | 'evidence-gap';

export type InsightStatus = 'pending' | 'observing' | 'snoozed' | 'dismissed' | 'converted' | 'invalidated';
export type InsightTab = 'pending' | 'observing' | 'snoozed' | 'history';
export type InsightEvidenceInvalidReason = 'source-missing-or-moved' | 'content-changed';
export type InsightObservationRelation = 'supports' | 'contradicts' | 'context';
export type InsightResolution = 'action' | 'permanent' | 'observation' | 'dismissed';

export interface ProactiveInsightSettings {
  enabled: boolean;
  autoAnalyze: boolean;
  minChangedNotes: number;
  dailyLimit: number;
  viewportItems: number;
  startupNotice: boolean;
}

export interface InsightEvidence {
  sourcePath: string;
  quote: string;
  contentSignature?: string;
}

export interface InvalidInsightEvidence {
  sourcePath: string;
  reason: InsightEvidenceInvalidReason;
}

export interface InsightPermanentDraft {
  title: string;
  judgment: string;
  applicableConditions: string;
  exceptions: string;
  actionPrinciple: string;
}

export interface InsightObservationDraft {
  title: string;
  hypothesis: string;
  recordFields: string;
  targetEvidenceCount: number;
}

export interface InsightObservationMatch extends InsightEvidence {
  relation: InsightObservationRelation;
  note: string;
  recordedAt: string;
}

export interface InsightObservation {
  path: string;
  hypothesis: string;
  recordFields: string[];
  targetEvidenceCount: number;
  matches: InsightObservationMatch[];
  startedAt: string;
  lastMatchedAt?: string;
  readyForReview?: boolean;
}

export interface InsightRecord {
  id: string;
  candidateId: string;
  kind: InsightKind;
  title: string;
  summary: string;
  rationale: string;
  evidence: InsightEvidence[];
  counterEvidence: string;
  confidence: number;
  suggestedAction: string;
  status: InsightStatus;
  sourceSignature: string;
  createdAt: string;
  updatedAt: string;
  snoozedUntil?: string;
  statusBeforeSnooze?: 'pending' | 'observing';
  convertedTo?: string;
  resolution?: InsightResolution;
  observation?: InsightObservation;
  migratedFromAccepted?: boolean;
  invalidatedAt?: string;
  invalidEvidence?: InvalidInsightEvidence[];
}

interface NoteFingerprint {
  mtime: number;
  size: number;
}

interface InsightStateFile {
  version: 3;
  notes: Record<string, NoteFingerprint>;
  pendingPaths: string[];
  insights: Record<string, InsightRecord>;
  lastIndexedAt?: string;
  lastAnalysisDate?: string;
  lastAutoAttemptDate?: string;
}

export interface NoteSignal {
  path: string;
  title: string;
  domain: string;
  content: string;
  excerpt: string;
  terms: string[];
  contentSignature: string;
}

export interface LocalInsightCandidate {
  id: string;
  kind: InsightKind;
  topic: string;
  reason: string;
  sources: Array<Pick<NoteSignal, 'path' | 'title' | 'excerpt' | 'contentSignature'>>;
  sourceSignature: string;
}

export interface InsightPreparation {
  baselineEstablished: boolean;
  changedNotes: number;
  pendingNotes: number;
  processedPaths: string[];
  candidates: LocalInsightCandidate[];
}

export interface InsightAnalysisResult extends InsightPreparation {
  generated: number;
  observationMatches: number;
  invalidated: number;
  insights: InsightRecord[];
}

export interface InsightCenterResult {
  items: InsightRecord[];
  counts: Record<InsightTab, number>;
  pendingNotes: number;
  viewportItems: number;
  lastAnalysisDate?: string;
  invalidated: number;
}

interface EvidenceValidationResult {
  checked: number;
  invalidated: number;
  backfilled: number;
  changed: boolean;
}

interface LoadedEvidenceSource {
  file: TFile;
  content: string;
  contentSignature: string;
}

interface ParsedObservationMatch {
  observationId: string;
  sourcePath: string;
  quote: string;
  relation: InsightObservationRelation;
  note: string;
}

const KIND_LABELS: Record<InsightKind, string> = {
  'repeat-pattern': '重复模式',
  'goal-behavior-gap': '目标与行为偏差',
  contradiction: '观点或决策矛盾',
  'cross-domain-link': '跨领域连接',
  'permanent-candidate': '知识沉淀机会',
  'evidence-gap': '证据不足',
};

const TOPIC_KEYWORDS = [
  '电气', '自动化', 'PLC', 'DCS', '仪表', '现场', '故障', '安全', '学习', '训练',
  '项目', '行动', '目标', '决策', '工作', '职场', '表达', '沟通', '关系', '边界',
  '时间', '手机', '短视频', '睡眠', '轮班', '健康', '健身', '饮食', '财务', '副业',
  '家庭', '情绪', '复盘', '知识', '输出', '旅行',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function snapshotStamp(date: Date): string {
  return formatLocalTimestamp(date).replace(/[-:T]/gu, '').slice(0, 14);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function computeInsightContentSignature(content: string): string {
  return stableHash(content.replace(/\r\n/gu, '\n'));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()[\]【】<>《》_-]+/gu, '');
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
}

function titleFrom(path: string, content: string): string {
  const heading = stripFrontmatter(content).match(/^#\s+(.+)$/mu)?.[1]?.trim();
  if (heading) return heading;
  return path.split('/').pop()?.replace(/\.md$/iu, '') ?? path;
}

function domainFrom(path: string): string {
  return path.split('/')[0] ?? '';
}

function excerptFrom(content: string): string {
  const body = stripFrontmatter(content)
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[\[[^\]]+\]\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return body.slice(0, MAX_NOTE_EXCERPT);
}

function extractTerms(title: string, content: string): string[] {
  const values = new Set<string>();
  const source = `${title}\n${content}`;
  for (const keyword of TOPIC_KEYWORDS) {
    if (source.toLowerCase().includes(keyword.toLowerCase())) values.add(keyword);
  }
  for (const match of source.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/gu)) {
    const term = match[1].split('/').pop()?.trim();
    if (term && term.length >= 2 && term.length <= 24) values.add(term);
  }
  for (const match of source.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,30})/gmu)) {
    values.add(match[1]);
  }
  for (const match of `${title}\n${source.match(/^#{1,3}\s+.+$/gmu)?.join('\n') ?? ''}`
    .matchAll(/[A-Za-z][A-Za-z0-9+.#-]{2,30}/gu)) {
    values.add(match[0].toLowerCase());
  }
  return [...values].slice(0, 24);
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|#^[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '');
  return cleaned.slice(0, 70) || '洞察候选';
}

function clampConfidence(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

function isInsightKind(value: unknown): value is InsightKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KIND_LABELS, value);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function uniqueById(candidates: LocalInsightCandidate[]): LocalInsightCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

export function extractInsightJson(
  text: string,
  candidates: ReadonlyMap<string, LocalInsightCandidate>,
  now = new Date(),
): InsightRecord[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidateText = (fenced ?? text).trim();
  const start = candidateText.indexOf('[');
  const end = candidateText.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new Error('模型没有返回可识别的洞察结果。');
  }
  const parsed: unknown = JSON.parse(candidateText.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('洞察结果格式不正确。');

  const timestamp = now.toISOString();
  const records: InsightRecord[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const candidateId = typeof item.candidateId === 'string' ? item.candidateId.trim() : '';
    const sourceCandidate = candidates.get(candidateId);
    if (!sourceCandidate) continue;
    const kind = isInsightKind(item.kind) && item.kind === sourceCandidate.kind
      ? item.kind
      : sourceCandidate.kind;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    if (!title || !summary) continue;

    const allowedSources = new Map(sourceCandidate.sources.map((source) => [source.path, source]));
    const evidence: InsightEvidence[] = [];
    if (Array.isArray(item.evidence)) {
      for (const raw of item.evidence) {
        if (!isRecord(raw)) continue;
        const sourcePath = typeof raw.sourcePath === 'string' ? raw.sourcePath.trim() : '';
        const source = allowedSources.get(sourcePath);
        if (!source) continue;
        const proposed = typeof raw.quote === 'string' ? raw.quote.trim().slice(0, 160) : '';
        const quote = proposed && source.excerpt.includes(proposed)
          ? proposed
          : source.excerpt.slice(0, 120);
        if (quote) evidence.push({
          sourcePath,
          quote,
          contentSignature: source.contentSignature,
        });
      }
    }
    if (evidence.length === 0) {
      for (const source of sourceCandidate.sources.slice(0, 3)) {
        if (source.excerpt) evidence.push({
          sourcePath: source.path,
          quote: source.excerpt.slice(0, 120),
          contentSignature: source.contentSignature,
        });
      }
    }

    records.push({
      id: `insight-${stableHash(candidateId)}`,
      candidateId,
      kind,
      title,
      summary,
      rationale: typeof item.rationale === 'string' ? item.rationale.trim() : sourceCandidate.reason,
      evidence,
      counterEvidence: typeof item.counterEvidence === 'string' ? item.counterEvidence.trim() : '',
      confidence: clampConfidence(item.confidence),
      suggestedAction: typeof item.suggestedAction === 'string' ? item.suggestedAction.trim() : '',
      status: 'pending',
      sourceSignature: sourceCandidate.sourceSignature,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  if (records.length === 0) throw new Error('模型没有返回有效洞察。');
  return records;
}

export function extractObservationMatchJson(
  text: string,
  observations: ReadonlyMap<string, InsightRecord>,
  signals: ReadonlyMap<string, NoteSignal>,
): ParsedObservationMatch[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidateText = (fenced ?? text).trim();
  const start = candidateText.indexOf('[');
  const end = candidateText.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  const parsed: unknown = JSON.parse(candidateText.slice(start, end + 1));
  if (!Array.isArray(parsed)) return [];

  const matches: ParsedObservationMatch[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const observationId = typeof item.observationId === 'string' ? item.observationId.trim() : '';
    const sourcePath = typeof item.sourcePath === 'string' ? item.sourcePath.trim() : '';
    const observation = observations.get(observationId);
    const signal = signals.get(sourcePath);
    if (!observation?.observation || !signal) continue;
    const relation = item.relation === 'supports' || item.relation === 'contradicts' || item.relation === 'context'
      ? item.relation
      : null;
    if (!relation) continue;
    const proposed = typeof item.quote === 'string' ? item.quote.trim().slice(0, 180) : '';
    if (!proposed || !signal.content.includes(proposed)) continue;
    matches.push({
      observationId,
      sourcePath,
      quote: proposed,
      relation,
      note: typeof item.note === 'string' ? item.note.trim().slice(0, 240) : '',
    });
  }
  return matches;
}

export class ProactiveInsightService {
  private state: InsightStateFile | null = null;

  constructor(
    private app: App,
    private plugin: SecondBrainPlugin,
    private getSettings: () => ProactiveInsightSettings,
  ) {}

  async prepare(forceAll = false, now = new Date()): Promise<InsightPreparation> {
    const state = await this.loadState();
    const eligible = this.getEligibleFiles();
    const currentPaths = new Set(eligible.map((file) => file.path));
    const firstRun = Object.keys(state.notes).length === 0;
    const changed: TFile[] = [];

    for (const file of eligible) {
      const previous = state.notes[file.path];
      if (!previous || previous.mtime !== file.stat.mtime || previous.size !== file.stat.size) {
        changed.push(file);
      }
      state.notes[file.path] = { mtime: file.stat.mtime, size: file.stat.size };
    }
    for (const path of Object.keys(state.notes)) {
      if (!currentPaths.has(path)) delete state.notes[path];
    }

    if (firstRun && !forceAll) {
      state.pendingPaths = [];
      state.lastIndexedAt = now.toISOString();
      await this.saveState();
      return {
        baselineEstablished: true,
        changedNotes: 0,
        pendingNotes: 0,
        processedPaths: [],
        candidates: [],
      };
    }

    state.pendingPaths = [...new Set([
      ...state.pendingPaths.filter((path) => currentPaths.has(path)),
      ...changed.map((file) => file.path),
    ])];
    state.lastIndexedAt = now.toISOString();

    const selectedPaths = forceAll
      ? eligible.map((file) => file.path)
      : state.pendingPaths;
    const signals = await this.loadSignals(this.expandWithLinkedNotes(selectedPaths, eligible));
    const candidates = this.buildCandidates(signals);
    const pendingSet = new Set(state.pendingPaths);
    const processedPaths = signals
      .map((signal) => signal.path)
      .filter((path) => pendingSet.has(path));
    await this.saveState();
    return {
      baselineEstablished: false,
      changedNotes: changed.length,
      pendingNotes: state.pendingPaths.length,
      processedPaths,
      candidates,
    };
  }

  async analyze(forceAll = false, now = new Date()): Promise<InsightAnalysisResult> {
    return runAnalysisJob(this.app, `insights-${forceAll ? 'all' : 'new'}`, () => this.analyzePrepared(forceAll, now));
  }

  private async analyzePrepared(forceAll: boolean, now: Date): Promise<InsightAnalysisResult> {
    const preparation = await this.prepare(forceAll, now);
    if (preparation.baselineEstablished) {
      const validation = await this.revalidatePendingEvidence(now);
      return { ...preparation, generated: 0, observationMatches: 0, invalidated: validation.invalidated, insights: [] };
    }
    const observationMatches = await this.evaluateObservations(preparation.processedPaths, now);
    if (preparation.candidates.length === 0) {
      await this.markPendingPathsAnalyzed(preparation.processedPaths, now);
      const validation = await this.revalidatePendingEvidence(now);
      return { ...preparation, generated: 0, observationMatches, invalidated: validation.invalidated, insights: [] };
    }

    const settings = this.getSettings();
    const prompt = this.buildPrompt(preparation.candidates, settings.dailyLimit);
    const sources = new Map<string, string>();
    for (const path of preparation.processedPaths) sources.set(path, await this.app.vault.adapter.read(path));
    const response = await this.askModel(prompt, 'fast');
    for (const candidate of preparation.candidates) {
      for (const source of candidate.sources) {
        if (computeInsightContentSignature(await this.app.vault.adapter.read(source.path)) !== source.contentSignature) {
          throw new Error(`分析期间来源已变化，请重新检查：${source.path}`);
        }
      }
    }
    for (const [path, content] of sources) {
      if (await this.app.vault.adapter.read(path) !== content) throw new Error(`分析期间来源已变化，请重新检查：${path}`);
    }
    const candidateMap = new Map(preparation.candidates.map((candidate) => [candidate.id, candidate]));
    const parsed = extractInsightJson(response, candidateMap, now).slice(0, Math.max(1, settings.dailyLimit));
    const state = await this.loadState();
    const generated: InsightRecord[] = [];

    for (const insight of parsed) {
      const previous = state.insights[insight.id];
      if (previous?.sourceSignature === insight.sourceSignature
        && ['dismissed', 'converted'].includes(previous.status)) {
        continue;
      }
      if (previous?.sourceSignature === insight.sourceSignature
        && ['pending', 'observing', 'snoozed'].includes(previous.status)) {
        continue;
      }
      state.insights[insight.id] = {
        ...insight,
        createdAt: previous?.createdAt ?? insight.createdAt,
      };
      generated.push(state.insights[insight.id]);
    }
    await this.markPendingPathsAnalyzed(preparation.processedPaths, now);
    const validation = await this.revalidatePendingEvidence(now);
    return {
      ...preparation,
      generated: generated.length,
      observationMatches,
      invalidated: validation.invalidated,
      insights: generated,
    };
  }

  async getCenter(tab: InsightTab): Promise<InsightCenterResult> {
    const state = await this.loadState();
    const now = new Date();
    const reactivated = this.reactivateSnoozed(state, now);
    const validation = await this.validatePendingEvidence(state, now);
    if (reactivated || validation.changed) await this.saveState();

    const values = Object.values(state.insights);
    const counts: Record<InsightTab, number> = {
      pending: values.filter((item) => item.status === 'pending').length,
      observing: values.filter((item) => item.status === 'observing').length,
      snoozed: values.filter((item) => item.status === 'snoozed').length,
      history: values.filter((item) => ['dismissed', 'converted', 'invalidated'].includes(item.status)).length,
    };
    const items = values
      .filter((item) => this.belongsToTab(item, tab))
      .sort((left, right) => {
        if (left.confidence !== right.confidence) return right.confidence - left.confidence;
        return right.updatedAt.localeCompare(left.updatedAt);
      });
    return {
      items,
      counts,
      pendingNotes: state.pendingPaths.length,
      viewportItems: Math.max(1, Math.min(10, this.getSettings().viewportItems)),
      lastAnalysisDate: state.lastAnalysisDate,
      invalidated: validation.invalidated,
    };
  }

  async getPendingCount(): Promise<number> {
    return (await this.getCenter('pending')).counts.pending;
  }

  async shouldAutoAnalyze(now = new Date()): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.enabled || !settings.autoAnalyze) return false;
    const preparation = await this.prepare(false, now);
    if (preparation.baselineEstablished) return false;
    const state = await this.loadState();
    return preparation.pendingNotes >= Math.max(1, settings.minChangedNotes)
      && state.lastAnalysisDate !== dateKey(now)
      && state.lastAutoAttemptDate !== dateKey(now);
  }

  async claimAutomaticAttempt(now = new Date()): Promise<boolean> {
    return serializeVaultOperation(this.app, 'insight-auto-budget', async () => {
      const state = await this.loadState();
      if (state.lastAutoAttemptDate === dateKey(now)) return false;
      state.lastAutoAttemptDate = dateKey(now);
      await this.saveState();
      return true;
    });
  }

  async updateInsight(
    id: string,
    changes: Partial<Pick<InsightRecord, 'title' | 'summary' | 'suggestedAction'>>,
  ): Promise<void> {
    const state = await this.loadState();
    const insight = state.insights[id];
    if (!insight) return;
    insight.title = changes.title?.trim() || insight.title;
    insight.summary = changes.summary?.trim() || insight.summary;
    insight.suggestedAction = changes.suggestedAction?.trim() || insight.suggestedAction;
    insight.updatedAt = new Date().toISOString();
    if (insight.observation) {
      insight.observation.hypothesis = insight.summary;
      await this.syncObservationNote(insight, new Date());
    }
    await this.saveState();
  }

  async snooze(id: string, days: number, now = new Date()): Promise<void> {
    const state = await this.loadState();
    const insight = state.insights[id];
    if (!insight) return;
    const until = new Date(now);
    until.setDate(until.getDate() + Math.max(1, days));
    insight.statusBeforeSnooze = insight.status === 'observing' ? 'observing' : 'pending';
    insight.status = 'snoozed';
    insight.snoozedUntil = until.toISOString();
    insight.updatedAt = now.toISOString();
    await this.saveState();
  }

  async restore(id: string): Promise<void> {
    const state = await this.loadState();
    const insight = state.insights[id];
    if (!insight) return;
    const status = insight.statusBeforeSnooze ?? 'pending';
    delete insight.statusBeforeSnooze;
    await this.updateStatus(id, status);
  }

  async dismiss(id: string): Promise<void> {
    await this.updateStatus(id, 'dismissed', { resolution: 'dismissed' });
  }

  async convertToPermanent(
    id: string,
    draft?: InsightPermanentDraft,
    now = new Date(),
  ): Promise<string> {
    const insight = await this.requireProcessable(id);
    const contentDraft: InsightPermanentDraft = draft ?? {
      title: insight.title,
      judgment: insight.summary,
      applicableConditions: insight.rationale,
      exceptions: insight.counterEvidence,
      actionPrinciple: insight.suggestedAction,
    };
    const folder = SECOND_BRAIN_PATHS.permanentNotes;
    await this.ensureFolder(folder);
    const base = sanitizeFileName(contentDraft.title);
    let path = `${folder}/${base}.md`;
    let sequence = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = `${folder}/${base}-${sequence}.md`;
      sequence++;
    }
    const sources = [...new Set(insight.evidence.map((item) => item.sourcePath))]
      .map((source) => `- [[${source.replace(/\.md$/iu, '')}]]`)
      .join('\n');
    const content = [
      '---',
      'type: permanent-note',
      'status: active',
      'knowledge_stage: established',
      `created: ${dateKey(now)}`,
      `updated: ${dateKey(now)}`,
      `insight_id: ${quoteYaml(insight.id)}`,
      '---',
      '',
      `# ${contentDraft.title}`,
      '',
      '> [!info] 使用方式',
      '> 这是经过你确认的长期经验。AI 只能在问题相关时引用，并同时考虑适用条件和例外。',
      '',
      '## 核心经验',
      '',
      contentDraft.judgment,
      '',
      '## 适用条件',
      '',
      contentDraft.applicableConditions || '- 尚未明确，需要在后续使用中补充。',
      '',
      '## 例外与失效条件',
      '',
      contentDraft.exceptions || '- 尚未记录，遇到反例时应重新评估。',
      '',
      '## 行动原则',
      '',
      contentDraft.actionPrinciple || '- 根据具体情境判断，不机械套用。',
      '',
      '## 形成依据',
      '',
      insight.rationale || '- 待补充。',
      '',
      '## 反证',
      '',
      insight.counterEvidence || '- 尚未记录反证。',
      '',
      '## 来源',
      '',
      sources,
      '',
    ].join('\n');
    const snapshotPath = await this.writeSnapshot('insight-permanent', [{ action: 'create', path }], now);
    await this.app.vault.create(path, content);
    await this.markConverted(id, path, snapshotPath, now, 'permanent');
    return path;
  }

  async startObservation(id: string, draft: InsightObservationDraft, now = new Date()): Promise<string> {
    const insight = await this.requireProcessable(id);
    const folder = `${SECOND_BRAIN_PATHS.permanentNotes}/待验证经验`;
    await this.ensureFolder(folder);
    const existingPath = insight.observation?.path;
    let path = existingPath || `${folder}/${sanitizeFileName(draft.title)}.md`;
    if (!existingPath) {
      let sequence = 2;
      while (await this.app.vault.adapter.exists(path)) {
        path = `${folder}/${sanitizeFileName(draft.title)}-${sequence}.md`;
        sequence++;
      }
    }
    const recordFields = draft.recordFields
      .split(/\r?\n/u)
      .map((value) => value.replace(/^[-*]\s*/u, '').trim())
      .filter(Boolean)
      .slice(0, 12);
    insight.title = draft.title.trim() || insight.title;
    insight.summary = draft.hypothesis.trim() || insight.summary;
    insight.status = 'observing';
    insight.resolution = 'observation';
    insight.observation = {
      path,
      hypothesis: draft.hypothesis.trim() || insight.summary,
      recordFields: recordFields.length > 0 ? recordFields : ['场景', '具体行为', '我的回应', '结果'],
      targetEvidenceCount: Math.max(1, Math.min(20, Math.round(draft.targetEvidenceCount || 3))),
      matches: insight.observation?.matches ?? [],
      startedAt: insight.observation?.startedAt ?? now.toISOString(),
      readyForReview: false,
    };
    insight.updatedAt = now.toISOString();
    delete insight.snoozedUntil;
    const content = this.renderObservationNote(insight, now);
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (abstract && 'extension' in abstract && abstract.extension === 'md') {
      const file = abstract as TFile;
      const before = await this.app.vault.read(file);
      const after = this.replaceObservationManagedBlock(before, content);
      await this.writeSnapshot('insight-observation', [{ action: 'modify', path, before }], now);
      await this.app.vault.modify(file, after);
    } else {
      await this.writeSnapshot('insight-observation', [{ action: 'create', path }], now);
      await this.app.vault.create(path, content);
    }
    await this.saveState();
    return path;
  }

  async convertToAction(id: string, now = new Date()): Promise<string> {
    const insight = await this.requireProcessable(id);
    const path = SECOND_BRAIN_PATHS.nextActions;
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!abstract || !('extension' in abstract) || abstract.extension !== 'md') {
      throw new Error(`未找到下一步行动文件：${path}`);
    }
    const file = abstract as TFile;
    const before = await this.app.vault.read(file);
    const marker = `<!-- insight:${id} -->`;
    if (before.includes(marker)) {
      await this.markConverted(id, path, '', now, 'action');
      return path;
    }
    const task = `- [ ] ${insight.suggestedAction || insight.title} ${marker}`;
    const section = /^## 本周\s*$/mu;
    const match = section.exec(before);
    let after: string;
    if (match) {
      const sectionEnd = before.slice(match.index + match[0].length).search(/^##\s+/mu);
      const insertAt = sectionEnd < 0
        ? before.length
        : match.index + match[0].length + sectionEnd;
      after = `${before.slice(0, insertAt).trimEnd()}\n${task}\n\n${before.slice(insertAt).trimStart()}`;
    } else {
      after = `${before.trimEnd()}\n\n## 本周\n\n${task}\n`;
    }
    const snapshotPath = await this.writeSnapshot('insight-action', [{ action: 'modify', path, before }], now);
    await this.app.vault.modify(file, after);
    await this.markConverted(id, path, snapshotPath, now, 'action');
    return path;
  }

  async markActionConverted(id: string, path: string, now = new Date()): Promise<void> {
    await this.markConverted(id, path, '', now, 'action');
  }

  async markDecisionConverted(id: string, decisionId: string, now = new Date()): Promise<void> {
    await this.markConverted(id, `${SECOND_BRAIN_PATHS.decisions}#${decisionId}`, '', now, 'action');
  }

  private async evaluateObservations(paths: string[], now: Date): Promise<number> {
    const state = await this.loadState();
    const observations = new Map(Object.values(state.insights)
      .filter((item) => item.status === 'observing' && item.observation)
      .map((item) => [item.id, item]));
    if (observations.size === 0 || paths.length === 0) return 0;

    const files = paths
      .filter((path) => !path.startsWith(`${SECOND_BRAIN_PATHS.permanentNotes}/待验证经验/`))
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((file): file is TFile => Boolean(file && 'extension' in file && file.extension === 'md'));
    if (files.length === 0) return 0;
    const signals = await this.loadSignals(files);
    const signalMap = new Map(signals.map((signal) => [signal.path, signal]));
    const payload = [...observations.values()].map((item) => ({
      observationId: item.id,
      title: item.title,
      hypothesis: item.observation?.hypothesis,
      recordFields: item.observation?.recordFields,
      existingEvidence: item.observation?.matches.map((match) => ({
        sourcePath: match.sourcePath,
        quote: match.quote,
      })),
    }));
    const notePayload = signals.map((signal) => ({
      sourcePath: signal.path,
      title: signal.title,
      excerpt: signal.excerpt.slice(0, 1200),
    }));
    const prompt = [
      '你是记忆管家的待验证经验核对器。只判断新增笔记是否包含与观察主题直接相关的真实事件、结果或反例。',
      '普通计划、抽象议论、模板空白、重复旧证据和仅提到相似词的内容不能计数。不要读取其他文件或调用工具。',
      '严格只返回 JSON 数组。没有有效匹配时返回 []。',
      '每项字段：observationId、sourcePath、quote、relation、note。',
      'quote 必须逐字复制新增笔记中的一个短句；relation 只能是 supports、contradicts 或 context。',
      'supports 表示支持假设，contradicts 表示出现反例，context 表示相关事件但暂不能判断。',
      '',
      `观察主题：${JSON.stringify(payload)}`,
      `新增笔记：${JSON.stringify(notePayload)}`,
    ].join('\n');
    const response = await this.askModel(prompt, 'fast');
    const matches = extractObservationMatchJson(response, observations, signalMap);
    if (matches.length === 0) return 0;

    let added = 0;
    const changed = new Set<InsightRecord>();
    for (const match of matches) {
      const insight = observations.get(match.observationId);
      if (!insight?.observation) continue;
      const duplicate = insight.observation.matches.some((existing) => (
        existing.sourcePath === match.sourcePath && normalizeText(existing.quote) === normalizeText(match.quote)
      ));
      if (duplicate) continue;
      insight.observation.matches.push({
        sourcePath: match.sourcePath,
        quote: match.quote,
        relation: match.relation,
        note: match.note,
        contentSignature: signalMap.get(match.sourcePath)?.contentSignature,
        recordedAt: now.toISOString(),
      });
      insight.observation.lastMatchedAt = now.toISOString();
      insight.updatedAt = now.toISOString();
      added += 1;
      changed.add(insight);
    }
    for (const insight of changed) {
      if (!insight.observation) continue;
      const hasCounterexample = insight.observation.matches.some((match) => match.relation === 'contradicts');
      if (hasCounterexample || insight.observation.matches.length >= insight.observation.targetEvidenceCount) {
        insight.status = 'pending';
        insight.observation.readyForReview = true;
      }
      await this.syncObservationNote(insight, now);
    }
    await this.saveState();
    return added;
  }

  private renderObservationNote(insight: InsightRecord, now: Date): string {
    const observation = insight.observation;
    if (!observation) throw new Error('观察设置不存在。');
    return [
      '---',
      'type: experience-hypothesis',
      'status: observing',
      'knowledge_stage: hypothesis',
      `created: ${dateKey(new Date(observation.startedAt))}`,
      `updated: ${dateKey(now)}`,
      `insight_id: ${quoteYaml(insight.id)}`,
      '---',
      '',
      `# ${insight.title}`,
      '',
      this.renderObservationManagedBlock(insight),
      '',
      '## 我的补充',
      '',
      '> 这里可以手动补充背景或案例；管家更新证据时不会覆盖本节。',
      '',
    ].join('\n');
  }

  private renderObservationManagedBlock(insight: InsightRecord): string {
    const observation = insight.observation;
    if (!observation) throw new Error('观察设置不存在。');
    const progress = `${observation.matches.length}/${observation.targetEvidenceCount}`;
    const status = observation.readyForReview ? '已达到复盘条件，等待你重新决定' : `观察中，已记录 ${progress}`;
    const fields = observation.recordFields.map((field) => `- [ ] ${field}`).join('\n');
    const origins = insight.evidence.length > 0
      ? insight.evidence.map((item) => `- [[${item.sourcePath.replace(/\.md$/iu, '')}]]：${item.quote}`).join('\n')
      : '- 暂无。';
    const matches = observation.matches.length > 0
      ? observation.matches.map((item) => {
        const relation = item.relation === 'supports' ? '支持' : item.relation === 'contradicts' ? '反例' : '相关情境';
        const note = item.note ? `；管家说明：${item.note}` : '';
        return `- **${relation}** · [[${item.sourcePath.replace(/\.md$/iu, '')}]]：${item.quote}${note}`;
      }).join('\n')
      : '- 尚未发现新的真实事件。';
    return [
      '<!-- second-brain:observation:start -->',
      `> [!warning] 待验证经验 · ${status}`,
      '> 这是一条假设，不应当作已经成立的事实或绝对规则。',
      '',
      '## 待验证假设',
      '',
      observation.hypothesis,
      '',
      '## 每次记录',
      '',
      fields,
      '',
      '## 最初依据',
      '',
      origins,
      '',
      `## 新增证据（${progress}）`,
      '',
      matches,
      '',
      '## 达到条件后的处理',
      '',
      '- 重新检查支持证据、反例和适用边界。',
      '- 再决定沉淀为长期经验、继续观察、转成行动或放弃。',
      '<!-- second-brain:observation:end -->',
    ].join('\n');
  }

  private replaceObservationManagedBlock(before: string, generated: string): string {
    const block = generated.match(/<!-- second-brain:observation:start -->[\s\S]*?<!-- second-brain:observation:end -->/u)?.[0];
    if (!block) return before;
    const pattern = /<!-- second-brain:observation:start -->[\s\S]*?<!-- second-brain:observation:end -->/u;
    if (pattern.test(before)) return before.replace(pattern, block);
    return `${before.trimEnd()}\n\n${block}\n`;
  }

  private async syncObservationNote(insight: InsightRecord, now: Date): Promise<void> {
    const path = insight.observation?.path;
    if (!path) return;
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!abstract || !('extension' in abstract) || abstract.extension !== 'md') return;
    const file = abstract as TFile;
    const before = await this.app.vault.read(file);
    const after = this.replaceObservationManagedBlock(before, this.renderObservationNote(insight, now));
    if (after === before) return;
    await this.writeSnapshot('observation-evidence', [{ action: 'modify', path, before }], now);
    await this.app.vault.modify(file, after);
  }

  getKindLabel(kind: InsightKind): string {
    return KIND_LABELS[kind];
  }

  private getEligibleFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles()
      .filter((file) => this.isEligiblePath(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private isEligiblePath(path: string): boolean {
    if (path.startsWith('.')) return false;
    if (path === 'AGENTS.md' || path === 'README.md' || path === '欢迎.md') return false;
    if (path.endsWith('/README.md')) return false;
    if (path.startsWith('010_收件箱/')
      && !path.startsWith(`${SECOND_BRAIN_PATHS.sourceInbox}/`)) return false;
    if (path.startsWith('010_收件箱/微信附件/')) return false;
    if (path.startsWith(`${SECOND_BRAIN_PATHS.archive}/`)) return false;
    if (path.startsWith(`${SECOND_BRAIN_PATHS.templates}/`)) return false;
    if (path.startsWith(`${SECOND_BRAIN_PATHS.permanentNotes}/待验证经验/`)) return false;
    if (path.startsWith('999_附件/')) return false;
    if (path === SECOND_BRAIN_PATHS.iterationLog) return false;
    if (path === SECOND_BRAIN_PATHS.guide || path === '000_元数据/003_微信Bot使用指南.md') return false;
    return true;
  }

  private expandWithLinkedNotes(paths: string[], eligible: TFile[]): TFile[] {
    const eligibleByPath = new Map(eligible.map((file) => [file.path, file]));
    const selected = new Set(paths.filter((path) => eligibleByPath.has(path)));
    const links = this.app.metadataCache.resolvedLinks ?? {};
    for (const path of [...selected]) {
      for (const target of Object.keys(links[path] ?? {})) {
        if (eligibleByPath.has(target)) selected.add(target);
      }
      for (const [source, targets] of Object.entries(links)) {
        if (Object.prototype.hasOwnProperty.call(targets, path) && eligibleByPath.has(source)) selected.add(source);
      }
      if (selected.size >= MAX_BATCH_NOTES) break;
    }
    return [...selected]
      .map((path) => eligibleByPath.get(path))
      .filter((file): file is TFile => Boolean(file))
      .sort((left, right) => right.stat.mtime - left.stat.mtime)
      .slice(0, MAX_BATCH_NOTES);
  }

  private async loadSignals(files: TFile[]): Promise<NoteSignal[]> {
    const signals: NoteSignal[] = [];
    for (const file of files) {
      const rawContent = await this.app.vault.cachedRead(file);
      const content = rawContent.slice(0, 12000);
      const title = titleFrom(file.path, content);
      signals.push({
        path: file.path,
        title,
        domain: domainFrom(file.path),
        content,
        excerpt: excerptFrom(content),
        terms: extractTerms(title, content),
        contentSignature: computeInsightContentSignature(rawContent),
      });
    }
    return signals;
  }

  private buildCandidates(signals: NoteSignal[]): LocalInsightCandidate[] {
    const candidates: LocalInsightCandidate[] = [];
    const byTerm = new Map<string, NoteSignal[]>();
    for (const signal of signals) {
      for (const term of signal.terms) {
        const group = byTerm.get(term) ?? [];
        group.push(signal);
        byTerm.set(term, group);
      }
    }

    for (const [term, rawGroup] of byTerm) {
      const group = [...new Map(rawGroup.map((signal) => [signal.path, signal])).values()];
      if (group.length >= 3) {
        candidates.push(this.makeCandidate(
          'repeat-pattern',
          term,
          `“${term}”在 ${group.length} 篇笔记中重复出现，可能存在稳定模式。`,
          group.slice(0, 5),
        ));
        if (!group.some((signal) => signal.path.startsWith(`${SECOND_BRAIN_PATHS.permanentNotes}/`))) {
          candidates.push(this.makeCandidate(
            'permanent-candidate',
            term,
            `围绕“${term}”已经积累多份材料，可以判断是否值得形成永久笔记。`,
            group.slice(0, 5),
          ));
        }
      }
      const domains = new Set(group.map((signal) => signal.domain));
      if (group.length >= 2 && domains.size >= 2) {
        candidates.push(this.makeCandidate(
          'cross-domain-link',
          term,
          `“${term}”同时出现在 ${domains.size} 个领域，可能存在可复用连接。`,
          group.slice(0, 4),
        ));
      }
      if (group.length >= 2 && group.some((signal) => /但是|然而|相反|不再|改为|并非|否定/gu.test(signal.content))) {
        candidates.push(this.makeCandidate(
          'contradiction',
          term,
          `围绕“${term}”出现转折或否定表达，需要核对观点是否发生变化。`,
          group.slice(0, 4),
        ));
      }
      const goal = group.find((signal) => /目标|优先|计划|长期方向|必须完成/gu.test(signal.content));
      const behavior = group.find((signal) => /没做到|未完成|拖延|没有执行|中断|偏离/gu.test(signal.content));
      if (goal && behavior && goal.path !== behavior.path) {
        candidates.push(this.makeCandidate(
          'goal-behavior-gap',
          term,
          `关于“${term}”的目标表达与行为记录可能存在偏差，需要基于事实核对。`,
          [goal, behavior],
        ));
      }
    }

    for (const signal of signals) {
      const absoluteClaim = /一定|必须|总是|从不|必然|绝对|唯一/gu.test(signal.content);
      const evidence = /例如|数据|记录|结果|证据|来源|\[\[|https?:\/\//gu.test(signal.content);
      if (absoluteClaim && !evidence) {
        candidates.push(this.makeCandidate(
          'evidence-gap',
          signal.title,
          '笔记中存在强结论，但当前文本没有明显案例、数据或来源支撑。',
          [signal],
        ));
      }
    }

    const kindRank: Record<InsightKind, number> = {
      contradiction: 0,
      'goal-behavior-gap': 1,
      'repeat-pattern': 2,
      'permanent-candidate': 3,
      'cross-domain-link': 4,
      'evidence-gap': 5,
    };
    return uniqueById(candidates)
      .sort((left, right) => kindRank[left.kind] - kindRank[right.kind]
        || right.sources.length - left.sources.length)
      .slice(0, 12);
  }

  private makeCandidate(
    kind: InsightKind,
    topic: string,
    reason: string,
    sources: NoteSignal[],
  ): LocalInsightCandidate {
    const sourcePaths = sources.map((source) => source.path).sort();
    const sourceSignature = stableHash(sources
      .map((source) => `${source.path}:${stableHash(normalizeText(source.excerpt))}`)
      .sort()
      .join('|'));
    return {
      id: `candidate-${stableHash(`${kind}|${normalizeText(topic)}|${sourcePaths.join('|')}`)}`,
      kind,
      topic,
      reason,
      sources: sources.map(({ path, title, excerpt, contentSignature }) => ({
        path,
        title,
        excerpt,
        contentSignature,
      })),
      sourceSignature,
    };
  }

  private buildPrompt(candidates: LocalInsightCandidate[], dailyLimit: number): string {
    const payload = candidates.map((candidate) => ({
      candidateId: candidate.id,
      kind: candidate.kind,
      topic: candidate.topic,
      reason: candidate.reason,
      sources: candidate.sources.map((source) => ({
        path: source.path,
        title: source.title,
        excerpt: source.excerpt.slice(0, 900),
      })),
    }));
    return [
      '你是个人第二大脑的主动洞察分析器。只分析下面提供的候选和证据，不读取其他文件、不调用工具、不修改任何内容。',
      '',
      '目标是发现跨笔记的稳定模式、目标与行为偏差、真实矛盾、跨领域连接、知识沉淀机会和证据缺口。',
      '必须区分事实与推断。不要根据单次情绪推断人格，不要给出心理疾病标签，不要虚构用户背景。',
      '没有足够证据时应跳过候选，不要为了凑数量制造洞察。',
      `最多返回 ${Math.max(1, dailyLimit)} 条高价值洞察。`,
      '',
      '严格只返回 JSON 数组，不要 Markdown。每项字段：',
      'candidateId、kind、title、summary、rationale、evidence、counterEvidence、confidence、suggestedAction。',
      'evidence 是数组，每项包含 sourcePath 和 quote；quote 必须逐字复制来源摘录中的短句。',
      'confidence 为 0 到 1。counterEvidence 写明反证、边界或尚未确认之处。',
      '',
      `候选：${JSON.stringify(payload)}`,
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
        reject(new Error('洞察分析超时，请减少本次分析范围后重试。'));
      }, 150000);
      child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
      stdout.on('line', (line) => {
        try {
          const event: unknown = JSON.parse(line);
          if (!isRecord(event) || event.type !== 'item.completed' || !isRecord(event.item)) return;
          if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
            messages.push(event.item.text);
          }
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
          reject(new Error('模型没有返回洞察结果。'));
          return;
        }
        resolve(response);
      });
      child.stdin.end(prompt);
    });
  }

  private async markPendingPathsAnalyzed(paths: string[], now: Date): Promise<void> {
    const state = await this.loadState();
    const analyzed = new Set(paths);
    state.pendingPaths = state.pendingPaths.filter((path) => !analyzed.has(path));
    state.lastAnalysisDate = dateKey(now);
    await this.saveState();
  }

  private async revalidatePendingEvidence(now: Date): Promise<EvidenceValidationResult> {
    const state = await this.loadState();
    const validation = await this.validatePendingEvidence(state, now);
    if (validation.changed) await this.saveState();
    return validation;
  }

  private async validatePendingEvidence(
    state: InsightStateFile,
    now: Date,
  ): Promise<EvidenceValidationResult> {
    const result: EvidenceValidationResult = {
      checked: 0,
      invalidated: 0,
      backfilled: 0,
      changed: false,
    };
    const sourceCache = new Map<string, Promise<LoadedEvidenceSource | null>>();
    const loadSource = (path: string): Promise<LoadedEvidenceSource | null> => {
      const cached = sourceCache.get(path);
      if (cached) return cached;
      const loading = (async () => {
        const abstract = this.app.vault.getAbstractFileByPath(path);
        if (!abstract || !('extension' in abstract) || abstract.extension !== 'md') return null;
        const file = abstract as TFile;
        try {
          const content = await this.app.vault.cachedRead(file);
          return {
            file,
            content,
            contentSignature: computeInsightContentSignature(content),
          };
        } catch {
          return null;
        }
      })();
      sourceCache.set(path, loading);
      return loading;
    };

    const locateMovedLegacySource = async (quote: string): Promise<LoadedEvidenceSource | null> => {
      const normalizedQuote = normalizeText(quote);
      if (!normalizedQuote) return null;
      const matches: LoadedEvidenceSource[] = [];
      for (const file of this.app.vault.getMarkdownFiles()) {
        const source = await loadSource(file.path);
        if (!source || !normalizeText(source.content).includes(normalizedQuote)) continue;
        matches.push(source);
        if (matches.length > 1) return null;
      }
      return matches[0] ?? null;
    };

    for (const insight of Object.values(state.insights)) {
      if (insight.status !== 'pending' && insight.status !== 'observing') continue;
      result.checked += 1;
      const invalidEvidence: InvalidInsightEvidence[] = [];
      for (const evidence of insight.evidence) {
        let source = await loadSource(evidence.sourcePath);
        if (!source && insight.migratedFromAccepted) {
          source = await locateMovedLegacySource(evidence.quote);
          if (source) {
            evidence.sourcePath = source.file.path;
            evidence.contentSignature = source.contentSignature;
            result.backfilled += 1;
            result.changed = true;
          }
        }
        if (!source) {
          invalidEvidence.push({
            sourcePath: evidence.sourcePath,
            reason: 'source-missing-or-moved',
          });
          continue;
        }

        const normalizedQuote = normalizeText(evidence.quote);
        const quoteStillExists = normalizedQuote.length > 0
          && normalizeText(source.content).includes(normalizedQuote);
        if (!quoteStillExists) {
          invalidEvidence.push({ sourcePath: evidence.sourcePath, reason: 'content-changed' });
          continue;
        }

        if (evidence.contentSignature !== source.contentSignature) {
          evidence.contentSignature = source.contentSignature;
          result.backfilled += 1;
          result.changed = true;
        }
      }

      if (invalidEvidence.length === 0) continue;
      if (insight.status === 'observing') {
        insight.invalidEvidence = invalidEvidence;
        insight.updatedAt = now.toISOString();
        result.changed = true;
        continue;
      }
      insight.status = 'invalidated';
      insight.invalidEvidence = invalidEvidence;
      insight.invalidatedAt = now.toISOString();
      insight.updatedAt = now.toISOString();
      delete insight.snoozedUntil;
      if (insight.observation) await this.updateObservationDocumentStatus(insight, 'invalidated', '', now);
      result.invalidated += 1;
      result.changed = true;
    }
    return result;
  }

  private belongsToTab(insight: InsightRecord, tab: InsightTab): boolean {
    if (tab === 'history') return ['dismissed', 'converted', 'invalidated'].includes(insight.status);
    return insight.status === tab;
  }

  private reactivateSnoozed(state: InsightStateFile, now: Date): boolean {
    let changed = false;
    for (const insight of Object.values(state.insights)) {
      if (insight.status !== 'snoozed' || !insight.snoozedUntil) continue;
      if (new Date(insight.snoozedUntil).getTime() > now.getTime()) continue;
      insight.status = insight.statusBeforeSnooze ?? 'pending';
      delete insight.snoozedUntil;
      delete insight.statusBeforeSnooze;
      insight.updatedAt = now.toISOString();
      changed = true;
    }
    return changed;
  }

  private async updateStatus(
    id: string,
    status: InsightStatus,
    changes: Partial<Pick<InsightRecord, 'title' | 'summary' | 'suggestedAction' | 'resolution'>> = {},
  ): Promise<void> {
    const state = await this.loadState();
    const insight = state.insights[id];
    if (!insight) return;
    insight.status = status;
    insight.title = changes.title?.trim() || insight.title;
    insight.summary = changes.summary?.trim() || insight.summary;
    insight.suggestedAction = changes.suggestedAction?.trim() || insight.suggestedAction;
    if (changes.resolution) insight.resolution = changes.resolution;
    insight.updatedAt = new Date().toISOString();
    delete insight.snoozedUntil;
    if (status === 'dismissed' && insight.observation) {
      await this.updateObservationDocumentStatus(insight, 'dismissed', '', new Date());
    }
    await this.saveState();
  }

  private async requireProcessable(id: string): Promise<InsightRecord> {
    const state = await this.loadState();
    const insight = state.insights[id];
    if (!insight) throw new Error('没有找到这条洞察。');
    if (insight.status !== 'pending' && insight.status !== 'observing') {
      throw new Error('这条提醒已经处理，不能重复转化。');
    }
    return insight;
  }

  private async markConverted(
    id: string,
    target: string,
    _snapshotPath: string,
    now: Date,
    resolution: InsightResolution,
  ): Promise<void> {
    const state = await this.loadState();
    const insight = state.insights[id];
    if (!insight) return;
    insight.status = 'converted';
    insight.convertedTo = target;
    insight.resolution = resolution;
    insight.updatedAt = now.toISOString();
    if (insight.observation) await this.updateObservationDocumentStatus(insight, 'converted', target, now);
    await this.saveState();
  }

  private async updateObservationDocumentStatus(
    insight: InsightRecord,
    status: 'converted' | 'dismissed' | 'invalidated',
    target: string,
    now: Date,
  ): Promise<void> {
    const path = insight.observation?.path;
    if (!path) return;
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!abstract || !('extension' in abstract) || abstract.extension !== 'md') return;
    const file = abstract as TFile;
    const before = await this.app.vault.read(file);
    const statusLabel = status === 'converted' ? '已转化' : status === 'dismissed' ? '已放弃' : '证据失效';
    const targetLine = target ? `\n> 处理结果：[[${target.replace(/\.md$/iu, '')}]]` : '';
    let after = before.replace(/^status:\s*[^\r\n]+/mu, `status: ${status}`);
    const marker = '<!-- second-brain:observation:end -->';
    const outcome = `\n\n> [!info] 观察结束 · ${statusLabel}${targetLine}\n`;
    if (!after.includes(`观察结束 · ${statusLabel}`) && after.includes(marker)) {
      after = after.replace(marker, `${marker}${outcome}`);
    }
    if (after === before) return;
    await this.writeSnapshot('observation-status', [{ action: 'modify', path, before }], now);
    await this.app.vault.modify(file, after);
  }

  private async restoreObservationDocument(insight: InsightRecord, now: Date): Promise<void> {
    const path = insight.observation?.path;
    if (!path) return;
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!abstract || !('extension' in abstract) || abstract.extension !== 'md') return;
    const file = abstract as TFile;
    const before = await this.app.vault.read(file);
    let after = before.replace(/^status:\s*invalidated\s*$/mu, 'status: observing');
    after = after.replace(
      /\n\n> \[!info\] 观察结束 · 证据失效(?:\r?\n> 处理结果：[^\r\n]+)?\r?\n?/gu,
      '\n',
    );
    if (after === before) return;
    await this.writeSnapshot('observation-restore', [{ action: 'modify', path, before }], now);
    await this.app.vault.modify(file, after);
  }

  private async writeSnapshot(
    label: string,
    changes: Array<{ action: 'create' | 'modify'; path: string; before?: string }>,
    now: Date,
  ): Promise<string> {
    const snapshotPath = `.second-brain/snapshots/${snapshotStamp(now)}-${label}`;
    await this.ensureFolder(snapshotPath);
    await this.app.vault.adapter.write(`${snapshotPath}/manifest.json`, JSON.stringify({
      createdAt: formatLocalTimestamp(now),
      changes,
    }, null, 2));
    return snapshotPath;
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = path.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }

  private async loadState(): Promise<InsightStateFile> {
    if (this.state) return this.state;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(INSIGHT_STATE_PATH)) {
      try {
        const parsed: unknown = JSON.parse(await adapter.read(INSIGHT_STATE_PATH));
        if (isRecord(parsed) && (parsed.version === 1 || parsed.version === 2 || parsed.version === 3)) {
          const insights = isRecord(parsed.insights) ? parsed.insights as Record<string, InsightRecord> : {};
          let migrated = parsed.version !== 3;
          const observationsToRestore: InsightRecord[] = [];
          for (const insight of Object.values(insights)) {
            if ((insight.status as string) === 'accepted') {
              insight.status = 'pending';
              insight.migratedFromAccepted = true;
              insight.updatedAt = new Date().toISOString();
              migrated = true;
              continue;
            }
            if (parsed.version === 2 && insight.migratedFromAccepted && insight.status === 'invalidated') {
              insight.status = insight.observation ? 'observing' : 'pending';
              insight.updatedAt = new Date().toISOString();
              delete insight.invalidatedAt;
              delete insight.invalidEvidence;
              if (insight.observation) observationsToRestore.push(insight);
              migrated = true;
            }
          }
          this.state = {
            version: 3,
            notes: isRecord(parsed.notes) ? parsed.notes as Record<string, NoteFingerprint> : {},
            pendingPaths: Array.isArray(parsed.pendingPaths)
              ? parsed.pendingPaths.filter((path): path is string => typeof path === 'string')
              : [],
            insights,
            lastIndexedAt: typeof parsed.lastIndexedAt === 'string' ? parsed.lastIndexedAt : undefined,
            lastAnalysisDate: typeof parsed.lastAnalysisDate === 'string' ? parsed.lastAnalysisDate : undefined,
            lastAutoAttemptDate: typeof parsed.lastAutoAttemptDate === 'string' ? parsed.lastAutoAttemptDate : undefined,
          };
          for (const insight of observationsToRestore) {
            await this.restoreObservationDocument(insight, new Date());
          }
          if (await this.hydrateDurableObservations(this.state)) migrated = true;
          if (migrated) {
            await adapter.write(INSIGHT_STATE_PATH, JSON.stringify(this.state, null, 2));
          }
          return this.state;
        }
      } catch {
        // Rebuild malformed runtime state without touching visible notes.
      }
    }
    this.state = { version: 3, notes: {}, pendingPaths: [], insights: {} };
    if (await this.hydrateDurableObservations(this.state)) {
      await this.ensureFolder('.second-brain/runtime');
      await adapter.write(INSIGHT_STATE_PATH, JSON.stringify(this.state, null, 2));
    }
    return this.state;
  }

  private async hydrateDurableObservations(state: InsightStateFile): Promise<boolean> {
    const prefix = `${SECOND_BRAIN_PATHS.permanentNotes}/待验证经验/`;
    let changed = false;
    for (const file of this.app.vault.getMarkdownFiles().filter((item) => item.path.startsWith(prefix))) {
      let content = '';
      try {
        content = await this.app.vault.cachedRead(file);
      } catch {
        continue;
      }
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
      const status = frontmatter.match(/^status:\s*([^\r\n]+)/mu)?.[1]?.trim();
      if (status !== 'observing') continue;
      const insightId = frontmatter.match(/^insight_id:\s*"?([^"\r\n]+)"?/mu)?.[1]?.trim();
      if (!insightId) continue;
      const title = titleFrom(file.path, content);
      const hypothesis = content.match(/^## 待验证假设\s*\r?\n+([\s\S]*?)(?=^##\s+)/mu)?.[1]?.trim() ?? '';
      if (!hypothesis) continue;
      const fieldsSection = content.match(/^## 每次记录\s*\r?\n+([\s\S]*?)(?=^##\s+)/mu)?.[1] ?? '';
      const recordFields = [...fieldsSection.matchAll(/^- \[[ xX]\]\s+(.+)$/gmu)]
        .map((match) => match[1].trim())
        .filter(Boolean);
      const progress = content.match(/^## 新增证据（\d+\/(\d+)）/mu);
      const targetEvidenceCount = Math.max(1, Math.min(20, Number(progress?.[1]) || 3));
      const matches: InsightObservationMatch[] = [];
      for (const match of content.matchAll(/^- \*\*(支持|反例|相关情境)\*\* · \[\[([^\]]+)\]\]：(.+)$/gmu)) {
        const parts = match[3].split('；管家说明：');
        matches.push({
          sourcePath: `${match[2].replace(/\.md$/iu, '')}.md`,
          quote: parts[0].trim(),
          relation: match[1] === '支持' ? 'supports' : match[1] === '反例' ? 'contradicts' : 'context',
          note: parts.slice(1).join('；管家说明：').trim(),
          recordedAt: new Date(file.stat.mtime).toISOString(),
        });
      }
      const readyForReview = content.includes('已达到复盘条件');
      const existing = state.insights[insightId];
      if (existing) {
        if (existing.observation?.path === file.path && !existing.migratedFromAccepted) continue;
        existing.status = readyForReview ? 'pending' : 'observing';
        existing.title = title;
        existing.summary = hypothesis;
        existing.observation = {
          path: file.path,
          hypothesis,
          recordFields: recordFields.length > 0 ? recordFields : ['场景', '具体行为', '我的回应', '结果'],
          targetEvidenceCount,
          matches,
          startedAt: existing.observation?.startedAt ?? new Date(file.stat.ctime).toISOString(),
          lastMatchedAt: matches.at(-1)?.recordedAt,
          readyForReview,
        };
        existing.resolution = 'observation';
        existing.updatedAt = new Date(file.stat.mtime).toISOString();
      } else {
        state.insights[insightId] = {
          id: insightId,
          candidateId: `durable-${stableHash(file.path)}`,
          kind: 'evidence-gap',
          title,
          summary: hypothesis,
          rationale: '从待验证经验笔记恢复；达到条件前不作为确定结论。',
          evidence: [],
          counterEvidence: '',
          confidence: 0.5,
          suggestedAction: '继续记录真实事件、结果和反例。',
          status: readyForReview ? 'pending' : 'observing',
          sourceSignature: stableHash(file.path),
          createdAt: new Date(file.stat.ctime).toISOString(),
          updatedAt: new Date(file.stat.mtime).toISOString(),
          resolution: 'observation',
          observation: {
            path: file.path,
            hypothesis,
            recordFields: recordFields.length > 0 ? recordFields : ['场景', '具体行为', '我的回应', '结果'],
            targetEvidenceCount,
            matches,
            startedAt: new Date(file.stat.ctime).toISOString(),
            lastMatchedAt: matches.at(-1)?.recordedAt,
            readyForReview,
          },
        };
      }
      changed = true;
    }
    return changed;
  }

  private async saveState(): Promise<void> {
    const state = await this.loadState();
    await this.ensureFolder('.second-brain/runtime');
    await this.app.vault.adapter.write(INSIGHT_STATE_PATH, JSON.stringify(state, null, 2));
  }
}
