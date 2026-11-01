import { fork, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unavailableReport } from './analyze.mjs';
import { ScanError } from './policy.mjs';
import { DEMO_SCENARIOS } from './fixtures.mjs';

export function browserExecutable(configured) {
  if (configured && (!isAbsolute(configured) || !existsSync(configured))) throw new Error('SCANNER_BROWSER_PATH must be an existing absolute browser executable');
  return configured || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].find(path => existsSync(path));
}

async function stopWorkerTree(worker) {
  if (!Number.isInteger(worker.pid) || worker.pid <= 0) return;
  if (process.platform === 'win32') {
    if (worker.exitCode !== null || worker.signalCode) return;
    // This PID is the child we just forked, never an arbitrary/public input.
    await new Promise(resolve => execFile(join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()));
  } else {
    try { process.kill(-worker.pid, 'SIGKILL'); } catch { worker.kill(); }
  }
}

export function createInspector({ loader = 'static', dns = 'system', executablePath } = {}) {
  if (!['static', 'browser'].includes(loader) || !['system', 'cloudflare'].includes(dns)) throw new Error('Invalid scanner configuration');
  const browserPath = loader === 'browser' ? browserExecutable(executablePath) : undefined;
  let active = 0;
  return async payload => {
    if (active >= 2) throw new ScanError('busy');
    active++;
    const demo = DEMO_SCENARIOS[payload.demoScenario];
    const unavailable = code => unavailableReport(demo?.url || payload.url, code, demo ? 'demo_fixture' : 'live');
    try {
      return await new Promise(resolve => {
        // Deliberately do not inherit .env, API keys, cookies or DB handles.
        // This is process separation, not a complete OS/container sandbox.
        const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
        const worker = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], { env, detached: process.platform !== 'win32', execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let settled = false;
        const finish = async report => { if (settled) return; settled = true; clearTimeout(timer); await stopWorkerTree(worker); resolve(report); };
        const timer = setTimeout(() => finish(unavailable('timeout')), 28000);
        worker.once('message', report => finish(report));
        worker.once('error', () => finish(unavailable('network_failed')));
        worker.once('exit', () => finish(unavailable('network_failed')));
        worker.send({ url: payload.url, demoScenario: payload.demoScenario, loader, dns, executablePath: browserPath });
      });
    } finally { active--; }
  };
}
