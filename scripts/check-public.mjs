import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
for (const artifact of ['main.js', 'styles.css', 'manifest.json']) {
  if (!existsSync(artifact)) throw new Error(`Missing release artifact: ${artifact}`);
  if (!paths.includes(artifact)) paths.push(artifact);
}
const checks = [
  ['private repository reference', /obsidian-second-brain-(?:private|mobile)/iu],
  ['personal home directory', /[A-Z]:[\\/]+Users[\\/]+\d{4,}/iu],
  ['company identifier', /\u6d77\u5316|\u6ee8\u6d77\u80fd\u6e90|\u6ee8\u80fd|\u6d77\u50a8\u6ee8/iu],
  ['personal contact', /[\w.+-]+@(?:qq|163|126)\.com/iu],
  ['access token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,})/u],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
];
const issues = [];
for (const file of paths) {
  if (!existsSync(file)) continue;
  if (/^(?:vault|memory|runtime|vendor|node_modules|\.obsidian|\.second-brain|\.codex|\.claude)\//u.test(file)
    || /(?:^|\/)(?:data\.json|credentials\.json|\.env(?:\..*)?)$/u.test(file)
    || /\.(?:pdf|docx?|xlsx?|png|jpe?g|sqlite|db|zip|map|log)$/iu.test(file)) {
    issues.push(`${file}: forbidden public file`);
    continue;
  }
  const content = readFileSync(file, 'utf8');
  if (content.includes('\0')) issues.push(`${file}: unexpected binary data`);
  for (const [label, pattern] of checks) {
    if (pattern.test(content)) issues.push(`${file}: ${label}`);
  }
}
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (manifest.version !== pkg.version || lock.version !== pkg.version || lock.packages[''].version !== pkg.version
  || versions[manifest.version] !== manifest.minAppVersion) issues.push('Release versions disagree');
if (manifest.id !== 'second-brain-evolution' || !manifest.isDesktopOnly) issues.push('Unexpected plugin identity');
if (issues.length) {
  console.error(issues.join('\n'));
  process.exit(1);
}
console.log(`Public content checks passed: ${paths.length} files, version ${manifest.version}`);
