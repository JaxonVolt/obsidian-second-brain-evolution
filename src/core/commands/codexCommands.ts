import type { SlashCommand } from '../types';

const CODEX_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'codex:compact',
    name: 'compact',
    description: 'Ask Codex to continue in a more compact form',
    content: '',
    source: 'plugin',
  },
  {
    id: 'codex:help',
    name: 'help',
    description: 'Ask Codex for help with available behaviors',
    content: '',
    source: 'plugin',
  },
  {
    id: 'codex:plan',
    name: 'plan',
    description: 'Ask Codex to plan before acting',
    content: '',
    source: 'plugin',
  },
];

const CODEX_COMMAND_NAMES = new Set(CODEX_COMMANDS.map((command) => command.name.toLowerCase()));

export function getCodexCommandsForDropdown(): SlashCommand[] {
  return CODEX_COMMANDS.map((command) => ({ ...command }));
}

export function isCodexPassthroughCommand(name: string): boolean {
  return CODEX_COMMAND_NAMES.has(name.trim().toLowerCase());
}
