const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return fallback;
  }
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Cannot auto-bump version ${version}; use --version.`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const value = args[i + 1];
    result[key] = value && !value.startsWith('--') ? value : true;
    if (result[key] === value) i += 1;
  }
  return result;
}

const args = parseArgs();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(args.version || pkg.version);
const tag = String(args.tag || `v${version}`).replace(/^v/, '');
const resolveOutput = value => path.isAbsolute(value) ? value : path.join(ROOT, value);
const output = resolveOutput(String(args.output || 'CHANGELOG.md'));
const notesOutput = resolveOutput(String(args['notes-output'] || 'release-notes.md'));
const previous = git(['describe', '--tags', '--abbrev=0', `${tag}^`]) || git(['describe', '--tags', '--abbrev=0', 'HEAD']);
const tagExists = !!git(['tag', '--list', tag]);
const target = tagExists ? tag : 'HEAD';
const range = previous ? `${previous}..${target}` : target;
const log = git(['log', range, '--no-merges', '--pretty=format:%h%x09%s%x09%an']);
const categories = [
  { title: 'Added', pattern: /^(feat|feature)(\([^)]*\))?:/i },
  { title: 'Fixed', pattern: /^fix(\([^)]*\))?:/i },
  { title: 'Security', pattern: /^security(\([^)]*\))?:/i },
  { title: 'Changed', pattern: /^(refactor|perf|style|build|ci|chore)(\([^)]*\))?:/i },
  { title: 'Documentation', pattern: /^docs(\([^)]*\))?:/i },
  { title: 'Tests', pattern: /^test(\([^)]*\))?:/i },
  { title: 'Removed', pattern: /^(revert|remove)(\([^)]*\))?:/i },
];
const grouped = new Map(categories.map(category => [category.title, []]));
const other = [];
for (const line of log.split(/\r?\n/).filter(Boolean)) {
  const [hash, subject, author] = line.split('\t');
  const category = categories.find(item => item.pattern.test(subject));
  const entry = `- ${subject} (\`${hash}\`) — ${author}`;
  if (category) grouped.get(category.title).push(entry);
  else other.push(entry);
}
const date = new Date().toISOString().slice(0, 10);
const notes = [`## ${tag} - ${date}`, ''];
if (!log) {
  notes.push('- Maintenance release.');
} else {
  for (const [title, entries] of grouped) {
    if (!entries.length) continue;
    notes.push(`### ${title}`, '', ...entries, '');
  }
  if (other.length) notes.push('### Other', '', ...other, '');
}
if (previous) notes.push(`**Changes since ${previous}**`, '');
const notesText = notes.join('\n').trim();
let sections = notesText;
if (fs.existsSync(output)) {
  const raw = fs.readFileSync(output, 'utf8').replace(/^# Changelog\s*/i, '');
  const firstRelease = raw.search(/^## /m);
  const current = (firstRelease >= 0 ? raw.slice(firstRelease) : '').trim();
  if (current) {
    const lines = current.split(/\r?\n/);
    const start = lines.findIndex(line => line.startsWith(`## ${tag} `));
    if (start >= 0) {
      let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
      if (end < 0) end = lines.length;
      lines.splice(start, end - start, ...notesText.split('\n'), '');
    } else {
      lines.unshift(...notesText.split('\n'), '');
    }
    sections = lines.join('\n').trim();
  }
}
const changelog = `# Changelog\n\nAll notable changes to Kyrios Chronos.\n\n${sections}\n`;
fs.writeFileSync(output, changelog);
fs.writeFileSync(notesOutput, `${notesText}\n`);
if (args['print']) process.stdout.write(notesText);
if (!args.quiet) process.stdout.write(`Changelog written for ${tag} (${previous || 'initial release'}).\n`);

if (args['print-version']) process.stdout.write(`${version}\n`);
if (!args.version && !args.tag && args.bump) process.stdout.write(`${bumpPatch(pkg.version)}\n`);
