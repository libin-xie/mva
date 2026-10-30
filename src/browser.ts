// Launches a specific browser with a file:// URL. No VS Code dependency.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type BrowserChoice = 'chrome' | 'edge' | 'custom';

function windowsCandidates(browser: 'chrome' | 'edge'): string[] {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? '';
  const rel = browser === 'chrome'
    ? ['Google\\Chrome\\Application\\chrome.exe']
    : ['Microsoft\\Edge\\Application\\msedge.exe'];
  return rel.flatMap(r => [pf, pf86, local].filter(Boolean).map(base => path.win32.join(base, r)));
}

function linuxCandidates(browser: 'chrome' | 'edge'): string[] {
  return browser === 'chrome'
    ? ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    : ['microsoft-edge', 'microsoft-edge-stable'];
}

/** Starts a program detached and resolves once it has started; rejects if it cannot be started. */
function launch(command: string, args: string[], waitForExit = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: !waitForExit, stdio: 'ignore', windowsHide: false });
    } catch (e) {
      reject(e);
      return;
    }
    child.once('error', reject);
    if (waitForExit) {
      child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
    } else {
      child.once('spawn', () => { child.unref(); resolve(); });
    }
  });
}

async function tryInOrder(commands: string[], args: string[]): Promise<string> {
  let lastError: unknown = new Error('no candidates');
  for (const cmd of commands) {
    try { await launch(cmd, args); return cmd; } catch (e) { lastError = e; }
  }
  throw lastError;
}

/**
 * Opens `url` in the chosen browser. Resolves with a short description of what was launched;
 * rejects with a readable message when the browser could not be found or started.
 */
export async function openInBrowser(url: string, browser: BrowserChoice, customPath = ''): Promise<string> {
  if (browser === 'custom') {
    if (!customPath) throw new Error('Browser is set to "custom" but no Browser Path is configured.');
    if (process.platform === 'darwin' && customPath.endsWith('.app')) {
      await launch('open', ['-a', customPath, url], true);
    } else {
      await launch(customPath, [url]);
    }
    return customPath;
  }
  const appName = browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
  if (process.platform === 'darwin') {
    await launch('open', ['-a', appName, url], true).catch(() => { throw new Error(`${appName} is not installed.`); });
    return appName;
  }
  if (process.platform === 'win32') {
    const found = windowsCandidates(browser).filter(p => fs.existsSync(p));
    if (!found.length) throw new Error(`${appName} was not found in the usual install folders.`);
    return tryInOrder(found, [url]);
  }
  return tryInOrder(linuxCandidates(browser), [url]).catch(() => { throw new Error(`${appName} was not found on the PATH.`); });
}
