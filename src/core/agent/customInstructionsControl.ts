import { RETRIEVAL_INSTRUCTIONS } from './retrievalInstructions';
import { VAULT_LINK_INSTRUCTIONS } from './vaultLinkInstructions';

export type CustomInstructionsOperation = 'append' | 'replace' | 'clear';

export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 20_000;

export interface CustomInstructionsProposal {
  operation: CustomInstructionsOperation;
  content: string;
}

export interface CustomInstructionsProposalResult {
  cleanedText: string;
  proposal: CustomInstructionsProposal | null;
}

const PROPOSAL_PATTERN = /<!--\s*second-brain-custom-instructions:(append|replace|clear)\s*\r?\n([\s\S]*?)\r?\n-->/gi;

export const CUSTOM_INSTRUCTIONS_CONTROL_PROMPT = `## Obsidian Plugin Custom Instructions Control

The plugin's persistent custom instructions are application settings, not files in the vault.

When, and only when, the user explicitly asks to add, update, replace, or clear the plugin's "自定义指令" / "custom instructions":

1. Never edit, create, or suggest editing any AGENTS.md file as a substitute for that request.
2. Resolve references such as "上面的规则" from the conversation, and write a concise, durable instruction proposal.
3. Continue handling any other tasks in the same user message normally.
4. End the response with exactly one hidden proposal comment in this format:

<!-- second-brain-custom-instructions:append
Markdown instruction text goes here.
-->

Use "append" to add a rule, "replace" only when the user explicitly asks to replace the complete instruction set, and "clear" only when the user explicitly asks to clear it. For "clear", leave the content area empty. Do not emit this comment when the user is only discussing, reviewing, or asking what custom instructions are. The plugin will show a confirmation window; the change is not saved until the user confirms it.

If the user explicitly names AGENTS.md as the desired destination, follow that file request and do not emit the proposal comment.`;

export function buildCodexDeveloperInstructions(
  customInstructions?: string,
  additionalInstructions?: string,
): string {
  const custom = customInstructions?.trim();
  const additional = additionalInstructions?.trim();
  return [
    custom,
    additional ? `## WeChat-only additional instructions\n\n${additional}` : '',
    RETRIEVAL_INSTRUCTIONS,
    CUSTOM_INSTRUCTIONS_CONTROL_PROMPT,
    VAULT_LINK_INSTRUCTIONS,
  ].filter(Boolean).join('\n\n');
}

export function extractCustomInstructionsProposal(text: string): CustomInstructionsProposalResult {
  let proposal: CustomInstructionsProposal | null = null;
  const cleanedText = text.replace(PROPOSAL_PATTERN, (_match, operation: string, rawContent: string) => {
    const content = rawContent.trim();
    if (operation === 'clear' || content) {
      proposal = {
        operation: operation as CustomInstructionsOperation,
        content: operation === 'clear' ? '' : content,
      };
    }
    return '';
  }).trimEnd();

  return { cleanedText, proposal };
}
