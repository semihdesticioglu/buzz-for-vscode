// Loads the esbuild bundle with a minimal fake 'vscode' module: it must evaluate without touching the network or the
// file system, export activate/deactivate, and keep the optional ws add-ons guarded.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const PROJ = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const file = path.join(PROJ, 'dist', 'extension.js');
const src = fs.readFileSync(file, 'utf8');
const kb = (src.length / 1024).toFixed(0);

const noop = () => undefined;
const disp = { dispose: noop };
const fakeVscode = new Proxy(
  {
    EventEmitter: class {
      constructor() {
        this.event = () => disp;
      }
      fire() {}
      dispose() {}
    },
    Disposable: class {
      constructor(fn) {
        this.dispose = fn || noop;
      }
    },
    Uri: { joinPath: () => ({}), file: () => ({}), parse: () => ({}), from: () => ({}) },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => disp, textDocuments: [] },
    window: {
      createOutputChannel: () => ({ appendLine: noop, dispose: noop }),
      createStatusBarItem: () => ({ dispose: noop }),
      onDidChangeActiveTextEditor: () => disp,
    },
    commands: { registerCommand: () => disp, executeCommand: async () => undefined },
    languages: { registerCodeActionsProvider: () => disp, registerCodeLensProvider: () => disp },
    env: { language: 'en' },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Right: 4 },
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    CodeActionKind: { QuickFix: { append: () => ({}) } },
  },
  { get: (t, k) => (k in t ? t[k] : class {}) },
);
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return fakeVscode;
  if (req === 'bufferutil' || req === 'utf-8-validate') throw new Error('optional add-on absent');
  return origLoad.apply(this, arguments);
};
const ext = require(file);
const ok = (c, msg) => {
  console.log((c ? 'PASS ' : 'FAIL ') + msg);
  if (!c) process.exitCode = 1;
};
ok(typeof ext.activate === 'function' && typeof ext.deactivate === 'function', `bundle (${kb} KB) exports activate/deactivate`);
ok(!/require\("highlight\.js|require\("markdown-it|require\("ws"\)/.test(src), 'dependencies are bundled, not required at runtime');
ok(/require\("vscode"\)/.test(src), 'vscode stays external');
ok(
  fs.readdirSync(path.join(PROJ, 'dist')).every((f) => f === 'extension.js'),
  'dist/ holds just the bundle (no source map in the production build)',
);
