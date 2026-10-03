import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import {
  type ActionWorkbenchService,
  isLongTermAction,
  isLongTermCompletedOn,
  isLongTermScheduledOn,
} from './ActionWorkbenchService';
import { serializeVaultOperation } from './VaultMutation';

const STATE_PATH = '.second-brain/runtime/action-reminder-state.json';

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimeKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface ReminderState {
  delivered: string[];
}

export class ActionReminderService {
  constructor(
    private app: App,
    private workbench: ActionWorkbenchService,
    private notify: (message: string) => void = (message) => { new Notice(message, 10_000); },
  ) {}

  async check(now = new Date()): Promise<number> {
    return serializeVaultOperation(this.app, 'action-reminders', () => this.checkDue(now));
  }

  private async checkDue(now: Date): Promise<number> {
    const state = await this.loadState();
    const delivered = new Set(state.delivered);
    const actions = (await this.workbench.listActions()).filter((action) => !['completed', 'cancelled'].includes(action.status));
    const validKeys = new Set(actions.map((action) => isLongTermAction(action)
      ? `${action.id}|${localDateKey(now)}|${action.preferredTime}`
      : `${action.id}|${action.reminderAt}`));
    for (const key of delivered) if (!validKeys.has(key)) delivered.delete(key);
    let count = 0;
    for (const action of actions) {
      if (isLongTermAction(action)) {
        if (!action.preferredTime
          || !isLongTermScheduledOn(action, now)
          || isLongTermCompletedOn(action, now)
          || localTimeKey(now) < action.preferredTime) continue;
        const key = `${action.id}|${localDateKey(now)}|${action.preferredTime}`;
        if (delivered.has(key)) continue;
        this.notify(`长期行动提醒：${action.title}`);
        delivered.add(key);
        count++;
        continue;
      }
      if (!action.reminderAt) continue;
      const dueAt = new Date(action.reminderAt);
      if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() > now.getTime()) continue;
      const key = `${action.id}|${action.reminderAt}`;
      if (delivered.has(key)) continue;
      const suffix = action.dueDate ? `（计划日期：${action.dueDate}）` : '';
      this.notify(`行动提醒：${action.title}${suffix}`);
      delivered.add(key);
      count++;
    }
    if (count > 0 || delivered.size !== state.delivered.length) {
      await this.saveState({ delivered: [...delivered] });
    }
    return count;
  }

  private async loadState(): Promise<ReminderState> {
    if (!(await this.app.vault.adapter.exists(STATE_PATH))) return { delivered: [] };
    try {
      const parsed = JSON.parse(await this.app.vault.adapter.read(STATE_PATH)) as Partial<ReminderState>;
      return {
        delivered: Array.isArray(parsed.delivered)
          ? parsed.delivered.filter((item): item is string => typeof item === 'string')
          : [],
      };
    } catch {
      return { delivered: [] };
    }
  }

  private async saveState(state: ReminderState): Promise<void> {
    await this.app.vault.adapter.write(STATE_PATH, JSON.stringify(state, null, 2));
  }
}
