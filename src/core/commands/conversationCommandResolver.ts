import { expandSlashCommandTemplate, parseSlashCommandInvocation } from '../../utils/slashCommand';
import type { SlashCommand } from '../types';
import { isCodexPassthroughCommand } from './codexCommands';
import { findKnowledgeCommand } from './knowledgeCommands';

export interface ConversationCommandResolution {
  blockedMessage?: string;
  prompt: string;
  queryOptions?: {
    allowedTools?: string[];
    model?: string;
  };
}

export function resolveConversationCommand(
  input: string,
  customCommands: readonly SlashCommand[] = [],
): ConversationCommandResolution | null {
  const invocation = parseSlashCommandInvocation(input);
  if (!invocation) return null;

  if (isCodexPassthroughCommand(invocation.name)) {
    return { prompt: input };
  }

  const normalizedName = invocation.name.trim().toLowerCase();
  const command = findKnowledgeCommand(normalizedName)
    ?? customCommands.find((item) => item.name.toLowerCase() === normalizedName)
    ?? null;
  if (!command) return null;

  if (command.userInvocable === false) {
    return {
      prompt: input,
      blockedMessage: `/${command.name} 不能被直接调用。`,
    };
  }

  const queryOptions: ConversationCommandResolution['queryOptions'] = {};
  const model = typeof command.model === 'string' ? command.model.trim() : '';
  if (model) queryOptions.model = model;
  if (command.allowedTools?.length) queryOptions.allowedTools = [...command.allowedTools];

  return {
    prompt: expandSlashCommandTemplate(command.content, invocation),
    queryOptions: Object.keys(queryOptions).length > 0 ? queryOptions : undefined,
  };
}
