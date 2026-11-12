// Audit of "Show diff" against the agents' real repository (read-only): for the recent feature branches, what our
// changeRange picks as base/tip and which files it lists, next to git's own answer.
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
// the agents' repository to audit: the path given, else the first git checkout under ~/.buzz/REPOS
const dir =
  process.argv[3] ||
  (() => {
    const base = path.join(os.homedir(), '.buzz', 'REPOS');
    const fs = require('fs');
    const first = fs.existsSync(base) && fs.readdirSync(base).find((n) => fs.existsSync(path.join(base, n, '.git')));
    if (!first) throw new Error('no repository under ~/.buzz/REPOS; pass one: node range_audit.js <repo> <path-to-agents-repo>');
    return path.join(base, first);
  })();
const i18n = require(path.join(PROJ, 'out/i18n.js'));
i18n.setLang('en');
const { changeRange } = require(path.join(PROJ, 'out/agentGit.js'));
const g = (...a) => execFileSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
const tryG = (...a) => {
  try {
    return g(...a);
  } catch {
    return '';
  }
};
// files agents keep as their own log (not the work): AGENTS.md, plus any given as a regular expression in BUZZ_AUDIT_LOGS
const LOGS = new RegExp(process.env.BUZZ_AUDIT_LOGS || '^AGENTS\\.md$');

(async () => {
  const before = { head: g('rev-parse', '--abbrev-ref', 'HEAD'), status: g('status', '--porcelain') };
  const buzz = g('rev-parse', '--short', 'buzz');
  console.log(`repo ${dir}; folder on "${before.head}"; buzz @ ${buzz}\n`);
  const refs = g(
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)|%(objectname:short)|%(committerdate:short)',
    'refs/heads/feature',
    'refs/remotes/origin/feature',
  )
    .split('\n')
    .filter(Boolean);
  const seen = new Set();
  let n = 0;
  for (const line of refs) {
    const [ref, sha, date] = line.split('|');
    const name = ref.replace(/^origin\//, '');
    if (seen.has(name) || n >= 14) continue;
    seen.add(name);
    n++;
    const own = tryG('rev-list', '--count', `buzz..${ref}`);
    const merged = tryG('merge-base', '--is-ancestor', ref, 'buzz') === '' && !tryG('rev-list', '-n1', `buzz..${ref}`);
    const r = await changeRange([dir], name, 'branch', 'buzz');
    console.log(`== ${name}  (${sha}, ${date}; ${own} commit(s) not in buzz; ${merged ? 'merged' : 'not merged'})`);
    if (typeof r === 'string') {
      console.log(`   -> message: ${r}\n`);
      continue;
    }
    const logsOnly = r.files.length && r.files.every((f) => LOGS.test(f.path));
    console.log(`   ours: ${r.base.slice(0, 7)}..${r.tip.slice(0, 7)}${r.worktree ? ' (worktree)' : ''}${r.note ? ' · ' + r.note : ''}`);
    console.log(`   files (${r.files.length}${logsOnly ? ', ONLY the log files' : ''}): ${r.files.map((f) => f.status + ' ' + f.path).join(', ')}`);
    const commits = tryG('log', '--format=%h %s', `${r.base}..${r.tip}`).split('\n').filter(Boolean);
    console.log(`   commits in that range (${commits.length}): ${commits.slice(0, 4).join(' | ')}${commits.length > 4 ? ' | …' : ''}`);
    // git's own idea of "what this branch did since it left buzz" for an unmerged branch
    if (!merged) {
      const mb = tryG('merge-base', 'buzz', ref);
      const files = tryG('diff', '--name-only', mb, ref).split('\n').filter(Boolean);
      const same = files.length === r.files.length && files.every((f) => r.files.some((x) => x.path === f));
      console.log(`   git merge-base..tip: ${files.length} files ${same ? '(same)' : '(DIFFERENT: ' + files.join(', ') + ')'}`);
    }
    console.log('');
  }
  // how often does a merge into buzz touch only the two log files?
  const merges = g('log', '--merges', '--first-parent', '-n', '12', '--format=%h|%s', 'buzz').split('\n').filter(Boolean);
  console.log('== last merges into buzz (first parent) and what each brought in');
  for (const m of merges) {
    const [h, s] = m.split('|');
    const files = tryG('diff', '--name-only', `${h}^1`, h).split('\n').filter(Boolean);
    const logsOnly = files.length && files.every((f) => LOGS.test(f));
    console.log(
      `   ${h} ${s.slice(0, 60)} -> ${files.length} files${logsOnly ? ' (ONLY log files)' : ''}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`,
    );
  }
  const after = { head: g('rev-parse', '--abbrev-ref', 'HEAD'), status: g('status', '--porcelain') };
  console.log(`\nfolder untouched: ${before.head === after.head && before.status === after.status ? 'yes' : 'NO'}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
