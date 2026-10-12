(function () {
  const DEFAULT_SETTINGS = {
    theme: 'glass',
    fadeSeconds: 20,
    fontSize: 18,
    maxMessages: 8,
    direction: 'bottom-up',
    position: 'left',
    columnWidth: 380,
    showBadges: true,
    showPlatformIcons: true,
    showPronouns: true,
    showTimestamps: false,
    showRedemptions: true,
    hideBotMessages: false,
    knownBots: [],
    enabledKnownBots: {},
    customBots: [],
    platforms: {
      twitch: true,
      youtube: true,
      kick: true,
      velora: true
    },
    alwaysOnTop: true
  };

  const urlParams = new URLSearchParams(window.location.search);
  const isPopoutMode = urlParams.get('mode') === 'popout' || Boolean(window.neonDesktop);

  let currentSettings = { ...DEFAULT_SETTINGS };
  const messagesContainer = document.getElementById('overlayMessages');
  const overlayContainer = document.getElementById('overlayContainer');
  const popoutHeader = document.getElementById('popoutHeader');
  const pinButton = document.getElementById('pinButton');
  const clearBtn = document.getElementById('clearBtn');
  const closeBtn = document.getElementById('closeBtn');

  const activeMessages = [];
  // Reconnects replay the server's history. Remembering recently rendered ids
  // keeps that replay from drawing the same message a second time (and keeps
  // deleted/cleared messages from coming back).
  const seenMessageIds = new Set();
  const seenMessageOrder = [];
  const SEEN_MESSAGE_LIMIT = 200;

  function rememberMessageId(id) {
    if (!id || seenMessageIds.has(id)) return;
    seenMessageIds.add(id);
    seenMessageOrder.push(id);
    while (seenMessageOrder.length > SEEN_MESSAGE_LIMIT) {
      seenMessageIds.delete(seenMessageOrder.shift());
    }
  }
  const veloraEmotes = new Map();
  const loadedVeloraChannels = new Set();

  function normalizePlatform(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeLogin(value) {
    return String(value || '').trim().replace(/^@/, '').toLowerCase();
  }

  function messageBotIdentity(message) {
    const sender = message?.sender || message?.user || message?.authorData || {};
    const metadata = message?.metadata || message?.meta || {};
    const author = message?.author && typeof message.author === 'object' ? message.author : {};
    const platform = normalizePlatform(message?.platform || sender.platform || author.platform);
    const platformUserId = String(message?.platformUserId || message?.userId || message?.user_id || message?.authorId || sender.platformUserId || sender.userId || sender.user_id || sender.id || author.platformUserId || author.userId || author.user_id || author.id || metadata.userId || '').trim();
    const login = normalizeLogin(message?.authorLogin || message?.login || message?.username || (typeof message?.author === 'string' ? message.author : '') || sender.login || sender.username || sender.user_name || author.login || author.username || author.user_name);
    return { platform, platformUserId, login };
  }

  function hasExplicitBotMetadata(message) {
    const sender = message?.sender || message?.user || message?.authorData || {};
    const metadata = message?.metadata || message?.meta || {};
    return message?.isBot === true || message?.is_bot === true || message?.bot === true ||
      sender?.isBot === true || sender?.is_bot === true || metadata?.isBot === true ||
      String(message?.role || '').toLowerCase() === 'bot' ||
      (Array.isArray(message?.userRoles) && message.userRoles.some((role) => String(role).toLowerCase() === 'bot'));
  }

  function getBotMatch(message) {
    if (hasExplicitBotMetadata(message)) return { matched: true, matchedBy: 'explicit-metadata' };
    const identity = messageBotIdentity(message);
    if (!identity.platform || (!identity.platformUserId && !identity.login)) return { matched: false, matchedBy: 'none', identity };
    const knownBots = Array.isArray(currentSettings.knownBots) ? currentSettings.knownBots : [];
    const enabledKnownBots = currentSettings.enabledKnownBots || {};
    const customBots = Array.isArray(currentSettings.customBots) ? currentSettings.customBots : [];
    const matches = (bot, source) => {
      if (!bot || normalizePlatform(bot.platform) !== identity.platform || bot.enabled === false) return null;
      const key = bot.key || `${bot.platform}:${bot.platformUserId || bot.userId || bot.login}`;
      if (source === 'known' && enabledKnownBots[key] === false) return null;
      const botId = String(bot.platformUserId || bot.userId || '').trim();
      if (identity.platformUserId && botId) return botId === identity.platformUserId ? `${source}-id` : null;
      // A catalog entry without a resolved platform ID can only use its
      // platform-scoped login as a temporary fallback. Resolved IDs always win.
      return identity.login && normalizeLogin(bot.login) === identity.login ? `${source}-login` : null;
    };
    for (const bot of knownBots) {
      const matchedBy = matches(bot, 'known');
      if (matchedBy) return { matched: true, matchedBy, identity };
    }
    for (const bot of customBots) {
      const matchedBy = matches(bot, 'custom');
      if (matchedBy) return { matched: true, matchedBy, identity };
    }
    return { matched: false, matchedBy: 'none', identity };
  }

  function isKnownBot(message) {
    return getBotMatch(message).matched;
  }

  function logBotFilterSettings() {
    const knownBots = Array.isArray(currentSettings.knownBots) ? currentSettings.knownBots : [];
    const customBots = Array.isArray(currentSettings.customBots) ? currentSettings.customBots : [];
    const enabledKnown = knownBots.filter((bot) => {
      const key = bot.key || `${bot.platform}:${bot.platformUserId || bot.userId || bot.login}`;
      return bot.enabled !== false && currentSettings.enabledKnownBots?.[key] !== false;
    }).length;
    const enabledCustom = customBots.filter((bot) => bot.enabled !== false).length;
    console.info('[Overlay Bot Filter]', `hideBotMessages=${currentSettings.hideBotMessages === true}`, `knownBotsEnabled=${enabledKnown}`, `customBotsEnabled=${enabledCustom}`);
  }

  function removeFilteredBotCards() {
    if (!currentSettings.hideBotMessages) return;
    for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
      const item = activeMessages[index];
      if (item?.message && isKnownBot(item.message)) deleteMessage(item.id);
    }
  }

  function parse7TvEmote(emote) {
    if (!emote || !emote.id || !emote.name) return null;
    const host = emote.data?.host;
    let url = '';
    if (host?.url && Array.isArray(host.files)) {
      const file = host.files.find((f) => f.format === 'WEBP' && f.name.includes('2x'))
        || host.files.find((f) => f.format === 'WEBP')
        || host.files[0];
      if (file) {
        url = `https:${host.url}/${file.name}`;
      }
    }
    if (!url) {
      url = `https://cdn.7tv.app/emote/${emote.id}/2x.webp`;
    }
    const flags = Number(emote.flags || emote.data?.flags || 0);
    const isZeroWidth = Boolean(flags & 256);
    return {
      name: emote.name,
      code: emote.name,
      url,
      isZeroWidth,
      provider: '7TV'
    };
  }

  async function pullVelora7TvEmotes(channel = '') {
    const normChannel = String(channel || '').trim().toLowerCase();
    if (normChannel && loadedVeloraChannels.has(normChannel) && veloraEmotes.size > 0) return;
    if (normChannel) loadedVeloraChannels.add(normChannel);

    try {
      // 1. If hosted on desktop app, query the local server /api/overlay/emotes/velora
      let fetchedLocal = false;
      try {
        const localUrl = `${window.location.origin}/api/overlay/emotes/velora${normChannel ? `?channel=${encodeURIComponent(normChannel)}` : ''}`;
        const res = await fetch(localUrl, { signal: AbortSignal.timeout?.(4000) || undefined });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.emotes) && data.emotes.length) {
            for (const em of data.emotes) {
              if (em.name && em.url) {
                veloraEmotes.set(em.name.toLowerCase(), em);
              }
            }
            fetchedLocal = true;
          }
        }
      } catch {}

      // 2. Direct 7TV fallback to guarantee 7TV emote availability
      if (!fetchedLocal || veloraEmotes.size < 50) {
        const fetchSet = async (url) => {
          try {
            const r = await fetch(url, { signal: AbortSignal.timeout?.(6000) || undefined });
            if (r.ok) {
              const set = await r.json();
              for (const raw of set.emotes || []) {
                const parsed = parse7TvEmote(raw);
                if (parsed) veloraEmotes.set(parsed.name.toLowerCase(), parsed);
              }
            }
          } catch {}
        };
        await Promise.all([
          fetchSet('https://7tv.io/v3/emote-sets/01KF6FKR7APVXQ0CFJ5M1JHWB8'),
          fetchSet('https://7tv.io/v3/emote-sets/global')
        ]);
      }

      refreshVeloraOverlayCards();
    } catch {}
  }

  const VELORA_APPROVED_BARE_EMOTES = new Set([
    'lethimcook', 'booba', 'letsgo', 'popcat', 'awkward', 'crunch',
    'peeposhy', 'aintnoway', 'petthemods', 'omegalul', 'nodders',
    'kekw', 'pog', 'pogu', 'monkas', 'monkaw', 'lulw', 'catjam', 'pepejam',
    'clueless', 'gigachad', 'copium', 'sadge', 'widepeepohappy', 'widepeeposad',
    'feelsgoodman', 'feelsbadman', '5head', 'ez', 'pausechamp', 'waitwhat',
    'prayge', 'bedge', 'wicked', 'pepelaugh', 'modcheck', 'hyperclap',
    'peped', 'ddcat', 'raintime', 'yep', 'nope', 'peepohappy', 'peeposad',
    'pepega', 'poggers', 'monkahmm', 'pepehands', 'susge', 'despair',
    'corpa', 'aware', 'giga'
  ]);

  function isVeloraBareAllowed(name, emote) {
    if (!name) return false;
    if (emote?.provider === 'Velora') return true;
    if (emote?.isBareAllowed) return true;
    return VELORA_APPROVED_BARE_EMOTES.has(String(name).trim().toLowerCase());
  }

  function renderVeloraTextWith7Tv(text) {
    if (!text || typeof text !== 'string') return '';
    const words = text.split(/(\s+)/);
    let html = '';
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        html += word;
        continue;
      }
      const isColon = word.startsWith(':') && word.endsWith(':') && word.length > 2;
      const cleanToken = isColon ? word.slice(1, -1) : word.replace(/^[:.,!?]+|[:.,!?]+$/g, '');
      const emote = veloraEmotes.get(cleanToken.toLowerCase()) || veloraEmotes.get(word.toLowerCase());
      if (emote && (isColon || isVeloraBareAllowed(cleanToken, emote))) {
        const img = `<img class="chat-emote velora-emote seventv-emote" src="${escapeHtml(emote.url)}" alt="${escapeHtml(emote.name)}" title="${escapeHtml(emote.name)} · 7TV">`;
        html += emote.isZeroWidth ? `<span class="velora-emote-wrapper zero-width">${img}</span>` : img;
      } else {
        html += escapeHtml(word);
      }
    }
    return html;
  }

  function enhanceVeloraContent(contentEl, msg) {
    if (!contentEl || msg.platform !== 'velora') return;
    const childNodes = Array.from(contentEl.childNodes);
    for (const node of childNodes) {
      if (node.nodeType === 3 && node.nodeValue) { // Node.TEXT_NODE
        const text = node.nodeValue;
        const tokens = text.split(/\s+/).filter(Boolean);
        const hasMatch = tokens.some((t) => {
          const isColon = t.startsWith(':') && t.endsWith(':') && t.length > 2;
          const clean = isColon ? t.slice(1, -1) : t.replace(/^[:.,!?]+|[:.,!?]+$/g, '');
          const em = veloraEmotes.get(clean.toLowerCase()) || veloraEmotes.get(t.toLowerCase());
          return em && (isColon || isVeloraBareAllowed(clean, em));
        });
        if (hasMatch) {
          const span = document.createElement('span');
          span.innerHTML = renderVeloraTextWith7Tv(text);
          node.replaceWith(span);
        }
      }
    }
  }

  function refreshVeloraOverlayCards() {
    if (!veloraEmotes.size || !messagesContainer) return;
    const cards = messagesContainer.querySelectorAll('.overlay-card[data-platform="velora"]');
    for (const card of cards) {
      const content = card.querySelector('.card-content, .message-body');
      if (content) {
        enhanceVeloraContent(content, { platform: 'velora' });
      }
    }
  }

  function applySettings(settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...currentSettings, ...settings, ...querySettings };
    logBotFilterSettings();
    removeFilteredBotCards();

    const requestedWidth = Number(currentSettings.columnWidth);
    const columnWidth = Number.isFinite(requestedWidth) ? Math.min(600, Math.max(240, requestedWidth)) : 380;
    document.documentElement.style.setProperty('--overlay-column-width', `${columnWidth}px`);

    // Apply font size
    document.documentElement.style.setProperty('--overlay-font-size', `${currentSettings.fontSize}px`);

    // Apply theme, direction, and alignment classes
    const themeClass = `theme-${currentSettings.theme || 'glass'}`;
    const dirClass = `direction-${currentSettings.direction || 'bottom-up'}`;
    const alignClass = `align-${currentSettings.position || 'left'}`;
    overlayContainer.className = `overlay-container ${themeClass} ${dirClass} ${alignClass}`;

    // Update pop-out pin button state
    if (pinButton) {
      pinButton.classList.toggle('active', Boolean(currentSettings.alwaysOnTop));
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function platformGlyph(platform) {
    switch (platform) {
      case 'twitch': return 'T';
      case 'youtube': return '▶';
      case 'kick': return '<img src="./kick-logo.svg" alt="Kick">';
      case 'velora': return '<img src="./velora-chat.svg" alt="Velora">';
      case 'neon': return '';
      default: return '●';
    }
  }

  function formatTime(dateVal) {
    try {
      const d = dateVal ? new Date(dateVal) : new Date();
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  // Filter before attachment URLs enter the live DOM. Animated emotes are not attachments.
  function setCompactContent(content, msg) {
    const template = document.createElement('template');
    if (msg.bodyHtml) template.innerHTML = msg.bodyHtml;
    else template.content.appendChild(document.createTextNode(msg.text || ''));
    const fragment = template.content;
    fragment.querySelectorAll('.chat-media-link, .chat-media-preview, .chat-inline-image, .chat-inline-gif, .link-preview, .velora-profile-preview, [data-chat-media="attachment"], img.twitch-gif[title="Twitch GIF"], video, audio, iframe').forEach(node => node.remove());
    fragment.querySelectorAll('img').forEach(node => {
      if (!node.matches('.chat-emote, .overlay-emote, .kick-emote, .youtube-emote, .vpzone-emote, .velora-emote, .seventv-emote')) node.remove();
    });
    fragment.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode(' ')));
    // Rich blocks must not introduce another visual line in the compact feed.
    fragment.querySelectorAll('div, p, section, article, figure, figcaption').forEach(node => {
      node.replaceWith(...node.childNodes, document.createTextNode(' '));
    });
    content.replaceChildren(fragment);
    if (msg.platform === 'velora') enhanceVeloraContent(content, msg);
    return Boolean(content.textContent.trim() || content.querySelector('img'));
  }

  function updateCompactMessage(msg) {
    const item = activeMessages.find(entry => entry.id === String(msg.id));
    if (!item) return;
    const body = item.element.querySelector('.card-content, .message-body');
    if (body && !setCompactContent(body, { ...msg, platform: item.element.dataset.platform })) {
      deleteMessage(msg.id);
    }
  }

  function renderOverlayMessage(msg) {
    // SSE reconnects replay history: render each message id only once.
    if (msg && msg.id && seenMessageIds.has(String(msg.id))) return;
    // Check platform filter (bypass for test messages and neon diagnostic messages)
    const isTest = Boolean(msg.isTest || msg.platform === 'neon' || !msg.platform);
    if (!isTest && msg.platform && currentSettings.platforms && currentSettings.platforms[msg.platform] === false) {
      return;
    }
    if (!isTest && currentSettings.hideBotMessages) {
      const botMatch = getBotMatch(msg);
      console.info('[Overlay Bot Check]', `platform=${normalizePlatform(msg?.platform)}`, `displayName=${String(msg?.displayName || (typeof msg?.author === 'string' ? msg.author : '') || msg?.author?.displayName || '')}`, `login=${botMatch.identity?.login || ''}`, `userId=${botMatch.identity?.platformUserId || ''}`, `isBot=${botMatch.matched}`, `matchedBy=${botMatch.matchedBy}`);
      if (botMatch.matched) return;
    }

    // Filter notices/system messages if not desired
    if (msg.system || msg.isNoticeOrError) {
      // Don't show system errors on stream overlay unless wanted
      return;
    }

    const card = document.createElement('article');
    card.className = 'overlay-card';
    card.dataset.id = msg.id || String(Date.now());
    if (msg.providerId) card.dataset.messageId = msg.providerId;
    if (msg.author) card.dataset.author = msg.author;
    if (msg.platform) card.dataset.platform = msg.platform;
    if (msg.color) card.style.setProperty('--name-color', msg.color);

    let role = msg.role || '';
    if (!role && msg.badgesHtml) {
      if (/broadcaster|owner/i.test(msg.badgesHtml)) role = 'broadcaster';
      else if (/moderator/i.test(msg.badgesHtml)) role = 'moderator';
      else if (/vip/i.test(msg.badgesHtml)) role = 'vip';
      else if (/subscriber|founder|member/i.test(msg.badgesHtml)) role = 'subscriber';
      else if (/verified/i.test(msg.badgesHtml)) role = 'verified';
      else if (/staff|admin/i.test(msg.badgesHtml)) role = 'staff';
    }
    if (role) card.dataset.role = role.toLowerCase();

    // Header (platform, badges, author, pronouns, time)
    const header = document.createElement('div');
    header.className = 'card-header';
    const authorLine = document.createElement('span');
    authorLine.className = 'overlay-author-line';

    if (currentSettings.showPlatformIcons && msg.platform && msg.platform !== 'neon') {
      const pill = document.createElement('span');
      pill.className = `platform-pill ${msg.platform}`;
      pill.innerHTML = platformGlyph(msg.platform);
      header.appendChild(pill);
    }

    if (currentSettings.showBadges && msg.badgesHtml) {
      const badgesSpan = document.createElement('span');
      badgesSpan.className = 'user-badges';
      badgesSpan.innerHTML = msg.badgesHtml;
      authorLine.appendChild(badgesSpan);
    }

    const authorSpan = document.createElement('span');
    authorSpan.className = 'author-name';
    if (msg.color) {
      authorSpan.style.setProperty('--name-color', msg.color);
    }
    authorSpan.textContent = msg.author || 'Anonymous';
    authorSpan.title = authorSpan.textContent;
    authorLine.appendChild(authorSpan);

    if (msg.secondaryHandle && String(msg.secondaryHandle).toLowerCase() !== String(msg.author || '').toLowerCase()) {
      const handleSpan = document.createElement('span');
      handleSpan.className = 'secondary-handle';
      handleSpan.textContent = `@${String(msg.secondaryHandle).replace(/^@/, '')}`;
      authorLine.appendChild(handleSpan);
    }

    if (currentSettings.showPronouns && msg.pronouns) {
      const pronouns = document.createElement('span');
      pronouns.className = 'pronouns-pill';
      pronouns.textContent = msg.pronouns;
      authorLine.appendChild(pronouns);
    }

    header.appendChild(authorLine);

    const sourceChannel = String(msg.sourceChannelLogin || msg.sourceChannel || (
      msg.platform === 'twitch' && msg.destinationChannel ? '' : msg.channel
    ) || '').replace(/^#/, '');
    if (sourceChannel) {
      const chan = document.createElement('span');
      chan.className = 'channel-tag';
      chan.textContent = `#${sourceChannel}`;
      chan.title = chan.textContent;
      header.appendChild(chan);
    }

    if (currentSettings.showTimestamps) {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'card-time';
      timeSpan.textContent = formatTime(msg.at);
      header.appendChild(timeSpan);
    }

    card.appendChild(header);

    // Body content
    const content = document.createElement('div');
    content.className = 'card-content overlay-message-content';
    if (!setCompactContent(content, msg)) return;
    if (msg.platform === 'velora') {
      if (msg.channel) pullVelora7TvEmotes(msg.channel);
      enhanceVeloraContent(content, msg);
    }
    card.appendChild(content);

    // Add to DOM
    messagesContainer.appendChild(card);
    rememberMessageId(String(card.dataset.id));
    activeMessages.push({ id: card.dataset.id, element: card, timestamp: Date.now(), message: msg });

    // Enforce max message limit
    const max = Number(currentSettings.maxMessages) || 8;
    while (activeMessages.length > max) {
      const oldest = activeMessages.shift();
      if (oldest?.element?.parentNode) {
        oldest.element.remove();
      }
    }

    // Handle fade-out timer
    const fadeSec = Number(currentSettings.fadeSeconds);
    if (fadeSec > 0) {
      setTimeout(() => {
        card.classList.add('fading-out');
        setTimeout(() => {
          if (card.parentNode) card.remove();
          const idx = activeMessages.findIndex((m) => m.id === card.dataset.id);
          if (idx !== -1) activeMessages.splice(idx, 1);
        }, 400);
      }, fadeSec * 1000);
    }
  }

  function clearAllMessages(platform) {
    if (!platform) {
      activeMessages.length = 0;
      messagesContainer.innerHTML = '';
      return;
    }
    const target = String(platform).toLowerCase();
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const item = activeMessages[i];
      if (String(item.element.dataset.platform || '').toLowerCase() === target) {
        item.element.remove();
        activeMessages.splice(i, 1);
      }
    }
  }

  function deleteMessage(msgId, author) {
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const item = activeMessages[i];
      if (
        (msgId && (item.id === msgId || item.element.dataset.messageId === msgId)) ||
        (author && item.element.dataset.author?.toLowerCase() === author.toLowerCase())
      ) {
        item.element.remove();
        activeMessages.splice(i, 1);
      }
    }
  }

  // Setup Pop-out controls if applicable
  if (isPopoutMode && popoutHeader) {
    popoutHeader.classList.remove('hidden');

    if (pinButton) {
      pinButton.addEventListener('click', () => {
        const next = !currentSettings.alwaysOnTop;
        currentSettings.alwaysOnTop = next;
        pinButton.classList.toggle('active', next);
        if (window.neonDesktop?.setAlwaysOnTop) {
          window.neonDesktop.setAlwaysOnTop(next);
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', clearAllMessages);
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (window.neonDesktop?.closeOverlayPopout) {
          window.neonDesktop.closeOverlayPopout();
        } else {
          window.close();
        }
      });
    }
  }

  // Connect to live data stream
  function setupLiveConnection() {
    // 1. Electron IPC connection
    if (window.neonDesktop?.onOverlayEvent) {
      window.neonDesktop.getOverlaySettings?.().then((settings) => {
        if (settings) applySettings(settings);
      }).catch(() => {});

      window.neonDesktop.onOverlayEvent((event) => {
        if (!event) return;
        switch (event.type) {
          case 'message':
            renderOverlayMessage(event.data);
            break;
          case 'clear':
            clearAllMessages(event.data?.platform);
            break;
          case 'delete':
            deleteMessage(event.data?.id, event.data?.author);
            break;
          case 'settings':
            applySettings(event.data);
            break;
          case 'update-message':
            if (event.data?.id) updateCompactMessage(event.data);
            break;
        }
      });
      return;
    }

    // 2. Standalone OBS Browser Source / Web connection via SSE
    const sseUrl = `${window.location.origin}/events`;
    const RECONNECT_DELAY_MS = 3000;
    // The server sends a heartbeat every 20s; anything older than this means
    // the socket is half-open (sleep/resume, network drop) and must be rebuilt.
    const STALE_AFTER_MS = 60000;
    const WATCH_INTERVAL_MS = 15000;
    let sse = null;
    let reconnectTimer = null;
    let lastEventAt = Date.now();
    let lastErrorLogAt = 0;

    function logConnectionIssue(message) {
      const now = Date.now();
      if (now - lastErrorLogAt < 30000) return;
      lastErrorLogAt = now;
      console.warn(`[Neon Overlay] ${message}`);
    }

    function scheduleReconnect() {
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
      }, RECONNECT_DELAY_MS);
    }

    function dropConnection(reason) {
      logConnectionIssue(reason);
      if (sse) {
        try { sse.close(); } catch {}
        sse = null;
      }
      scheduleReconnect();
    }

    function connectSSE() {
      try {
        if (sse) {
          try { sse.close(); } catch {}
          sse = null;
        }
        sse = new EventSource(sseUrl);
        lastEventAt = Date.now();

        sse.onmessage = (e) => {
          lastEventAt = Date.now();
          try {
            const event = JSON.parse(e.data);
            if (!event) return;
            switch (event.type) {
              case 'message':
                renderOverlayMessage(event.data);
                break;
              case 'clear':
                clearAllMessages(event.data?.platform);
                break;
              case 'delete':
                deleteMessage(event.data?.id, event.data?.author);
                break;
              case 'settings':
                applySettings(event.data);
                break;
              case 'update-message':
                if (event.data?.id) updateCompactMessage(event.data);
                break;
              case 'init':
                if (event.data?.settings) applySettings(event.data.settings);
                if (Array.isArray(event.data?.history)) {
                  event.data.history.forEach(renderOverlayMessage);
                }
                break;
              // 'ping' heartbeats only refresh lastEventAt above.
            }
          } catch (err) {
            console.error('[Neon Overlay] Failed to parse SSE payload:', err);
          }
        };

        sse.onerror = () => {
          dropConnection(`Live connection lost; retrying in ${RECONNECT_DELAY_MS / 1000}s`);
        };
      } catch (err) {
        dropConnection(`Unable to open live connection: ${err && err.message ? err.message : err}`);
      }
    }

    connectSSE();

    setInterval(() => {
      if (sse && Date.now() - lastEventAt > STALE_AFTER_MS) {
        dropConnection('No events or heartbeats received recently; reconnecting');
      }
    }, WATCH_INTERVAL_MS);

    // Fetch initial settings & history via REST API
    fetch(`${window.location.origin}/api/overlay/settings`)
      .then((r) => r.json())
      .then((settings) => {
        if (settings) applySettings(settings);
      })
      .catch(() => {});

    connectSSE();
  }

  // Handle URL query parameters override if present
  const querySettings = {};
  if (urlParams.has('theme')) querySettings.theme = urlParams.get('theme');
  if (urlParams.has('columnWidth')) querySettings.columnWidth = Number(urlParams.get('columnWidth'));
  if (urlParams.has('fontSize')) querySettings.fontSize = Number(urlParams.get('fontSize'));
  if (urlParams.has('fadeSeconds')) querySettings.fadeSeconds = Number(urlParams.get('fadeSeconds'));
  if (urlParams.has('direction')) querySettings.direction = urlParams.get('direction');
  if (urlParams.has('position')) querySettings.position = urlParams.get('position');
  if (urlParams.has('align')) querySettings.position = urlParams.get('align');
  if (Object.keys(querySettings).length > 0) {
    applySettings(querySettings);
  }

  pullVelora7TvEmotes();
  setupLiveConnection();
})();
