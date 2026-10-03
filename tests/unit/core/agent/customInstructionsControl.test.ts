import {
  buildCodexDeveloperInstructions,
  CUSTOM_INSTRUCTIONS_CONTROL_PROMPT,
  extractCustomInstructionsProposal,
} from '@/core/agent/customInstructionsControl';
import { RETRIEVAL_INSTRUCTIONS } from '@/core/agent/retrievalInstructions';
import { VAULT_LINK_INSTRUCTIONS } from '@/core/agent/vaultLinkInstructions';

describe('customInstructionsControl', () => {
  describe('buildCodexDeveloperInstructions', () => {
    it('keeps user instructions and appends the protected plugin protocol', () => {
      const result = buildCodexDeveloperInstructions('默认使用中文。');

      expect(result).toContain('默认使用中文。');
      expect(result).toContain(CUSTOM_INSTRUCTIONS_CONTROL_PROMPT);
      expect(result).toContain(VAULT_LINK_INSTRUCTIONS);
      expect(result.indexOf('默认使用中文。')).toBeLessThan(
        result.indexOf('## Obsidian Plugin Custom Instructions Control'),
      );
    });

    it('still injects the protected plugin protocol when user instructions are blank', () => {
      expect(buildCodexDeveloperInstructions('  \n ')).toBe(`${RETRIEVAL_INSTRUCTIONS}\n\n${CUSTOM_INSTRUCTIONS_CONTROL_PROMPT}\n\n${VAULT_LINK_INSTRUCTIONS}`);
    });

    it('places WeChat-only instructions after shared rules and before the control protocol', () => {
      const result = buildCodexDeveloperInstructions('共享规则', '微信规则');

      expect(result).toContain('## WeChat-only additional instructions\n\n微信规则');
      expect(result.indexOf('共享规则')).toBeLessThan(result.indexOf('微信规则'));
      expect(result.indexOf('微信规则')).toBeLessThan(
        result.indexOf('## Obsidian Plugin Custom Instructions Control'),
      );
    });
  });

  describe('extractCustomInstructionsProposal', () => {
    it('extracts an append proposal and removes the hidden marker from saved chat text', () => {
      const result = extractCustomInstructionsProposal(`已整理为长期规则，请在弹窗中确认。

<!-- second-brain-custom-instructions:append
## 学习笔记整理

- 主体只保留正确答案。
-->`);

      expect(result.cleanedText).toBe('已整理为长期规则，请在弹窗中确认。');
      expect(result.proposal).toEqual({
        operation: 'append',
        content: '## 学习笔记整理\n\n- 主体只保留正确答案。',
      });
    });

    it('supports replace and clear operations', () => {
      expect(extractCustomInstructionsProposal(`<!-- second-brain-custom-instructions:replace
新完整指令
-->`).proposal).toEqual({ operation: 'replace', content: '新完整指令' });

      expect(extractCustomInstructionsProposal(`<!-- second-brain-custom-instructions:clear

-->`).proposal).toEqual({ operation: 'clear', content: '' });
    });

    it('ignores an empty append proposal instead of opening a destructive confirmation', () => {
      const input = `保持原样。
<!-- second-brain-custom-instructions:append

-->`;
      const result = extractCustomInstructionsProposal(input);

      expect(result.proposal).toBeNull();
      expect(result.cleanedText).toBe('保持原样。');
    });

    it('does not treat ordinary discussion as an instruction change', () => {
      const text = '解释一下自定义指令和 AGENTS.md 的区别。';
      expect(extractCustomInstructionsProposal(text)).toEqual({
        cleanedText: text,
        proposal: null,
      });
    });
  });
});
