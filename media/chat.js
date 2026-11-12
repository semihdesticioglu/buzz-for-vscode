// Buzz chat webview: channel notes on top, threads on the left, the selected thread on the right.
// Message HTML is produced by the extension with markdown-it (html:false); strings come from the extension (EN/TR).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const log = $('log'),
    input = $('input'),
    sendBtn = $('sendBtn');
  const channelChips = $('channelChips'),
    threadList = $('threadList'),
    threadTitle = $('threadTitle'),
    channelTitle = $('channelTitle');
  const mentionMenu = $('mentionMenu'),
    chips = $('chips'),
    working = $('working'),
    workingText = $('workingText');
  const status = $('status'),
    setupBox = $('setup'),
    main = $('main'),
    elsewhere = $('elsewhere'),
    agentsOff = $('agentsOff'),
    openDesktopBtn = $('openDesktopBtn'),
    searchBox = $('searchBox'),
    searchScope = $('searchScope'),
    searchHead = $('searchHead'),
    filterBtn = $('filterBtn'),
    filterRow = $('filterRow'),
    filterBox = $('filterBox'),
    filterCount = $('filterCount'),
    backBtn = $('backBtn');
  const channelTyping = $('channelTyping'),
    replyBar = $('replyBar');
  const seen = new Map(); // thread id -> latest activity seen (for the unread dot)
  const narrow = window.matchMedia('(max-width: 640px)');

  const st = {
    searchScope: 'channel', // what the search box covers: this channel, or every channel ('all')
    ready: false,
    channels: [],
    current: null,
    threads: [],
    openId: undefined,
    members: [],
    mentions: new Map(),
    sending: false,
    firstThreads: true,
    olderDone: false,
    menu: { open: false, items: [], index: 0, start: 0 },
    strings: {},
    lang: document.documentElement.lang || 'en',
    live: { state: 'off' },
    presence: {},
    busy: new Set(),
    working: { items: [], channel: [] },
    setupMsg: null,
    replyTo: null, // { id, author, snippet }: answer this message directly instead of the thread root
  };
  // drafts: one per thread and one per channel's "New thread" ("channel:thread", "channel:new"), kept by the
  // extension, so the side bar and the editor tab share them and they outlive a reload
  const DRAFTS_MAX = 30;
  const drafts = new Map(); // key -> { text, mentions: [[name, pubkey]], replyTo, at }; the newest last
  let draftKey = null; // whose draft the composer shows (null: no thread on screen yet)
  let sentFrom = null; // the composer a message on its way was sent from
  let draftTimer = 0;
  // an older version kept one draft in this view's own state: it goes to the first composer that opens
  const saved = vscode.getState() || {};
  if (saved.draft) input.value = saved.draft;
  if (saved.draft !== undefined) vscode.setState({});
  autosize();

  /** Translate: T('replies', 3) -> "💬 3 replies". */
  function T(key) {
    const s = st.strings[key];
    const args = Array.prototype.slice.call(arguments, 1);
    return (s === undefined ? key : s).replace(/\{(\d+)\}/g, (_, i) => (args[i] === undefined ? '' : String(args[i])));
  }
  const locale = () => (st.lang === 'tr' ? 'tr-TR' : 'en-GB');

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'i18n':
        return onI18n(m);
      case 'host':
        return onHost(m);
      case 'channels':
        return onChannels(m);
      case 'channel':
        return onChannel(m);
      case 'threads':
        return onThreads(m);
      case 'searchResults':
        return onSearchResults(m);
      case 'thread':
        onThread(m);
        if (m.partial) log.prepend(el('div', 'notice', T('threadPartial'))); // its oldest part could not be read
        return;
      case 'threadAppend':
        return onThreadAppend(m);
      case 'olderDone':
        st.olderDone = true;
        return renderThreads();
      case 'elsewhere':
        return onElsewhere(m);
      case 'agentsOffline':
        return onAgentsOffline(m);
      case 'live':
        st.live = m;
        return renderLive();
      case 'jiraInfo':
        return onJiraInfo(m);
      case 'members':
        st.members = m.items;
        return renderChannels();
      case 'presence':
        st.presence = m.map || {};
        renderChannels();
        return applyPresence();
      case 'working':
        return onWorking(m);
      case 'contexts':
        return onContexts(m.items);
      case 'focusInput':
        input.focus();
        return;
      case 'drafts':
        return onDrafts(m);
      case 'sending':
        st.sending = m.on;
        sendBtn.classList.toggle('busy', !!m.on);
        if (!m.on) sentFrom = null; // 'sent' (if it went) came before this
        updateSend();
        return;
      case 'sent':
        return onSent(m);
      case 'status':
        status.textContent = m.text || '';
        status.title = m.text || '';
        return;
      case 'error':
        return toast(m.message);
      case 'toast':
        return toast(m.message, m.ok);
    }
  });

  // ------------------------------------------------------------ language
  function onI18n(m) {
    st.strings = m.strings || {};
    st.lang = m.lang || 'en';
    document.documentElement.lang = st.lang;
    document.querySelectorAll('[data-i18n]').forEach((e) => {
      e.textContent = T(e.dataset.i18n);
    });
    if (typeof renderScope === 'function') renderScope();
    if (st.search && st.search.items) renderSearch();
    document.querySelectorAll('[data-i18n-title]').forEach((e) => {
      e.title = T(e.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((e) => {
      e.placeholder = T(e.dataset.i18nPh);
    });
    document.querySelectorAll('.lang button').forEach((b) => {
      const on = b.dataset.lang === st.lang;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('sendBtn').setAttribute('aria-label', T('send'));
    renderLive();
    if (st.setupMsg) onChannels(st.setupMsg);
    else if (st.ready) renderChannels();
    if (st.current) {
      channelTitle.textContent = (st.current.isDm ? '@ ' : '# ') + st.current.name;
      renderThreads();
    }
    renderWorking();
    updatePlaceholder();
  }
  document.querySelectorAll('.lang button').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.lang !== st.lang) vscode.postMessage({ type: 'setLanguage', lang: b.dataset.lang });
    };
  });

  // ------------------------------------------------------------ channels (post-it notes)
  function onChannels(m) {
    st.ready = m.ready;
    if (!m.ready) {
      st.setupMsg = m;
      main.hidden = true;
      setupBox.hidden = false;
      setupBox.innerHTML = '';
      const card = el('div', 'card');
      card.append(el('h3', '', T('connect')), el('p', '', m.error || T('setupNeeded')));
      // "Start setup" only when something is really missing (CLI, relay, key); a passing failure gets "Try again"
      if (m.setup !== false) {
        const b = el('button', '', T('startSetup'));
        b.onclick = () => vscode.postMessage({ type: 'setup' });
        card.append(b);
      }
      const r = el('button', m.setup !== false ? 'secondary' : '', T('retry'));
      r.onclick = () => vscode.postMessage({ type: 'refresh' });
      card.append(r);
      setupBox.append(card);
      channelChips.innerHTML = '';
      updateSend();
      return;
    }
    st.setupMsg = null;
    main.hidden = false;
    setupBox.hidden = true;
    st.channels = m.items || [];
    renderChannels();
  }

  function renderChannels() {
    if (!st.ready) return;
    channelChips.innerHTML = '';
    if (!st.channels.length) channelChips.append(el('span', 'muted', T('noChannels')));
    for (const c of st.channels) {
      const active = st.current && st.current.id === c.id;
      const b = el('button', 'note c' + c.color + (c.isDm ? ' dm' : '') + (active ? ' active' : ''));
      if (c.peer) {
        b.dataset.pk = c.peer;
        b.prepend(el('span', 'pdot'));
      }
      b.append(document.createTextNode((c.isDm ? '@ ' : '# ') + c.name));
      b.title = c.isDm ? T('dmTitle', c.name) : '#' + c.name;
      // the open channel shows how many of its agents are online
      if (active && !c.isDm) {
        const on = st.members.filter((x) => x.isAgent && st.presence[x.pubkey] === 'online');
        if (on.length) {
          const n = el('span', 'note-online', '● ' + on.length);
          n.title = on.map((x) => x.name).join(', ') + ' · ' + T('online');
          b.append(n);
        }
      }
      b.style.setProperty('--tilt', ((c.color % 3) - 1) * 1.2 + 'deg');
      b.onclick = () => {
        if (st.current && st.current.id === c.id) return;
        threadList.innerHTML = '';
        threadList.append(el('div', 'muted pad', T('loading')));
        vscode.postMessage({ type: 'select', id: c.id });
      };
      channelChips.append(b);
    }
    // "+": new channel, join a channel, add a member (a menu on the extension side)
    const add = el('button', 'note add', '＋');
    add.title = T('channelMenu');
    add.setAttribute('aria-label', T('channelMenu'));
    add.onclick = () => vscode.postMessage({ type: 'channelMenu' });
    channelChips.append(add);
    applyPresence();
  }

  // ------------------------------------------------------------ agents offline (Buzz Desktop closed)
  function onAgentsOffline(m) {
    agentsOff.hidden = !m.offline;
    if (!m.offline) return;
    agentsOff.querySelector('.ao-text').textContent = T('agentsOffline', (m.names || []).join(', '));
    openDesktopBtn.disabled = false;
    openDesktopBtn.textContent = T('openDesktop');
  }
  openDesktopBtn.onclick = () => {
    vscode.postMessage({ type: 'openDesktop' });
    openDesktopBtn.disabled = true;
    agentsOff.querySelector('.ao-text').textContent = T('desktopStarting');
  };

  function onChannel(m) {
    const changed = !st.current || st.current.id !== m.id;
    if (changed && draftKey !== null) {
      // the thread on screen keeps its draft (text, mentions, reply target); the composer is empty while the channel
      // loads. Text typed with no thread on screen yet (an older version's draft, typing while loading) stays and goes
      // to the first thread that opens.
      keepDraft();
      draftKey = null;
      showDraft(null);
    }
    st.current = m;
    if (changed) {
      st.firstThreads = true;
      st.olderDone = false;
      st.openId = undefined;
      st.threads = [];
      st.members = [];
      st.busy = new Set();
      log.innerHTML = '';
      threadTitle.textContent = '';
      st.mentions.clear();
      seen.clear();
      elsewhere.hidden = true;
      agentsOff.hidden = true;
      // an all-channel search survives the switch (a result in another channel was opened); a channel search does not
      if (!(st.search && st.search.scope === 'all')) {
        st.search = undefined;
        searchBox.value = '';
        searchHead.hidden = true;
      }
      filterBox.value = '';
      filterRow.hidden = true;
      filterBtn.classList.remove('on');
      filterCount.textContent = '';
      body.classList.remove('show-thread');
      threadList.innerHTML = '';
      threadList.append(el('div', 'muted pad', T('loading')));
      if (st.search) renderSearch();
    }
    channelTitle.textContent = (m.isDm ? '@ ' : '# ') + m.name;
    renderChannels();
    syncDraft();
    updatePlaceholder();
    updateSend();
  }

  // ------------------------------------------------------------ threads (left)
  function onThreads(m) {
    if (!st.current || m.channelId !== st.current.id) return;
    st.threads = m.items || [];
    if (typeof m.more === 'boolean') st.olderDone = !m.more; // whether older pages can still be read
    if (st.firstThreads) st.readFloor = st.threads.reduce((a, t) => Math.max(a, t.ts), 0);
    for (const t of st.threads) {
      // on first load everything counts as read; so do threads where I wrote last, the open one, and older
      // threads brought in later ("Load older", an old thread opened from a notification)
      if (st.firstThreads || t.lastIsMe || t.id === st.openId || t.ts <= (st.readFloor || 0)) seen.set(t.id, t.ts);
    }
    // on first load the first thread opens with the list (wide layout): marked in this very render, not in a second one
    let first;
    if (st.firstThreads) {
      st.firstThreads = false;
      if (!narrow.matches && st.openId === undefined) {
        if (st.threads.length) {
          first = st.threads[0].id;
          st.openId = first;
        } else vscode.postMessage({ type: 'newThread' });
      }
    }
    renderThreads();
    if (first) openThread(first, true);
  }

  function avatar(cls, p) {
    const a = el('span', cls + (p.isAgent ? ' agent' : ''), p.isAgent ? '🐝' : p.initials);
    if (p.pubkey) a.dataset.pk = p.pubkey;
    return a;
  }

  function renderThreads() {
    if (!st.current) return;
    if (st.search) return; // results stay as they are; a live list update does not redraw them
    const top = threadList.scrollTop;
    threadList.innerHTML = '';
    if (!st.threads.length) {
      threadList.append(el('div', 'muted pad', T('noThreads')));
      return;
    }
    let unread = 0;
    for (const t of st.threads) {
      const isNew = t.id !== st.openId && t.ts > (seen.get(t.id) || 0);
      const busy = st.busy.has(t.id);
      if (isNew) unread++;
      const it = el('div', 'titem' + (t.id === st.openId ? ' active' : '') + (busy ? ' busy' : '') + (isNew ? ' unread' : ''));
      it.dataset.id = t.id;
      it.tabIndex = 0;
      const head = el('div', 't-head');
      head.append(avatar('avatar', t));
      head.append(el('span', 't-author', t.isMe ? T('you') : t.author));
      head.append(el('span', 't-time', t.time));
      it.append(head);
      if (t.id !== st.openId && st.current && drafts.has(st.current.id + ':' + t.id)) {
        const pen = el('span', 't-draft', '✎');
        pen.title = T('draft');
        head.insertBefore(pen, head.querySelector('.t-time'));
      }
      it.append(el('div', 't-snippet', t.snippet));
      const meta = el('div', 't-meta');
      const faces = el('span', 'faces');
      (t.people || []).forEach((p) => {
        const f = avatar('face', p);
        f.title = p.name;
        faces.append(f);
      });
      meta.append(faces);
      const n = t.replies;
      meta.append(
        el(
          'span',
          '',
          !n
            ? T('noReplies')
            : n === 1
              ? t.lastAuthor
                ? T('repliesOneLatest', t.lastAuthor)
                : T('repliesOne')
              : t.lastAuthor
                ? T('repliesLatest', n, t.lastAuthor)
                : T('replies', n),
        ),
      );
      if (busy) {
        const d = el('span', 'dots');
        d.append(el('i'), el('i'), el('i'));
        meta.append(d);
      }
      it.append(meta);
      it.onclick = () => openThread(t.id);
      it.onkeydown = (e) => {
        if (e.key === 'Enter') openThread(t.id);
      };
      threadList.append(it);
    }
    backBtn.textContent = unread ? T('backNew') : T('back');
    backBtn.classList.toggle('has-new', unread > 0);
    if (!st.olderDone) {
      const o = el('button', 'older', T('older'));
      o.type = 'button';
      o.onclick = () => {
        o.textContent = T('loading');
        vscode.postMessage({ type: 'older' });
      };
      threadList.append(o);
    }
    threadList.scrollTop = top;
    applyPresence(threadList);
    revealActive();
  }

  // ------------------------------------------------------------ search: the whole history, through Buzz's search
  function runSearch() {
    const query = searchBox.value.trim();
    if (!query) return clearSearch();
    st.search = { query, scope: st.searchScope };
    renderSearch();
    vscode.postMessage({ type: 'search', query, scope: st.searchScope });
  }
  function clearSearch() {
    if (!st.search && !searchBox.value) return;
    st.search = undefined;
    searchBox.value = '';
    searchHead.hidden = true;
    renderThreads();
  }
  function onSearchResults(m) {
    if (!st.search || m.query !== st.search.query || m.scope !== st.search.scope) return;
    st.search.items = m.items || [];
    st.search.capped = !!m.capped;
    st.search.cap = m.cap;
    st.search.error = m.error;
    renderSearch();
  }
  function renderSearch() {
    const s = st.search;
    if (!s) return;
    const top = threadList.scrollTop;
    searchHead.textContent = '';
    searchHead.hidden = false;
    threadList.innerHTML = '';
    const n = s.items ? s.items.length : 0;
    const text = !s.items
      ? T('searching')
      : s.error
        ? s.error
        : (n ? T('searchResults', n, s.query) : T('searchNone', s.query)) + (s.capped ? ' ' + T('searchCapped', s.cap || n) : '');
    searchHead.append(el('span', '', text));
    const clear = el('button', 'link', T('clear'));
    clear.type = 'button';
    clear.onclick = clearSearch;
    searchHead.append(clear); // also while searching: a search the extension could not answer must not trap the list
    if (!s.items) return;
    for (const r of s.items) {
      const it = el('div', 'titem result' + (r.id === st.openId ? ' active' : ''));
      it.dataset.id = r.id;
      it.tabIndex = 0;
      const head = el('div', 't-head');
      head.append(avatar('avatar', r));
      head.append(el('span', 't-author', r.isMe ? T('you') : r.author));
      head.append(el('span', 't-time', r.time));
      it.append(head);
      it.append(el('div', 't-snippet', r.snippet));
      const meta = el('div', 't-meta');
      if (s.scope === 'all' || !st.current || r.channelId !== st.current.id) meta.append(el('span', 's-ch', r.channelName));
      if (r.matches > 1) meta.append(el('span', '', T('matches', r.matches)));
      it.append(meta);
      const open = () => vscode.postMessage({ type: 'openResult', channel: r.channelId, id: r.id });
      it.onclick = open;
      it.onkeydown = (e) => {
        if (e.key === 'Enter') open();
      };
      threadList.append(it);
    }
    applyPresence(threadList);
    threadList.scrollTop = top;
  }
  function renderScope() {
    const key = st.searchScope === 'channel' ? 'searchScopeChannel' : 'searchScopeAll';
    searchScope.textContent = st.searchScope === 'channel' ? '#' : '∗';
    searchScope.dataset.i18nTitle = key;
    searchScope.title = T(key);
    searchScope.classList.toggle('all', st.searchScope === 'all');
  }
  searchBox.onkeydown = (e) => {
    if (e.key === 'Enter') runSearch();
    else if (e.key === 'Escape') clearSearch();
  };
  searchBox.oninput = () => {
    if (!searchBox.value && st.search) clearSearch();
  };
  searchScope.onclick = () => {
    st.searchScope = st.searchScope === 'channel' ? 'all' : 'channel';
    renderScope();
    if (st.search) runSearch();
  };
  renderScope();

  // ------------------------------------------------------------ filter inside the open thread (instant, local)
  // case folding in both languages: "INSERT" must find "insert" under a Turkish UI, "İstanbul" "istanbul" under English
  const folds = (s) => [s.toLocaleLowerCase('en'), s.toLocaleLowerCase('tr')];
  function applyFilter() {
    const raw = filterBox.value.trim();
    const qs = folds(raw);
    const msgs = [...log.querySelectorAll('.msg')];
    let shown = 0;
    for (const m of msgs) {
      // the message's text and its author, not the buttons and labels around them
      const body = m.querySelector('.body');
      const name = m.querySelector('.name');
      const ts = folds((body ? body.textContent : m.textContent) + ' ' + (name ? name.textContent : ''));
      const hit = !raw || ts.some((t, i) => t.includes(qs[i]));
      m.classList.toggle('filtered-out', !hit);
      if (hit) {
        shown++;
        if (raw && body && body.classList.contains('fold')) body.classList.add('open'); // the match may be in the folded part
      }
    }
    // a day line with nothing visible under it goes too
    for (const d of log.querySelectorAll('.day')) {
      let any = false;
      for (let n = d.nextElementSibling; n && !n.classList.contains('day'); n = n.nextElementSibling) {
        if (n.classList.contains('msg') && !n.classList.contains('filtered-out')) {
          any = true;
          break;
        }
      }
      d.classList.toggle('filtered-out', !!raw && !any);
    }
    log.classList.toggle('filtering', !!raw); // grouped messages show their author again
    filterCount.textContent = raw ? T('filterCount', shown, msgs.length) : '';
  }
  filterBtn.onclick = () => {
    filterRow.hidden = !filterRow.hidden;
    filterBtn.classList.toggle('on', !filterRow.hidden);
    if (filterRow.hidden) {
      filterBox.value = '';
      applyFilter();
    } else {
      filterBox.focus();
    }
  };
  filterBox.oninput = applyFilter;
  filterBox.onkeydown = (e) => {
    if (e.key === 'Escape') {
      filterBox.value = '';
      applyFilter();
      filterRow.hidden = true;
      filterBtn.classList.remove('on');
    }
  };
  new MutationObserver(() => {
    if (filterBox.value) applyFilter();
  }).observe(log, { childList: true });

  /** `listed`: the list was just rendered with this thread active, so it is not rendered a second time. */
  function openThread(id, listed) {
    elsewhere.hidden = true;
    if (id === st.openId && st.renderedId === id && log.querySelector('.msg')) {
      body.classList.add('show-thread');
      return;
    }
    st.openId = id;
    const t = st.threads.find((x) => x.id === id);
    if (t) seen.set(id, t.ts);
    syncDraft();
    if (!listed) {
      renderThreads();
      markActive();
    }
    log.innerHTML = '';
    st.renderedId = undefined; // what was on screen is gone: the next thread message is a fresh render
    log.append(el('div', 'muted pad', T('loading')));
    body.classList.add('show-thread');
    vscode.postMessage({ type: 'openThread', id });
  }

  function markActive() {
    [...threadList.querySelectorAll('.titem')].forEach((x) => x.classList.toggle('active', !!x.dataset.id && x.dataset.id === st.openId));
    revealActive();
  }

  /** A thread opened from outside (Buzz Lens, a notification): scroll the list to it once, gently. */
  function revealActive() {
    if (!st.revealActive) return;
    const it = threadList.querySelector('.titem.active');
    if (!it) return;
    st.revealActive = false;
    if (it.offsetParent) it.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ------------------------------------------------------------ selected thread (right)
  function onThread(m) {
    const same = st.renderedId === m.id; // same thread re-rendered (language switch, a nested reply arrived)
    if (m.id && !same) st.revealActive = true;
    st.openId = m.id === null ? null : m.id;
    const t = st.threads.find((x) => x.id === m.id);
    if (t) seen.set(t.id, t.ts);
    syncDraft(); // the composer shows this thread's draft, its reply bar included
    markActive();
    if (!same || m.reveal || m.id === null) body.classList.add('show-thread');
    if (m.id && st.elsewhereThread === m.id) elsewhere.hidden = true;
    const stick = same && nearBottom();
    const keep = same ? log.scrollTop : null;
    st.renderedId = m.id;
    threadTitle.textContent = m.id === null ? T('newThread') : m.title || '';
    threadTitle.title = threadTitle.textContent;
    log.innerHTML = '';
    st.lastMsg = null;
    hideJira();
    if (m.id === null) {
      log.append(el('div', 'empty', m.notice || T('newThreadEmpty')));
    } else if (!m.items.length) {
      log.append(el('div', 'muted pad', T('loading')));
    } else {
      appendItems(m.items);
    }
    updatePlaceholder();
    updateSend();
    requestAnimationFrame(() => {
      log.scrollTop = keep === null ? log.scrollHeight : keep;
      // a reply that landed under an earlier message: highlight it, and bring it into view if you were following along
      const flashed = (m.flash || []).map((id) => log.querySelector('.msg[data-id="' + id + '"]')).filter(Boolean);
      flashed.forEach((x) => x.classList.add('flash'));
      if (flashed.length && stick) flashed[flashed.length - 1].scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    if (keep === null && (!narrow.matches || m.id === null)) input.focus();
  }

  /** Live connection indicator. */
  function renderLive() {
    const m = st.live;
    const dot = $('liveDot');
    const live = m.state === 'live';
    dot.className = 'live-dot ' + (live ? 'on' : m.state === 'connecting' ? 'wait' : 'off');
    dot.textContent = live ? T('live') : m.state === 'connecting' ? T('connecting') : T('polling');
    const why =
      m.reason === 'certificate'
        ? T('certTip')
        : { off: T('offTip'), offline: T('offlineTip'), error: T('errorTip'), connecting: T('connectingTip') }[m.state] || T('liveTip');
    dot.title = why + (m.detail ? ' (' + m.detail + ')' : '') + (live ? '' : T('pollingSuffix'));
  }

  /** New message outside the open thread: a clickable banner above the thread. */
  function onElsewhere(m) {
    if (m.thread === st.openId) return;
    st.elsewhereThread = m.thread;
    elsewhere.textContent = '';
    elsewhere.append(el('span', 'ew-dot', '●'));
    elsewhere.append(el('span', 'ew-text', (m.count > 1 ? T('elsewhereMany', m.count) : T('elsewhereOne')) + m.author + ': ' + m.snippet));
    elsewhere.append(el('span', 'ew-open', T('open')));
    elsewhere.onclick = () => openThread(m.thread);
    elsewhere.hidden = false;
  }

  function onThreadAppend(m) {
    if (m.id !== st.openId) return;
    const stick = nearBottom();
    const p = log.querySelector('.pad');
    if (p) p.remove();
    appendItems(m.items);
    if (stick) requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  }

  // ------------------------------------------------------------ day separators, grouping, folding
  const GROUP_GAP = 5 * 60; // messages by the same person within 5 minutes share one header

  function dayKey(ts) {
    const d = new Date(ts * 1000);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function dayLabel(ts) {
    const d = new Date(ts * 1000);
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (diff === 0) return T('today');
    if (diff === 1) return T('yesterday');
    const wd = d.toLocaleDateString(locale(), { weekday: 'long' });
    const dm = d.toLocaleDateString(
      locale(),
      d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' },
    );
    return wd.charAt(0).toLocaleUpperCase(locale()) + wd.slice(1) + ', ' + dm;
  }

  function appendItems(items) {
    for (const it of items) {
      const depth = it.depth || 0;
      const day = dayKey(it.ts);
      const last = st.lastMsg;
      // day separators only between top-level messages; a nested reply stays under its parent
      if (depth === 0 && (!last || last.topDay !== day)) log.append(el('div', 'day', dayLabel(it.ts)));
      const cont =
        !!last &&
        last.author === it.author &&
        last.isMe === it.isMe &&
        !it.isRoot &&
        it.ts - last.ts < GROUP_GAP &&
        last.depth === depth &&
        last.parentId === it.parentId &&
        dayKey(last.ts) === day;
      // "↳ reply to X" when the message it answers isn't the one right above
      const label = depth > 0 && it.parentAuthor && (!last || last.id !== it.parentId);
      // a nested reply from another day than the separator above it shows its day next to the time
      const otherDay = depth > 0 && last && last.topDay !== day;
      const a = msgEl(it, cont && !label, label, otherDay ? dayLabel(it.ts) + ' ' : '');
      log.append(a);
      if (!it.isMe) requestAnimationFrame(() => foldIfLong(a));
      st.lastMsg = {
        id: it.id,
        day,
        topDay: depth === 0 ? day : last ? last.topDay : day,
        author: it.author,
        isMe: it.isMe,
        ts: it.ts,
        depth,
        parentId: it.parentId,
      };
    }
    applyPresence(log);
  }

  function foldIfLong(a) {
    const b = a.querySelector('.body');
    // a message with a proposed change stays open so its Show diff / Apply buttons are visible
    if (!b || b.scrollHeight <= 260 || b.querySelector('.patch')) return;
    const extra = Math.max(2, Math.round((b.scrollHeight - 170) / 21));
    b.classList.add('fold');
    const more = el('button', 'more', T('showMore', extra));
    more.type = 'button';
    more.onclick = () => {
      const open = b.classList.toggle('open');
      more.textContent = open ? T('showLess') : T('showMore', extra);
    };
    a.append(more);
  }

  function msgEl(it, cont, label, dayPrefix) {
    const depth = it.depth || 0;
    const a = el(
      'article',
      'msg' + (it.isMe ? ' me' : '') + (it.isAgent ? ' agent' : '') + (it.isRoot ? ' root' : '') + (cont ? ' cont' : '') + (depth ? ' nested' : ''),
    );
    a.dataset.id = it.id;
    if (depth) a.style.setProperty('--depth', String(Math.min(depth, 3)));
    if (label) a.append(el('div', 'reply-to', T('replyTo', it.parentAuthor)));
    if (it.id && st.openId) {
      const r = el('button', 'reply-btn', T('reply'));
      r.type = 'button';
      r.title = T('replyTitle');
      r.dataset.reply = it.id;
      r.dataset.author = it.isMe ? T('you') : it.author;
      r.dataset.snippet = it.snippet || '';
      a.append(r);
    }
    const head = el('div', 'head');
    head.append(avatar('avatar', it));
    head.append(el('span', 'name', it.isMe ? T('you') : it.author));
    if (it.isAgent && !it.isMe) head.append(el('span', 'tag', T('agentTag')));
    if (it.isRoot) head.append(el('span', 'tag root-tag', T('threadTag')));
    const time = el('span', 'time', (dayPrefix || '') + it.time);
    time.title = new Date(it.ts * 1000).toLocaleString(locale());
    head.append(time);
    a.append(head);
    const b = el('div', 'body');
    b.innerHTML = it.html; // produced safely in the extension (markdown-it, html:false)
    b.querySelectorAll('.code > .copy').forEach((x) => {
      x.textContent = T('copy');
    });
    b.querySelectorAll('a.ref').forEach((x) => {
      x.title = x.dataset.line ? T('openInEditorLine', x.dataset.path, x.dataset.line) : T('openInEditor', x.dataset.path);
    });
    for (const p of it.patches || []) {
      const code = b.querySelector('.code[data-block="' + p.block + '"]');
      if (code) code.after(patchBar(it.id, p));
    }
    if (it.git) b.append(gitBar(it.id, it.git));
    a.append(b);
    return a;
  }

  /** Work an agent reports (a branch or commit): Show diff. */
  function gitBar(id, g) {
    const bar = el('div', 'patch gitbar');
    const refs = [...g.branches, ...g.commits.map((c) => c.slice(0, 7))];
    bar.append(el('span', 'p-label', '⎇'));
    const what = el('span', 'p-file', refs.join(' · '));
    what.title = [...g.branches, ...g.commits].join('\n');
    bar.append(what);
    const btn = el('button', 'pbtn primary', T('showDiff'));
    btn.type = 'button';
    btn.title = T('gitDiffTip');
    btn.dataset.act = 'gitDiff';
    btn.dataset.id = id;
    bar.append(btn);
    return bar;
  }

  /** "Show diff / Apply" under a code block the agent proposed for a file. */
  function patchBar(id, p) {
    const bar = el('div', 'patch');
    bar.append(el('span', 'p-label', '✎ ' + T('proposal')));
    const file = el('span', 'p-file', p.files.join(', '));
    file.title = p.files.join('\n');
    bar.append(file);
    const diff = el('button', 'pbtn primary', T('showDiff'));
    diff.type = 'button';
    diff.dataset.act = 'patchDiff';
    const btns = [diff];
    if (p.local) {
      // opt-in (buzz.proposals.applyLocally): write the proposal into your own workspace
      const apply = el('button', 'pbtn', T('apply'));
      apply.type = 'button';
      apply.dataset.act = 'patchApply';
      btns.push(apply);
    }
    for (const btn of btns) {
      btn.dataset.id = id;
      btn.dataset.block = p.block;
      bar.append(btn);
    }
    return bar;
  }

  // ------------------------------------------------------------ presence and typing
  /** Green (online) / yellow (away) dot on every element that carries a pubkey. */
  function applyPresence(root) {
    (root || document).querySelectorAll('[data-pk]').forEach((e) => {
      const s = st.presence[e.dataset.pk];
      e.classList.toggle('p-online', s === 'online');
      e.classList.toggle('p-away', s === 'away');
      if (e.dataset.btitle === undefined) e.dataset.btitle = e.title || '';
      const word = s === 'online' ? T('online') : s === 'away' ? T('away') : '';
      e.title = [e.dataset.btitle, word].filter(Boolean).join(' · ');
    });
  }

  function onWorking(m) {
    st.working = { items: m.items || [], channel: m.channel || [] };
    const busy = new Set(m.busy || []);
    const changed = busy.size !== st.busy.size || [...busy].some((x) => !st.busy.has(x));
    st.busy = busy;
    if (changed) renderThreads();
    renderWorking();
  }

  function phrase(list) {
    // "working" only when the agent itself says so (a typing signal, as Buzz Desktop shows it); after a mention
    // without a signal the chat is merely waiting, and says so
    const working = list.filter((x) => x.isAgent && x.real).map((x) => '@' + x.name);
    const waiting = list.filter((x) => x.isAgent && !x.real).map((x) => '@' + x.name);
    const people = list.filter((x) => !x.isAgent).map((x) => x.name);
    const parts = [];
    if (working.length) parts.push(working.length > 1 ? T('workingMany', working.join(', ')) : T('working', working[0]));
    if (waiting.length) parts.push(waiting.length > 1 ? T('waitingMany', waiting.join(', ')) : T('waiting', waiting[0]));
    if (people.length) parts.push(people.length > 1 ? T('typingMany', people.join(', ')) : T('typing', people[0]));
    return parts.join(' · ');
  }

  function renderWorking() {
    const here = st.working.items;
    working.hidden = !here.length;
    workingText.textContent = here.length ? phrase(here) : '';
    const ch = st.working.channel;
    channelTyping.hidden = !ch.length;
    channelTyping.textContent = ch.length ? phrase(ch) : '';
  }

  function onContexts(items) {
    chips.innerHTML = '';
    const icon = { code: '⌗', error: '⚠', terminal: '›_' };
    items.forEach((c, i) => {
      const chip = el('span', 'chip k-' + c.kind);
      chip.title = c.title;
      chip.append(document.createTextNode((icon[c.kind] || '⌗') + ' ' + c.label));
      const x = el('button', '', '✕');
      x.title = T('remove');
      x.onclick = () => vscode.postMessage({ type: 'removeContext', index: i });
      chip.append(x);
      chips.append(chip);
    });
    updateSend();
  }

  function onSent(m) {
    // text typed while the message was being sent stays
    const sent = m && typeof m.text === 'string' ? m.text : null;
    const rest = (text) => (sent === null ? '' : text.startsWith(sent) ? text.slice(sent.length).replace(/^\s+/, '') : text);
    const from = sentFrom;
    sentFrom = null;
    if (from && from !== draftKey) {
      // another thread is on screen by now: what was sent leaves the draft it was typed in, this composer stays
      const d = drafts.get(from);
      if (d) {
        const text = rest(d.text);
        if (text.trim()) drafts.set(from, { ...d, text, replyTo: null, at: Date.now() });
        else drafts.delete(from);
        persistDrafts();
        markDrafts();
      }
      updateSend();
      return;
    }
    setReply(null);
    input.value = rest(input.value);
    for (const name of [...st.mentions.keys()]) if (!input.value.includes('@' + name)) st.mentions.delete(name);
    keepDraft();
    autosize();
    updateSend();
    input.focus();
  }

  // ------------------------------------------------------------ composer
  /** Reply to a specific message: shown as a bar above the composer until sent or cancelled. */
  function setReply(r) {
    st.replyTo = r;
    replyBar.innerHTML = '';
    replyBar.hidden = !r;
    if (!r) return;
    replyBar.append(el('span', 'rb-icon', '↳'));
    const txt = el('span', 'rb-text');
    txt.append(el('strong', '', T('replyingTo', r.author)));
    if (r.snippet) txt.append(document.createTextNode(' · ' + r.snippet));
    replyBar.append(txt);
    const x = el('button', '', '✕');
    x.type = 'button';
    x.title = T('cancel');
    x.onclick = () => {
      setReply(null);
      keepDraft();
      input.focus();
    };
    replyBar.append(x);
  }

  function updatePlaceholder() {
    if (!st.current) {
      input.placeholder = T('composerPh');
      return;
    }
    input.placeholder = st.openId ? T('replyPh') : st.current.isDm ? T('newPhDm', st.current.name) : T('newPhChannel', st.current.name);
  }

  function send() {
    if (!canSend()) return;
    const text = input.value;
    const pubkeys = [];
    for (const [name, pk] of st.mentions) if (text.includes('@' + name)) pubkeys.push(pk);
    st.sending = true;
    sentFrom = draftKey;
    updateSend();
    // the channel and thread on screen travel with the message: a click on another channel a moment earlier must not redirect it
    vscode.postMessage({ type: 'send', text, mentions: pubkeys, replyTo: st.replyTo ? st.replyTo.id : undefined, thread: st.openId, channel: st.current.id });
  }

  function canSend() {
    return st.ready && st.current && st.openId !== undefined && !st.sending && (input.value.trim() || chips.children.length);
  }
  function updateSend() {
    sendBtn.disabled = !canSend();
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  // ------------------------------------------------------------ drafts
  const draftKeyOf = () => (st.current && st.openId !== undefined ? st.current.id + ':' + (st.openId === null ? 'new' : st.openId) : null);

  /** The extension's drafts (on load): the composer shows its own once a thread is on screen. */
  function onDrafts(m) {
    drafts.clear();
    const items = Object.entries(m.items || {}).sort((a, b) => (a[1].at || 0) - (b[1].at || 0)); // the newest last
    for (const [key, d] of items) if (d && typeof d.text === 'string') drafts.set(key, d);
    if (draftKey && !input.value.trim() && drafts.has(draftKey)) showDraft(drafts.get(draftKey));
    markDrafts();
  }

  /** What the composer holds is the draft of the place it was typed in; an empty composer is no draft. */
  function keepDraft() {
    if (!draftKey) return;
    const text = input.value;
    const had = drafts.has(draftKey);
    drafts.delete(draftKey); // set again below: the newest last
    if (text.trim()) {
      drafts.set(draftKey, { text, mentions: [...st.mentions], replyTo: st.replyTo, at: Date.now() });
      while (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value);
    } else if (!had) return;
    persistDrafts();
  }

  function showDraft(d) {
    input.value = d ? d.text : '';
    st.mentions.clear();
    if (d && d.mentions) for (const [name, pk] of d.mentions) st.mentions.set(name, pk);
    setReply(d && d.replyTo ? d.replyTo : null);
    autosize();
    updateSend();
  }

  /**
   * The composer follows the thread on screen: what was typed stays with the thread (or "New thread") it was typed
   * in, and comes back with it. Text typed before any thread was on screen goes to the first one, added to its draft.
   */
  function syncDraft() {
    const key = draftKeyOf();
    if (key === draftKey) return;
    const carried = draftKey === null && input.value.trim() ? input.value : '';
    keepDraft();
    draftKey = key;
    if (!key) showDraft(null);
    else {
      const d = drafts.get(key);
      showDraft(carried ? { ...(d || {}), text: d ? d.text.replace(/\s+$/, '') + '\n\n' + carried : carried } : d);
      if (carried) keepDraft();
    }
    markDrafts();
  }

  /** Threads in the list with a draft get a pencil, the open one excepted (its draft is in the composer). */
  function markDrafts() {
    if (!st.current) return;
    for (const row of threadList.querySelectorAll('.titem[data-id]')) {
      const head = row.querySelector('.t-head');
      if (!head) continue;
      const want = row.dataset.id !== st.openId && drafts.has(st.current.id + ':' + row.dataset.id);
      const has = row.querySelector('.t-draft');
      if (want && !has) {
        const pen = el('span', 't-draft', '✎');
        pen.title = T('draft');
        head.insertBefore(pen, head.querySelector('.t-time'));
      } else if (!want && has) has.remove();
    }
  }

  /** To the extension, a moment after the last change (typing does not post every key). */
  function persistDrafts() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDrafts, 300);
  }
  function flushDrafts() {
    clearTimeout(draftTimer);
    vscode.postMessage({ type: 'drafts', items: Object.fromEntries(drafts) });
  }
  // the view is hidden or closed: what is pending goes now
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      keepDraft();
      flushDrafts();
    }
  });
  window.addEventListener('pagehide', () => {
    keepDraft();
    flushDrafts();
  });

  let lastTyping = 0;
  input.addEventListener('input', () => {
    autosize();
    updateSend();
    keepDraft();
    updateMentionMenu();
    const now = Date.now();
    if (input.value.trim() && st.openId !== undefined && now - lastTyping > 2500) {
      lastTyping = now;
      vscode.postMessage({ type: 'typing' });
    }
  });
  input.addEventListener('click', updateMentionMenu);
  input.addEventListener('keydown', (e) => {
    if (st.menu.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveMenu(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveMenu(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(st.menu.items[st.menu.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }
    }
    if (e.key === 'Escape' && st.replyTo) {
      e.preventDefault();
      setReply(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.onclick = send;
  $('attachBtn').onclick = () => vscode.postMessage({ type: 'attachSelection' });
  $('wideBtn').onclick = () => {
    flushDrafts(); // the other place (side bar / editor tab) reads them when it opens
    vscode.postMessage({ type: 'wide' });
  };
  /** In the editor tab the button goes back to the side bar; in the side bar it opens the tab. */
  function onHost(m) {
    const b = $('wideBtn');
    const key = m.kind === 'panel' ? 'wideBack' : 'wide';
    b.textContent = m.kind === 'panel' ? '⤡' : '⤢';
    b.dataset.i18nTitle = key;
    b.title = T(key);
  }
  $('refreshBtn').onclick = () => vscode.postMessage({ type: 'refresh' });
  $('newBtn').onclick = () => {
    st.openId = null;
    syncDraft();
    markActive();
    vscode.postMessage({ type: 'newThread' });
  };
  $('backBtn').onclick = () => {
    body.classList.remove('show-thread');
  };
  $('mentionBtn').onclick = () => {
    const p = input.selectionStart;
    const pre = input.value.slice(0, p);
    const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + '@';
    input.value = pre + ins + input.value.slice(p);
    input.selectionStart = input.selectionEnd = p + ins.length;
    input.focus();
    autosize();
    updateMentionMenu();
  };

  // ------------------------------------------------------------ @ suggestions
  function updateMentionMenu() {
    const p = input.selectionStart;
    const m = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(input.value.slice(0, p));
    if (!m || !st.members.length) return closeMenu();
    const q = m[2].toLocaleLowerCase(locale());
    const rank = (x) => (st.presence[x.pubkey] === 'online' ? 0 : st.presence[x.pubkey] === 'away' ? 1 : 2);
    const items = st.members
      .filter((x) => x.name.toLocaleLowerCase(locale()).includes(q))
      .sort((a, b) => Number(b.isAgent) - Number(a.isAgent) || rank(a) - rank(b))
      .slice(0, 12);
    if (!items.length) return closeMenu();
    st.menu = { open: true, items, index: 0, start: p - m[2].length - 1 };
    mentionMenu.innerHTML = '';
    items.forEach((x, i) => {
      const o = el('div', 'opt' + (i === 0 ? ' active' : ''));
      const dot = el('span', 'pdot');
      dot.dataset.pk = x.pubkey;
      o.append(dot);
      o.append(el('span', 'opt-name', (x.isAgent ? '🐝 ' : '') + x.name));
      const s = st.presence[x.pubkey];
      const sub = [x.isAgent ? T('agentTag') : '', s === 'online' ? T('online') : s === 'away' ? T('away') : ''].filter(Boolean).join(' · ');
      if (sub) o.append(el('span', 'sub', sub));
      o.onmousedown = (e) => {
        e.preventDefault();
        pickMention(x);
      };
      mentionMenu.append(o);
    });
    mentionMenu.hidden = false;
    applyPresence(mentionMenu);
  }

  function moveMenu(d) {
    const n = st.menu.items.length;
    st.menu.index = (st.menu.index + d + n) % n;
    [...mentionMenu.children].forEach((c, i) => c.classList.toggle('active', i === st.menu.index));
    mentionMenu.children[st.menu.index].scrollIntoView({ block: 'nearest' });
  }

  function pickMention(x) {
    if (!x) return closeMenu();
    const p = input.selectionStart;
    const before = input.value.slice(0, st.menu.start);
    const after = input.value.slice(p);
    const ins = '@' + x.name + ' ';
    input.value = before + ins + after;
    input.selectionStart = input.selectionEnd = before.length + ins.length;
    st.mentions.set(x.name, x.pubkey);
    closeMenu();
    autosize();
    updateSend();
    keepDraft();
    input.focus();
  }

  function closeMenu() {
    st.menu.open = false;
    mentionMenu.hidden = true;
  }

  // ------------------------------------------------------------ clicks inside the thread
  log.addEventListener('click', (e) => {
    const copy = e.target.closest('.copy');
    if (copy) {
      const code = copy.parentElement.querySelector('code');
      vscode.postMessage({ type: 'copy', text: code ? code.innerText : '' });
      return;
    }
    const rb = e.target.closest('.reply-btn');
    if (rb) {
      setReply({ id: rb.dataset.reply, author: rb.dataset.author, snippet: rb.dataset.snippet });
      keepDraft();
      input.focus();
      return;
    }
    const pb = e.target.closest('.pbtn');
    if (pb) {
      vscode.postMessage({ type: pb.dataset.act, id: pb.dataset.id, block: Number(pb.dataset.block) });
      return;
    }
    const ref = e.target.closest('a.ref');
    if (ref) {
      e.preventDefault();
      vscode.postMessage({ type: 'openRef', path: ref.dataset.path, line: ref.dataset.line, end: ref.dataset.end });
      return;
    }
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      vscode.postMessage({ type: 'open', url: a.getAttribute('href') });
    }
  });

  // ------------------------------------------------------------ Jira card (hover an issue key)
  const jcache = new Map();
  const JIRA_FRESH_MS = 60000;
  const jcard = el('div', 'jcard');
  jcard.hidden = true;
  document.body.append(jcard);
  let jTimer, jHide, jAnchor;
  log.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.jira');
    if (!a) return;
    clearTimeout(jHide);
    if (jAnchor === a && !jcard.hidden) return;
    clearTimeout(jTimer);
    jTimer = setTimeout(() => showJira(a), 350);
  });
  log.addEventListener('mouseout', (e) => {
    if (!e.target.closest('a.jira')) return;
    clearTimeout(jTimer);
    jHide = setTimeout(hideJira, 250);
  });
  log.addEventListener('scroll', () => hideJira());
  jcard.addEventListener('mouseenter', () => clearTimeout(jHide));
  jcard.addEventListener('mouseleave', () => {
    jHide = setTimeout(hideJira, 250);
  });

  function showJira(a) {
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return; // no card for a link that is scrolled away
    jAnchor = a;
    const key = a.dataset.key;
    const c = jcache.get(key);
    renderJcard(key, c || { loading: true });
    jcard.hidden = false;
    placeJcard(a);
    // what is known shows at once; older than a minute, it is asked again and the card updates when it arrives
    if (!c || c.error || Date.now() - (c.at || 0) > JIRA_FRESH_MS) vscode.postMessage({ type: 'jiraInfo', key });
  }
  function hideJira() {
    clearTimeout(jTimer);
    jcard.hidden = true;
    jAnchor = null;
  }
  function placeJcard(a) {
    const r = a.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    jcard.style.width = w + 'px';
    jcard.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + 'px';
    jcard.style.top = r.bottom + 6 + 'px';
    const h = jcard.offsetHeight;
    if (r.bottom + 6 + h > window.innerHeight - 8) jcard.style.top = Math.max(8, r.top - h - 6) + 'px';
  }
  function onJiraInfo(m) {
    jcache.set(m.key, m.data ? { data: m.data, at: Date.now() } : { error: m.error, needsToken: m.needsToken, at: Date.now() });
    while (jcache.size > 300) jcache.delete(jcache.keys().next().value);
    if (jAnchor && jAnchor.dataset.key === m.key && !jcard.hidden) {
      renderJcard(m.key, jcache.get(m.key));
      placeJcard(jAnchor);
    }
  }
  function renderJcard(key, s) {
    jcard.innerHTML = '';
    jcard.append(el('div', 'jk', key + (s.data && s.data.type ? ' · ' + s.data.type : '')));
    if (s.loading) {
      jcard.append(el('div', 'muted', T('jiraLoading')));
      return;
    }
    if (s.error) {
      jcard.append(el('div', 'jerr', s.error));
      if (s.needsToken) {
        const b = el('button', 'jbtn', T('jiraEnterToken'));
        b.type = 'button';
        b.onclick = () => {
          jcache.delete(key);
          hideJira();
          vscode.postMessage({ type: 'setJiraToken' });
        };
        jcard.append(b);
      }
      return;
    }
    const d = s.data;
    jcard.append(el('div', 'jt', d.summary));
    const dl = el('dl');
    const row = (k, v) => {
      dl.append(el('dt', '', k));
      const dd = el('dd');
      if (typeof v === 'string') dd.textContent = v;
      else dd.append(v);
      dl.append(dd);
    };
    row(T('jiraStatus'), el('span', 'jst ' + ({ new: 'st-new', indeterminate: 'st-prog', done: 'st-done' }[d.statusCategory] || 'st-new'), d.status || '—'));
    row(T('jiraAssignee'), d.assignee || '—');
    if (d.estimateText || d.spent) row(T('jiraEffort'), T('jiraEffortText', d.estimateText || '—', d.spentText));
    jcard.append(dl);
    const open = el('a', 'jopen', T('jiraOpen'));
    open.href = d.url;
    open.onclick = (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'open', url: d.url });
    };
    jcard.append(open);
  }

  // ------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }
  let toastTimer;
  function toast(msg, ok) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = el('div', 'toast');
      document.querySelector('.composer-wrap').append(t);
    }
    t.className = 'toast' + (ok ? ' ok' : '');
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ok ? 1800 : 7000);
  }

  vscode.postMessage({ type: 'ready' });
})();
