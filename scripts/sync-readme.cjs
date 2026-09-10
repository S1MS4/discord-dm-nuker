const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const source = fs.readFileSync(path.join(root, 'discord-dm-panel.js'), 'utf8').trimEnd();
const start = '<!-- script:start -->';
const end = '<!-- script:end -->';
const from = readme.indexOf(start);
const to = readme.indexOf(end, from);

if (from < 0 || to < 0) throw new Error('README script markers are missing.');

const block = `${start}\n\n\`\`\`javascript\n${source}\n\`\`\`\n\n${end}`;
const updated = readme.slice(0, from) + block + readme.slice(to + end.length);

if (process.argv.includes('--check')) {
  if (updated !== readme) {
    console.error('README script is out of date. Run npm run docs:sync.');
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(readmePath, updated);
}
