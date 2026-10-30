// Smoke test for src/extension.ts using a stand-in for the VS Code API.
// Run: node test/smoke-extension.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ---- fake vscode ---------------------------------------------------------
const log = { info: [], warn: [], error: [], status: [], exec: [], external: [], configUpdates: [] };
let settings = {};
let workspaceFolders;
let activeEditor;

class Uri {
  constructor(scheme, p) { this.scheme = scheme; this.fsPath = p; this.path = p; }
  static file(p) { return new Uri('file', path.resolve(p)); }
  static parse(v) { return new Uri(v.split(':')[0], v); }
  static joinPath(base, ...segs) { return Uri.file(path.join(base.fsPath, ...segs)); }
  toString() { return this.scheme + '://' + this.fsPath; }
}
const makeDoc = (file, text) => ({
  uri: file ? Uri.file(file) : new Uri('untitled', 'Untitled-1'),
  fileName: file ?? 'Untitled-1',
  isUntitled: !file,
  languageId: 'plaintext',
  getText: () => text ?? fs.readFileSync(file, 'utf8'),
});
const answer = { info: undefined };
const fakeVscode = {
  Uri,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    get workspaceFolders() { return workspaceFolders; },
    getWorkspaceFolder(uri) { return (workspaceFolders ?? []).find(w => uri.fsPath.startsWith(w.uri.fsPath + path.sep)); },
    getConfiguration() {
      return {
        get: (k, d) => (k in settings ? settings[k] : d),
        update: async (k, v, t) => { log.configUpdates.push([k, v, t]); settings[k] = v; },
      };
    },
    openTextDocument: async (uri) => makeDoc(uri.fsPath),
  },
  window: {
    get activeTextEditor() { return activeEditor; },
    showInformationMessage: async (m, ...items) => { log.info.push(m); return answer.info; },
    showWarningMessage: async (m) => { log.warn.push(m); return undefined; },
    showErrorMessage: async (m) => { log.error.push(m); return undefined; },
    setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
  },
  commands: {
    _registry: {},
    registerCommand(id, fn) { this._registry[id] = fn; return { dispose() {} }; },
    executeCommand: async (id, ...args) => { log.exec.push([id, ...args]); },
  },
  env: { openExternal: async (uri) => { log.external.push(uri); return true; } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: fakeVscode };

// ---- setup ---------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvba-smoke-'));
const ws = path.join(root, 'workspace');
fs.mkdirSync(path.join(ws, 'BP'), { recursive: true });
for (const f of ['TEST1', 'GET.CUST']) fs.copyFileSync(path.join(__dirname, 'fixtures', f), path.join(ws, 'BP', f));
const fakeBrowserOut = path.join(root, 'browser-args.txt');
const fakeBrowser = path.join(root, 'fake-browser.sh');
fs.writeFileSync(fakeBrowser, `#!/bin/sh\necho "$@" > "${fakeBrowserOut}"\n`, { mode: 0o755 });

