import { type App, moment } from 'obsidian';

const DEFAULT_FOLDER = '300_复盘与日志/310_每日笔记';

export async function resolveDailyNote(app: App, date: Date): Promise<{ path: string; initial: string }> {
  const adapter = app.vault.adapter;
  const configPath = '.obsidian/daily-notes.json';
  const configured = await adapter.exists(configPath);
  let config: { folder?: string; format?: string; template?: string } = {};
  if (configured) config = JSON.parse(await adapter.read(configPath));
  if (!config || typeof config !== 'object'
    || [config.folder, config.format, config.template].some((value) => value !== undefined && typeof value !== 'string')) {
    throw new Error('每日笔记配置格式无效，请先核对每日笔记设置。');
  }
  const folder = (config.folder ?? (configured ? '' : DEFAULT_FOLDER)).replace(/\\/gu, '/').replace(/\/$/u, '');
  const format = config.format || (configured ? 'YYYY-MM-DD' : 'YYYY-MM/YYYY-MM-DD');
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const name = format === 'YYYY-MM/YYYY-MM-DD' ? `${day.slice(0, 7)}/${day}` : format === 'YYYY-MM-DD' ? day : moment(date).format(format);
  const path = `${folder ? `${folder}/` : ''}${name}.md`.replace(/\\/gu, '/');
  if (path.split('/').some((part) => part === '..' || part === '.') || /^[A-Za-z]:/u.test(path) || path.startsWith('/')) throw new Error('日记目录必须位于当前笔记库。');
  let initial = `# ${day}\n`;
  const template = config.template ?? (configured ? '' : '900_模板/00_每日笔记模板.md');
  if (!template) return { path, initial };
  const templatePath = template.endsWith('.md') ? template : `${template}.md`;
  if (await adapter.exists(templatePath)) {
    initial = (await adapter.read(templatePath)).replace(/\{\{date(?::([^}]+))?\}\}/gu, (_match, spec?: string) => {
      const value = spec || 'YYYY-MM-DD';
      return value === 'YYYY-MM-DD' ? day : value === 'YYYY-MM' ? day.slice(0, 7) : moment(date).format(value);
    }).replace(/\{\{time(?::([^}]+))?\}\}/gu, (_match, spec?: string) => moment(date).format(spec || 'HH:mm'));
  }
  return { path, initial };
}
