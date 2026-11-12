// A headless Chrome or Edge for the webview harnesses: BUZZ_CHROME, else the usual places; nothing is downloaded.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

/** The browser executable, or undefined. */
function findBrowser() {
  const env = process.env.BUZZ_CHROME;
  if (env && fs.existsSync(env)) return env;
  return (CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p));
}

/** Launch options for puppeteer-core: headless, a throwaway profile, no sandbox where CI runs as root. */
function launchOptions(extraArgs = []) {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('no Chrome or Edge found; set BUZZ_CHROME');
  const args = ['--no-first-run', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), ...extraArgs];
  return { executablePath, headless: true, userDataDir: path.join(os.tmpdir(), 'buzz-harness-profile'), args };
}

module.exports = { find: findBrowser, launchOptions };
