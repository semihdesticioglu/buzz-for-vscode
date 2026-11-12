// A small agents' repository for the harnesses, made in a temporary home folder so that nothing of the user's is
// read: ~/.buzz/REPOS/demo_repo with the agents' branch ("buzz"), a branch merged into it with a merge commit, an open
// branch with two commits (a file changed, one added, one deleted), and a file renamed in its history. The working
// folder is left on the open branch, as an agent's checkout often is: the extension reads the "buzz" branch, not the
// folder.
//   const demo = require('./demo_repo').makeDemoHome();   // before out/agentRepo.js is used
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeDemoHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-home-'));
  // os.homedir() reads these: the extension looks for ~/.buzz/REPOS under this home from now on
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const repo = path.join(home, '.buzz', 'REPOS', 'demo_repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'buzz');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'user.name', 'Demo');
  write('pipeline/rollup.py', 'def score(x):\n    return x\n');
  write('sql/report.sql', 'select 1;\n');
  write('README.md', '# demo\n');
  commit('first');
  fs.mkdirSync(path.join(repo, 'pipeline', 'steps'), { recursive: true });
  git('mv', 'pipeline/rollup.py', 'pipeline/steps/rollup.py');
  commit('move rollup into steps');
  // a branch merged into buzz with a merge commit
  git('checkout', '-q', '-b', 'feature/abc-101-merged');
  write('sql/report.sql', 'select 2;\n');
  write('docs/notes.md', 'notes\n');
  commit('abc-101: report and notes');
  git('checkout', '-q', 'buzz');
  write('README.md', '# demo\n\nbuzz moved on\n');
  commit('buzz moved on');
  git('merge', '-q', '--no-ff', '-m', "Merge branch 'feature/abc-101-merged'", 'feature/abc-101-merged');
  // an open branch (not in buzz)
  git('checkout', '-q', '-b', 'feature/abc-102-open');
  write('pipeline/steps/rollup.py', 'def score(x):\n    return x * 2\n');
  commit('abc-102: double the score');
  write('pipeline/steps/sort.py', 'def rank(xs):\n    return sorted(xs)\n');
  fs.rmSync(path.join(repo, 'README.md'));
  commit('abc-102: rank, and the readme goes');
  return {
    home,
    repo,
    name: 'demo_repo',
    merged: 'feature/abc-101-merged',
    open: 'feature/abc-102-open',
    commit: git('rev-parse', '--short', 'HEAD~1'), // one commit of the open branch
    git,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

module.exports = { makeDemoHome };
