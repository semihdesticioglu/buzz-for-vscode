// The HTML of the chat webview. Labels are filled in from i18n at build time and carry data-i18n attributes so the
// webview can switch language without reloading; the script is nonce-locked and the CSP allows nothing else.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { lang, webviewStrings } from './i18n';

/** The chat webview document: strings in the current language, a nonce-locked script, a strict CSP. */
export function chatHtml(w: vscode.Webview, media: vscode.Uri, imageHost: string | undefined): string {
  const n = randomBytes(16).toString('base64'); // the only script the CSP lets run
  const css = w.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
  const js = w.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
  const imgHost = imageHost;
  const img = [w.cspSource, 'data:', imgHost ? `https://${imgHost} http://${imgHost}` : ''].filter(Boolean).join(' ');
  const s = webviewStrings();
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  // data-i18n / data-i18n-title / data-i18n-ph let the webview switch language without reloading
  const tx = (k: string) => `data-i18n="${k}">${esc(s[k] ?? k)}`;
  const ti = (k: string) => `data-i18n-title="${k}" title="${esc(s[k] ?? k)}"`;
  const cur = lang();
  return `<!DOCTYPE html>
<html lang="${cur}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src ${w.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>Buzz</title></head>
<body class="app">
<header class="top">
<div id="channelChips" class="ch-chips"><span class="muted" ${tx('loadingChannels')}</span></div>
<div class="top-actions">
  <span id="liveDot" class="live-dot off">${esc(s.polling)}</span>
  <div class="lang" role="group" ${ti('langTitle')}>
    <button type="button" data-lang="en" aria-pressed="${cur === 'en'}" class="${cur === 'en' ? 'on' : ''}">EN</button>
    <button type="button" data-lang="tr" aria-pressed="${cur === 'tr'}" class="${cur === 'tr' ? 'on' : ''}">TR</button>
  </div>
  <button id="wideBtn" class="icon-btn" ${ti('wide')}>⤢</button>
  <button id="refreshBtn" class="icon-btn" ${ti('refresh')}>⟳</button>
</div>
</header>
<div id="agentsOff" class="agents-off" hidden><span class="ao-text"></span><button id="openDesktopBtn" class="ao-btn" ${tx('openDesktop')}</button></div>
<div id="setup" class="setup" hidden></div>
<div id="main" class="main">
<aside class="threads">
  <div class="threads-head">
    <span id="channelTitle" class="ch-title"></span>
    <button id="newBtn" class="new-btn" ${ti('newThreadTitle')} ${tx('newThread')}</button>
  </div>
  <div class="search-row">
    <input id="searchBox" type="search" data-i18n-ph="searchPh" placeholder="${esc(s.searchPh)}" />
    <button id="searchScope" class="scope" type="button" ${ti('searchScopeChannel')}>#</button>
  </div>
  <div id="searchHead" class="search-head" hidden></div>
  <div id="channelTyping" class="ch-typing" hidden></div>
  <div id="threadList" class="thread-list"></div>
</aside>
<section class="thread-pane">
  <div class="thread-head">
    <button id="backBtn" class="back" ${tx('back')}</button>
    <span id="threadTitle" class="thread-title"></span>
    <span id="status" class="status"></span>
    <button id="filterBtn" class="filter-btn" type="button" ${ti('filterThread')}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.5 1a5.5 5.5 0 1 0 3.36 9.85l3.9 3.9 1.06-1.06-3.9-3.9A5.5 5.5 0 0 0 6.5 1Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg><span ${tx('filter')}</span></button>
  </div>
  <div id="filterRow" class="filter-row" hidden><input id="filterBox" type="search" data-i18n-ph="filterPh" placeholder="${esc(s.filterPh)}" /><span id="filterCount" class="muted"></span></div>
  <button id="elsewhere" class="elsewhere" hidden></button>
  <main id="log" class="log" aria-live="polite"></main>
  <div id="working" class="working" hidden><span class="dots"><i></i><i></i><i></i></span><span id="workingText"></span></div>
  <footer class="composer-wrap">
    <div id="replyBar" class="reply-bar" hidden></div>
    <div id="chips" class="chips"></div>
    <div class="composer">
      <textarea id="input" rows="1" data-i18n-ph="composerPh" placeholder="${esc(s.composerPh)}"></textarea>
      <div class="toolbar">
        <button id="mentionBtn" class="tool" ${ti('mention')}>@</button>
        <button id="attachBtn" class="tool" ${ti('attachTitle')} ${tx('attach')}</button>
        <span class="hint" ${tx('hint')}</span>
        <button id="sendBtn" class="send" ${ti('send')} aria-label="${esc(s.send)}"><svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 2.5 3.2 7.3l1.06 1.06L7.25 5.4V13.5h1.5V5.4l2.99 2.96 1.06-1.06z"/></svg></button>
      </div>
    </div>
    <div id="mentionMenu" class="menu mention-menu" hidden></div>
  </footer>
</section>
</div>
<script nonce="${n}" src="${js}"></script>
</body></html>`;
}