const extDir = process.env.MVBA_EXT_DIR || path.join(__dirname, '..');
const ext = require(path.join(extDir, 'out', 'extension.js'));
const globalState = new Map();
const context = {
  subscriptions: [],
  globalState: { get: (k, d) => (globalState.has(k) ? globalState.get(k) : d), update: async (k, v) => { globalState.set(k, v); } },
  extensionUri: Uri.file(extDir),
};
ext.activate(context);
const run = (...args) => fakeVscode.commands._registry['mvbasicAnalyser.analyseProgram'](...args);
const reset = () => { for (const k of Object.keys(log)) log[k] = []; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const test = async (name, fn) => {
  reset();
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n' + e.stack); process.exitCode = 1; }
};

(async () => {
  console.log('Extension smoke test');
  workspaceFolders = [{ uri: Uri.file(ws), name: 'workspace', index: 0 }];

  await test('commands are registered', () => {
    assert.ok(fakeVscode.commands._registry['mvbasicAnalyser.analyseProgram']);
    assert.ok(fakeVscode.commands._registry['mvbasicAnalyser.showSetupGuide']);
  });

  await test('no open file → friendly error', async () => {
    activeEditor = undefined;
    await run();
    assert.match(log.error[0], /Open a UniVerse BASIC program/);
  });

  await test('default output folder is <workspace>/docs/uvdoc; openIn=none writes only', async () => {
    settings = { openIn: 'none' };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    const out = path.join(ws, 'docs', 'uvdoc', 'TEST1.md');
    assert.ok(fs.existsSync(out), 'report missing');
    const md = fs.readFileSync(out, 'utf8');
    assert.match(md, /`BP\/TEST1`/);
    assert.match(md, /```mermaid/);
    assert.match(log.info[0], /Report saved/);
    assert.match(log.status[0], /TEST1 analysed → TEST1\.md/);
  });

  await test('unsaved edits in the editor are analysed (not the file on disk)', async () => {
    settings = { openIn: 'none' };
    const edited = fs.readFileSync(path.join(ws, 'BP', 'TEST1'), 'utf8').replace('   GOSUB SUB3\n', '   GOSUB SUB3\n   GOSUB SUB9\n');
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1'), edited) };
    await run();
    assert.match(fs.readFileSync(path.join(ws, 'docs', 'uvdoc', 'TEST1.md'), 'utf8'), /SUB9 +line \? +· called line 5 +⚠ label not found/);
  });

  await test('browser=custom launches it with a file:// URL; setup notice shown once', async () => {
    settings = { openIn: 'browser', browser: 'custom', browserPath: fakeBrowser };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    await sleep(400);
    const args = fs.readFileSync(fakeBrowserOut, 'utf8').trim();
    assert.equal(args, 'file://' + path.join(ws, 'docs', 'uvdoc', 'TEST1.md'));
    assert.equal(log.info.filter(m => /install a Markdown viewer extension/.test(m)).length, 1);
    reset();
    await run();
    assert.equal(log.info.filter(m => /install a Markdown viewer extension/.test(m)).length, 0, 'notice shown twice');
  });

  await test('browser not found → warning + VS Code preview fallback', async () => {
    settings = { openIn: 'browser', browser: 'custom', browserPath: path.join(root, 'no-such-browser') };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    assert.match(log.warn[0], /could not be opened in the browser/);
    assert.deepEqual(log.exec.map(e => e[0]), ['markdown.showPreview']);
    assert.equal(log.exec[0][1].fsPath, path.join(ws, 'docs', 'uvdoc', 'TEST1.md'));
  });

  await test('browser=system uses the OS opener', async () => {
    settings = { openIn: 'browser', browser: 'system' };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    assert.equal(log.external[0].fsPath, path.join(ws, 'docs', 'uvdoc', 'TEST1.md'));
  });

  await test('openIn=vscodePreview opens only the preview', async () => {
    settings = { openIn: 'vscodePreview' };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    assert.deepEqual(log.exec.map(e => e[0]), ['markdown.showPreview']);
    assert.equal(log.external.length, 0);
  });

  await test('Notes section survives a re-run', async () => {
    settings = { openIn: 'none' };
    const out = path.join(ws, 'docs', 'uvdoc', 'TEST1.md');
    fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace(/(<!-- mvba:notes:start[^>]*-->\n)/, '$1Reviewed with the team on 30 Oct.'));
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    assert.match(fs.readFileSync(out, 'utf8'), /Reviewed with the team on 30 Oct\./);
  });

  await test('explorer right-click + relative outputFolder setting', async () => {
    settings = { openIn: 'none', outputFolder: 'reports/mv' };
    activeEditor = undefined;
    await run(Uri.file(path.join(ws, 'BP', 'GET.CUST')));
    assert.ok(fs.existsSync(path.join(ws, 'reports', 'mv', 'GET.CUST.md')));
  });

  await test('${workspaceFolder} and ~ in outputFolder', async () => {
    const doc = makeDoc(path.join(ws, 'BP', 'TEST1'));
    assert.equal(ext.resolveOutputFolder('${workspaceFolder}/out', doc), path.join(ws, 'out'));
    assert.equal(ext.resolveOutputFolder('~/mvba', doc), path.join(os.homedir(), 'mvba'));
    assert.equal(ext.resolveOutputFolder(path.join(root, 'abs'), doc), path.join(root, 'abs'));
  });

  await test('no workspace open → uvdoc folder next to the program', async () => {
    workspaceFolders = undefined;
    settings = { openIn: 'none' };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'GET.CUST')) };
    await run();
    assert.ok(fs.existsSync(path.join(ws, 'BP', 'uvdoc', 'GET.CUST.md')));
    workspaceFolders = [{ uri: Uri.file(ws), name: 'workspace', index: 0 }];
  });

  await test('"Use VS Code preview instead" on the first-run notice changes the setting', async () => {
    globalState.clear();
    answer.info = 'Use VS Code Preview Instead';
    settings = { openIn: 'browser', browser: 'custom', browserPath: fakeBrowser };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    await sleep(50);
    assert.deepEqual(log.configUpdates[0], ['openIn', 'vscodePreview', 1]);
    answer.info = undefined;
  });

  await test('excludeRoutines setting reaches the report', async () => {
    settings = { openIn: 'none', excludeRoutines: ['sub1*'] };
    activeEditor = { document: makeDoc(path.join(ws, 'BP', 'TEST1')) };
    await run();
    const md = fs.readFileSync(path.join(ws, 'docs', 'uvdoc', 'TEST1.md'), 'utf8');
    assert.match(md, /Hidden by the Exclude Routines setting: SUB1 \(1 call\)/);
    const tree = /```text\n([\s\S]*?)```/.exec(md)[1];
    assert.ok(!/SUB1/.test(tree) && /SUB2/.test(tree), tree);
  });

  await test('Show Setup Guide opens the README', async () => {
    await fakeVscode.commands._registry['mvbasicAnalyser.showSetupGuide']();
    assert.equal(log.exec[0][0], 'markdown.showPreview');
    assert.ok(log.exec[0][1].fsPath.endsWith('README.md'));
    assert.ok(fs.existsSync(log.exec[0][1].fsPath), 'README.md not shipped');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  fs.rmSync(root, { recursive: true, force: true });
})();
