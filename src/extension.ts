import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProgram } from './parser.js';
import { renderReport, extractNotes, reportFileName, DiagramStyle } from './report.js';
import { openInBrowser, BrowserChoice } from './browser.js';

const VERSION = '1.0.0';
const SETUP_SHOWN_KEY = 'mvbasicAnalyser.setupNoticeShown';

type OpenIn = 'browser' | 'vscodePreview' | 'both' | 'none';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mvbasicAnalyser.analyseProgram', (uri?: vscode.Uri) => analyseProgram(context, uri)),
    vscode.commands.registerCommand('mvbasicAnalyser.showSetupGuide', () => showSetupGuide(context)),
  );
}

export function deactivate(): void { /* nothing to clean up */ }

async function analyseProgram(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  try {
    // 1. Which program? Explorer right-click passes a uri; otherwise use the active editor (including unsaved edits).
    let doc: vscode.TextDocument | undefined;
    if (uri instanceof vscode.Uri && uri.scheme === 'file') {
      doc = await vscode.workspace.openTextDocument(uri);
    } else {
      doc = vscode.window.activeTextEditor?.document;
    }
    if (!doc) {
      vscode.window.showErrorMessage('MultiValue Basic Analyser: Open a UniVerse BASIC program, then run Analyse Program.');
      return;
    }

    const config = vscode.workspace.getConfiguration('mvbasicAnalyser', doc.uri);
    const sourceFile = doc.isUntitled ? '' : doc.uri.fsPath;
    const baseName = sourceFile ? path.basename(sourceFile).replace(/\.(b|bas|bp|basic)$/i, '') : 'UNTITLED';

    // 2. Analyse
    const model = parseProgram(doc.getText(), baseName);

    // 3. Where to save
    const outDir = resolveOutputFolder(config.get<string>('outputFolder', ''), doc);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, reportFileName(model.name));
    const notes = fs.existsSync(outFile) ? extractNotes(fs.readFileSync(outFile, 'utf8')) : undefined;

    const markdown = renderReport(model, {
      sourcePath: displayPath(doc),
      generatedAt: new Date(),
      diagram: config.get<DiagramStyle>('diagram', 'mermaid'),
      maxDepth: Math.max(1, config.get<number>('maxTreeDepth', 10)),
      version: VERSION,
      notes,
      exclude: config.get<string[]>('excludeRoutines', []),
      reportExists: name => fs.existsSync(path.join(outDir, reportFileName(name))),
    });
    fs.writeFileSync(outFile, markdown, 'utf8');

    // 4. Open it
    const openIn = config.get<OpenIn>('openIn', 'browser');
    if (openIn === 'browser' || openIn === 'both') {
      maybeShowSetupNotice(context);
      const ok = await openReportInBrowser(outFile, config);
      if (!ok && openIn === 'browser') await showPreview(outFile);
    }
    if (openIn === 'vscodePreview' || openIn === 'both') await showPreview(outFile);

    const warn = model.warnings.length ? ` · ${model.warnings.length} warning${model.warnings.length === 1 ? '' : 's'}` : '';
    vscode.window.setStatusBarMessage(`$(book) ${model.name} analysed → ${path.basename(outFile)}${warn}`, 8000);
    if (openIn === 'none') {
      const pick = await vscode.window.showInformationMessage(`Report saved: ${outFile}`, 'Show in Folder');
      if (pick) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outFile));
    }
  } catch (err) {
    vscode.window.showErrorMessage(`MultiValue Basic Analyser could not complete the analysis: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Empty setting → <workspace>/docs/uvdoc; no workspace → <program folder>/uvdoc; untitled → temp folder. */
export function resolveOutputFolder(setting: string, doc: vscode.TextDocument): string {
  const ws = vscode.workspace.getWorkspaceFolder(doc.uri) ?? vscode.workspace.workspaceFolders?.[0];
  const wsPath = ws?.uri.fsPath;
  const fileDir = doc.isUntitled ? undefined : path.dirname(doc.uri.fsPath);
  const base = wsPath ?? fileDir ?? path.join(os.tmpdir(), 'mvba');

  let s = (setting ?? '').trim();
  if (!s) return wsPath ? path.join(wsPath, 'docs', 'uvdoc') : fileDir ? path.join(fileDir, 'uvdoc') : base;
  s = s.replace(/\$\{workspaceFolder\}/g, base)
       .replace(/\$\{fileDirname\}/g, fileDir ?? base)
       .replace(/^~(?=$|[\\/])/, os.homedir());
  return path.isAbsolute(s) ? path.normalize(s) : path.join(base, s);
}

function displayPath(doc: vscode.TextDocument): string {
  if (doc.isUntitled) return 'unsaved file';
  const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
  return ws ? path.relative(ws.uri.fsPath, doc.uri.fsPath).split(path.sep).join('/') : doc.uri.fsPath;
}

async function openReportInBrowser(file: string, config: vscode.WorkspaceConfiguration): Promise<boolean> {
  const browser = config.get<string>('browser', 'chrome');
  const url = pathToFileURL(file).href;
  try {
    if (browser === 'system') {
      const ok = await vscode.env.openExternal(vscode.Uri.file(file));
      if (!ok) throw new Error('the operating system did not open the file');
      return true;
    }
    await openInBrowser(url, browser as BrowserChoice, config.get<string>('browserPath', ''));
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const pick = await vscode.window.showWarningMessage(
      `The report could not be opened in the browser (${reason}). It has been opened in the VS Code Markdown preview instead.`,
      'Browser Settings');
    if (pick) await vscode.commands.executeCommand('workbench.action.openSettings', 'mvbasicAnalyser.browser');
    return false;
  }
}

async function showPreview(file: string): Promise<void> {
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

/** First time a report goes to the browser, explain the one-off browser setup (doesn't block opening). */
function maybeShowSetupNotice(context: vscode.ExtensionContext): void {
  if (context.globalState.get<boolean>(SETUP_SHOWN_KEY, false)) return;
  void context.globalState.update(SETUP_SHOWN_KEY, true);
  void vscode.window.showInformationMessage(
    'Reports open in your browser as Markdown (.md) files. To display them with formatted tables and diagrams, install a Markdown viewer extension in your browser and allow it to access local files.',
    'Show Setup Guide', 'Use VS Code Preview Instead',
  ).then(async pick => {
    if (pick === 'Show Setup Guide') await showSetupGuide(context);
    if (pick === 'Use VS Code Preview Instead') {
      await vscode.workspace.getConfiguration('mvbasicAnalyser').update('openIn', 'vscodePreview', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Reports will now open in the VS Code Markdown preview. You can change this under Settings › MultiValue Basic Analyser › Open In.');
    }
  });
}

async function showSetupGuide(context: vscode.ExtensionContext): Promise<void> {
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'README.md'));
}
