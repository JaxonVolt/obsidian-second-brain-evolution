import {
  buildDailyInfoBlock,
  DAILY_INFO_START,
  findUpcomingEvent,
  isDailyNoteCandidate,
  localDateKey,
  selectPreferredDailyNotePath,
  upsertDailyInfo,
} from '@/core/knowledge/DailyNoteInfoService';

describe('DailyNoteInfoService helpers', () => {
  it('prefers the configured year-month layout when a root duplicate exists', () => {
    const date = new Date(2026, 7, 9);
    expect(selectPreferredDailyNotePath([
      '300_复盘与日志/310_每日笔记/2026-08-09.md',
      '300_复盘与日志/310_每日笔记/2026-08/2026-08-09.md',
    ], date)).toBe('300_复盘与日志/310_每日笔记/2026-08/2026-08-09.md');
  });
  const july25 = new Date(2026, 6, 25, 12, 0, 0);

  it('builds compact offline information for the current date', () => {
    const block = buildDailyInfoBlock(july25);

    expect(block).toContain('7月25日 · 星期六 · 农历六月十二');
    expect(block).not.toContain('星座');
    expect(block).not.toMatch(/\d\/5/);
    expect(block).toContain('今日无特别习俗');
    expect(block).toContain('建军节（7天后）');
    expect(block).toContain('**宜**：祭祀、祈福、解除');
    expect(block).toContain('**忌**：嫁娶、斋醮、开市');
  });

  it('finds the next event across a month boundary', () => {
    expect(findUpcomingEvent(july25)).toEqual({ days: 7, name: '建军节' });
  });

  it('finds the next event across a year boundary', () => {
    expect(findUpcomingEvent(new Date(2026, 11, 31, 12, 0, 0))).toEqual({
      days: 1,
      name: '元旦节',
    });
  });

  it('inserts the information directly below the title', () => {
    const content = '---\ntype: daily\n---\n\n# 2026-07-25\n\n## 今天做了什么\n\n- ';
    const block = buildDailyInfoBlock(july25);
    const updated = upsertDailyInfo(content, block);

    expect(updated.indexOf(DAILY_INFO_START)).toBeGreaterThan(updated.indexOf('# 2026-07-25'));
    expect(updated.indexOf(DAILY_INFO_START)).toBeLessThan(updated.indexOf('## 今天做了什么'));
  });

  it('is idempotent and refreshes an existing block', () => {
    const content = '# 2026-07-25\n\n## 今天做了什么\n';
    const oldBlock = [
      DAILY_INFO_START,
      '> **日期**：7月25日 · 星期六 · 农历六月十二',
      '> **星座运势（娱乐）**：金牛座 · 3/5 · 旧提示',
      '> **习俗**：旧内容',
    ].join('\n');
    const once = upsertDailyInfo(content, oldBlock);
    const twice = upsertDailyInfo(once, buildDailyInfoBlock(july25));

    expect(twice.split(DAILY_INFO_START)).toHaveLength(2);
    expect(twice).not.toContain('星座');
    expect(twice).not.toContain('旧提示');
  });

  it('handles a note without a title without deleting its content', () => {
    const content = '---\ntype: daily\n---\n\n原有内容\n';
    const updated = upsertDailyInfo(content, buildDailyInfoBlock(july25));

    expect(updated).toContain('原有内容');
    expect(updated).toContain(DAILY_INFO_START);
  });

  it('only targets today and recognized daily-note locations', () => {
    expect(isDailyNoteCandidate(
      '300_复盘与日志/310_每日笔记/2026-07-25.md',
      '2026-07-25',
      july25
    )).toBe(true);
    expect(isDailyNoteCandidate(
      '其他目录/2026-07-25.md',
      '2026-07-25',
      july25,
      'daily'
    )).toBe(true);
    expect(isDailyNoteCandidate(
      '其他目录/2026-07-25.md',
      '2026-07-25',
      july25
    )).toBe(false);
    expect(isDailyNoteCandidate(
      '300_复盘与日志/310_每日笔记/2026-07-24.md',
      '2026-07-24',
      july25
    )).toBe(false);
  });

  it('formats local date keys without UTC drift', () => {
    expect(localDateKey(new Date(2024, 1, 29, 0, 5, 0))).toBe('2024-02-29');
  });
});
