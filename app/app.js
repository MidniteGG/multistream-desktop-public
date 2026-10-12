const DEFAULT_SETTINGS = {
  paneCount: 1,
  paneViews: ['all', 'twitch', 'youtube'],
  density: 'compact',
  fontSize: 13,
  accent: 'duo',
  timestamps: true,
  badges: true,
  systemMessages: true,
  animations: true,
  tabOrder: ['all', 'twitch', 'youtube', 'kick', 'velora', 'notices']
};

const MAX_CHAT_MESSAGES = 500;
const MAX_SYSTEM_MESSAGES = 25;
const TWITCH_KEEPALIVE_INTERVAL_MS = 60000;
const TWITCH_STALE_CONNECTION_MS = 150000;
const VELORA_REFERRAL_URL = 'https://velora.tv/register?ref=Kluma';
const TWITCH_AUTH_ACCOUNT_URL = 'https://teammidnite.tv/NeonLogin/account.php';
const DESKTOP_NOTICES_POLL_MS = 5 * 60 * 1000;
const IS_BROWSER_CLIENT = Boolean(window.neonMobile);

if (IS_BROWSER_CLIENT && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

async function getBrowserNeonLoginStatus() {
  try {
    const response = await fetch('/NeonLogin/api/userinfo.php', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!response.ok) return { authenticated: false };
    const profile = await response.json();
    return {
      authenticated: true,
      user: {
        id: profile.id,
        username: profile.username,
        displayName: profile.display_name || profile.name || profile.username,
        avatarUrl: profile.avatar_url || profile.picture || '',
        links: profile.links || {}
      }
    };
  } catch {
    return { authenticated: false };
  }
}

function browserNeonLogin() {
  const redirect = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  window.location.assign(`/NeonLogin/?redirect=${encodeURIComponent(redirect)}`);
}

let mobileGatewaySocket = null;
let mobileGatewayQueue = [];
const mobileGatewaySubscriptions = new Set();

function mobileGatewayUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/mobile-gateway`;
}

function routeMobileGatewayPacket(packet) {
  if (packet.type === 'status' && packet.platform && packet.channel) {
    const connected = packet.state === 'connected';
    if (packet.platform === 'twitch') {
      state.twitch.connected = connected;
      state.twitch.connecting = !connected && packet.state !== 'disconnected';
      state.twitch.channel = packet.channel;
    } else if (packet.platform === 'kick') {
      state.kick.connected = connected;
      state.kick.connecting = !connected && packet.state !== 'disconnected';
      state.kick.channel = packet.channel;
    } else if (packet.platform === 'velora') {
      state.velora.connected = connected;
      state.velora.connecting = !connected && packet.state !== 'disconnected';
      state.velora.channel = packet.channel;
    }
    updateComposerState();
    return;
  }
  if (packet.type === 'message' && packet.message) {
    addMessage(packet.message);
    return;
  }
  if (packet.type === 'youtube_batch') {
    for (const message of packet.payload?.messages || []) {
      addMessage({ ...message, platform: 'youtube', at: message.published_at || new Date() });
    }
    return;
  }
  if (packet.type === 'provider_event' && packet.platform === 'velora') {
    handleVeloraEvent({ type: 'provider_event', event: packet.event, payload: packet.payload });
  }
}

function ensureMobileGateway() {
  if (!IS_BROWSER_CLIENT) return Promise.reject(new Error('Mobile gateway is only used by the browser client.'));
  if (mobileGatewaySocket?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(mobileGatewayUrl());
    mobileGatewaySocket = socket;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Mobile chat gateway did not connect.')); socket.close(); }
    }, 10000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      for (const packet of mobileGatewayQueue.splice(0)) socket.send(JSON.stringify(packet));
      if (!settled) { settled = true; resolve(); }
    });
    socket.addEventListener('message', (event) => {
      try { routeMobileGatewayPacket(JSON.parse(event.data)); } catch { /* ignore malformed provider frames */ }
    });
    socket.addEventListener('close', () => {
      if (mobileGatewaySocket === socket) mobileGatewaySocket = null;
      mobileGatewaySubscriptions.clear();
      if (!settled) { clearTimeout(timeout); settled = true; reject(new Error('Mobile chat gateway closed before authentication.')); }
    });
    socket.addEventListener('error', () => {
      if (!settled) { clearTimeout(timeout); settled = true; reject(new Error('Mobile chat gateway connection failed.')); }
    });
  });
}

async function connectMobileGateway(platform, channel) {
  await ensureMobileGateway();
  const key = `${platform}:${channel}`;
  if (mobileGatewaySubscriptions.has(key)) return { connected: true, channel };
  const packet = { type: 'subscribe', platform, channel };
  if (mobileGatewaySocket?.readyState === WebSocket.OPEN) mobileGatewaySocket.send(JSON.stringify(packet));
  else mobileGatewayQueue.push(packet);
  mobileGatewaySubscriptions.add(key);
  return { connected: true, channel };
}

// YouTube chat integration for Neon Multistream.
const YOUTUBE_CHAT_ENABLED = true;

// Twitch JOIN notices: show a system notice when a viewer enters chat, expire
// it like other system messages, and suppress repeat notices for the same user
// within a short window so reconnect bursts do not flood the log.
const TWITCH_JOIN_NOTICE_EXPIRY_MS = 20000;
const TWITCH_JOIN_NOTICE_DEDUP_MS = 60000;
const twitchJoinNotices = new Map();
const moderatedUsers = new Map();

let renderFrame = null;
let historySaveTimer = null;
const linkPreviewCache = new Map();
const veloraProfilePreviewCache = new Map();

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem('neonMultistream.settings.v1') || '{}');
    const storedOrder = Array.isArray(stored.tabOrder) ? stored.tabOrder : [];
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      tabOrder: [...storedOrder, ...DEFAULT_SETTINGS.tabOrder.filter((view) => !storedOrder.includes(view))]
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const state = {
  activeView: 'all',
  sendTarget: 'all',
  paused: false,
  auth: { authenticated: false },
  settings: loadSettings(),
  messages: [],
  noticeHistory: [],
  twitch: {
    socket: null, channel: '', connected: false, connecting: false, live: null, liveTimer: null,
    emotes: new Map(), emoteTimer: null, nativeEmotes: new Map(), scopes: [], authenticated: false,
    canReadChat: false, canSendChat: false, canUseTwitchEmotes: false, userId: '', tokenType: 'user',
    canModerate: false, eventSubEligible: false, monitored: new Map(), reconnectTimer: null, reconnectAttempt: 0,
    watchdogTimer: null, lastFrameAt: 0, badgeCatalogs: new Map(), roomChannels: new Map(), reconnectUrl: '', redemptionRetryTimer: null,
    redemptionNoticeKey: '',
    nick: ''
  },
  youtube: {
    timer: null, connecting: false, connected: false, quotaBlocked: false, liveChatId: '', broadcastId: '',
    channel: '', pageToken: '', seen: new Set(), emotes: new Map(), emotesLoading: false, lastEmoteLoad: 0,
    canSend: false, writeAuthorizeUrl: ''
  },
  kick: { socket: null, channel: '', chatroomId: '', connected: false, connecting: false, reconnectTimer: null, reconnectAttempt: 0, pingTimer: null, announcedChannel: '' },
  velora: {
    timer: null, connecting: false, connected: false, channel: '', channelOwnerId: '', channelOwnerLogin: '',
    seen: new Set(), emotes: new Map(),
    badgeCatalog: new Map(), catalogLoaded: false,
    emoteChannels: new Set(), emoteChannelsLoading: new Set(),
    canSend: false, canModerate: false, announcedChannel: '', monitored: new Map()
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const dialog = $('#connectionsDialog');
const appearanceDialog = $('#appearanceDialog');
const userContextMenu = $('#userContextMenu');
const veloraProfileCard = $('#veloraProfileCard');
let contextMessage = null;
const veloraProfileCache = new Map();
let restoredMonitoredChannels = false;
let storageScope = null;
let desktopNoticesTimer = null;

function identityScope(auth) {
  if (!auth?.authenticated || !auth.user) return 'guest';
  const identity = String(auth.user.id || auth.user.username || '').trim().toLowerCase();
  return identity ? `user-${identity.replace(/[^a-z0-9_-]/g, '_')}` : 'guest';
}

function scopedStorageKey(name) {
  return `neonMultistream.${name}.v2.${storageScope || 'uninitialized'}`;
}

async function loadDesktopNotices() {
  if (!window.neonDesktop?.getDesktopNotices) return;
  try {
    const result = await window.neonDesktop.getDesktopNotices();
    const notices = Array.isArray(result?.notices) ? result.notices : [];
    const seenKey = scopedStorageKey('desktopNoticesSeen');
    const seen = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]'));
    let changed = false;
    for (const notice of notices) {
      const id = String(notice.id || '');
      if (!id || seen.has(id)) continue;
      const suffix = notice.action_url ? ` ${notice.action_url}` : '';
      addMessage({
        system: true,
        platform: 'neon',
        text: `[${notice.title || 'Neon notice'}] ${notice.message}${suffix}`
      });
      seen.add(id);
      changed = true;
    }
    if (changed) localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-200)));
  } catch {
    // Notices are advisory and must never interrupt chat startup.
  }
}

function scheduleDesktopNotices() {
  if (desktopNoticesTimer) clearInterval(desktopNoticesTimer);
  loadDesktopNotices();
  desktopNoticesTimer = setInterval(loadDesktopNotices, DESKTOP_NOTICES_POLL_MS);
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function readableNameColor(value, fallback = '#7ce7ff') {
  const color = String(value || '');
  const match = color.match(/^#([0-9a-f]{6})$/i);
  if (!match) return fallback;
  let red = parseInt(match[1].slice(0, 2), 16);
  let green = parseInt(match[1].slice(2, 4), 16);
  let blue = parseInt(match[1].slice(4, 6), 16);
  const linearChannel = (channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (r, g, b) =>
    0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
  const backgroundLuminance = luminance(9, 10, 15);
  const contrast = () => (luminance(red, green, blue) + 0.05) / (backgroundLuminance + 0.05);
  let passes = 0;
  while (contrast() < 5.5 && passes < 20) {
    red += (255 - red) * 0.12;
    green += (255 - green) * 0.12;
    blue += (255 - blue) * 0.12;
    passes++;
  }
  return `rgb(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)})`;
}

function timestamp(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function loadChatHistory() {
  if (!storageScope) return [];
  try {
    const history = JSON.parse(localStorage.getItem(scopedStorageKey('chatHistory')) || '[]');
    return Array.isArray(history)
      ? history.slice(-500).map((message) => {
        const restored = { ...message, at: new Date(message.at), dimmed: false };
        if (restored.platform === 'twitch' && !restored.sourceAttribution) {
          const evidence = restored.twitchSourceEvidence;
          restored.sourceAttribution = evidence?.sourceLogin ? 'explicit'
            : restored.sourceRoomId && restored.sourceChannelLogin ? 'resolved'
            : evidence && !evidence.shared && restored.sourceChannelLogin === restored.destinationChannel ? 'local' : 'unknown';
          restored.sourceChannelAuthoritative = ['explicit', 'resolved'].includes(restored.sourceAttribution);
          if (restored.sourceAttribution === 'unknown') restored.channel = restored.sourceChannel = restored.sourceChannelLogin = '';
        }
        return restored;
      })
      : [];
  } catch {
    return [];
  }
}

function saveChatHistory() {
  if (!storageScope) return;
  localStorage.setItem(
    scopedStorageKey('chatHistory'),
    JSON.stringify(state.messages.filter((message) => !message.system).slice(-500))
  );
}

function scheduleChatHistorySave() {
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    saveChatHistory();
  }, 250);
}

function trimMessages() {
  const regular = state.messages.filter((message) => !message.system).slice(-MAX_CHAT_MESSAGES);
  const system = state.messages.filter((message) => message.system).slice(-MAX_SYSTEM_MESSAGES);
  const retained = new Set([...regular, ...system]);
  state.messages = state.messages.filter((message) => retained.has(message));
}

function scheduleMessageRender() {
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    updateCounts();
    renderMessages();
  });
}

function scrollLogToLatest(log) {
  if (state.paused) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!state.paused) log.scrollTop = log.scrollHeight;
    });
  });
}

function moderationIdentityKeys(message = {}) {
  const platform = String(message.platform || '').trim().toLowerCase();
  if (!platform) return [];
  const userId = String(message.userId || message.authorId || '').trim().toLowerCase();
  const login = String(message.authorLogin || message.username || message.author || '').trim().toLowerCase();
  return [
    ...(userId ? [`${platform}:id:${userId}`] : []),
    ...(login ? [`${platform}:login:${login}`] : [])
  ];
}

function isModeratedUser(message) {
  const now = Date.now();
  for (const key of moderationIdentityKeys(message)) {
    const expiresAt = moderatedUsers.get(key);
    if (expiresAt === undefined) continue;
    if (expiresAt !== Infinity && expiresAt <= now) {
      moderatedUsers.delete(key);
      continue;
    }
    return true;
  }
  return false;
}

// Overlay delivery is fire-and-forget; a rejected IPC promise would otherwise
// disappear as an unhandled rejection and the message would silently never
// reach the OBS/pop-out overlay.
function broadcastOverlayEvent(payload) {
  const broadcast = window.neonDesktop?.broadcastOverlay;
  if (typeof broadcast !== 'function') return;
  try {
    const result = broadcast(payload);
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        console.error('[Overlay] Broadcast failed:', payload && payload.type, err && err.message ? err.message : err);
      });
    }
  } catch (err) {
    console.error('[Overlay] Broadcast threw:', payload && payload.type, err && err.message ? err.message : err);
  }
}

function moderateUser(identity, durationSeconds = 0) {
  const expiresAt = durationSeconds > 0 ? Date.now() + (durationSeconds * 1000) : Infinity;
  const keys = moderationIdentityKeys(identity);
  keys.forEach((key) => moderatedUsers.set(key, expiresAt));
  if (!keys.length) return;
  state.messages = state.messages.filter((message) => {
    if (String(message.platform || '').toLowerCase() !== String(identity.platform || '').toLowerCase()) return true;
    return !moderationIdentityKeys(message).some((key) => keys.includes(key));
  });
  broadcastOverlayEvent({
    type: 'delete',
    data: { author: identity.author || identity.authorLogin || identity.username || '' }
  });
  scheduleChatHistorySave();
  scheduleMessageRender();
}

function unmoderateUser(identity) {
  moderationIdentityKeys(identity).forEach((key) => moderatedUsers.delete(key));
}

function moderationDurationSeconds(payload = {}) {
  const duration = Number(payload.duration || payload.duration_seconds || payload.expires_in || 0);
  if (duration > 0) return duration;
  const expiresAt = Date.parse(payload.expires_at || payload.expiresAt || '');
  return Number.isFinite(expiresAt) ? Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)) : 0;
}

function clearChatHistory(view = state.settings.paneViews[0] || state.activeView || 'all', channel = '') {
  if (view === 'notices' || view === 'errors') {
    state.noticeHistory = [];
    updateCounts();
    renderMessages();
    return;
  }
  state.messages = state.messages.filter((message) => {
    if (view !== 'all' && message.platform !== view) return true;
    return channel ? message.channel !== channel : false;
  });
  // Only wipe the overlay messages that were actually removed: a platform
  // tab clear must not erase other platforms from the stream overlay.
  broadcastOverlayEvent(view !== 'all' ? { type: 'clear', data: { platform: view } } : { type: 'clear' });
  saveChatHistory();
  updateCounts();
  renderMessages();
}

function mergeTwitchBadges(existing = [], incoming = []) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  const indexes = new Map(merged.map((badge, index) => {
    const item = typeof badge === 'object' && badge ? badge : { type: badge };
    return [`${String(item.type || item.set_id || '').toLowerCase()}/${String(item.version || item.id || '')}/${item.badgeChannel || ''}`, index];
  }));
  for (const badge of Array.isArray(incoming) ? incoming : []) {
    const item = typeof badge === 'object' && badge ? badge : { type: badge };
    const key = `${String(item.type || item.set_id || '').toLowerCase()}/${String(item.version || item.id || '')}/${item.badgeChannel || ''}`;
    if (!item.type && !item.set_id) continue;
    if (!indexes.has(key)) {
      merged.push(badge);
      indexes.set(key, merged.length - 1);
    } else if (typeof merged[indexes.get(key)] === 'object' && typeof badge === 'object') {
      merged[indexes.get(key)] = { ...merged[indexes.get(key)], ...badge };
    }
  }
  return merged;
}

function normalizeTwitchEventBadges(badges = []) {
  return (Array.isArray(badges) ? badges : []).map((badge) => {
    if (typeof badge === 'string') {
      const [type, version] = badge.split('/');
      return { type, version };
    }
    if (!badge || typeof badge !== 'object') return null;
    return {
      ...badge,
      type: badge.type || badge.set_id || badge.name || '',
      version: badge.version || badge.id || ''
    };
  }).filter((badge) => badge?.type);
}

// Temporary bounded diagnostics for the first Shared Chat message per app run.
// Only channel/badge metadata and provider IDs are included, never message text,
// sender details, tokens, session objects, or credentials.
function traceTwitchSource(stage, message, renderedLabel = null) {
  if (typeof window === 'undefined' || message?.platform !== 'twitch') return;
  const evidence = message.twitchSourceEvidence;
  if (!evidence?.shared) return;
  if (message.sourceChannelAuthoritative && message.sourceChannelLogin === message.destinationChannel) return;
  const id = message.sourceMessageId || message.providerId;
  if (!id) return;
  const trace = window.neonTwitchSourceTrace ||= { id, entries: new Set() };
  if (trace.id !== id || trace.entries.size >= 10) return;
  const key = `${stage}/${message.sourceChannelLogin || ''}/${renderedLabel || ''}`;
  if (trace.entries.has(key)) return;
  trace.entries.add(key);
  console.info('[Twitch Shared Chat source]', JSON.stringify({
    stage, transport: evidence.transport, receivingChannel: message.destinationChannel || '',
    sourceBroadcasterId: message.sourceRoomId || '',
    receivingBroadcasterId: message.destinationRoomId || '',
    sourceBroadcasterLogin: evidence.sourceLogin || '', sourceBroadcasterName: evidence.sourceName || '',
    sourceMessageId: message.sourceMessageId || '', receivingMessageId: message.providerId || '',
    sourceBadges: evidence.sourceBadges || [], normalizedSource: message.sourceChannelLogin || '',
    sourceAuthoritative: Boolean(message.sourceChannelAuthoritative), renderedLabel
  }));
}

function visibleMessageBadges(message) {
  if (message.platform !== 'twitch') return message.badges;
  if (Array.isArray(message.sourceBadges)) return message.sourceBadges;
  const shared = message.sourceRoomId && message.sourceRoomId !== message.destinationRoomId;
  if (!shared) return message.badges;
  // Without origin badges, receiving-room roles/subscriptions cannot establish
  // membership in the originating room. Preserve them in stored metadata.
  const channelBadges = new Set(['subscriber', 'founder', 'bits', 'moderator', 'vip', 'broadcaster']);
  return (message.badges || []).filter((badge) => !channelBadges.has(badge.type || badge.set_id || badge));
}

function mergeTwitchSource(existing, incoming) {
  const rank = (message) => message.sourceAttribution === 'explicit' && message.sourceChannelAuthoritative === true ? 3
    : message.sourceChannelAuthoritative === true && (message.sourceAttribution === 'resolved' || message.sourceRoomId) ? 2
    : message.sourceAttribution === 'local' ? 1 : 0;
  const source = incoming.sourceChannelLogin || incoming.sourceChannel || '';
  if (!source || !rank(incoming) || rank(incoming) < rank(existing)) return;
  existing.channel = existing.sourceChannel = existing.sourceChannelLogin = source;
  existing.sourceAttribution = incoming.sourceAttribution || 'resolved';
  existing.sourceChannelAuthoritative = incoming.sourceChannelAuthoritative === true;
}

function addMessage(message) {
  if (message.platform === 'twitch' && message.sourceRoomId && !message.sourceChannelLogin && !message.sourceChannel) {
    loadTwitchChatBadges(message.sourceRoomId);
  }
  if (message.platform === 'twitch' && !message.system && message.providerId) {
    const ids = [message.providerId, message.sourceMessageId].filter(Boolean);
    const existing = state.messages.find((item) => item.platform === 'twitch' && !item.system &&
      [item.providerId, item.sourceMessageId].some((id) => id && ids.includes(id)));
    if (existing) {
      // EventSub carries the authoritative Shared Chat source. Keep it when
      // the matching IRC copy arrives with only the connected room target.
      mergeTwitchSource(existing, message);
      if (message.destinationChannel) existing.destinationChannel = message.destinationChannel;
      existing.badges = mergeTwitchBadges(existing.badges, message.badges);
      if (Array.isArray(message.sourceBadges)) existing.sourceBadges = mergeTwitchBadges(existing.sourceBadges, message.sourceBadges);
      if (Array.isArray(message.destinationBadges)) existing.destinationBadges = mergeTwitchBadges(existing.destinationBadges, message.destinationBadges);
      existing.sourceRoomId = message.sourceRoomId || existing.sourceRoomId || '';
      existing.sourceMessageId = message.sourceMessageId || existing.sourceMessageId || '';
      if (message.twitchSourceEvidence?.shared) existing.twitchSourceEvidence = message.twitchSourceEvidence;
      // Keep IRC native-emote ranges intact. EventSub is only enriching
      // provenance unless it carries a Twitch GIF fragment.
      if (message.twitchFragments?.some((fragment) => fragment.type === 'gif' && fragment.url)) {
        existing.twitchFragments = message.twitchFragments;
      }
      scheduleChatHistorySave();
      traceTwitchSource('merged', existing);
      scheduleMessageRender();
      return existing;
    }
  }
  if (message.platform === 'twitch' && message.twitchRewardId && state.messages.some((item) =>
    item.platform === 'twitch' && item.redemption?.id === message.twitchRewardId &&
    item.channel === message.channel && item.authorLogin === message.authorLogin &&
    item.text === message.text && Math.abs(new Date(item.at).getTime() - new Date(message.at || Date.now()).getTime()) < 30000
  )) return null;
  if (!message.system && isModeratedUser(message)) return null;
  const isJoinNotice = Boolean(
    message.isJoinNotice ||
    (message.system && String(message.text || '').toLowerCase().includes(' just joined #'))
  );
  const isNoticeOrError = Boolean(
    isJoinNotice || (
      message.system ||
      message.isError ||
      message.platform === 'errors' ||
      message.platform === 'notices' ||
      String(message.text || '').toLowerCase().includes('error') ||
      String(message.text || '').toLowerCase().includes('disconnected') ||
      String(message.text || '').toLowerCase().includes('failed') ||
      String(message.text || '').toLowerCase().includes('quota')
    )
  );
  const stored = { id: crypto.randomUUID(), at: new Date(), isJoinNotice, isNoticeOrError, ...message };
  state.messages.push(stored);
  if (isNoticeOrError) {
    state.noticeHistory.push(stored);
    if (state.noticeHistory.length > 500) state.noticeHistory.shift();
  }
  trimMessages();
  if (!stored.system && stored.platform !== 'errors' && stored.platform !== 'notices') {
    scheduleChatHistorySave();
    if (window.neonDesktop?.broadcastOverlay) {
      const overlayMsg = {
          id: stored.id,
          providerId: stored.providerId || stored.id,
          messageId: stored.messageId || stored.providerId || stored.id,
          at: stored.at ? new Date(stored.at).toISOString() : new Date().toISOString(),
          platform: stored.platform,
          author: stored.author || '',
          displayName: typeof stored.author === 'string' ? stored.author : (stored.author?.displayName || stored.author?.username || ''),
          authorLogin: stored.authorLogin || stored.login || stored.username || stored.user?.login || stored.user?.username || stored.sender?.login || stored.sender?.username || '',
          platformUserId: stored.platformUserId || stored.userId || stored.authorId || stored.user?.id || stored.user?.userId || stored.sender?.id || stored.sender?.userId || '',
          user: {
            id: stored.platformUserId || stored.userId || stored.authorId || stored.user?.id || stored.user?.userId || stored.sender?.id || stored.sender?.userId || '',
            login: stored.authorLogin || stored.login || stored.username || stored.user?.login || stored.user?.username || stored.sender?.login || stored.sender?.username || '',
            displayName: typeof stored.author === 'string' ? stored.author : (stored.author?.displayName || stored.author?.username || '')
          },
          isBot: stored.isBot === true || stored.sender?.isBot === true,
          role: stored.role || '',
          userRoles: Array.isArray(stored.userRoles) ? stored.userRoles : [],
          color: readableNameColor(stored.color),
          channel: stored.channel || '',
          destinationChannel: stored.destinationChannel || '',
          sourceChannelLogin: stored.sourceChannelLogin || stored.sourceChannel || (
            stored.platform === 'twitch' && stored.destinationChannel ? '' : stored.channel || ''
          ),
          pronouns: stored.pronouns || '',
          effect: stored.effect || '',
          isRedemption: Boolean(stored.redemption || stored.veloraRedemption),
          badgesHtml: renderUserBadges(
            visibleMessageBadges(stored),
            stored.sourceChannelLogin || stored.sourceChannel || stored.destinationChannel || stored.channel,
            stored.platform
          ),
          bodyHtml: renderMessageBody(stored),
          text: stored.text || ''
        };
      broadcastOverlayEvent({ type: 'message', data: overlayMsg });
    }
  }
  scheduleMessageRender();
  if (stored.system) {
    window.setTimeout(() => {
      state.messages = state.messages.filter((item) => item.id !== stored.id);
      scheduleMessageRender();
    }, Number(stored.expiresIn || 20000));
  }
  return stored;
}

function createMessageRow(message, options = {}) {
  message = { ...message, badges: visibleMessageBadges(message) };
  const isSticky = Boolean(options.isNoticeView);
  const permitsSourceLabel = message.platform !== 'twitch' || message.sourceChannelAuthoritative === true || message.sourceAttribution === 'local';
  const sourceChannel = permitsSourceLabel ? String(message.sourceChannelLogin || message.sourceChannel || (
    message.platform === 'twitch' && message.destinationChannel ? '' : message.channel
  ) || '').replace(/^#/, '') : '';
  const badgeChannel = sourceChannel || String(message.destinationChannel || '').replace(/^#/, '');
  if (message.platform === 'twitch' && message.sourceRoomId && !sourceChannel) loadTwitchChatBadges(message.sourceRoomId);
  if (message.platform === 'twitch' && badgeChannel) loadTwitchChatBadges(badgeChannel);
  if (message.platform === 'twitch') {
    for (const badge of message.badges || []) if (badge?.badgeChannel) loadTwitchChatBadges(badge.badgeChannel);
  }
  const rawUsername = String(message.authorLogin || message.username || (typeof message.author === 'string' ? message.author : message.author?.login || message.author?.username || '') || '');
  console.debug('[Author Render]', `platform=${String(message.platform || '')}`, `rawUsername=${rawUsername}`, `renderedUsername=${rawUsername}`);
  const row = document.createElement('article');
  const effectClass = message.platform === 'velora' && message.effect
    ? ` effect-${String(message.effect).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`
    : '';
  const linkClass = !message.system && messageLinks(message.text).length ? ' has-chat-link' : '';
  const stickyClass = isSticky ? ' sticky-notice' : '';
  row.className = `message-row ${message.system ? 'system' : ''} ${message.dimmed ? 'dimmed' : ''}${effectClass}${linkClass}${stickyClass}`;
  row.dataset.platform = message.platform || 'system';
  if (message.system || message.platform === 'errors' || message.platform === 'notices') {
    const platformClass = message.platform && message.platform !== 'errors' && message.platform !== 'notices' ? ` ${escapeHtml(message.platform)}` : '';
    const platformLabel = message.platform && message.platform !== 'errors' && message.platform !== 'notices' ? escapeHtml(message.platform.toUpperCase()) : 'EVENT';
    const systemText = message.platform === 'neon' ? linkifyText(message.text) : escapeHtml(message.text);
    row.innerHTML = `<time>${timestamp(message.at)}</time><span class="message-platform error-mark${platformClass}">${platformLabel}</span><p>${systemText}</p>`;
  } else {
    row.innerHTML = `
      <time>${timestamp(message.at)}</time>
      <span class="message-platform ${escapeHtml(message.platform)}" role="img" title="${escapeHtml(sourceChannel ? `Message source: ${platformDisplayName(message.platform)} · #${sourceChannel}` : `Message source: ${platformDisplayName(message.platform)}`)}" aria-label="${escapeHtml(sourceChannel ? `Message source: ${platformDisplayName(message.platform)} · #${sourceChannel}` : `Message source: ${platformDisplayName(message.platform)}`)}">${platformGlyph(message.platform)}</span>
      <span class="message-author-block">
        <span class="author-line">${renderUserBadges(message.badges, badgeChannel, message.platform)}<span class="author-identity-line"><b class="message-author" style="--name-color:${readableNameColor(message.color)}" title="${escapeHtml(sourceChannel ? `${message.author} in #${sourceChannel} · right-click for actions` : `${message.author} · right-click for actions`)}">${escapeHtml(message.author)}</b>${message.secondaryHandle && message.secondaryHandle.toLowerCase() !== message.author.toLowerCase() ? `<span class="secondary-handle" style="font-size:0.78em;">@${escapeHtml(message.secondaryHandle.replace(/^@/, ''))}</span>` : ''}${message.pronouns ? `<span class="pronoun-badge" title="${escapeHtml(message.platform === 'velora' ? 'Velora pronouns' : "Pronouns provided by Alejo Pereyra's Pronouns API")}">${escapeHtml(message.pronouns)}</span>` : ''}</span></span>
        ${sourceChannel ? `<small class="chat-channel" title="#${escapeHtml(sourceChannel)}${message.destinationChannel && message.destinationChannel !== sourceChannel ? ` · Received in #${escapeHtml(message.destinationChannel)}` : ''}"><span class="chat-channel-icon" aria-hidden="true">#</span><span class="chat-channel-name">${escapeHtml(sourceChannel)}</span></small>` : ''}
      </span>
      <div class="message-content"><div class="message-text">${renderMessageBody(message)}</div>${renderLinkPreview(message)}</div>
      ${((message.platform === 'twitch' && message.canModerate) || (message.platform === 'velora' && state.velora.canModerate)) && message.author
        ? `<button class="moderation-menu" type="button" title="Moderate ${escapeHtml(message.author)}" aria-label="Moderate ${escapeHtml(message.author)}">⋮</button>`
        : ''}`;
    if (row.querySelector('.message-content .twitch-gif, .message-content .chat-inline-image, .message-content .chat-media-preview, .message-content .velora-profile-preview')) row.classList.add('has-media');
    if (message.providerId) row.dataset.messageId = message.providerId;
    if (message.author) row.dataset.author = message.author;
    if (sourceChannel) row.dataset.channel = sourceChannel;
    if (message.platform === 'twitch') {
      row.dataset.destinationChannel = message.destinationChannel || '';
      traceTwitchSource('rendered', message, row.querySelector('.chat-channel-name')?.textContent || '');
    }
  }
  return row;
}

function messageLinks(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi)].map((match) =>
    match[0].replace(/[),.!?;:]+$/g, '')
  ).filter(Boolean);
}

function linkifyText(value) {
  const text = String(value || '');
  let html = '';
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const raw = match[0];
    const url = raw.replace(/[),.!?;:]+$/g, '');
    const trailing = raw.slice(url.length);
    html += escapeHtml(text.slice(cursor, match.index));
    html += `<a class="chat-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open in your browser">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
    cursor = Number(match.index) + raw.length;
  }
  return html + escapeHtml(text.slice(cursor));
}

function renderLinkPreview(message) {
  const url = messageLinks(message.text)[0];
  if (!url) return '';
  const veloraUsername = veloraUsernameFromUrl(url);
  if (veloraUsername) return renderVeloraProfilePreview(url, veloraUsername);
  // Keep ordinary chat URLs as one clean inline link. Rich external previews
  // can duplicate or render broken images inside a fast-moving chat feed.
  return '';
}

function isInlineImageUrl(rawUrl) {
  return isGifUrl(rawUrl);
}

function isGifUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return url.pathname.toLowerCase().endsWith('.gif')
      || /^(?:media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function renderInlineMediaText(text) {
  let html = '';
  let cursor = 0;
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const raw = match[0];
    const url = raw.replace(/[),.!?;:]+$/g, '');
    if (!isInlineImageUrl(url)) continue;
    html += linkifyText(text.slice(cursor, match.index));
    const gifClass = isGifUrl(url) ? ' chat-inline-gif' : '';
    html += `<a class="chat-media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img class="chat-inline-image${gifClass}" src="${escapeHtml(url)}" alt="Shared image" loading="lazy"></a>${escapeHtml(raw.slice(url.length))}`;
    cursor = Number(match.index) + raw.length;
  }
  return html + linkifyText(String(text || '').slice(cursor));
}

function veloraUsernameFromUrl(value) {
  try {
    const parsed = new URL(value);
    if (!/^(?:www\.)?velora\.tv$/i.test(parsed.hostname)) return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.length === 1 && /^[a-z0-9_.-]{1,64}$/i.test(parts[0]) ? parts[0] : '';
  } catch {
    return '';
  }
}

function renderVeloraProfilePreview(url, username) {
  const cacheKey = username.toLowerCase();
  const profile = veloraProfilePreviewCache.get(cacheKey);
  if (profile === undefined) {
    veloraProfilePreviewCache.set(cacheKey, null);
    window.neonDesktop?.getVeloraProfile?.(username).then((result) => {
      veloraProfilePreviewCache.set(cacheKey, result || false);
      scheduleMessageRender();
    }).catch(() => veloraProfilePreviewCache.set(cacheKey, false));
    return '';
  }
  if (!profile) return '';
  const displayName = profile.displayName || profile.display_name || profile.username || username;
  const pronouns = profile.pronounsShort || profile.pronouns || '';
  const category = profile.streamInfo?.category?.name || profile.streamInfo?.category || '';
  const tags = Array.isArray(profile.streamTags) ? profile.streamTags.filter(Boolean).slice(0, 2).join(' · ') : '';
  const meta = profile.isLive ? `● LIVE${category ? ` · ${category}` : ''}` : (tags || 'Velora');
  const avatar = veloraAvatar(profile);
  const banner = veloraProfileImage(profile);
  const bio = veloraProfileBio(profile) || 'View this creator on Velora.';
  const bannerStyle = banner ? ` style="background-image:url('${escapeHtml(String(banner).replaceAll("'", '%27'))}')"` : '';
  return `<a class="velora-profile-preview" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${bannerStyle}>
    <span class="velora-profile-preview-shade"></span>
    ${avatar ? `<img src="${escapeHtml(avatar)}" alt="" class="velora-profile-preview-avatar" loading="lazy">` : '<span class="velora-profile-preview-avatar fallback">V</span>'}
    <span class="velora-profile-preview-copy"><b>${escapeHtml(displayName)}${pronouns ? ` <small>${escapeHtml(pronouns)}</small>` : ''}</b><em>${escapeHtml(meta)}</em><span>${escapeHtml(bio)}</span></span>
    <img class="velora-profile-preview-mark" src="./velora-chat.svg" alt="Velora">
  </a>`;
}

const VELORA_BADGE_ASSET_VERSION = '20260922';
function veloraBadgeAssetUrl(filename) {
  return 'https://velora.tv/velora-badges/' + filename + '?v=' + VELORA_BADGE_ASSET_VERSION;
}

const VELORA_COMMUNITY_STAFF_IMG = veloraBadgeAssetUrl('VeloraCommunityManagement.png');
const veloraOfficialAssets = {
  broadcaster: { imageUrl: veloraBadgeAssetUrl('StreamerBroadcasterBadge.png'), title: 'Broadcaster' },
  streamer: { imageUrl: veloraBadgeAssetUrl('StreamerBroadcasterBadge.png'), title: 'Broadcaster' },
  streamerbroadcaster: { imageUrl: veloraBadgeAssetUrl('StreamerBroadcasterBadge.png'), title: 'Broadcaster' },
  streamer_broadcaster: { imageUrl: veloraBadgeAssetUrl('StreamerBroadcasterBadge.png'), title: 'Broadcaster' },
  vip: { imageUrl: veloraBadgeAssetUrl('VIPBadge.png'), title: 'VIP' },
  bot: { imageUrl: veloraBadgeAssetUrl('BotBadge.png'), title: 'Bot' },
  staff: { imageUrl: veloraBadgeAssetUrl('VeloraStaffBadge.png'), title: 'Staff' },
  admin: { imageUrl: veloraBadgeAssetUrl('VeloraStaffBadge.png'), title: 'Admin' },
  administrator: { imageUrl: veloraBadgeAssetUrl('VeloraStaffBadge.png'), title: 'Admin' },
  velorastaff: { imageUrl: veloraBadgeAssetUrl('VeloraStaffBadge.png'), title: 'Staff' },
  velora_staff: { imageUrl: veloraBadgeAssetUrl('VeloraStaffBadge.png'), title: 'Staff' },
  'staff-community': { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  staff_community: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  staffcommunity: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  community_staff: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  'community-staff': { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  community_management: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  'community-management': { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  communitystaff: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  communitymanagement: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  community_manager: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  'community-manager': { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  communitymanager: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  community: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  cm: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  veloracommunitymanagement: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  velora_community_management: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  'velora-community-management': { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  communitymanagementbadge: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  veloracommunitymanagementbadge: { imageUrl: VELORA_COMMUNITY_STAFF_IMG, title: 'Community Staff' },
  'pride-month-2026': { imageUrl: 'https://assets.velora.tv/badges/catalog/pride-month-2026/static-7750079e-edbe-427f-8e80-298945352e1e.png', title: 'Pride Month 2026' },
  pride_month_2026: { imageUrl: 'https://assets.velora.tv/badges/catalog/pride-month-2026/static-7750079e-edbe-427f-8e80-298945352e1e.png', title: 'Pride Month 2026' },
  pride: { imageUrl: 'https://assets.velora.tv/badges/catalog/pride-month-2026/static-7750079e-edbe-427f-8e80-298945352e1e.png', title: 'Pride Month 2026' },
  'new-year-2026': { imageUrl: 'https://assets.velora.tv/badges/catalog/new-year-2026/static-70556a95-8437-4334-a9d0-364f5e485518.png', title: 'New Year 2026' },
  new_year_2026: { imageUrl: 'https://assets.velora.tv/badges/catalog/new-year-2026/static-70556a95-8437-4334-a9d0-364f5e485518.png', title: 'New Year 2026' },
  new_year: { imageUrl: 'https://assets.velora.tv/badges/catalog/new-year-2026/static-70556a95-8437-4334-a9d0-364f5e485518.png', title: 'New Year 2026' },
  'christmas-2025': { imageUrl: 'https://assets.velora.tv/badges/catalog/christmas-2025/static-ef05b8ab-d5e0-495a-83e5-02e8b0837cf9.png', title: 'Christmas 2025' },
  christmas_2025: { imageUrl: 'https://assets.velora.tv/badges/catalog/christmas-2025/static-ef05b8ab-d5e0-495a-83e5-02e8b0837cf9.png', title: 'Christmas 2025' },
  christmas: { imageUrl: 'https://assets.velora.tv/badges/catalog/christmas-2025/static-ef05b8ab-d5e0-495a-83e5-02e8b0837cf9.png', title: 'Christmas 2025' },
  'halloween-2025': { imageUrl: 'https://assets.velora.tv/badges/catalog/halloween-2025/static-5f1fbf40-9a1a-44be-885a-1c1a73c997ec.png', title: 'Halloween 2025' },
  halloween_2025: { imageUrl: 'https://assets.velora.tv/badges/catalog/halloween-2025/static-5f1fbf40-9a1a-44be-885a-1c1a73c997ec.png', title: 'Halloween 2025' },
  halloween: { imageUrl: 'https://assets.velora.tv/badges/catalog/halloween-2025/static-5f1fbf40-9a1a-44be-885a-1c1a73c997ec.png', title: 'Halloween 2025' }
};

function resolveVeloraBadgeKey(badge) {
  if (!badge) return '';
  if (typeof badge === 'string') return normalizeVeloraBadgeKey(badge);
  const candidates = [
    badge.slug,
    badge.name,
    badge.title,
    badge.label,
    badge.badge,
    badge.role,
    badge.id,
    badge.key,
    badge.type
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const normalized = normalizeVeloraBadgeKey(candidate);
    if (normalized && !['site', 'channel', 'provider', 'custom', 'badge', 'static', 'role', 'follower', 'system'].includes(normalized)) {
      return normalized;
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'string') {
      return normalizeVeloraBadgeKey(candidate);
    }
  }
  return '';
}

function renderUserBadges(badges = [], channel = '', platform = '', allowVeloraRotation = true) {
  const labels = {
    broadcaster: ['★', 'Broadcaster'],
    moderator: ['◆', 'Moderator'],
    vip: ['♦', 'VIP'],
    subscriber: ['♥', 'Subscriber'],
    founder: ['♥', 'Founder'],
    member: ['♥', 'Member'],
    owner: ['★', 'Channel owner'],
    verified: ['✓', 'Verified'],
    partner: ['★', 'Partner'],
    staff: ['⚙', 'Staff'],
    admin: ['⚙', 'Admin'],
    staff_community: ['⚙', 'Community Staff'],
    community_staff: ['⚙', 'Community Staff']
  };
  let visibleBadges = (Array.isArray(badges) ? badges : []);
  if (platform !== 'twitch') visibleBadges = visibleBadges.slice(0, 8);
  if (platform === 'velora' && allowVeloraRotation) {
    visibleBadges = visibleBadges.map((badge) => {
      if (typeof badge !== 'object' || !badge) return resolveVeloraBadgeKey(badge);
      const imageUrl = badge.imageUrl || badge.image_url || badge.iconUrl || badge.icon_url || badge.url || badge.src || '';
      const key = resolveVeloraBadgeKey(badge);
      return imageUrl ? { ...badge, type: key || 'provider', imageUrl } : (key || badge);
    }).filter(Boolean);

    // Velora keeps role/identity badges visible and cycles the remaining
    // profile, event, team, and tenure badges through one slot. Prefer any
    // explicit metadata when the API supplies it, then use the known role
    // keys as the safe permanent-badge fallback.
    const permanentKeys = new Set([
      'broadcaster', 'owner', 'staff', 'admin', 'moderator', 'vip',
      'verified', 'partner', 'bot'
    ]);
    const permanentBadges = [];
    const rotatingBadges = [];
    for (const badge of visibleBadges) {
      const key = normalizeVeloraBadgeKey(
        typeof badge === 'string' ? badge : resolveVeloraBadgeKey(badge)
      );
      const explicitPermanent = typeof badge === 'object' && badge
        ? badge.isPermanent === true || badge.permanent === true || badge.rotating === false || badge.isRotating === false
        : false;
      const explicitRotating = typeof badge === 'object' && badge
        ? badge.isRotating === true || badge.rotating === true || badge.isTenure === true || badge.tenure === true
        : false;
      const isPermanent = explicitPermanent || (!explicitRotating && permanentKeys.has(key));
      (isPermanent ? permanentBadges : rotatingBadges).push(badge);
    }

    visibleBadges = permanentBadges;
    if (rotatingBadges.length > 0) {
      const rotationDuration = rotatingBadges.length * 3.5;
      const rotationItems = rotatingBadges.map((badge, index) => {
        const rendered = renderUserBadges([badge], channel, 'velora', false);
        const delay = -(index * 3.5);
        const staticClass = rotatingBadges.length === 1 ? ' static' : '';
        return `<span class="velora-badge-rotation-item${staticClass}" style="animation-duration:${rotationDuration}s;animation-delay:${delay}s" aria-hidden="true">${rendered}</span>`;
      }).join('');
      visibleBadges.push({
        __veloraRotationHtml: `<span class="velora-badge-rotation-slot" aria-label="Rotating Velora badges">${rotationItems}</span>`
      });
    }
  }
  return visibleBadges.map((badge) => {
    if (badge && typeof badge === 'object' && badge.__veloraRotationHtml) return badge.__veloraRotationHtml;
    const rawKey = String(typeof badge === 'string' ? badge : resolveVeloraBadgeKey(badge) || badge?.slug || badge?.name || badge?.type || badge?.id || badge?.badge || '').toLowerCase().replace(/[\s-]+/g, '_');
    const key = normalizeVeloraBadgeKey(rawKey);
    if (!key && !rawKey) return '';
    const version = String(typeof badge === 'object' ? badge?.version || '' : '');
    const catalog = platform === 'twitch' ? state.twitch.badgeCatalogs.get(String(badge?.badgeChannel || channel).toLowerCase()) : null;
    const directImage = typeof badge === 'object' ? (badge.imageUrl || badge.image_url || badge.iconUrl || badge.icon_url || badge.url || badge.src) : '';
    const asset = directImage
      ? { imageUrl: directImage, title: badge.title || badge.label || badge.name || badge.text || 'Velora badge' }
      : catalog?.get(`${key}/${version}`) || catalog?.get(`${key}/1`);
    if (asset?.imageUrl) {
      return `<img class="user-badge-image" src="${escapeHtml(asset.imageUrl)}" alt="${escapeHtml(asset.title)}" title="${escapeHtml(asset.title)}">`;
    }
    if (platform === 'velora') {
      const official = !directImage && (
        veloraOfficialAssets[key] ||
        veloraOfficialAssets[rawKey] ||
        veloraOfficialAssets[key.replace(/_/g, '-')] ||
        veloraOfficialAssets[rawKey.replace(/_/g, '-')] ||
        state.velora.badgeCatalog?.get(key) ||
        state.velora.badgeCatalog?.get(rawKey) ||
        state.velora.badgeCatalog?.get(key.replace(/_/g, '-')) ||
        state.velora.badgeCatalog?.get(rawKey.replace(/_/g, '-'))
      );
      if (official?.imageUrl) {
        return `<img class="user-badge-image velora-official-badge ${escapeHtml(key)}" src="${escapeHtml(official.imageUrl)}" alt="${escapeHtml(official.title)}" title="${escapeHtml(official.title)}">`;
      }
      const veloraIcons = {
        broadcaster: ['Broadcaster', '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="4" width="8" height="8" rx="1.5"></rect><path d="m11 6 3-1.5v7L11 10z"></path><circle cx="7" cy="8" r="1.5"></circle></svg>'],
        subscriber: ['Subscriber', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 1.8 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.2l-3.6 1.9.7-4.1-3-2.9 4.1-.6z"></path></svg>'],
        moderator: ['Moderator', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13 3v4.2c0 3.1-2 5.8-5 7.3-3-1.5-5-4.2-5-7.3V3z"></path><path d="m5.5 8 1.5 1.5 3.5-3.5"></path></svg>'],
        vip: ['VIP', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m2 6 3-3 3 3 3-3 3 3-2 6H4z"></path></svg>'],
        verified: ['Verified', '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none"></circle><path d="m5 8 2 2 4-4"></path></svg>'],
        partner: ['Partner', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 10 6l4.8.7-3.5 3.4.8 4.8L8 12.6l-4.1 2.3.8-4.8L1.2 6.7 6 6z"></path></svg>'],
        staff: ['Staff', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.5 11.5 11.2 8.2a4.5 4.5 0 0 0-5.4-5.4L8.7 5.7l-2.4 2.4-2.9-2.9a4.5 4.5 0 0 0 5.4 5.4l3.3 3.3a1.5 1.5 0 0 0 2.4-2.1z"></path></svg>'],
        admin: ['Admin', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13 3v4.2c0 3.1-2 5.8-5 7.3-3-1.5-5-4.2-5-7.3V3z"></path><path d="M8 5v6"></path><path d="M5 8h6"></path></svg>'],
        bot: ['Bot', '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="4" width="10" height="8" rx="2"></rect><circle cx="6" cy="8" r="1"></circle><circle cx="10" cy="8" r="1"></circle><path d="M8 2v2M5 14v1M11 14v1"></path></svg>']
      };
      const [title, icon] = veloraIcons[key] || [];
      if (icon) return `<span class="velora-provider-badge ${escapeHtml(key)}" title="${escapeHtml(title)}">${icon}</span>`;
    }
    const [glyph, title] = labels[key] || [];
    if (glyph) {
      return `<span class="user-badge ${escapeHtml(key)}" title="${escapeHtml(title || key)}">${glyph}</span>`;
    }
    return '';
  }).join('');
}

function normalizeVeloraBadgeKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    sub: 'subscriber', supporter: 'subscriber', paid_subscriber: 'subscriber',
    mod: 'moderator', channel_moderator: 'moderator',
    very_important_person: 'vip',
    administrator: 'admin', team: 'team',
    system: 'bot', automated: 'bot',
    staff_community: 'staff_community', staffcommunity: 'staff_community', 'staff-community': 'staff_community',
    community_staff: 'staff_community', communitystaff: 'staff_community', 'community-staff': 'staff_community',
    community_management: 'staff_community', communitymanagement: 'staff_community', 'community-management': 'staff_community',
    community_manager: 'staff_community', communitymanager: 'staff_community', 'community-manager': 'staff_community',
    veloracommunitymanagement: 'staff_community', velora_community_management: 'staff_community'
  };
  return aliases[key] || key;
}

function isVeloraBroadcaster(message, sender, channel = state.velora.channel) {
  const senderId = String(sender?.id || sender?.userId || sender?.user_id || sender?._id || message?.userId || message?.senderId || message?.authorId || '').trim();
  const senderLogin = String(sender?.username || sender?.user_name || message?.username || message?.authorLogin || sender?.login || '').trim().toLowerCase();
  const messageChannelId = String(message?.channelId || message?.channel_id || '').trim();
  const targetChannel = String(channel || state.velora.channel || '').trim().toLowerCase().replace(/^@/, '');
  const ownerId = String(state.velora.channelOwnerId || '').trim();
  const ownerLogin = String(state.velora.channelOwnerLogin || targetChannel).trim().toLowerCase();

  // Authoritative UUID-to-UUID check
  if (senderId && messageChannelId && senderId === messageChannelId) {
    return true;
  }
  if (senderId && ownerId && senderId === ownerId) {
    return true;
  }
  // Explicit room broadcaster/owner flag if supplied
  if (message?.isBroadcaster === true || message?.isChannelOwner === true || sender?.isBroadcaster === true || sender?.isChannelOwner === true) {
    return true;
  }
  // Username/login fallback
  if (senderLogin && (senderLogin === targetChannel || (ownerLogin && senderLogin === ownerLogin))) {
    return true;
  }
  return false;
}

function collectVeloraBadges(message, sender, channel = state.velora.channel, profile = null) {
  const isBroadcaster = isVeloraBroadcaster(message, sender, channel);
  const authorLogin = normalizeVeloraChannel(sender?.username || message?.username || message?.authorLogin || '').toLowerCase();
  const profileCache = (typeof veloraProfileCache !== 'undefined' && veloraProfileCache) ? veloraProfileCache : null;
  const effectiveProfile = profile || (authorLogin && profileCache ? profileCache.get(authorLogin) : null) || {};

  const badgeDetailsList = [
    ...(Array.isArray(message?.badgeDetails) ? message.badgeDetails : []),
    ...(Array.isArray(sender?.badgeDetails) ? sender.badgeDetails : []),
    ...(Array.isArray(effectiveProfile?.badgeDetails) ? effectiveProfile.badgeDetails : []),
    ...(Array.isArray(effectiveProfile?.badges) ? effectiveProfile.badges : [])
  ];
  const badgeDetailsMap = new Map();
  for (const b of badgeDetailsList) {
    if (!b || typeof b !== 'object') continue;
    const slug = String(b.slug || b.id || b.name || '').toLowerCase().replace(/[\s-]+/g, '_');
    const rawSlug = String(b.slug || b.id || b.name || '').toLowerCase();
    const img = b.staticAssetUrl || b.animatedAssetUrl || b.imageUrl || b.image_url || b.iconUrl || b.icon_url || '';
    const label = b.label || b.name || b.title || slug;
    if (img) {
      const badgeObj = { ...b, imageUrl: img, title: label, slug: b.slug || slug, type: slug };
      if (slug) badgeDetailsMap.set(slug, badgeObj);
      if (rawSlug) badgeDetailsMap.set(rawSlug, badgeObj);
    }
  }

  const subBadgeObj = message?.subscriptionBadge || sender?.subscriptionBadge || effectiveProfile?.subscriptionBadge || null;

  // Explicit presentation badges provided by the Velora chat server for this message
  const hasExplicitChatBadges = (Array.isArray(message?.badges) && message.badges.length > 0) ||
                                (Array.isArray(sender?.badges) && sender.badges.length > 0);
  const sourceBadges = hasExplicitChatBadges
    ? (Array.isArray(message?.badges) && message.badges.length > 0 ? message.badges : sender.badges)
    : [];

  let rawBadges = [];
  if (sourceBadges.length > 0) {
    rawBadges = [...sourceBadges];
    for (const b of badgeDetailsList) {
      if (b && typeof b === 'object' && b.slug && !['broadcaster', 'moderator', 'vip', 'subscriber', 'staff', 'admin'].includes(String(b.slug).toLowerCase())) {
        const slugNorm = String(b.slug).toLowerCase();
        if (!rawBadges.some(existing => (typeof existing === 'string' ? existing.toLowerCase() : String(existing?.slug || '').toLowerCase()) === slugNorm)) {
          rawBadges.push(b);
        }
      }
    }
    if (effectiveProfile?.teamMemberships?.[0]?.team?.iconUrl) {
      const team = effectiveProfile.teamMemberships[0].team;
      rawBadges.push({
        type: 'team',
        slug: team.slug || 'team',
        imageUrl: team.iconUrl,
        title: team.displayName || 'Team'
      });
    }
  } else {
    // Preserve native Velora badge priority/order:
    // Broadcaster -> Staff/Admin -> Moderator -> VIP -> Subscriber -> Event/Profile badges -> Team
    if (isBroadcaster) rawBadges.push('broadcaster');
    if (effectiveProfile?.staffBadgeVisible || effectiveProfile?.staffBadgeType || effectiveProfile?.role === 'admin' || effectiveProfile?.role === 'staff') {
      rawBadges.push(effectiveProfile.staffBadgeType || effectiveProfile.role || 'staff');
    }
    if (message?.isModerator || sender?.isModerator || effectiveProfile?.isModerator || (Array.isArray(message?.userRoles) && message.userRoles.includes('moderator'))) {
      rawBadges.push('moderator');
    }
    if (message?.isVip || sender?.isVip || effectiveProfile?.isVip || (Array.isArray(message?.userRoles) && message.userRoles.includes('vip'))) {
      rawBadges.push('vip');
    }
    if (message?.isSubscriber || sender?.isSubscriber || effectiveProfile?.isSubscriber || subBadgeObj || (Array.isArray(message?.userRoles) && message.userRoles.includes('subscriber'))) {
      // subscriptionTier is 'tier1'|'tier2'|null — flat on the top-level message object (Velora wire format)
      const subTier = message?.subscriptionTier ?? effectiveProfile?.subscriptionTier ?? null;
      rawBadges.push(subBadgeObj
        ? { type: 'subscriber', slug: 'subscriber', subscriptionTier: subTier, imageUrl: subBadgeObj.staticAssetUrl || subBadgeObj.animatedAssetUrl, title: subBadgeObj.label || 'Subscriber' }
        : (subTier ? { type: 'subscriber', slug: 'subscriber', subscriptionTier: subTier, title: `Subscriber (${subTier})` } : 'subscriber'));
    }
    for (const b of badgeDetailsList) {
      if (b && typeof b === 'object' && b.slug && !['broadcaster', 'moderator', 'vip', 'subscriber', 'staff', 'admin'].includes(String(b.slug).toLowerCase())) {
        rawBadges.push(b);
      }
    }
    if (effectiveProfile?.teamMemberships?.[0]?.team?.iconUrl) {
      const team = effectiveProfile.teamMemberships[0].team;
      rawBadges.push({
        type: 'team',
        slug: team.slug || 'team',
        imageUrl: team.iconUrl,
        title: team.displayName || 'Team'
      });
    }
    if (message?.isBot || sender?.isBot || message?.isSystem || sender?.isSystem) {
      rawBadges.push('bot');
    }
  }

  const badges = [];
  const seen = new Set();

  for (const item of rawBadges) {
    if (!item) continue;
    if (typeof item === 'object') {
      const normKey = resolveVeloraBadgeKey(item);
      const rawType = item.slug || item.name || item.text || item.key || item.badge || item.role || item.id || item.type || '';
      let imageUrl = item.imageUrl || item.image_url || item.iconUrl || item.icon_url || item.staticAssetUrl || item.animatedAssetUrl || item.url || item.src || '';
      if (!imageUrl && (normKey === 'subscriber' || String(rawType).toLowerCase() === 'subscriber') && subBadgeObj) {
        imageUrl = subBadgeObj.staticAssetUrl || subBadgeObj.animatedAssetUrl || '';
      }
      if (!imageUrl && badgeDetailsMap.has(normKey || String(rawType).toLowerCase())) {
        const detail = badgeDetailsMap.get(normKey || String(rawType).toLowerCase());
        imageUrl = detail.imageUrl;
      }
      const dedupeKey = imageUrl ? `img:${imageUrl}` : (normKey || String(rawType).toLowerCase());
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      badges.push(imageUrl ? { ...item, type: normKey || 'provider', imageUrl, title: item.title || item.label || item.name || rawType } : (normKey || rawType));
    } else {
      const normKey = resolveVeloraBadgeKey(item) || normalizeVeloraBadgeKey(item);
      const rawKey = String(item).toLowerCase();
      let badgeObj = null;
      if (normKey === 'subscriber' && subBadgeObj) {
        badgeObj = { type: 'subscriber', slug: 'subscriber', imageUrl: subBadgeObj.staticAssetUrl || subBadgeObj.animatedAssetUrl, title: subBadgeObj.label || 'Subscriber' };
      } else if (badgeDetailsMap.has(normKey) || badgeDetailsMap.has(rawKey)) {
        badgeObj = badgeDetailsMap.get(normKey) || badgeDetailsMap.get(rawKey);
      }
      if (badgeObj?.imageUrl) {
        const dedupeKey = `img:${badgeObj.imageUrl}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          badges.push(badgeObj);
        }
      } else {
        const dedupeKey = normKey || rawKey;
        if (!dedupeKey || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        badges.push(normKey || item);
      }
    }
  }

  // Broadcaster fallback: if sender is authoritative broadcaster but Velora badges[] omitted 'broadcaster'
  if (isBroadcaster && !seen.has('broadcaster')) {
    badges.unshift('broadcaster');
    seen.add('broadcaster');
  }

  return badges;
}

async function loadTwitchChatBadges(channel) {
  const normalized = String(channel || '').toLowerCase();
  if (!normalized || state.twitch.badgeCatalogs.has(normalized)) return;
  state.twitch.badgeLoads ||= new Map();
  if (state.twitch.badgeLoads.has(normalized)) return state.twitch.badgeLoads.get(normalized);
  const pending = (async () => {
  try {
    const payload = await window.neonDesktop.getTwitchChatAssets(normalized);
    const catalog = new Map((payload.badges || []).map((badge) => [
      `${String(badge.set_id || '').toLowerCase()}/${String(badge.id || '')}`,
      { imageUrl: badge.image_url || '', title: badge.title || badge.set_id || 'Twitch badge' }
    ]));
    state.twitch.badgeCatalogs.set(normalized, catalog);
    const login = normalizeTwitchChannel(payload.channel || (/^\d+$/.test(normalized) ? '' : normalized));
    if (login) state.twitch.badgeCatalogs.set(login, catalog);
    const roomId = String(payload.broadcaster_id || (/^\d+$/.test(normalized) ? normalized : ''));
    if (roomId && login) {
      state.twitch.roomChannels.set(roomId, login);
      for (const message of state.messages) {
        if (message.platform !== 'twitch' || message.sourceRoomId !== roomId || message.sourceChannelAuthoritative) continue;
        message.sourceChannel = message.sourceChannelLogin = message.channel = login;
        message.sourceChannelAuthoritative = true;
        message.sourceAttribution = 'resolved';
        if (Array.isArray(message.sourceBadges)) message.sourceBadges = message.sourceBadges.map((badge) => ({ ...badge, badgeChannel: login }));
        traceTwitchSource('resolved-room-id', message);
      }
      scheduleChatHistorySave();
    }
    renderMessages();
  } catch {
    // Symbolic badges remain available if Twitch's badge service is unavailable.
  }
  })();
  state.twitch.badgeLoads.set(normalized, pending);
  try { await pending; } finally { state.twitch.badgeLoads.delete(normalized); }
}

async function loadTwitchPronouns(message) {
  if (!message?.authorLogin) return;
  try {
    const result = await window.neonDesktop.getTwitchPronouns(message.authorLogin);
    if (!result?.display || !state.messages.some((item) => item.id === message.id)) return;
    message.pronouns = result.display;
    saveChatHistory();
    renderMessages();
  } catch {
    // Users without a configured pronoun remain unlabeled.
  }
}

function formatVeloraEmoteTag(emote, label) {
  const provider = emote?.provider || 'Velora';
  const providerClass = provider === '7TV' ? ' seventv-emote' : '';
  const isZw = Boolean(emote?.isZeroWidth);
  const imgTag = `<img class="chat-emote velora-emote${providerClass}${isZw ? ' zero-width-emote' : ''}" src="${escapeHtml(emote.url)}" alt="${escapeHtml(label)}" title="${escapeHtml(label)} · ${escapeHtml(provider)}">`;
  if (isZw) {
    return `<span class="velora-emote-wrapper zero-width">${imgTag}</span>`;
  }
  return imgTag;
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
  'corpa', 'aware', 'giga', 'vibe', 'sigma'
]);

function isVeloraBareAllowed(name, emote) {
  if (!name) return false;
  if (emote?.provider === 'Velora') return true;
  if (emote?.isBareAllowed) return true;
  return VELORA_APPROVED_BARE_EMOTES.has(String(name).trim().toLowerCase());
}

function renderVeloraBareEmotes(segment) {
  if (!segment) return '';
  return segment.split(/(\s+)/).map((part) => {
    if (!part || /^\s+$/.test(part)) return part;
    // Explicit :name: syntax that was not resolved must stay as literal text
    if (part.startsWith(':') && part.endsWith(':') && part.length > 2) {
      return renderInlineMediaText(part);
    }
    const clean = part.replace(/^[:.,!?]+|[:.,!?]+$/g, '');
    const emote = state.velora.emotes.get(part)
      || state.velora.emotes.get(part.toLowerCase())
      || (clean ? (state.velora.emotes.get(clean) || state.velora.emotes.get(clean.toLowerCase())) : null)
      || (state.twitch?.emotes?.get(part) || state.twitch?.emotes?.get(clean));
    if (emote && isVeloraBareAllowed(clean || part, emote)) {
      return formatVeloraEmoteTag(emote, clean || part);
    }
    return renderInlineMediaText(part);
  }).join('');
}

function renderVeloraMessageText(text) {
  const colonEmotePattern = /:([A-Za-z0-9_.-]+):/g;
  let html = '';
  let cursor = 0;
  for (const match of text.matchAll(colonEmotePattern)) {
    const rawCode = match[0];
    const innerCode = match[1];
    const emote = state.velora.emotes.get(rawCode)
      || state.velora.emotes.get(rawCode.toLowerCase())
      || state.velora.emotes.get(innerCode)
      || state.velora.emotes.get(innerCode.toLowerCase())
      || (state.twitch?.emotes?.get(rawCode) || state.twitch?.emotes?.get(innerCode));
    if (emote) {
      html += renderVeloraBareEmotes(text.slice(cursor, match.index));
      html += formatVeloraEmoteTag(emote, innerCode);
      cursor = Number(match.index) + rawCode.length;
    }
  }
  html += renderVeloraBareEmotes(text.slice(cursor));
  return html;
}

function renderMessageBody(message) {
  const text = String(message.text || '');
  if (message.platform === 'twitch' && message.redemption) {
    const reward = message.redemption;
    return `<span class="twitch-redemption"><span><b>redeemed</b> ${escapeHtml(reward.title || 'a Channel Points reward')}</span>${text ? `<span class="redemption-input">${linkifyText(text)}</span>` : ''}${Number(reward.cost || 0) ? `<span class="redemption-cost">◉ ${Number(reward.cost).toLocaleString()}</span>` : ''}</span>`;
  }
  if (message.platform === 'velora' && message.veloraRedemption) {
    const reward = message.veloraRedemption;
    return `<span class="velora-redemption"><span><b>redeemed</b> ${escapeHtml(reward.title || 'a Velora reward')}</span>${text ? `<span class="redemption-input">${linkifyText(text)}</span>` : ''}${Number(reward.cost || 0) ? `<span class="redemption-cost">◆ ${Number(reward.cost).toLocaleString()}</span>` : ''}</span>`;
  }
  if (message.platform === 'kick') {
    let html = '';
    let cursor = 0;
    const emotePattern = /\[emote:(\d+):([^\]]+)\]/g;
    for (const match of text.matchAll(emotePattern)) {
      html += renderInlineMediaText(text.slice(cursor, match.index));
      html += `<img class="chat-emote kick-emote" src="https://files.kick.com/emotes/${encodeURIComponent(match[1])}/fullsize" alt="${escapeHtml(match[2])}" title="${escapeHtml(match[2])} · Kick">`;
      cursor = Number(match.index) + match[0].length;
    }
    return html + renderInlineMediaText(text.slice(cursor));
  }
  if (message.platform === 'youtube') {
    let html = '';
    let cursor = 0;
    const emojiPattern = /:[A-Za-z0-9_-]+:/g;
    for (const match of text.matchAll(emojiPattern)) {
      const emote = state.youtube.emotes.get(match[0]);
      if (!emote) continue;
      html += renderInlineMediaText(text.slice(cursor, match.index));
      html += `<img class="chat-emote youtube-emote" src="${escapeHtml(emote.url)}" alt="${escapeHtml(match[0])}" title="${escapeHtml(match[0])} · YouTube">`;
      cursor = Number(match.index) + match[0].length;
    }
    return html + renderInlineMediaText(text.slice(cursor));
  }
  if (message.platform === 'velora') {
    return renderVeloraMessageText(text);
  }
  if (message.platform !== 'twitch') return renderInlineMediaText(text);
  const renderThirdParty = (value) => value.split(/(\s+)/).map((part) => {
    const clean = part.replace(/^:+|:+$/g, '');
    const twitchEmotes = state.twitch?.emotes instanceof Map ? state.twitch.emotes : new Map();
    const emote = twitchEmotes.get(part) || twitchEmotes.get(clean);
    return emote
      ? `<img class="chat-emote" src="${escapeHtml(emote.url)}" alt="${escapeHtml(part)}" title="${escapeHtml(part)} · ${escapeHtml(emote.provider)}">`
      : renderInlineMediaText(part);
  }).join('');
  const nativeRanges = message.nativeEmotes || [];
  const nativeGifRanges = Array.isArray(message.nativeGifs) ? message.nativeGifs : [];
  if (Array.isArray(message.twitchFragments) && message.twitchFragments.length) {
    return message.twitchFragments.map((fragment) => {
      const gifUrl = String(fragment.url || fragment.gif?.url || fragment.media?.url || '').trim();
      if (gifUrl) {
        return `<img class="chat-emote twitch-gif" data-chat-media="attachment" src="${escapeHtml(gifUrl)}" alt="${escapeHtml(fragment.text || 'Twitch GIF')}" title="Twitch GIF">`;
      }
      return renderThirdParty(String(fragment.text || ''));
    }).join('');
  }
  if (nativeRanges.length || nativeGifRanges.length) {
    let html = '';
    let cursor = 0;
    const ranges = [
      ...nativeRanges.map((emote) => ({ ...emote, kind: 'emote' })),
      ...nativeGifRanges.map((gif) => ({ ...gif, kind: 'gif' }))
    ].sort((a, b) => a.start - b.start);
    for (const media of ranges) {
      html += renderThirdParty(text.slice(cursor, media.start));
      if (media.kind === 'gif') {
        html += `<img class="chat-emote twitch-gif" data-chat-media="attachment" src="${escapeHtml(media.url)}" alt="Twitch GIF" title="Twitch GIF">`;
      } else {
        const label = text.slice(media.start, media.end + 1);
        html += `<img class="chat-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(media.id)}/default/dark/2.0" alt="${escapeHtml(label)}" title="${escapeHtml(label)}">`;
      }
      cursor = media.end + 1;
    }
    return html + renderThirdParty(text.slice(cursor));
  }
  return renderThirdParty(text);
}

function buildWorkspace() {
  const workspace = $('#chatWorkspace');
  workspace.innerHTML = '';
  workspace.style.setProperty('--pane-count', state.settings.paneCount);
  for (let index = 0; index < state.settings.paneCount; index++) {
    const pane = document.createElement('section');
    pane.className = 'chat-pane';
    pane.dataset.pane = index;
    pane.innerHTML = `
      <header class="pane-header">
        <select aria-label="Pane ${index + 1} platform">
          <option value="all">ALL</option>
          <option value="twitch">Twitch</option>
          <option value="youtube">YouTube</option>
          <option value="kick">Kick</option>
          <option value="velora">Velora</option>
          <option value="notices">Notices</option>
        </select>
      </header>
      <div class="chat-log" data-follow="true"></div>`;
    pane.querySelector('select').value = state.settings.paneViews[index] || 'all';
    pane.querySelector('select').addEventListener('change', (event) => {
      state.settings.paneViews[index] = event.currentTarget.value;
      saveSettings();
      renderMessages();
    });
    pane.querySelector('.chat-log').addEventListener('scroll', (event) => {
      const log = event.currentTarget;
      log.dataset.follow = String(log.scrollHeight - log.scrollTop - log.clientHeight <= 48);
    }, { passive: true });
    pane.querySelector('.chat-log').addEventListener('load', (event) => {
      const log = event.currentTarget;
      if (state.paused || event.target?.tagName !== 'IMG') return;
      scrollLogToLatest(log);
    }, true);
    workspace.appendChild(pane);
  }
  renderMessages();
}

function renderMessages() {
  const query = $('#searchInput').value.trim().toLowerCase();
  $$('.chat-pane').forEach((pane, index) => {
    const log = pane.querySelector('.chat-log');
    const previousScrollTop = log.scrollTop;
    const view = state.settings.paneViews[index] || state.activeView;
    const isNoticeView = view === 'notices' || view === 'errors';
    const sourceMessages = isNoticeView ? state.noticeHistory : state.messages;
    const visible = sourceMessages.filter((message) => {
      if (isNoticeView) {
        const haystack = `${message.author || ''} ${message.text || ''} ${message.platform || ''}`.toLowerCase();
        return !query || haystack.includes(query);
      }
      if (message.isJoinNotice) return false;
      if (message.system && !state.settings.systemMessages) return false;
      const matchesView = view === 'all' || message.platform === view || message.system;
      const haystack = `${message.author || ''} ${message.text || ''}`.toLowerCase();
      return matchesView && (!query || haystack.includes(query));
    });
    log.innerHTML = '';
    if (visible.length === 0) {
      const empty = document.createElement('section');
      empty.className = 'empty-state';
      if (isNoticeView) {
        empty.innerHTML = `<p>${query ? 'No matching notices.' : 'No connection errors or system notices recorded.'}</p>`;
      } else {
        const links = state.auth?.user?.links || {};
        const hasConfiguredChat = Object.values(links).some(Boolean) ||
          Boolean(state.twitch.channel || state.twitch.connected || state.twitch.connecting || state.twitch.monitored.size) ||
          Boolean(state.youtube.connected || state.youtube.connecting || state.youtube.channel) ||
          Boolean(state.kick.channel || state.kick.connected) ||
          Boolean(state.velora.channel || state.velora.connected || state.velora.connecting);
        empty.innerHTML = index === 0 && !query && !hasConfiguredChat
          ? `<div class="empty-logo">N<span>×</span>M</div><h1>Your streams. One chat.</h1><p>Connect a streaming account or add a public Twitch channel to begin.</p><button class="primary-button empty-connect-button" type="button">Set up connections</button>`
          : `<p>${query ? 'No matching messages.' : 'Connected. Waiting for chat messages.'}</p>`;
      }
      log.appendChild(empty);
    } else {
      visible.forEach((message) => log.appendChild(createMessageRow(message, { isNoticeView })));
    }
    if (!state.paused) {
      log.scrollTop = log.scrollHeight;
      log.dataset.follow = 'true';
      scrollLogToLatest(log);
    } else {
      log.scrollTop = previousScrollTop;
    }
  });
}

function platformGlyph(platform) {
  if (platform === 'twitch') {
    return '<svg class="platform-logo" viewBox="0 0 512 512" aria-hidden="true"><path fill="currentColor" d="M391.2 103.5h-38.7v109.7h38.6V103.5zm-106.2-.4h-38.6v109.8H285V103.1zM120.8 0 24.3 91.4v329.7h116v91h96.5l96.5-91h74.3L487.7 345V0H120.8zm328.6 326.9-74.3 70.3h-85.7l-48 45.3v-45.3H140.3V38.4h309.1v288.5z"/></svg>';
  }
  return ({
    youtube: '▶',
    kick: '<img class="platform-logo kick-logo" src="./kick-logo.svg" alt="" aria-hidden="true">',
    velora: '<img class="platform-logo velora-logo" src="./velora-chat.svg" alt="" aria-hidden="true">',
    notices: '⚠',
    errors: '⚠'
  })[platform] || '•';
}

function platformDisplayName(platform) {
  return ({
    twitch: 'Twitch',
    youtube: 'YouTube',
    kick: 'Kick',
    velora: 'Velora',
    vpzone: 'VPZone'
  })[platform] || String(platform || 'Unknown').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function updateCounts() {
  const counts = { twitch: 0, youtube: 0, kick: 0, velora: 0 };
  state.messages.forEach((message) => {
    if (counts[message.platform] !== undefined && !message.system) counts[message.platform]++;
  });
  Object.entries(counts).forEach(([platform, count]) => {
    const el = $(`#${platform}Count`);
    if (el) el.textContent = count;
  });
  const allEl = $('#allCount');
  if (allEl) allEl.textContent = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const noticesEl = $('#noticesCount') || $('#errorsCount');
  if (noticesEl) noticesEl.textContent = state.noticeHistory.length;
}

function randomNick() {
  return `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
}

function canUseTwitchEventSubForChannel(session, channel) {
  if (!session?.authenticated) return false;
  const userId = String(session.userId || '');
  const broadcasterId = String(session.broadcasterId || '');
  if (userId && broadcasterId) return userId === broadcasterId;
  return Boolean(session.username) && String(session.username).toLowerCase() === String(channel).toLowerCase();
}

async function connectTwitch(rawChannel) {
  const channel = (rawChannel || '').trim().toLowerCase().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, '');
  if (!/^[a-z0-9_]{2,25}$/.test(channel)) {
    return;
  }
  if (IS_BROWSER_CLIENT) {
    const detail = $('#twitchDetail');
    if (detail) detail.textContent = `Connecting to Twitch #${channel}…`;
    await connectMobileGateway('twitch', channel);
    if (detail) detail.textContent = `Reading #${channel} · mobile gateway`;
    return;
  }
  if ((state.twitch.connected || state.twitch.connecting) && state.twitch.channel === channel) return;
  if (state.twitch.reconnectTimer) clearTimeout(state.twitch.reconnectTimer);
  if (state.twitch.watchdogTimer) clearInterval(state.twitch.watchdogTimer);
  state.twitch.reconnectTimer = null;
  state.twitch.watchdogTimer = null;
  const previousChannel = state.twitch.channel;
  if (state.twitch.socket) {
    const previousSocket = state.twitch.socket;
    state.twitch.socket = null;
    try { previousSocket.close(); } catch { }
  }
  if (previousChannel && previousChannel !== channel) clearChatHistory('twitch', previousChannel);
  state.twitch.channel = channel;
  state.twitch.connecting = true;
  let session = {};
  try { session = await window.neonDesktop.getTwitchSession(channel); } catch { }
  if (!state.twitch.connecting || state.twitch.channel !== channel) return;
  const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  if (state.twitch.liveTimer) clearTimeout(state.twitch.liveTimer);
  state.twitch = {
    ...state.twitch, socket, channel, connected: false, connecting: true, live: null,
    scopes: session.scopes || [], authenticated: Boolean(session.authenticated),
    canReadChat: Boolean(session.canReadChat), canSendChat: Boolean(session.canSendChat),
    canUseTwitchEmotes: Boolean(session.canUseTwitchEmotes), userId: session.userId || '',
    tokenType: session.tokenType || 'user', reconnectUrl: session.reconnectUrl || '',
    canModerate: false,
    eventSubEligible: canUseTwitchEventSubForChannel(session, channel),
    redemptionNoticeKey: ''
  };
  dialog.close();
  setConnectionSummary('CONNECTING');
  addMessage({ system: true, platform: 'twitch', text: `Connecting to twitch.tv/${channel}…` });

  socket.addEventListener('open', () => {
    state.twitch.lastFrameAt = Date.now();
    const nick = (session.available && session.accessToken && session.username)
      ? session.username.toLowerCase()
      : randomNick();
    state.twitch.nick = nick;
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
    socket.send((session.available && session.accessToken && session.username) ? `PASS oauth:${session.accessToken}` : 'PASS SCHMOOPIIE');
    socket.send(`NICK ${nick}`);
    socket.send(`JOIN #${channel}`);
    state.twitch.watchdogTimer = setInterval(() => {
      if (state.twitch.socket !== socket) return;
      if (Date.now() - state.twitch.lastFrameAt > TWITCH_STALE_CONNECTION_MS) {
        try { socket.close(); } catch { }
        return;
      }
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(`PING :neon-multistream-${Date.now()}`); } catch { }
      }
    }, TWITCH_KEEPALIVE_INTERVAL_MS);
  });

  socket.addEventListener('message', ({ data }) => {
    if (state.twitch.socket !== socket) return;
    state.twitch.lastFrameAt = Date.now();
    for (const line of data.split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        socket.send(line.replace('PING', 'PONG'));
        continue;
      }
      if (line.includes('Login authentication failed') || line.includes('Login unsuccessful')) {
        const anonNick = randomNick();
        state.twitch.nick = anonNick;
        state.twitch.authenticated = false;
        try {
          socket.send('PASS SCHMOOPIIE');
          socket.send(`NICK ${anonNick}`);
          socket.send(`JOIN #${channel}`);
        } catch { }
        continue;
      }
      if (line.includes(` JOIN #${channel}`) || line.includes(' 001 ')) {
        if (!state.twitch.connected) {
          state.twitch.connected = true;
          state.twitch.connecting = false;
          state.twitch.reconnectAttempt = 0;
          setConnectionSummary('1 STREAM LIVE');
          $('#twitchDetail').textContent = !session.authenticated
            ? 'Reconnect Twitch'
            : !session.canSendChat
              ? 'Reconnect Twitch to enable sending'
              : !session.canUseTwitchEmotes
                ? 'Connected · emotes unavailable'
                : `Reading #${channel}`;
          addMessage({ system: true, platform: 'twitch', text: `Connected to Twitch channel #${channel}` });
          loadTwitchEmotes(channel);
          updateTwitchReconnectAction();
          updateComposerState();
          loadTwitchChatBadges(channel);
          pollTwitchLiveStatus();
          if (state.twitch.eventSubEligible) {
            window.neonDesktop.connectTwitchRedemptions().then((result) => {
              handleTwitchRedemptionsResult(result);
            }).catch(() => {});
          }
        }
      }
      announceTwitchJoin(line, channel, state.twitch.nick);
      updateTwitchPermissions(line);
      handleTwitchModerationEvent(line);
      const parsed = parseTwitchMessage(line, channel);
      if (parsed) loadTwitchPronouns(addMessage(parsed));
    }
  });

  socket.addEventListener('close', () => {
    if (state.twitch.socket !== socket) return;
    if (state.twitch.watchdogTimer) clearInterval(state.twitch.watchdogTimer);
    state.twitch.watchdogTimer = null;
    state.twitch.connected = false;
    state.twitch.connecting = false;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(state.twitch.reconnectAttempt, 5)));
    state.twitch.reconnectAttempt++;
    setConnectionSummary('RECONNECTING');
    addMessage({ system: true, platform: 'twitch', text: `Twitch disconnected. Reconnecting to #${channel}…` });
    state.twitch.reconnectTimer = setTimeout(() => {
      state.twitch.reconnectTimer = null;
      if (state.twitch.channel === channel && state.twitch.socket === socket) connectTwitch(channel);
    }, delay);
  });

  socket.addEventListener('error', () => {
    addMessage({ system: true, platform: 'twitch', text: 'Twitch connection error. Check the channel and your network.' });
  });
}

function parseNativeEmotes(tag = '') {
  if (!tag) return [];
  return tag.split('/').flatMap((entry) => {
    const [id, positions = ''] = entry.split(':');
    return positions.split(',').map((position) => {
      const [start, end] = position.split('-').map(Number);
      return { id, start, end };
    }).filter((item) => item.id && Number.isInteger(item.start) && Number.isInteger(item.end));
  });
}

function parseTwitchMessage(line, connectionChannel = '') {
  let tags = {};
  let raw = line;
  if (raw.startsWith('@')) {
    const spaceIndex = raw.indexOf(' ');
    if (spaceIndex !== -1) {
      const tagStr = raw.slice(1, spaceIndex);
      raw = raw.slice(spaceIndex + 1);
      tags = Object.fromEntries(tagStr.split(';').map((tag) => {
        const [key, ...rest] = tag.split('=');
        return [key, rest.join('=')];
      }));
    }
  }
  const observedRoom = raw.match(/\s(?:PRIVMSG|ROOMSTATE|USERSTATE|USERNOTICE|CLEARCHAT|CLEARMSG)\s+#([^ ]+)/);
  const observedChannel = normalizeTwitchChannel(observedRoom?.[1] || connectionChannel);
  const observedRoomId = tags['room-id'] || tags.room_id || '';
  if (observedRoomId && typeof state.twitch.roomChannels?.set === 'function' && observedChannel) {
    state.twitch.roomChannels.set(String(observedRoomId), observedChannel);
  }
  const match = raw.match(/^:([^!]+)![^ ]+ PRIVMSG #([^ ]+) :(.*)$/);
  if (!match) return null;
  const authorLogin = match[1].toLowerCase();
  // IRC Shared Chat identifies the origin with source-room-id. Resolve its
  // login independently of the destination connection; EventSub may enrich it.
  const sourceLogin = tags['source-broadcaster-user-login'] || tags.source_broadcaster_user_login ||
    tags['source-broadcaster-user-name'] || tags.source_broadcaster_user_name || '';
  const roomId = tags['room-id'] || tags.room_id || '';
  const sourceRoomId = tags['source-room-id'] || tags.source_room_id || '';
  const sourceMessageId = tags['source-id'] || tags.source_id || '';
  const destinationChannel = normalizeTwitchChannel(match[2] || connectionChannel);
  if (roomId && typeof state.twitch.roomChannels?.set === 'function' && destinationChannel) {
    state.twitch.roomChannels.set(String(roomId), destinationChannel);
  }
  const mappedSourceChannel = sourceRoomId && typeof state.twitch.roomChannels?.get === 'function'
    ? state.twitch.roomChannels.get(String(sourceRoomId)) || ''
    : '';
  const hasRelayMetadata = ['source-broadcaster-user-login', 'source_broadcaster_user_login',
    'source-broadcaster-user-name', 'source_broadcaster_user_name',
    'source-broadcaster-user-id', 'source_broadcaster_user_id', 'source-msg-id', 'source_msg_id',
    'source-id', 'source_id', 'source-room-id', 'source_room_id', 'source-badges', 'source_badges',
    'source-badge-info', 'source_badge_info',
    'source-only', 'source_only'].some((key) => Object.prototype.hasOwnProperty.call(tags, key));
  const nativeSharedMessage = sourceRoomId && roomId && sourceRoomId === roomId;
  const onlySharedFlag = !sourceRoomId && !sourceMessageId && !sourceLogin &&
    !tags['source-broadcaster-user-id'] && !tags.source_broadcaster_user_id &&
    (tags['source-only'] === '1' || tags.source_only === '1');
  const sourceAttribution = sourceLogin ? 'explicit' : mappedSourceChannel ? 'resolved'
    : (!hasRelayMetadata || nativeSharedMessage || onlySharedFlag) ? 'local' : 'unknown';
  const sourceChannel = normalizeTwitchChannel(sourceLogin || mappedSourceChannel ||
    ((!hasRelayMetadata || nativeSharedMessage || onlySharedFlag) ? destinationChannel : ''));
  const text = match[3];
  const nativeGifs = String(tags.gifs || '').split(',').map((entry) => {
    const [range = '', id = '', url = ''] = entry.split('|');
    const [start, end] = range.split('-').map(Number);
    return { id, start, end, url };
  }).filter((gif) => gif.url && Number.isInteger(gif.start) && Number.isInteger(gif.end));
  const destinationBadges = normalizeTwitchEventBadges(String(tags.badges || '').split(',').filter(Boolean))
    .map((badge) => ({ ...badge, badgeChannel: destinationChannel }));
  const sourceBadgeTag = tags['source-badges'] ?? tags.source_badges;
  const sourceBadges = sourceBadgeTag === undefined ? undefined
    : normalizeTwitchEventBadges(String(sourceBadgeTag).split(',').filter(Boolean))
      .map((badge) => ({ ...badge, badgeChannel: sourceChannel || sourceRoomId }));
  const parsedMessage = {
    platform: 'twitch',
    channel: sourceChannel,
    sourceChannel,
    sourceChannelLogin: sourceChannel,
    destinationChannel,
    destinationRoomId: String(roomId || ''),
    sourceAttribution,
    sourceChannelAuthoritative: Boolean(sourceLogin || mappedSourceChannel),
    sourceRoomId: String(sourceRoomId || ''),
    sourceMessageId: String(sourceMessageId || ''),
    sourceBadges,
    destinationBadges,
    twitchSourceEvidence: {
      transport: 'irc', shared: Boolean(sourceRoomId || sourceMessageId || sourceLogin),
      sourceLogin, sourceName: tags['source-broadcaster-user-name'] || '',
      sourceBadges: String(tags['source-badges'] || '').split(',').filter(Boolean)
    },
    messageId: tags.id || '',
    ...(Number(tags['tmi-sent-ts']) > 0 ? { at: new Date(Number(tags['tmi-sent-ts'])) } : {}),
    author: tags['display-name'] || match[1],
    authorLogin,
    userId: tags['user-id'] || '',
    color: tags.color || '#a970ff',
    text,
    providerId: tags.id || '',
    nativeEmotes: parseNativeEmotes(tags.emotes),
    nativeGifs,
    badges: mergeTwitchBadges(String(tags.badges || '').split(',').map((badge) => {
      const [type, version] = badge.split('/');
      return { type, version, badgeChannel: destinationChannel };
    }).filter((badge) => badge.type), String(tags['source-badges'] || tags.source_badges || '').split(',').map((badge) => {
      const [type, version] = badge.split('/');
      return { type, version, badgeChannel: sourceChannel || sourceRoomId };
    }).filter((badge) => badge.type)),
    canModerate: state.twitch.canModerate,
    twitchRewardId: tags['custom-reward-id'] || '',
    dimmed: false
  };
  traceTwitchSource('normalized', parsedMessage);
  return parsedMessage;
}

function announceTwitchJoin(line, channel, nick) {
  const join = line.match(/^(?:@[^ ]+ )?:([^!]+)![^ ]+ JOIN #([^ ]+)/);
  if (!join) return;
  const username = join[1].toLowerCase();
  const joinedChannel = join[2].toLowerCase();
  if (!username || !joinedChannel || joinedChannel !== String(channel || '').toLowerCase()) return;
  // Our own JOIN acknowledgement is not a viewer entering the chat.
  if (username === String(nick || '').toLowerCase()) return;
  const now = Date.now();
  const key = `${joinedChannel}/${username}`;
  const last = twitchJoinNotices.get(key) || 0;
  if (now - last < TWITCH_JOIN_NOTICE_DEDUP_MS) return;
  const channelKey = `channel:${joinedChannel}`;
  if (now - (twitchJoinNotices.get(channelKey) || 0) < 10000) return;
  if (twitchJoinNotices.size > 5000) {
    for (const [storedKey, at] of twitchJoinNotices) {
      if (now - at > TWITCH_JOIN_NOTICE_DEDUP_MS * 10) twitchJoinNotices.delete(storedKey);
    }
  }
  twitchJoinNotices.set(key, now);
  twitchJoinNotices.set(channelKey, now);
  // Twitch JOIN lines carry only the lowercase login, so the first letter is
  // capitalized for display rather than looking up each user's display name.
  const displayName = `${username.charAt(0).toUpperCase()}${username.slice(1)}`;
  addMessage({
    system: true,
    platform: 'twitch',
    expiresIn: TWITCH_JOIN_NOTICE_EXPIRY_MS,
    isJoinNotice: true,
    text: `${displayName} just joined #${joinedChannel}`
  });
}

function updateTwitchReconnectAction() {
  const button = document.querySelector('article[data-provider="twitch"] button');
  if (!button) return;
  button.textContent = state.twitch.reconnectUrl ? 'Reconnect Twitch' : 'Add channel';
  button.title = state.twitch.reconnectUrl
    ? 'Open the NeonLogin Auth Page to unauthorize and re-authorize Twitch'
    : 'Add an extra public Twitch channel to read alongside your main stream.';
  scheduleTwitchRedemptionRetry();
}

function scheduleTwitchRedemptionRetry() {
  if (state.twitch.redemptionRetryTimer) {
    clearTimeout(state.twitch.redemptionRetryTimer);
    state.twitch.redemptionRetryTimer = null;
  }
  if (!state.twitch.reconnectUrl) return;
  // After the user re-authorizes Twitch in the browser, pick the new token up
  // automatically instead of waiting for the next Twitch rejoin.
  state.twitch.redemptionRetryTimer = setTimeout(() => {
    state.twitch.redemptionRetryTimer = null;
    if (!state.twitch.reconnectUrl || !state.twitch.connected || !state.twitch.eventSubEligible) return;
    window.neonDesktop.connectTwitchRedemptions().then((result) => {
      handleTwitchRedemptionsResult(result);
    }).catch(() => {});
  }, 60000);
}

function handleTwitchRedemptionsResult(result) {
  if (result?.connecting) return;
  if (result?.connected) {
    // EventSub readiness only proves the redemption/chat subscription. Do not
    // erase a reconnect requirement caused by a missing send or emote scope.
    const authNeedsReconnect = !state.twitch.authenticated || !state.twitch.canSendChat || !state.twitch.canUseTwitchEmotes;
    if (state.twitch.reconnectUrl && !authNeedsReconnect) {
      state.twitch.reconnectUrl = '';
      if (state.twitch.redemptionRetryTimer) {
        clearTimeout(state.twitch.redemptionRetryTimer);
        state.twitch.redemptionRetryTimer = null;
      }
      updateTwitchReconnectAction();
      const detail = $('#twitchDetail');
      if (detail) detail.textContent = state.twitch.channel
        ? `Reading #${state.twitch.channel}`
        : 'Twitch point redeems connected';
    }
    return;
  }
  state.twitch.reconnectUrl = result?.reconnectUrl || '';
  updateTwitchReconnectAction();
  const detail = $('#twitchDetail');
  if (detail && String(result?.message || '').toLowerCase().includes('reconnect')) {
    detail.textContent = 'Reconnect Twitch in NeonLogin to enable point redeems';
  }
}

function handleTwitchRedemption(payload) {
  if (!state.twitch.eventSubEligible) return;
  if (payload?.type === 'connected') {
    state.twitch.redemptionNoticeKey = '';
    handleTwitchRedemptionsResult({ connected: true });
    if (payload.chatConnected === false) {
      state.twitch.reconnectUrl = TWITCH_AUTH_ACCOUNT_URL;
      updateTwitchReconnectAction();
      const detail = $('#twitchDetail');
      if (detail) detail.textContent = 'Open the Auth Page to unauthorize and re-authorize Twitch for GIF messages';
    }
    return;
  }
  if (payload?.type === 'disconnected') {
    if (state.twitch.redemptionNoticeKey !== 'disconnected') {
      state.twitch.redemptionNoticeKey = 'disconnected';
      addMessage({ system: true, platform: 'twitch', text: payload.message });
    }
    return;
  }
  if (payload?.type === 'error') {
    const errorText = payload.message === 'not_authenticated'
      ? 'Twitch point redemption session expired. Re-authenticating…'
      : (payload.message || 'Twitch point redeems could not connect.');
    const noticeKey = `error:${errorText}`;
    if (state.twitch.redemptionNoticeKey !== noticeKey) {
      state.twitch.redemptionNoticeKey = noticeKey;
      addMessage({ system: true, platform: 'twitch', text: errorText });
    }
    if (payload.reconnectUrl) {
      state.twitch.reconnectUrl = payload.reconnectUrl;
      updateTwitchReconnectAction();
      const detail = $('#twitchDetail');
      if (detail) detail.textContent = 'Reconnect Twitch in NeonLogin to enable point redeems';
    }
    return;
  }
  if (payload?.type === 'chat_message' && payload.event) {
    handleTwitchChatMessage(payload.event);
    return;
  }
  if (payload?.type !== 'redemption' || !payload.event) return;
  if (state.twitch.reconnectUrl) {
    state.twitch.reconnectUrl = '';
    if (state.twitch.redemptionRetryTimer) {
      clearTimeout(state.twitch.redemptionRetryTimer);
      state.twitch.redemptionRetryTimer = null;
    }
    updateTwitchReconnectAction();
    const detail = $('#twitchDetail');
    if (detail) detail.textContent = state.twitch.channel
      ? `Reading #${state.twitch.channel}`
      : 'Twitch point redeems connected';
  }
  const event = payload.event;
  const sourceChannel = normalizeTwitchChannel(event.source_broadcaster_user_login || event.broadcaster_user_login || '');
  if (!sourceChannel) return;
  const input = String(event.user_input || '');
  const authorLogin = String(event.user_login || '').toLowerCase();
  const redeemedAt = new Date(event.redeemed_at || Date.now());
  // Twitch also emits a PRIVMSG when a reward requires typed input. Remove that
  // ordinary copy so the richer redemption notice appears exactly once.
  state.messages = state.messages.filter((message) => !(
    message.platform === 'twitch' && message.twitchRewardId === event.reward?.id &&
    message.channel === sourceChannel &&
    String(message.authorLogin || '').toLowerCase() === authorLogin &&
    String(message.text || '') === input && Math.abs(new Date(message.at).getTime() - redeemedAt.getTime()) < 30000
  ));
  const message = addMessage({
    providerId: String(event.id || ''), messageId: String(event.id || ''), platform: 'twitch', channel: sourceChannel,
    sourceChannel, sourceChannelLogin: sourceChannel,
    destinationChannel: normalizeTwitchChannel(event.broadcaster_user_login || ''),
    author: event.user_name || event.user_login || 'Twitch Viewer', authorLogin,
    color: '#a970ff', text: input, at: redeemedAt,
    redemption: { id: event.reward?.id || '', title: event.reward?.title || 'Channel Points reward', cost: event.reward?.cost || 0 },
    badges: [], canModerate: state.twitch.canModerate, dimmed: false
  });
  loadTwitchPronouns(message);
}

function handleTwitchChatMessage(event) {
  const fragments = Array.isArray(event.message?.fragments) ? event.message.fragments : [];
  const explicitSourceChannel = normalizeTwitchChannel(
    event.source_broadcaster_user_login || event.source_broadcaster_user_name ||
    event.sourceBroadcasterUserLogin || event.sourceBroadcasterUserName || ''
  );
  const hasSharedSourceMetadata = Boolean(
    explicitSourceChannel || event.source_broadcaster_user_id || event.source_broadcaster_user_name ||
    event.sourceBroadcasterUserId || event.sourceBroadcasterUserName || event.source_message_id
  );
  // EventSub's broadcaster is the origin for a native message, but is the
  // destination for a Shared Chat relay. Never use it as a source when Twitch
  // has indicated that the event is shared but omitted the source login.
  const sourceChannel = explicitSourceChannel || (
    hasSharedSourceMetadata ? '' : normalizeTwitchChannel(event.broadcaster_user_login || '')
  );
  const sourceAttribution = explicitSourceChannel ? 'explicit' : hasSharedSourceMetadata ? 'unknown' : 'local';
  const destinationChannel = normalizeTwitchChannel(
    event.destination_broadcaster_user_login || event.broadcaster_user_login || ''
  );
  const authorLogin = String(event.chatter_user_login || '').toLowerCase();
  const twitchFragments = fragments.map((fragment) => {
    const gifUrl = String(fragment?.gif?.url || fragment?.url || fragment?.media?.url || '').trim();
    return {
    type: gifUrl ? 'gif' : (fragment?.type || 'text'),
    text: String(fragment?.text || ''),
    url: gifUrl
    };
  });
  const text = twitchFragments.map((fragment) => fragment.text).join('') || String(event.message?.text || '');
  const at = new Date(event.sent_at || Date.now());
  const eventMessageId = String(event.message_id || '');
  const sourceMessageId = String(event.source_message_id || '');
  const twitchSourceEvidence = {
    transport: 'eventsub', shared: hasSharedSourceMetadata,
    sourceLogin: String(event.source_broadcaster_user_login || ''),
    sourceName: String(event.source_broadcaster_user_name || ''),
    sourceBadges: normalizeTwitchEventBadges(event.source_badges).map((badge) => `${badge.type}/${badge.version}`)
  };
  traceTwitchSource('received-eventsub', {
    platform: 'twitch', providerId: eventMessageId, sourceMessageId,
    destinationRoomId: String(event.broadcaster_user_id || ''),
    sourceRoomId: String(event.source_broadcaster_user_id || ''), destinationChannel,
    sourceChannelLogin: sourceChannel, sourceAttribution,
    sourceChannelAuthoritative: Boolean(explicitSourceChannel), twitchSourceEvidence
  });
  const eventBadges = mergeTwitchBadges(
    normalizeTwitchEventBadges(event.badges).map((badge) => ({ ...badge, badgeChannel: destinationChannel })),
    normalizeTwitchEventBadges(event.source_badges).map((badge) => ({ ...badge, badgeChannel: sourceChannel || String(event.source_broadcaster_user_id || '') }))
  );
  const existing = state.messages.find((message) => (
    message.platform === 'twitch' && (
      [message.providerId, message.sourceMessageId].some((id) => id && (id === eventMessageId || id === sourceMessageId))
    )
  ));
  if (existing) {
    if (twitchFragments.some((fragment) => fragment.type === 'gif' && fragment.url)) {
      existing.twitchFragments = twitchFragments;
    }
    existing.badges = mergeTwitchBadges(existing.badges, eventBadges);
    if (Array.isArray(event.source_badges)) existing.sourceBadges = mergeTwitchBadges(existing.sourceBadges,
      normalizeTwitchEventBadges(event.source_badges).map((badge) => ({ ...badge, badgeChannel: sourceChannel || String(event.source_broadcaster_user_id || '') })));
    existing.destinationBadges = mergeTwitchBadges(existing.destinationBadges,
      normalizeTwitchEventBadges(event.badges).map((badge) => ({ ...badge, badgeChannel: destinationChannel })));
    existing.sourceMessageId = sourceMessageId || existing.sourceMessageId || '';
    existing.sourceRoomId = String(event.source_broadcaster_user_id || existing.sourceRoomId || '');
    existing.destinationRoomId = String(event.broadcaster_user_id || existing.destinationRoomId || '');
    if (hasSharedSourceMetadata) existing.twitchSourceEvidence = twitchSourceEvidence;
    mergeTwitchSource(existing, { sourceChannelLogin: sourceChannel, sourceAttribution,
      sourceRoomId: String(event.source_broadcaster_user_id || ''), sourceChannelAuthoritative: Boolean(explicitSourceChannel) });
    existing.destinationChannel = destinationChannel || existing.destinationChannel || '';
    if (!existing.sourceChannelAuthoritative && existing.sourceRoomId) loadTwitchChatBadges(existing.sourceRoomId);
    scheduleChatHistorySave();
    traceTwitchSource('merged-eventsub', existing);
    scheduleMessageRender();
    return;
  }
  const chatMessage = {
    providerId: String(event.message_id || ''),
    messageId: String(event.message_id || ''),
    sourceMessageId,
    sourceRoomId: String(event.source_broadcaster_user_id || ''),
    twitchSourceEvidence,
    destinationRoomId: String(event.broadcaster_user_id || ''),
    platform: 'twitch',
    channel: sourceChannel,
    sourceChannel: sourceChannel,
    sourceChannelLogin: sourceChannel,
    destinationChannel,
    sourceAttribution,
    sourceChannelAuthoritative: Boolean(explicitSourceChannel),
    author: event.chatter_user_name || event.chatter_user_login || 'Twitch Viewer',
    authorLogin,
    userId: event.chatter_user_id || '',
    color: event.color || '#a970ff',
    text,
    twitchFragments,
    at,
    badges: eventBadges,
    sourceBadges: Array.isArray(event.source_badges) ? normalizeTwitchEventBadges(event.source_badges)
      .map((badge) => ({ ...badge, badgeChannel: sourceChannel || String(event.source_broadcaster_user_id || '') })) : undefined,
    destinationBadges: normalizeTwitchEventBadges(event.badges)
      .map((badge) => ({ ...badge, badgeChannel: destinationChannel })),
    canModerate: state.twitch.canModerate,
    dimmed: false
  };
  if (twitchFragments.some((fragment) => fragment.type === 'gif' && fragment.url)) {
    chatMessage.twitchFragments = twitchFragments;
  }
  addMessage(chatMessage);
}

function normalizeTwitchChannel(rawChannel) {
  return String(rawChannel || '').trim().toLowerCase().replace(/^#/, '')
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/[/?#].*$/, '');
}

function savedMonitoredChannels() {
  try {
    const channels = JSON.parse(localStorage.getItem(scopedStorageKey('monitoredTwitch')) || '[]');
    return Array.isArray(channels) ? channels.filter((channel) => /^[a-z0-9_]{2,25}$/.test(channel)) : [];
  } catch {
    return [];
  }
}

function saveMonitoredChannels() {
  localStorage.setItem(scopedStorageKey('monitoredTwitch'), JSON.stringify([...state.twitch.monitored.keys()]));
}

function renderMonitoredChannels() {
  const container = $('#monitoredChannels');
  if (!container) return;
  container.innerHTML = '';
  for (const [channel, connection] of state.twitch.monitored) {
    const chip = document.createElement('span');
    chip.className = `monitored-channel ${connection.connected ? 'connected' : ''}`;
    chip.innerHTML = `<i></i><span>Twitch #${escapeHtml(channel)}</span><button type="button" data-remove-platform="twitch" data-remove-channel="${escapeHtml(channel)}" title="Stop monitoring #${escapeHtml(channel)}">×</button>`;
    container.appendChild(chip);
  }
  for (const [channel, connection] of state.velora.monitored) {
    const chip = document.createElement('span');
    chip.className = `monitored-channel ${connection.connected ? 'connected' : ''}`;
    chip.innerHTML = `<i></i><span>Velora #${escapeHtml(channel)}</span><button type="button" data-remove-platform="velora" data-remove-channel="${escapeHtml(channel)}" title="Stop monitoring #${escapeHtml(channel)}">×</button>`;
    container.appendChild(chip);
  }
}

async function monitorTwitchChannel(rawChannel, persist = true) {
  const channel = normalizeTwitchChannel(rawChannel);
  if (!/^[a-z0-9_]{2,25}$/.test(channel) || channel === state.twitch.channel || state.twitch.monitored.has(channel)) return;
  const connection = {
    socket: null, connected: false, reconnectTimer: null, watchdogTimer: null,
    reconnectAttempt: 0, lastFrameAt: 0
  };
  state.twitch.monitored.set(channel, connection);
  if (persist) saveMonitoredChannels();
  renderMonitoredChannels();
  let session = {};
  try { session = await window.neonDesktop.getTwitchSession(); } catch { }
  if (!state.twitch.monitored.has(channel)) return;
  const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  connection.socket = socket;
  socket.addEventListener('open', () => {
    connection.lastFrameAt = Date.now();
    const nick = (session.available && session.accessToken && session.username)
      ? session.username.toLowerCase()
      : randomNick();
    connection.nick = nick;
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
    socket.send((session.available && session.accessToken && session.username) ? `PASS oauth:${session.accessToken}` : 'PASS SCHMOOPIIE');
    socket.send(`NICK ${nick}`);
    socket.send(`JOIN #${channel}`);
    connection.watchdogTimer = setInterval(() => {
      if (state.twitch.monitored.get(channel) !== connection) return;
      if (Date.now() - connection.lastFrameAt > TWITCH_STALE_CONNECTION_MS) {
        try { socket.close(); } catch { }
        return;
      }
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(`PING :neon-multistream-${Date.now()}`); } catch { }
      }
    }, TWITCH_KEEPALIVE_INTERVAL_MS);
  });
  socket.addEventListener('message', ({ data }) => {
    if (state.twitch.monitored.get(channel)?.socket !== socket) return;
    connection.lastFrameAt = Date.now();
    for (const line of data.split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        socket.send(line.replace('PING', 'PONG'));
        continue;
      }
      if (line.includes('Login authentication failed') || line.includes('Login unsuccessful')) {
        const anonNick = randomNick();
        connection.nick = anonNick;
        try {
          socket.send('PASS SCHMOOPIIE');
          socket.send(`NICK ${anonNick}`);
          socket.send(`JOIN #${channel}`);
        } catch { }
        continue;
      }
      if (line.includes(` JOIN #${channel}`) || line.includes(' 001 ')) {
        if (!connection.connected) {
          connection.connected = true;
          connection.reconnectAttempt = 0;
          renderMonitoredChannels();
          addMessage({ system: true, platform: 'twitch', text: `Now monitoring Twitch chat #${channel}` });
          loadTwitchChatBadges(channel);
        }
      }
      announceTwitchJoin(line, channel, connection.nick);
      const parsed = parseTwitchMessage(line, channel);
      if (parsed) loadTwitchPronouns(addMessage({ ...parsed, canModerate: false, dimmed: false }));
    }
  });
  socket.addEventListener('close', () => {
    if (state.twitch.monitored.get(channel) !== connection) return;
    if (connection.watchdogTimer) clearInterval(connection.watchdogTimer);
    connection.watchdogTimer = null;
    connection.connected = false;
    renderMonitoredChannels();
    const delay = Math.min(30000, 1000 * (2 ** Math.min(connection.reconnectAttempt, 5)));
    connection.reconnectAttempt++;
    connection.reconnectTimer = setTimeout(() => {
      if (state.twitch.monitored.get(channel) !== connection) return;
      state.twitch.monitored.delete(channel);
      monitorTwitchChannel(channel, false);
    }, delay);
  });
}

function stopMonitoringTwitch(channel) {
  const connection = state.twitch.monitored.get(channel);
  if (!connection) return;
  if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
  if (connection.watchdogTimer) clearInterval(connection.watchdogTimer);
  state.twitch.monitored.delete(channel);
  try { connection.socket?.close(); } catch { }
  saveMonitoredChannels();
  clearChatHistory('twitch', channel);
  renderMonitoredChannels();
  addMessage({ system: true, platform: 'twitch', text: `Stopped monitoring Twitch chat #${channel}` });
}

function restoreMonitoredTwitchChannels() {
  if (restoredMonitoredChannels) return;
  restoredMonitoredChannels = true;
  savedMonitoredChannels()
    .filter((channel) => channel !== state.twitch.channel)
    .forEach((channel) => monitorTwitchChannel(channel, false));
}

function putThirdPartyEmote(name, url, provider) {
  if (name && url && !state.twitch.emotes.has(name)) state.twitch.emotes.set(name, { url, provider });
}

async function loadTwitchEmotes(channel) {
  if (state.twitch.emoteTimer) clearTimeout(state.twitch.emoteTimer);
  state.twitch.emotes = new Map();
  try {
    const catalog = await window.neonDesktop.getTwitchEmotes(channel);
    if (state.twitch.channel !== channel) return;
    for (const emote of catalog.emotes || []) putThirdPartyEmote(emote.name, emote.url, emote.provider);
    if (state.twitch.emotes.size) {
      addMessage({
        system: true,
        platform: 'twitch',
        text: `Loaded ${state.twitch.emotes.size} FFZ, BetterTTV, and 7TV emotes for #${channel}.`
      });
    } else {
      state.twitch.emoteTimer = setTimeout(() => loadTwitchEmotes(channel), 15000);
    }
    renderMessages();
  } catch {
    state.twitch.emoteTimer = setTimeout(() => loadTwitchEmotes(channel), 15000);
  }
}

function updateTwitchPermissions(line) {
  const match = line.match(/^@([^ ]+) :tmi\.twitch\.tv USERSTATE /);
  if (!match) return;
  const tags = Object.fromEntries(match[1].split(';').map((tag) => tag.split('=')));
  const badges = String(tags.badges || '');
  state.twitch.canModerate = state.twitch.authenticated &&
    (tags.mod === '1' || badges.includes('broadcaster/'));
}

function handleTwitchModerationEvent(line) {
  const clear = line.match(/^@([^ ]+) :tmi\.twitch\.tv (CLEARMSG|CLEARCHAT) #[^ ]+(?: :(.+))?$/);
  if (!clear) return;
  const tags = Object.fromEntries(clear[1].split(';').map((tag) => tag.split('=')));
  if (clear[2] === 'CLEARMSG') {
    const targetId = tags['target-msg-id'] || '';
    state.messages = state.messages.filter((item) => item.providerId !== targetId);
    if (targetId) broadcastOverlayEvent({ type: 'delete', data: { id: targetId } });
  } else if (clear[3]) {
    moderateUser({
      platform: 'twitch',
      userId: tags['target-user-id'] || '',
      authorLogin: clear[3]
    }, Number(tags['ban-duration'] || 0));
  } else {
    state.messages = state.messages.filter((item) => item.platform !== 'twitch');
    broadcastOverlayEvent({ type: 'clear', data: { platform: 'twitch' } });
  }
  scheduleChatHistorySave();
  scheduleMessageRender();
}

async function pollTwitchLiveStatus() {
  if (!state.twitch.channel) return;
  try {
    const status = await window.neonDesktop.getTwitchLiveStatus(state.twitch.channel);
    const changed = state.twitch.live !== status.live;
    state.twitch.live = status.live;
    document.body.classList.toggle('twitch-offline', !status.live);
    if (changed) {
      setConnectionSummary(status.live ? '1 STREAM LIVE' : 'STREAM OFFLINE');
      if (!status.live) {
        addMessage({ system: true, platform: 'twitch', text: `#${state.twitch.channel} is offline. Previous chat remains available.` });
      } else {
        addMessage({ system: true, platform: 'twitch', text: `#${state.twitch.channel} is live.` });
      }
    }
  } catch { }
  state.twitch.liveTimer = setTimeout(pollTwitchLiveStatus, 10000);
}

function sendTwitchCommand(command) {
  const socket = state.twitch.socket;
  if (!state.twitch.canModerate || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(`PRIVMSG #${state.twitch.channel} :${command}`);
}

function sendTwitchMessage(message) {
  if (!getComposerCapabilities('twitch').text || !state.twitch.channel) {
    throw new Error('Twitch chat sending is unavailable; reconnect the authenticated Twitch account.');
  }
  // The NeonLogin broker owns the Twitch User Access Token. The renderer and
  // packaged client never receive or log that token.
  return window.neonDesktop.sendTwitchMessage({ channel: state.twitch.channel, message });
}

function setConnectionSummary(text) {
  $('#connectionSummary').textContent = text;
  $('.live-status').classList.toggle('online', text.includes('LIVE'));
}

function saveSettings() {
  localStorage.setItem('neonMultistream.settings.v1', JSON.stringify(state.settings));
}

function applySettings(rebuild = false) {
  const settings = state.settings;
  document.documentElement.style.setProperty('--chat-font-size', `${settings.fontSize}px`);
  document.body.dataset.density = settings.density;
  document.body.dataset.accent = settings.accent;
  document.body.classList.toggle('hide-timestamps', !settings.timestamps);
  document.body.classList.toggle('hide-badges', !settings.badges);
  document.body.classList.toggle('effects-off', !settings.animations);
  $('#paneCountSetting').value = String(settings.paneCount);
  $('#densitySetting').value = settings.density;
  $('#fontSizeSetting').value = String(settings.fontSize);
  $('#fontSizeOutput').textContent = `${settings.fontSize}px`;
  $('#accentSetting').value = settings.accent;
  $('#timestampsSetting').checked = settings.timestamps;
  $('#badgesSetting').checked = settings.badges;
  $('#systemSetting').checked = settings.systemMessages;
  $('#animationsSetting').checked = settings.animations;
  if (rebuild) buildWorkspace();
  else renderMessages();
}

function reorderTabs() {
  const tabs = $('#tabs');
  state.settings.tabOrder.forEach((view) => {
    const tab = tabs.querySelector(`.tab[data-view="${view}"]`);
    if (tab) tabs.insertBefore(tab, $('#addChannelButton'));
  });
}

function initials(name) {
  return String(name || 'NL').split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}

function isDefaultOrPlaceholderAvatar(url) {
  if (!url || typeof url !== 'string') return true;
  const trimmed = url.trim().toLowerCase();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return true;
  if (trimmed.includes('user-default-pictures') || trimmed.includes('user-default-pictures-uv')) return true;
  if (trimmed.includes('dicebear.com')) return true;
  if (trimmed.includes('avatar-1786484782831')) return true;
  if (trimmed.includes('placehold.co')) return true;
  return false;
}

function resolveAvatarUrl(candidate = '') {
  const user = state.auth?.user || {};
  const currentKnown = user.avatarUrl || user.avatar || user.profile_image_url || '';
  if (candidate && !isDefaultOrPlaceholderAvatar(candidate)) {
    const raw = String(candidate).trim();
    return raw.startsWith('/') ? `https://teammidnite.tv${raw}` : raw;
  }
  if (currentKnown && !isDefaultOrPlaceholderAvatar(currentKnown)) {
    const raw = String(currentKnown).trim();
    return raw.startsWith('/') ? `https://teammidnite.tv${raw}` : raw;
  }
  try {
    const cached = localStorage.getItem(scopedStorageKey('lastKnownAvatar')) || '';
    if (cached && !isDefaultOrPlaceholderAvatar(cached)) {
      return cached.startsWith('/') ? `https://teammidnite.tv${cached}` : cached;
    }
  } catch {}
  return '';
}

function showIdentityAvatar(profileImageUrl = '') {
  const avatar = $('#identityAvatar');
  const signedIn = Boolean(state.auth?.authenticated && state.auth?.user);
  const user = state.auth?.user || {};
  const url = resolveAvatarUrl(profileImageUrl);

  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    try {
      localStorage.setItem(scopedStorageKey('lastKnownAvatar'), url);
      if (user && !user.avatarUrl) user.avatarUrl = url;
    } catch {}

    avatar.innerHTML = '';
    const image = document.createElement('img');
    image.className = 'identity-profile-image';
    image.alt = user.displayName || user.username || 'Profile picture';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      image.remove();
      if (user.links?.twitch) {
        avatar.innerHTML = '<svg class="identity-twitch-logo" viewBox="0 0 512 512" role="img" aria-label="Twitch"><path fill="currentColor" d="M391.2 103.5h-38.7v109.7h38.6V103.5zm-106.2-.4h-38.6v109.8H285V103.1zM120.8 0 24.3 91.4v329.7h116v91h96.5l96.5-91h74.3L487.7 345V0H120.8zm328.6 326.9-74.3 70.3h-85.7l-48 45.3v-45.3H140.3V38.4h309.1v288.5z"/></svg>';
      } else {
        avatar.textContent = initials(user.displayName || user.username);
      }
    }, { once: true });
    image.src = url;
    avatar.appendChild(image);
    return;
  }

  if (signedIn) {
    if (user.links?.twitch) {
      avatar.innerHTML = '<svg class="identity-twitch-logo" viewBox="0 0 512 512" role="img" aria-label="Twitch"><path fill="currentColor" d="M391.2 103.5h-38.7v109.7h38.6V103.5zm-106.2-.4h-38.6v109.8H285V103.1zM120.8 0 24.3 91.4v329.7h116v91h96.5l96.5-91h74.3L487.7 345V0H120.8zm328.6 326.9-74.3 70.3h-85.7l-48 45.3v-45.3H140.3V38.4h309.1v288.5z"/></svg>';
    } else {
      avatar.textContent = initials(user.displayName || user.username);
    }
  } else {
    avatar.textContent = 'NL';
  }
}

async function refreshTwitchIdentityAvatar(username) {
  // Do not clobber a known valid NeonLogin identity avatar
  const currentAvatar = state.auth?.user?.avatarUrl;
  if (currentAvatar && !isDefaultOrPlaceholderAvatar(currentAvatar)) {
    return;
  }
  const expectedScope = storageScope;
  try {
    const profile = await window.neonDesktop.getTwitchLiveStatus(username);
    if (storageScope === expectedScope && profile?.profileImageUrl && !isDefaultOrPlaceholderAvatar(profile.profileImageUrl)) {
      showIdentityAvatar(profile.profileImageUrl);
    }
  } catch {
    // Falls back to existing avatar image, Twitch glyph, or user initials.
  }
}

function resetConnectionsForIdentityChange() {
  if (state.twitch.socket) try { state.twitch.socket.close(); } catch { }
  if (state.twitch.liveTimer) clearTimeout(state.twitch.liveTimer);
  if (state.twitch.emoteTimer) clearTimeout(state.twitch.emoteTimer);
  for (const connection of state.twitch.monitored.values()) {
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    if (connection.watchdogTimer) clearInterval(connection.watchdogTimer);
    try { connection.socket?.close(); } catch { }
  }
  state.twitch.socket = null;
  state.twitch.channel = '';
  state.twitch.nick = '';
  state.twitch.connected = false;
  state.twitch.connecting = false;
  state.twitch.authenticated = false;
  state.twitch.canReadChat = false;
  state.twitch.canSendChat = false;
  state.twitch.canUseTwitchEmotes = false;
  state.twitch.userId = '';
  state.twitch.scopes = [];
  state.twitch.monitored.clear();
  state.twitch.liveTimer = null;
  state.twitch.emoteTimer = null;
  state.twitch.reconnectTimer = null;
  state.twitch.watchdogTimer = null;
  state.twitch.reconnectUrl = '';
  state.twitch.redemptionNoticeKey = '';
  if (state.twitch.redemptionRetryTimer) clearTimeout(state.twitch.redemptionRetryTimer);
  state.twitch.redemptionRetryTimer = null;
  twitchJoinNotices.clear();
  if (state.kick.socket) try { state.kick.socket.close(); } catch { }
  if (state.kick.reconnectTimer) clearTimeout(state.kick.reconnectTimer);
  if (state.kick.pingTimer) clearInterval(state.kick.pingTimer);
  state.kick = { socket: null, channel: '', chatroomId: '', connected: false, connecting: false, reconnectTimer: null, reconnectAttempt: 0, pingTimer: null, announcedChannel: '' };
  if (state.youtube.timer) clearTimeout(state.youtube.timer);
  state.youtube.timer = null;
  state.youtube.connecting = false;
  state.youtube.connected = false;
  state.youtube.liveChatId = '';
  state.youtube.broadcastId = '';
  state.youtube.channel = '';
  state.youtube.pageToken = '';
  state.youtube.canSend = false;
  state.youtube.writeAuthorizeUrl = '';
  state.youtube.seen.clear();
  if (state.velora.timer) clearTimeout(state.velora.timer);
  state.velora = {
    timer: null, connecting: false, connected: false, channel: '', seen: new Set(), emotes: new Map(),
    emoteChannels: new Set(), emoteChannelsLoading: new Set(), announcedChannel: '', monitored: new Map()
  };
  window.neonDesktop?.disconnectVelora().catch(() => {});
  restoredMonitoredChannels = false;
}

function renderAuth(auth) {
  const nextScope = identityScope(auth);
  if (storageScope !== nextScope) {
    if (storageScope !== null) resetConnectionsForIdentityChange();
    storageScope = nextScope;
    state.messages = loadChatHistory();
    updateCounts();
    renderMessages();
  }
  const previousUser = state.auth?.user || {};
  const incomingUser = auth?.user || {};
  if (previousUser.avatarUrl && !isDefaultOrPlaceholderAvatar(previousUser.avatarUrl) && isDefaultOrPlaceholderAvatar(incomingUser.avatarUrl)) {
    incomingUser.avatarUrl = previousUser.avatarUrl;
  }
  state.auth = auth ? { ...auth, user: incomingUser } : { authenticated: false };
  const signedIn = Boolean(state.auth.authenticated && state.auth.user);
  const user = state.auth.user || {};
  $('#identityName').textContent = signedIn ? user.displayName : 'Sign in with NeonLogin';
  $('#identityDetail').textContent = signedIn ? `@${user.username}` : 'Required for linked accounts';
  if (signedIn) showIdentityAvatar(user.avatarUrl);
  else $('#identityAvatar').textContent = 'NL';
  $('#neonLoginTitle').textContent = signedIn ? user.displayName : 'Sign in with NeonLogin';
  $('#neonLoginDetail').textContent = signedIn
    ? `NeonLogin @${user.username} · linked accounts synced`
    : 'Use one secure identity for your streaming account links.';
  $('#neonLoginButton').textContent = signedIn ? 'Sign out' : 'Sign in';
  $('#neonLoginButton').classList.toggle('secondary-button', signedIn);

  const links = user.links || {};
  const labels = {
    twitch: ['Twitch', 'Public read mode available'],
    youtube: ['YouTube Live', 'Connect YouTube via NeonLogin'],
    kick: ['Kick', 'Chat API connector planned'],
    velora: ['Velora', 'Public read-only chat available']
  };
  Object.entries(labels).forEach(([provider, [, fallback]]) => {
    const article = $(`article[data-provider="${provider}"]`);
    if (!article) return;
    article.classList.toggle('linked', Boolean(links[provider]));
    const detail = article.querySelector('small');
    if (provider === 'twitch' && state.twitch.connected) return;
    if (provider === 'velora' && state.velora.connected) return;
    if (provider === 'youtube' && state.youtube.connected) return;

    if (provider === 'twitch') {
      const username = user.twitchAuth?.username || user.twitch_username || user.username || '';
      detail.textContent = state.twitch.reconnectUrl
        ? 'Reconnect Twitch in NeonLogin to enable point redeems'
        : (username ? `Connected to #${username}` : fallback);
      updateTwitchReconnectAction();
    } else if (provider === 'kick') {
      const username = user.username || '';
      detail.textContent = username ? `Connected to #${username}` : fallback;
    } else if (provider === 'youtube') {
      if (!YOUTUBE_CHAT_ENABLED) {
        detail.textContent = 'Temporarily disabled';
        const button = article.querySelector('button');
        if (button) {
          button.textContent = 'Disabled';
          button.classList.add('coming-soon');
          button.onclick = null;
        }
      } else {
        const title = user.youtubeTitle || user.displayName || user.username || '';
        detail.textContent = links.youtube ? `Connected to #${title}` : fallback;
      }
    } else if (provider === 'velora') {
      const veloraStatus = state.velora.canModerate ? 'moderator' : (state.velora.canSend ? 'chat active' : 'read-only');
      detail.textContent = state.velora.channel ? `Reading #${state.velora.channel} (${veloraStatus})` : fallback;
    } else {
      detail.textContent = links[provider] ? 'Linked through NeonLogin' : fallback;
    }

    if (provider === 'youtube' || provider === 'kick') {
      const button = article.querySelector('button');
      if (button) {
        if (provider === 'youtube' && !YOUTUBE_CHAT_ENABLED) {
          button.textContent = 'Disabled';
          button.classList.add('coming-soon');
          button.onclick = null;
        } else {
          button.textContent = links[provider] ? 'Linked' : 'Link account';
          button.classList.remove('coming-soon');
          button.onclick = () => window.neonDesktop.openExternal('https://teammidnite.tv/NeonLogin/account.php');
        }
      }
    }
  });
  if (signedIn) {
    const userTwitch = user.links?.twitch
      ? (user.twitchUsername || user.twitchAuth?.username || user.twitch_username || user.twitch_login || '')
      : '';
    if (userTwitch) refreshTwitchIdentityAvatar(userTwitch);
    if (userTwitch && !state.twitch.connected && !state.twitch.userDisconnected) {
      connectTwitch(userTwitch);
    }
    const userKick = preferredKickChannel(user.links?.kick ? user.kickUsername : '');
    if (userKick) connectKick(userKick);
    if (user.links?.youtube && !state.youtube.connected && !state.youtube.quotaBlocked) {
      startYouTubeConnector();
    }
  } else {
    const savedTwitch = localStorage.getItem(scopedStorageKey('twitchChannel')) || '';
    if (savedTwitch && !state.twitch.connected) {
      connectTwitch(savedTwitch);
    }
    const savedKick = preferredKickChannel('');
    if (savedKick) connectKick(savedKick);
    stopYouTubeConnector();
  }
  const savedVelora = localStorage.getItem(scopedStorageKey('veloraChannel')) || state.velora.channel || '';
  if (savedVelora && (!state.velora.connected || !state.velora.canSend) && !state.velora.connecting) {
    startVeloraConnector(savedVelora, true);
  }
  restoreMonitoredTwitchChannels();
  restoreMonitoredVeloraChannels();
}

function preferredKickChannel(fallback = '') {
  return localStorage.getItem(scopedStorageKey('kickChannel')) || fallback;
}

async function getKickChatroomId(channel) {
  const result = await window.neonDesktop.getKickChatroom(channel);
  return result?.chatroomId || null;
}

function connectKick(channelName = '') {
  const channel = (channelName || '').trim().toLowerCase();
  if (!channel) return;
  if (IS_BROWSER_CLIENT) {
    const detail = $('#kickDetail');
    if (detail) detail.textContent = `Connecting to Kick #${channel}…`;
    connectMobileGateway('kick', channel)
      .then(() => { if (detail) detail.textContent = `Reading #${channel} · mobile gateway`; })
      .catch((error) => { if (detail) detail.textContent = error.message; });
    return;
  }
  if (!state.kick) state.kick = { socket: null, channel: '', chatroomId: '', connected: false, connecting: false, reconnectTimer: null, reconnectAttempt: 0, pingTimer: null, announcedChannel: '' };
  if ((state.kick.connected || state.kick.connecting) && state.kick.channel === channel) return;
  if (state.kick.reconnectTimer) clearTimeout(state.kick.reconnectTimer);
  if (state.kick.pingTimer) clearInterval(state.kick.pingTimer);
  state.kick.pingTimer = null;
  const previousChannel = state.kick.channel;
  if (state.kick.socket) {
    try { state.kick.socket.close(); } catch { }
  }
  if (previousChannel && previousChannel !== channel) {
    state.kick.chatroomId = '';
    state.kick.announcedChannel = '';
    clearChatHistory('kick', previousChannel);
  }
  const socket = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false');
  const reconnectAttempt = state.kick.reconnectAttempt || 0;
  const chatroomId = state.kick.chatroomId || '';
  const announcedChannel = state.kick.announcedChannel || '';
  state.kick = { socket, channel, chatroomId, connected: false, connecting: true, reconnectTimer: null, reconnectAttempt, pingTimer: null, announcedChannel };
  const article = $('article[data-provider="kick"]');
  const detail = article?.querySelector('small');
  if (detail) detail.textContent = `Connecting to Kick #${channel}…`;

  let subscribedChannel = '';
  let subscriptionTimer = null;
  const failConnection = (message) => {
    if (state.kick.socket !== socket) return;
    if (state.kick.pingTimer) clearInterval(state.kick.pingTimer);
    state.kick.pingTimer = null;
    state.kick.connected = false;
    state.kick.connecting = false;
    if (detail) detail.textContent = message;
    addMessage({ system: true, platform: 'kick', text: message });
    if (subscriptionTimer) clearTimeout(subscriptionTimer);
    try { socket.close(); } catch { }
  };
  socket.addEventListener('open', async () => {
    if (state.kick.pingTimer) clearInterval(state.kick.pingTimer);
    state.kick.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
        } catch { }
      }
    }, 30000);

    try {
      let dynamicId = state.kick.chatroomId;
      if (!dynamicId) {
        dynamicId = await getKickChatroomId(channel);
        if (dynamicId) state.kick.chatroomId = String(dynamicId);
      }
      if (!dynamicId) throw new Error(`Kick chatroom for #${channel} was not returned.`);
      if (state.kick.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      subscribedChannel = `chatrooms.${dynamicId}.v2`;
      socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: subscribedChannel } }));
      if (detail) detail.textContent = `Subscribing to Kick #${channel}…`;
      subscriptionTimer = setTimeout(() => {
        failConnection(`Kick did not confirm the chat subscription for #${channel}. Retrying…`);
      }, 12000);
    } catch (error) {
      failConnection(error?.message || `Kick chat discovery failed for #${channel}.`);
    }
  });

  socket.addEventListener('message', ({ data }) => {
    if (state.kick.socket !== socket) return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.event === 'pusher:ping') {
        socket.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        return;
      }
      if (parsed.event === 'pusher_internal:subscription_succeeded' && parsed.channel === subscribedChannel) {
        if (subscriptionTimer) clearTimeout(subscriptionTimer);
        subscriptionTimer = null;
        state.kick.connected = true;
        state.kick.connecting = false;
        const isReconnect = state.kick.announcedChannel === channel;
        state.kick.reconnectAttempt = 0;
        state.kick.announcedChannel = channel;
        article?.classList.add('linked');
        if (detail) detail.textContent = `Reading Kick #${channel}`;
        if (!isReconnect) {
          addMessage({ system: true, platform: 'kick', text: `Connected to Kick channel #${channel}` });
        }
      } else if (parsed.event === 'pusher:error' || parsed.event === 'pusher_internal:subscription_error') {
        const errorObj = typeof parsed.data === 'string'
          ? (() => { try { return JSON.parse(parsed.data); } catch { return { message: parsed.data }; } })()
          : (parsed.data || {});
        const code = Number(errorObj.code || 0);
        // Code 4200: Pusher advisory to reconnect immediately (e.g. server rebalance/restart).
        // Code 4201: Reconnect after a brief delay.
        if (code === 4200 || code === 4201) {
          if (subscriptionTimer) clearTimeout(subscriptionTimer);
          subscriptionTimer = null;
          state.kick.connecting = true;
          state.kick.connected = false;
          if (detail) detail.textContent = `Reconnecting Kick #${channel}…`;
          try { socket.close(); } catch { }
          const reconnectDelay = code === 4201 ? 1000 : 100;
          setTimeout(() => {
            if (state.kick.channel === channel) connectKick(channel);
          }, reconnectDelay);
          return;
        }
        const errorData = typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data || {});
        failConnection(`Kick rejected the chat subscription for #${channel}${errorData ? `: ${errorData}` : ''}`);
      } else if (
        parsed.event === 'App\\Events\\ChatMessageEvent' ||
        parsed.event === 'ChatMessageEvent' ||
        (typeof parsed.event === 'string' && parsed.event.includes('ChatMessageEvent'))
      ) {
        const payload = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
        if (payload && (payload.content || payload.message)) {
          addMessage({
            platform: 'kick',
            channel,
            author: payload.sender?.username || payload.sender?.slug || payload.slug || 'Kick User',
            authorLogin: payload.sender?.slug || payload.sender?.username || payload.slug || '',
            userId: payload.sender?.id || payload.sender?.user_id || payload.user_id || '',
            color: payload.sender?.identity?.color || '#53fc18',
            badges: (payload.sender?.identity?.badges || []).map((badge) =>
              String(badge?.type || badge?.text || badge?.name || badge || '').toLowerCase()
            ).filter(Boolean),
            text: payload.content || payload.message
          });
        }
      } else if (typeof parsed.event === 'string' && /(?:ban|timeout|unban)/i.test(parsed.event)) {
        const payload = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : (parsed.data || {});
        const user = payload.user || payload.sender || payload.banned_user || payload.target || {};
        const identity = {
          platform: 'kick',
          userId: user.id || user.user_id || payload.user_id || payload.target_user_id || '',
          authorLogin: user.slug || user.username || payload.username || payload.slug || ''
        };
        if (/unban/i.test(parsed.event)) unmoderateUser(identity);
        else moderateUser(identity, moderationDurationSeconds(payload));
      }
    } catch { }
  });

  socket.addEventListener('close', () => {
    if (state.kick.socket !== socket) return;
    if (state.kick.pingTimer) clearInterval(state.kick.pingTimer);
    state.kick.pingTimer = null;
    state.kick.connected = false;
    state.kick.connecting = false;
    if (subscriptionTimer) clearTimeout(subscriptionTimer);
    article?.classList.remove('linked');
    const delay = Math.min(30000, 1500 * (2 ** Math.min(state.kick.reconnectAttempt, 4)));
    state.kick.reconnectAttempt++;
    if (detail && !detail.textContent.includes('blocked') && !detail.textContent.includes('could not be resolved')) {
      detail.textContent = `Kick disconnected · retrying in ${Math.round(delay / 1000)}s…`;
    }
    state.kick.reconnectTimer = setTimeout(() => {
      state.kick.reconnectTimer = null;
      if (state.kick.channel === channel && !state.kick.connected && !state.kick.connecting) {
        connectKick(channel);
      }
    }, delay);
  });

  socket.addEventListener('error', () => {
    if (state.kick.socket === socket && detail) detail.textContent = `Kick connection error for #${channel}`;
  });
}

function normalizeVeloraChannel(value) {
  return String(value || '').trim()
    .replace(/^https?:\/\/(?:www\.)?velora\.tv\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
}

function savedMonitoredVeloraChannels() {
  try {
    const channels = JSON.parse(localStorage.getItem(scopedStorageKey('monitoredVelora')) || '[]');
    return Array.isArray(channels) ? channels.filter((channel) => /^[a-z0-9_.-]{1,64}$/.test(channel)) : [];
  } catch {
    return [];
  }
}

function saveMonitoredVeloraChannels() {
  localStorage.setItem(scopedStorageKey('monitoredVelora'), JSON.stringify([...state.velora.monitored.keys()]));
}

function mergeVeloraEmotes(emotes) {
  for (const emote of emotes || []) {
    const rawName = String(emote?.name || emote?.code || '');
    if (!rawName) continue;
    const clean = rawName.replace(/^:+|:+$/g, '');
    const entry = {
      ...emote,
      name: clean || rawName
    };
    state.velora.emotes.set(rawName, entry);
    state.velora.emotes.set(rawName.toLowerCase(), entry);
    if (clean) {
      state.velora.emotes.set(clean, entry);
      state.velora.emotes.set(clean.toLowerCase(), entry);
      state.velora.emotes.set(`:${clean}:`, entry);
      state.velora.emotes.set(`:${clean.toLowerCase()}:`, entry);
    }
  }
}

function scheduleVeloraPoll(delay = 3000) {
  // Retained as a no-op for settings migrated from the polling prototype.
}

async function startVeloraConnector(channelName, forceRefresh = false) {
  const channel = normalizeVeloraChannel(channelName);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(channel)) return;
  if (IS_BROWSER_CLIENT) {
    const detail = $('#veloraDetail');
    if (detail) detail.textContent = `Connecting to Velora #${channel}…`;
    await connectMobileGateway('velora', channel);
    try {
      const history = await window.neonDesktop.getVeloraMessages({ channel });
      for (const message of history.messages || []) addVeloraMessage(message, channel);
    } catch { /* live transport remains usable if history is unavailable */ }
    if (detail) detail.textContent = `Reading #${channel} · mobile gateway`;
    return;
  }
  if (!forceRefresh && state.velora.connected && state.velora.canSend && state.velora.channel.toLowerCase() === channel.toLowerCase()) return;
  if (!forceRefresh && state.velora.connecting && state.velora.channel.toLowerCase() === channel.toLowerCase()) return;
  if (state.velora.timer) clearTimeout(state.velora.timer);
  const previousChannel = state.velora.channel;
  if (previousChannel && previousChannel.toLowerCase() !== channel.toLowerCase()) clearChatHistory('velora', previousChannel);
  const existingBadgeCatalog = state.velora?.badgeCatalog || new Map();
  const existingCatalogLoaded = Boolean(state.velora?.catalogLoaded);
  const existingEmotes = state.velora?.emotes || new Map();
  const existingSeen = state.velora?.seen || new Set();
  const existingMonitored = state.velora?.monitored || new Map();
  state.velora = {
    timer: null, connecting: true, connected: Boolean(state.velora?.connected && !forceRefresh), channel,
    seen: existingSeen, emotes: existingEmotes,
    badgeCatalog: existingBadgeCatalog, catalogLoaded: existingCatalogLoaded,
    emoteChannels: state.velora?.emoteChannels || new Set(), emoteChannelsLoading: state.velora?.emoteChannelsLoading || new Set(),
    canSend: Boolean(state.velora?.canSend), canModerate: Boolean(state.velora?.canModerate),
    announcedChannel: state.velora?.announcedChannel || '', monitored: existingMonitored
  };
  localStorage.setItem(scopedStorageKey('veloraChannel'), channel);
  const article = $('article[data-provider="velora"]');
  const detail = $('#veloraDetail');
  const button = $('#veloraButton');
  if (detail && !state.velora.connected) detail.textContent = `Connecting to Velora #${channel}…`;
  if (button && !state.velora.connected) { button.textContent = 'Connecting…'; button.disabled = true; }
  article?.classList.add('linked');
  try {
    const result = await window.neonDesktop.connectVelora(channel);
    if (state.velora.channel.toLowerCase() !== channel.toLowerCase()) return;
    const shouldAnnounceConnection = state.velora.announcedChannel.toLowerCase() !== channel.toLowerCase();
    state.velora.connecting = false;
    state.velora.connected = Boolean(result?.connected);
    state.velora.channel = result?.channel || channel;
    state.velora.channelOwnerId = result?.channelOwnerId || result?.channelId || '';
    state.velora.channelOwnerLogin = (result?.channelOwnerLogin || channel).toLowerCase();
    state.velora.connectedUsername = result?.connectedUsername || '';
    state.velora.connectedUserId = result?.connectedUserId || '';
    state.velora.canSend = Boolean(result?.can_write);
    state.velora.canModerate = Boolean(result?.can_moderate);
    state.velora.isOwner = Boolean(result?.is_owner);

    if (result?.profile && typeof result.profile === 'object') {
      const p = result.profile;
      if (p.username) veloraProfileCache.set(p.username.toLowerCase(), p);
      if (p.id) veloraProfileCache.set(String(p.id).toLowerCase(), p);
      if (result.connectedUsername) veloraProfileCache.set(result.connectedUsername.toLowerCase(), p);
      state.velora.profile = p;
    }
    if (result?.channelProfile && typeof result.channelProfile === 'object') {
      const cp = result.channelProfile;
      if (cp.username) veloraProfileCache.set(cp.username.toLowerCase(), cp);
      if (cp.id) veloraProfileCache.set(String(cp.id).toLowerCase(), cp);
      state.velora.channelProfile = cp;
    }
    if (Array.isArray(result?.emotes) && result.emotes.length) {
      mergeVeloraEmotes(result.emotes);
      renderMessages();
    }
    const modStatus = state.velora.canModerate ? 'moderator' : (state.velora.canSend ? 'chat active' : 'read-only');
    if (detail) detail.textContent = `Velora #${channel} connected · ${modStatus}`;
    if (button) { button.textContent = 'Connected'; button.disabled = false; }
    if (shouldAnnounceConnection && state.velora.connected) {
      const modeText = state.velora.canModerate ? 'moderation and chat enabled' : (state.velora.canSend ? 'chat enabled' : 'read-only mode');
      addMessage({ system: true, platform: 'velora', text: `Connected to Velora channel #${channel} (${modeText})` });
      state.velora.announcedChannel = channel;
    }
    updateComposerState();
    try {
      const catalog = await window.neonDesktop.getVeloraEmotes(channel);
      if (state.velora.channel.toLowerCase() === channel.toLowerCase()) {
        mergeVeloraEmotes(catalog.emotes);
        if (state.twitch?.emotes?.size > 0) {
          for (const [key, em] of state.twitch.emotes.entries()) {
            if (em?.provider === '7TV' && !state.velora.emotes.has(key)) {
              mergeVeloraEmotes([em]);
            }
          }
        }
        renderMessages();
      }
    } catch {
      // Chat remains usable if Velora's optional public emote catalog is unavailable.
    }
    try {
      await loadVeloraBadgeCatalog();
    } catch {
      // Dynamic badge catalog load is non-fatal
    }
    // Bootstrap any history the provider makes public; live messages arrive
    // through the Socket.IO event bridge below. Velora only serves history for
    // the resolved channel UUID, so carry it over from the confirmed connection.
    const history = await window.neonDesktop.getVeloraMessages({ channel, channelId: result.channelId || '' });
    for (const message of history.messages || []) addVeloraMessage(message, channel);
    await preloadVeloraSenderEmotes(history.messages || [], channel);
  } catch (error) {
    state.velora.connecting = false;
    state.velora.connected = false;
    if (detail) detail.textContent = `Velora #${channel} failed: ${error?.message || 'connection unavailable'}`;
    if (button) { button.textContent = 'Retry'; button.disabled = false; }
  }
}

async function monitorVeloraChannel(channelName, persist = true) {
  const channel = normalizeVeloraChannel(channelName).toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/.test(channel) || channel === state.velora.channel.toLowerCase() || state.velora.monitored.has(channel)) return;
  state.velora.monitored.set(channel, { connected: false, connecting: true });
  if (persist) saveMonitoredVeloraChannels();
  renderMonitoredChannels();
  try {
    const result = await window.neonDesktop.monitorVelora(channel);
    if (!state.velora.monitored.has(channel)) return;
    const entry = state.velora.monitored.get(channel);
    entry.connected = Boolean(result?.connected);
    entry.connecting = false;
    renderMonitoredChannels();
  } catch (error) {
    const entry = state.velora.monitored.get(channel);
    if (entry) {
      entry.connected = false;
      entry.connecting = false;
      entry.error = error?.message || 'connection unavailable';
      renderMonitoredChannels();
    }
  }
}

function stopMonitoringVelora(channel) {
  const normalized = normalizeVeloraChannel(channel).toLowerCase();
  const entry = state.velora.monitored.get(normalized);
  if (!entry) return;
  state.velora.monitored.delete(normalized);
  Promise.resolve(window.neonDesktop.stopMonitoringVelora?.(normalized)).catch(() => {});
  saveMonitoredVeloraChannels();
  clearChatHistory('velora', normalized);
  renderMonitoredChannels();
  addMessage({ system: true, platform: 'velora', text: `Stopped monitoring Velora chat #${normalized}` });
}

function restoreMonitoredVeloraChannels() {
  savedMonitoredVeloraChannels()
    .filter((channel) => channel !== state.velora.channel.toLowerCase())
    .forEach((channel) => monitorVeloraChannel(channel, false));
}

async function loadVeloraBadgeCatalog() {
  if (state.velora.catalogLoaded) return;
  try {
    const data = window.neonDesktop?.getVeloraBadgeCatalog
      ? await window.neonDesktop.getVeloraBadgeCatalog()
      : await fetch('https://api.velora.tv/api/badges/catalog').then((r) => r.json()).catch(() => ({ badges: [] }));
    if (Array.isArray(data?.badges)) {
      for (const b of data.badges) {
        if (!b || typeof b !== 'object') continue;
        const imageUrl = b.animatedAssetUrl || b.staticAssetUrl || b.imageUrl || b.image_url || b.iconUrl || b.icon_url || b.assetUrl || b.asset_url || b.url || b.src || '';
        if (!imageUrl) continue;
        const item = {
          imageUrl,
          title: b.title || b.label || b.name || b.slug || b.id || 'Velora badge'
        };
        const keys = [b.id, b.slug, b.name, b.title, b.label, b.key, b.type, b.role, b.badge];
        for (const keyValue of keys) {
          if (!keyValue || typeof keyValue !== 'string') continue;
          const lower = keyValue.toLowerCase();
          const normalized = normalizeVeloraBadgeKey(keyValue);
          state.velora.badgeCatalog.set(lower, item);
          state.velora.badgeCatalog.set(lower.replace(/[\s-]+/g, '_'), item);
          if (normalized) {
            state.velora.badgeCatalog.set(normalized, item);
            state.velora.badgeCatalog.set(normalized.replace(/_/g, '-'), item);
          }
        }
      }
      state.velora.catalogLoaded = true;
    }
  } catch {
    // Non-fatal fallback
  }
}

const veloraPending7TvLookups = new Set();

async function checkAndResolveVelora7TvEmotes(body, channel) {
  if (!body || !window.neonDesktop?.resolveSevenTvEmotes) return;
  const matches = [...String(body).matchAll(/:([A-Za-z0-9_.-]{2,40}):/g)];
  const words = String(body).split(/\s+/).map((w) => w.replace(/^[:.,!?]+|[:.,!?]+$/g, '')).filter(Boolean);
  if (!matches.length && !words.length) return;

  const unknown = [];
  const addCandidate = (clean) => {
    if (!clean || clean.length < 2) return;
    const lower = clean.toLowerCase();
    if (state.velora.emotes.has(clean) || state.velora.emotes.has(lower)) return;
    if (state.twitch?.emotes?.has(clean) || state.twitch?.emotes?.has(lower)) {
      const tw = state.twitch.emotes.get(clean) || state.twitch.emotes.get(lower);
      if (tw) mergeVeloraEmotes([tw]);
      return;
    }
    if (!veloraPending7TvLookups.has(lower)) {
      veloraPending7TvLookups.add(lower);
      unknown.push(clean);
    }
  };

  for (const match of matches) {
    addCandidate(match[1]);
  }
  for (const word of words) {
    if (isVeloraBareAllowed(word)) {
      addCandidate(word);
    }
  }

  if (!unknown.length) return;

  try {
    const resolved = await window.neonDesktop.resolveSevenTvEmotes(unknown);
    if (Array.isArray(resolved) && resolved.length > 0) {
      mergeVeloraEmotes(resolved);
      renderMessages();
      broadcastUpdatedOverlayMessages();
    }
  } catch (err) {
    // Non-fatal lookup error
  }
}

function broadcastUpdatedOverlayMessages() {
  if (!window.neonDesktop?.broadcastOverlay) return;
  const recent = state.messages.slice(-30);
  for (const msg of recent) {
    if (msg.platform === 'velora') {
      broadcastOverlayEvent({
        type: 'update-message',
        data: {
          id: msg.id,
          bodyHtml: renderMessageBody(msg)
        }
      });
    }
  }
}

const veloraPendingProfileLookups = new Set();

async function enrichVeloraProfileAsync(username, channel = state.velora.channel) {
  const clean = normalizeVeloraChannel(username).toLowerCase();
  if (!clean || veloraPendingProfileLookups.has(clean)) return;
  const profileCache = (typeof veloraProfileCache !== 'undefined' && veloraProfileCache) ? veloraProfileCache : null;
  if (profileCache?.has(clean)) return;
  if (!window.neonDesktop?.getVeloraProfile) return;
  veloraPendingProfileLookups.add(clean);
  try {
    const profile = await window.neonDesktop.getVeloraProfile(clean);
    if (profile && typeof profile === 'object') {
      if (profileCache) {
        profileCache.set(clean, profile);
        if (profile.id) profileCache.set(String(profile.id).toLowerCase(), profile);
      }

      let updated = false;
      for (const msg of state.messages) {
        if (msg.platform === 'velora' && normalizeVeloraChannel(msg.authorLogin || msg.author).toLowerCase() === clean) {
          if (!msg.pronouns && (profile.pronouns || profile.pronounsShort)) {
            const rawPronouns = profile.pronounsFull || profile.pronouns || profile.pronounsShort;
            msg.pronouns = typeof rawPronouns === 'string' ? rawPronouns.trim() : (rawPronouns.display || rawPronouns.full || rawPronouns.short || '');
            updated = true;
          }
          const newBadges = collectVeloraBadges(msg, profile, msg.channel || channel, profile);
          if (JSON.stringify(newBadges) !== JSON.stringify(msg.badges)) {
            msg.badges = newBadges;
            updated = true;
          }
          if (!msg.secondaryHandle && (profile.tag || profile.secondaryHandle)) {
            msg.secondaryHandle = profile.tag || profile.secondaryHandle;
            updated = true;
          }
          if (profile.accentColor && (!msg.color || msg.color === '#FFFFFF' || msg.color === '#e2af00')) {
            msg.color = profile.accentColor;
            updated = true;
          }
        }
      }
      if (updated) {
        scheduleMessageRender();
        if (typeof broadcastUpdatedOverlayMessages === 'function') {
          broadcastUpdatedOverlayMessages();
        }
      }
    }
  } catch {
    // Non-fatal
  } finally {
    veloraPendingProfileLookups.delete(clean);
  }
}

function addVeloraMessage(rawMessage, channel = state.velora.channel) {
  let message = rawMessage;
  if (Array.isArray(message)) message = message[0];
  if (message?.message && typeof message.message === 'object') message = message.message;
  if (!message || typeof message !== 'object') return null;
  if (message.card?.type === 'points-celebration') {
    handleVeloraRedeem({ event: message.card.payload }, channel);
    return null;
  }
  const id = String(message.id || message.messageId || message._id || '');
  const existingByProviderId = id
    ? state.messages.find((item) => item.platform === 'velora' && item.providerId === id)
    : null;
  if (existingByProviderId) {
    existingByProviderId.optimistic = false;
    return existingByProviderId;
  }
  if (id && state.velora.seen.has(id)) return null;

  const sender = message.sender || message.user || message.author || message.profile || {};
  const authorLogin = normalizeVeloraChannel(sender.username || message.username || message.authorLogin || '').toLowerCase();
  const body = String(message.content || message.body || message.text || (typeof message.message === 'string' ? message.message : '') || '');
  if (!body) return null;
  const at = new Date(message.createdAt || message.created_at || message.timestamp || Date.now());

  // Check if an existing optimistic message matches this incoming message:
  const existingOptimistic = state.messages.find((item) =>
    item.platform === 'velora' &&
    item.optimistic &&
    item.channel === channel &&
    normalizeVeloraChannel(item.authorLogin || item.author).toLowerCase() === authorLogin &&
    item.text === body &&
    Math.abs(new Date(item.at).getTime() - at.getTime()) < 15000
  );
  if (existingOptimistic) {
    existingOptimistic.optimistic = false;
    if (id) {
      existingOptimistic.providerId = id;
      state.velora.seen.add(id);
    }
    return existingOptimistic;
  }

  if (id) {
    state.velora.seen.add(id);
    try {
      window.neonDesktop?.veloraMarkSeen?.([id]);
    } catch { }
  }

  const profileCache = (typeof veloraProfileCache !== 'undefined' && veloraProfileCache) ? veloraProfileCache : null;
  let profile = profileCache?.get?.(authorLogin) || null;
  if (!profile && (sender.id || message.userId)) {
    profile = profileCache?.get?.(String(sender.id || message.userId).toLowerCase()) || null;
  }
  if (!profile && state.velora?.profile) {
    const vp = state.velora.profile;
    const vpLogin = normalizeVeloraChannel(vp.username || vp.displayName || '').toLowerCase();
    const vpId = String(vp.id || vp.userId || '').toLowerCase();
    if (vpLogin === authorLogin || (sender.id && vpId === String(sender.id).toLowerCase()) || (message.userId && vpId === String(message.userId).toLowerCase())) {
      profile = vp;
      if (authorLogin && profileCache) profileCache.set(authorLogin, vp);
    }
  }
  if (!profile && state.velora?.channelProfile && authorLogin === state.velora.channelOwnerLogin) {
    profile = state.velora.channelProfile;
    if (authorLogin && profileCache) profileCache.set(authorLogin, profile);
  }

  // If this message has rich badge or pronoun details, update the cache
  if (message.badgeDetails?.length || message.subscriptionBadge || (Array.isArray(message.badges) && message.badges.length) || message.pronouns || message.pronounsFull) {
    const existing = profile || {};
    profile = {
      ...existing,
      id: message.userId || sender.id || existing.id,
      username: authorLogin || existing.username,
      displayName: message.displayName || sender.displayName || existing.displayName,
      pronouns: message.pronounsFull || message.pronouns || sender.pronounsFull || sender.pronouns || existing.pronouns,
      pronounsShort: message.pronounsShort || sender.pronounsShort || existing.pronounsShort,
      accentColor: message.accentColor || sender.accentColor || existing.accentColor,
      badges: message.badgeDetails || (Array.isArray(message.badges) && message.badges.length ? message.badges : existing.badges),
      subscriptionBadge: message.subscriptionBadge || existing.subscriptionBadge,
      badgeDetails: message.badgeDetails || existing.badgeDetails,
      userRoles: message.userRoles || existing.userRoles,
      role: message.role || existing.role,
      isSubscriber: message.isSubscriber ?? existing.isSubscriber,
      isModerator: message.isModerator ?? existing.isModerator,
      isVip: message.isVip ?? existing.isVip,
      subscriptionTier: message.subscriptionTier ?? existing.subscriptionTier ?? null
    };
    if (authorLogin && profileCache) profileCache.set(authorLogin, profile);
    if (profile.id && profileCache) profileCache.set(String(profile.id).toLowerCase(), profile);
  }

  const metadata = message.metadata || message.meta || {};
  const effectValue = message.effect || message.messageEffect || message.effectKey || message.style?.effect
    || metadata.effect || metadata.messageEffect || metadata.effectKey || metadata.style?.effect || '';
  const effect = typeof effectValue === 'object'
    ? effectValue.key || effectValue.slug || effectValue.id
      || [effectValue.type, effectValue.variant || effectValue.color || effectValue.name].filter(Boolean).join('-')
    : effectValue;

  const rawPronouns = sender.pronounsFull || sender.pronouns || sender.pronounsShort
    || message.pronounsFull || message.pronouns || message.pronounsShort
    || profile?.pronounsFull || profile?.pronouns || profile?.pronounsShort || '';
  const pronouns = typeof rawPronouns === 'string'
    ? rawPronouns.trim()
    : (rawPronouns.display || rawPronouns.full || rawPronouns.label || rawPronouns.short || '');

  const secondaryHandle = message.secondaryHandle || message.tag || sender.secondaryHandle || sender.tag
    || profile?.tag || profile?.secondaryHandle || '';

  const author = sender.displayName || sender.display_name || message.displayName || message.display_name
    || profile?.displayName || profile?.display_name || sender.username || message.username || profile?.username || message.authorName || 'Velora User';

  const color = sender.accentColor || sender.color || message.accentColor || message.color || profile?.accentColor || '#FFFFFF';

  const badges = collectVeloraBadges(message, sender, channel, profile);

  const stored = addMessage({
    providerId: id,
    optimistic: Boolean(message.optimistic),
    platform: 'velora',
    channel,
    author,
    authorLogin,
    userId: sender.id || sender.userId || sender.user_id || sender._id || message.userId || message.senderId || message.authorId || profile?.id || '',
    color,
    badges,
    pronouns,
    secondaryHandle,
    effect: String(effect || '').toLowerCase(),
    text: body,
    at
  });

  if (typeof loadVeloraSenderEmotes === 'function') loadVeloraSenderEmotes(authorLogin, body, channel);
  if (typeof checkAndResolveVelora7TvEmotes === 'function') checkAndResolveVelora7TvEmotes(body, channel);

  if (!profile && authorLogin && typeof enrichVeloraProfileAsync === 'function') {
    enrichVeloraProfileAsync(authorLogin, channel);
  }

  if (state.velora.seen.size > 3000) {
    const toRetain = new Set([...state.velora.seen].slice(-2000));
    state.velora.seen.clear();
    toRetain.forEach((id) => state.velora.seen.add(id));
  }

  return stored;
}

async function preloadVeloraSenderEmotes(messages, channel) {
  // 1. Collect all candidate 7TV emote tokens across restored messages (only colon-delimited tokens)
  const candidate7Tv = new Set();
  const senders = new Set();
  for (const raw of messages || []) {
    let message = raw;
    if (Array.isArray(message)) message = message[0];
    if (message?.message && typeof message.message === 'object') message = message.message;
    const body = String(message?.content || message?.body || message?.text || (typeof message?.message === 'string' ? message.message : '') || '');
    if (body) {
      for (const m of body.matchAll(/:([A-Za-z0-9_.-]{2,40}):/g)) {
        const clean = m[1];
        if (clean && clean.length >= 2 && !state.velora.emotes.has(clean) && !state.velora.emotes.has(clean.toLowerCase())) {
          candidate7Tv.add(clean);
        }
      }
      for (const w of body.split(/\s+/).map((p) => p.replace(/^[:.,!?]+|[:.,!?]+$/g, '')).filter(Boolean)) {
        if (w && isVeloraBareAllowed(w) && !state.velora.emotes.has(w) && !state.velora.emotes.has(w.toLowerCase())) {
          candidate7Tv.add(w);
        }
      }
    }
    const username = String(
      message?.sender?.username || message?.user?.username || message?.author || message?.username || ''
    ).trim();
    const login = normalizeVeloraChannel(username).toLowerCase();
    if (/^[a-z0-9_.-]{1,64}$/.test(login)) senders.add(login);
  }

  if (candidate7Tv.size > 0 && window.neonDesktop?.resolveSevenTvEmotes) {
    window.neonDesktop.resolveSevenTvEmotes([...candidate7Tv]).then((resolved) => {
      if (Array.isArray(resolved) && resolved.length) {
        mergeVeloraEmotes(resolved);
        renderMessages();
      }
    }).catch(() => {});
  }

  const pending = [...senders]
    .slice(0, 40)
    .filter((login) => !state.velora.emoteChannels.has(login) && !state.velora.emoteChannelsLoading.has(login));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const login = pending[cursor++];
      state.velora.emoteChannelsLoading.add(login);
      try {
        const catalog = await window.neonDesktop.getVeloraEmotes(login);
        if (state.velora.channel.toLowerCase() !== channel.toLowerCase()) return;
        mergeVeloraEmotes(catalog.emotes);
        state.velora.emoteChannels.add(login);
        renderMessages();
      } catch {
        // A sender's optional emote set must not interrupt chat.
      } finally {
        state.velora.emoteChannelsLoading.delete(login);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  if (state.velora.channel.toLowerCase() === channel.toLowerCase()) renderMessages();
}

async function loadVeloraSenderEmotes(authorLoginValue, body, channel) {
  const authorLogin = normalizeVeloraChannel(authorLoginValue).toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/.test(authorLogin)) return;
  const tokens = String(body || '').split(/\s+/).map((part) => part.replace(/^:+|:+$/g, ''));
  const hasUnknownSenderEmote = tokens.some((clean) => {
    const lower = clean.toLowerCase();
    return lower.startsWith(authorLogin) && !state.velora.emotes.has(clean) && !state.velora.emotes.has(lower);
  });
  if (!hasUnknownSenderEmote || state.velora.emoteChannels.has(authorLogin)
    || state.velora.emoteChannelsLoading.has(authorLogin)) return;

  state.velora.emoteChannelsLoading.add(authorLogin);
  try {
    const catalog = await window.neonDesktop.getVeloraEmotes(authorLogin);
    if (state.velora.channel.toLowerCase() !== channel.toLowerCase()) return;
    mergeVeloraEmotes(catalog.emotes);
    state.velora.emoteChannels.add(authorLogin);
    renderMessages();
  } catch {
    // A sender's optional external emote set must not interrupt chat.
  } finally {
    state.velora.emoteChannelsLoading.delete(authorLogin);
  }
}

function handleVeloraEvent(event) {
  const detail = $('#veloraDetail');
  const monitorChannel = String(event.monitorChannel || '').trim().replace(/^@/, '').toLowerCase();
  if (event.type === 'monitor_connected') {
    const entry = state.velora.monitored.get(monitorChannel);
    if (entry) {
      entry.connected = true;
      entry.connecting = false;
    }
    if (Array.isArray(event.emotes) && event.emotes.length) mergeVeloraEmotes(event.emotes);
    renderMonitoredChannels();
    return;
  }
  if (event.type === 'monitor_disconnected') {
    const entry = state.velora.monitored.get(monitorChannel);
    if (entry) {
      entry.connected = false;
      entry.connecting = true;
    }
    renderMonitoredChannels();
    return;
  }
  if (event.type === 'monitor_error') {
    const entry = state.velora.monitored.get(monitorChannel);
    if (entry) {
      entry.connected = false;
      entry.connecting = false;
      entry.error = event.message || 'connection unavailable';
    }
    renderMonitoredChannels();
    return;
  }
  if (event.type === 'connected') {
    const announcedChannel = String(state.velora.announcedChannel || '').toLowerCase();
    const shouldAnnounceConnection = announcedChannel !== String(event.channel || state.velora.channel).toLowerCase();
    state.velora.connecting = false;
    state.velora.connected = true;
    state.velora.channel = event.channel || state.velora.channel;
    state.velora.channelOwnerId = event.channelOwnerId || event.channelId || state.velora.channelOwnerId;
    state.velora.channelOwnerLogin = (event.channelOwnerLogin || state.velora.channel || '').toLowerCase();
    state.velora.connectedUsername = event.connectedUsername || state.velora.connectedUsername;
    state.velora.connectedUserId = event.connectedUserId || state.velora.connectedUserId;
    state.velora.canSend = Boolean(event.can_write);
    state.velora.canModerate = Boolean(event.can_moderate);
    state.velora.isOwner = Boolean(event.is_owner);

    if (event.profile && typeof event.profile === 'object') {
      const p = event.profile;
      if (p.username) veloraProfileCache.set(p.username.toLowerCase(), p);
      if (p.id) veloraProfileCache.set(String(p.id).toLowerCase(), p);
      if (event.connectedUsername) veloraProfileCache.set(event.connectedUsername.toLowerCase(), p);
      state.velora.profile = p;
    }
    if (event.channelProfile && typeof event.channelProfile === 'object') {
      const cp = event.channelProfile;
      if (cp.username) veloraProfileCache.set(cp.username.toLowerCase(), cp);
      if (cp.id) veloraProfileCache.set(String(cp.id).toLowerCase(), cp);
      state.velora.channelProfile = cp;
    }
    if (Array.isArray(event.emotes) && event.emotes.length) {
      mergeVeloraEmotes(event.emotes);
      renderMessages();
    }
    const modStatus = state.velora.canModerate ? 'moderator' : (state.velora.canSend ? 'chat active' : 'read-only');
    if (detail) detail.textContent = `Velora #${state.velora.channel} connected · ${modStatus}`;
    const button = $('#veloraButton');
    if (button) { button.textContent = 'Connected'; button.disabled = false; }
    if (shouldAnnounceConnection) {
      if (!state.youtube.connected && state.velora.canSend) setSendTarget('velora');
      const modeText = state.velora.canModerate ? 'moderation and chat enabled' : (state.velora.canSend ? 'chat enabled' : 'read-only mode');
      addMessage({ system: true, platform: 'velora', text: `Connected to Velora channel #${state.velora.channel} (${modeText})` });
      state.velora.announcedChannel = state.velora.channel;
    }
    updateComposerState();
    return;
  }
  if (event.type === 'chat_cleared') {
    const channel = monitorChannel || event.channel || state.velora.channel;
    clearChatHistory('velora', channel);
    addMessage({ system: true, platform: 'velora', text: `Chat was cleared in #${channel}.` });
    return;
  }
  if (event.type === 'disconnected') {
    state.velora.connected = false;
    if (detail) detail.textContent = `Reconnecting to Velora #${state.velora.channel}…`;
    const button = $('#veloraButton');
    if (button) button.textContent = 'Reconnecting…';
    updateComposerState();
    return;
  }
  if (event.type === 'error') {
    if (detail) detail.textContent = event.message || 'Velora chat unavailable';
    return;
  }
  if (event.type !== 'provider_event') return;
  const eventName = String(event.event || '').toLowerCase();
  if (eventName === 'chatcleared') {
    const channel = monitorChannel || state.velora.channel;
    clearChatHistory('velora', channel);
    addMessage({ system: true, platform: 'velora', text: `Chat was cleared in #${channel}.` });
    return;
  }
  if (/(?:ban|timeout|unban|moderationnotice)/.test(eventName)) {
    const payload = event.payload || {};
    const user = payload.user || payload.sender || payload.target || payload.bannedUser || {};
    const identity = {
      platform: 'velora',
      userId: user.id || user.userId || user.user_id || payload.userId || payload.targetUserId || '',
      authorLogin: user.username || user.login || payload.username || ''
    };
    if (eventName.includes('unban')) unmoderateUser(identity);
    else moderateUser(identity, moderationDurationSeconds(payload));
    return;
  }
  if (eventName.includes('delete') && event.payload?.messageId) {
    state.messages = state.messages.filter((item) => item.providerId !== event.payload.messageId);
    broadcastOverlayEvent({ type: 'delete', data: { id: event.payload.messageId } });
    renderMessages();
    return;
  }
  if (eventName.includes('message') && !eventName.includes('edit') && !eventName.includes('delete')) {
    addVeloraMessage(event.payload, monitorChannel || state.velora.channel);
  }
  if (['pointscelebration', 'redeem', 'channel_points_custom_reward_redemption'].includes(eventName)) {
    handleVeloraRedeem({ event: event.payload }, monitorChannel || state.velora.channel);
  }
  if (eventName === 'join' || eventName === 'presence') {
    handleVeloraJoin(event.payload, monitorChannel || state.velora.channel);
  }
}

function handleVeloraRedeem(payload, channel = state.velora.channel) {
  if (payload?.type === 'error') {
    addMessage({ system: true, platform: 'velora', text: payload.message || 'Velora redeems could not connect.' });
    return;
  }
  const event = payload?.event || (payload?.type === 'redeem' ? payload : (payload?.reward || payload?.rewardTitle || payload?.itemName ? payload : null));
  if (!event || typeof event !== 'object' || Array.isArray(event)) return;
  const eventChannel = String(event.broadcaster_login || event.channel?.username || (typeof event.channel === 'string' ? event.channel : '') || channel).toLowerCase();
  if (state.velora.channel.toLowerCase() !== eventChannel) return;
  const id = String(event.id || event.redemptionId || '');
  const seenId = id ? `redeem:${eventChannel}:${id}` : '';
  if (seenId && state.velora.seen.has(seenId)) return;
  if (seenId) state.velora.seen.add(seenId);
  if (state.velora.seen.size > 5000) state.velora.seen.delete(state.velora.seen.values().next().value);
  const input = String(event.user_input || event.input || event.userMessage || event.message || '');
  const authorLogin = String(event.user_login || event.userName || event.username || '').toLowerCase();
  const redeemedAt = new Date(event.redeemed_at || event.created_at || event.createdAt || Date.now());
  addMessage({
    providerId: id,
    platform: 'velora',
    channel: eventChannel,
    author: event.user_name || event.userName || event.displayName || event.display_name || event.username || 'Velora Viewer',
    authorLogin,
    color: '#c9a900',
    text: input,
    at: redeemedAt,
    veloraRedemption: {
      title: event.reward?.title || event.rewardTitle || event.itemName || event.title || 'Velora Reward',
      cost: event.reward?.cost || event.rewardCost || event.cost || 0
    },
    badges: [],
    dimmed: false
  });
}

const veloraJoinNotices = new Map();

function announceVeloraJoin(event, channel) {
  if (!event) return;
  const username = String(event.user_name || event.username || event.user_login || event.login || event.name || '').trim();
  if (!username) return;
  const targetChannel = String(channel || state.velora.channel || '').toLowerCase();
  const key = `${targetChannel}/${username.toLowerCase()}`;
  const now = Date.now();
  const last = veloraJoinNotices.get(key) || 0;
  if (now - last < 60000) return;
  if (veloraJoinNotices.size > 5000) {
    for (const [storedKey, at] of veloraJoinNotices) {
      if (now - at > 600000) veloraJoinNotices.delete(storedKey);
    }
  }
  veloraJoinNotices.set(key, now);
  addMessage({
    system: true,
    platform: 'velora',
    expiresIn: 20000,
    text: `${username} just joined ${targetChannel ? `#${targetChannel}` : 'chat'}`
  });
}

function handleVeloraJoin(payload, channel = state.velora.channel) {
  if (payload?.type === 'error') {
    addMessage({ system: true, platform: 'velora', text: payload.message || 'Velora presence could not be loaded.' });
    return;
  }
  if (payload?.type !== 'join' && payload?.type !== 'presence' && !payload?.event && !payload?.user_name && !payload?.username) return;
  announceVeloraJoin(payload.event || payload, channel);
}



function stopYouTubeConnector(options = {}) {
  const previousChannel = state.youtube.channel;
  if (state.youtube.timer) clearTimeout(state.youtube.timer);
  state.youtube.timer = null;
  state.youtube.connecting = false;
  state.youtube.connected = false;
  state.youtube.liveChatId = '';
  state.youtube.broadcastId = '';
  state.youtube.channel = '';
  state.youtube.pageToken = '';
  state.youtube.canSend = false;
  state.youtube.writeAuthorizeUrl = '';
  state.youtube.seen.clear();
  if (options.quotaBlocked) {
    state.youtube.quotaBlocked = true;
  }
  if (options.clearHistory && previousChannel) clearChatHistory('youtube', previousChannel);
  updateComposerState();
}

async function startYouTubeConnector(manual = false) {
  if (!YOUTUBE_CHAT_ENABLED) {
    markYouTubeDisabledUI();
    return;
  }
  if (state.youtube.quotaBlocked) {
    if (manual) {
      addMessage({ system: true, platform: 'youtube', text: 'YouTube API daily quota exceeded. Live chat cannot connect until Google resets the quota.' });
    }
    return;
  }
  if (state.youtube.connecting || state.youtube.connected) return;

  const isLinked = Boolean(state.auth?.user?.links?.youtube || state.auth?.user?.youtubeTitle || state.auth?.user?.youtube_channel_title);
  if (!isLinked && !manual) {
    return;
  }

  state.youtube.connecting = true;
  const detail = $('article[data-provider="youtube"] small');
  if (detail) detail.textContent = 'Checking for an active livestream…';

  try {
    const status = await window.neonDesktop.getYouTubeStatus();
    if (!status.live || !status.live.live_chat_id) {
      throw new Error('youtube_no_active_live_chat');
    }
    state.youtube.connected = true;
    state.youtube.liveChatId = status.live.live_chat_id;
    state.youtube.broadcastId = status.live.broadcast_id || '';
    state.youtube.channel = status.live.channel_title || status.live.channel_name || status.live.title || 'YouTube Live';
    state.youtube.canSend = Boolean(status.can_send);
    state.youtube.writeAuthorizeUrl = status.write_authorize_url || '';
    if (detail) detail.textContent = `Live: ${status.live.title}${state.youtube.canSend ? ' · sending enabled' : ' · read only'}`;
    const article = $('article[data-provider="youtube"]');
    if (article) article.classList.add('linked');
    const youtubeButton = $('#youtubeButton');
    if (youtubeButton) {
      youtubeButton.textContent = state.youtube.canSend ? 'Linked' : 'Read only';
      youtubeButton.onclick = () => window.neonDesktop.openExternal('https://teammidnite.tv/NeonLogin/account.php');
    }
    addMessage({ system: true, platform: 'youtube', text: `Connected to YouTube Live: ${status.live.title}` });
    if (!state.twitch.connected) setSendTarget('youtube');
    updateComposerState();
    loadYouTubeEmotes(state.youtube.broadcastId);
    scheduleYouTubePoll(0);
  } catch (error) {
    const code = String(error?.message || '').toLowerCase();
    const isQuota = code.includes('quota') || code.includes('quotaexceeded') || code.includes('youtube_quota_exceeded');

    if (isQuota) {
      state.youtube.quotaBlocked = true;
      stopYouTubeConnector({ quotaBlocked: true });
      if (detail) detail.textContent = 'Quota exceeded (resets daily)';
      const button = $('article[data-provider="youtube"] button');
      if (button) {
        button.textContent = 'Quota limit';
        button.classList.remove('coming-soon');
        button.onclick = () => window.neonDesktop.openExternal('https://teammidnite.tv/NeonLogin/account.php');
      }
      addMessage({ system: true, platform: 'youtube', text: 'YouTube API daily quota exceeded. Live chat polling stopped for this session.' });
      return;
    }

    if (code.includes('youtube_no_active_live_chat')) {
      const channelTitle = error?.details?.channel_title || state.auth?.user?.youtubeTitle || state.auth?.user?.displayName || state.auth?.user?.username || '';
      if (detail) {
        detail.textContent = channelTitle
          ? `Linked as @${channelTitle} (not live)`
          : 'Linked · no active livestream';
      }
      const article = $('article[data-provider="youtube"]');
      if (article) article.classList.add('linked');
      const button = $('article[data-provider="youtube"] button');
      if (button) {
        button.textContent = 'Check Live';
        button.classList.remove('coming-soon');
        button.onclick = () => startYouTubeConnector(true);
      }
      // Strictly no auto-retry timer!
    } else if (code.includes('youtube_reauthorization_required') || code.includes('youtube_not_linked')) {
      if (detail) detail.textContent = 'Reconnect YouTube to enable live chat';
      const button = $('article[data-provider="youtube"] button');
      if (button) {
        button.textContent = 'Reconnect';
        button.classList.remove('coming-soon');
        button.onclick = () => window.neonDesktop.openExternal('https://teammidnite.tv/NeonLogin/account.php');
      }
    } else {
      if (detail) detail.textContent = 'YouTube Live offline';
      const button = $('article[data-provider="youtube"] button');
      if (button) {
        button.textContent = 'Check Live';
        button.classList.remove('coming-soon');
        button.onclick = () => startYouTubeConnector(true);
      }
    }
  } finally {
    state.youtube.connecting = false;
  }
}

async function loadYouTubeEmotes(broadcastId, force = false) {
  if (!YOUTUBE_CHAT_ENABLED) return;
  if (!broadcastId || state.youtube.emotesLoading) return;
  if (!force && Date.now() - state.youtube.lastEmoteLoad < 10000) return;
  state.youtube.emotesLoading = true;
  state.youtube.lastEmoteLoad = Date.now();
  try {
    const catalog = await window.neonDesktop.getYouTubeEmotes(broadcastId);
    if (state.youtube.broadcastId !== broadcastId) return;
    for (const emote of catalog.emotes || []) state.youtube.emotes.set(emote.name, emote);
    renderMessages();
  } catch {
    // YouTube messages remain readable as colon codes if its public catalog is unavailable.
  } finally {
    state.youtube.emotesLoading = false;
  }
}

// Composer capabilities are deliberately platform-owned. The combined target
// is text-only because a provider token cannot be translated safely to every
// destination.
function getComposerCapabilities(platform) {
  if (platform === 'twitch') {
    const chatWrite = Boolean(state.twitch.canSendChat);
    return {
      text: chatWrite && Boolean(state.twitch.connected && state.twitch.authenticated), unicodeEmoji: true,
      platformEmotes: Boolean(state.twitch.connected && state.twitch.authenticated && state.twitch.canUseTwitchEmotes),
      subscriberEmotes: Boolean(state.twitch.connected && state.twitch.authenticated && state.twitch.canUseTwitchEmotes),
      animatedEmotes: Boolean(state.twitch.connected && state.twitch.authenticated && state.twitch.canUseTwitchEmotes), gifs: false, media: false
    };
  }
  if (platform === 'velora') {
    const canWrite = Boolean(state.velora.connected && state.velora.canSend);
    return { text: canWrite, unicodeEmoji: true, platformEmotes: canWrite && state.velora.emotes.size > 0, subscriberEmotes: false, animatedEmotes: canWrite, gifs: false, media: false };
  }
  // YouTube's liveChatMessages API accepts text; its displayed custom emoji
  // markup is not a sendable API contract. Kick currently has no authenticated
  // emote-send endpoint in this client, so neither gets a misleading picker.
  return { text: platform !== 'all', unicodeEmoji: true, platformEmotes: false, subscriberEmotes: false, animatedEmotes: false, gifs: false, media: false };
}

let activeEmoteSection = 'All';
let emotePickerCatalog = [];

function closeEmotePicker() {
  $('#emotePopover')?.classList.add('hidden');
}

function renderEmotePicker() {
  const search = String($('#emoteSearch')?.value || '').trim().toLowerCase();
  const section = activeEmoteSection;
  const visible = emotePickerCatalog.filter((emote) => {
    const matchesSearch = !search || `${emote.name} ${emote.source || ''}`.toLowerCase().includes(search);
    const matchesSection = search || section === 'All' || emote.section === section;
    return matchesSearch && matchesSection;
  });
  const grid = $('#emoteGrid');
  if (!grid) return;
  grid.replaceChildren();
  visible.forEach((emote) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'emote-item'; button.title = `${emote.name} · ${emote.source || 'platform'}`;
    button.dataset.emoteName = emote.name;
    button.innerHTML = `<img src="${escapeHtml(emote.url)}" alt="${escapeHtml(emote.name)}"><span>${escapeHtml(emote.name)}</span>`;
    grid.appendChild(button);
  });
  $('#emoteStatus').textContent = visible.length ? `${visible.length} available to this account` : 'No sendable emotes available.';
}

async function openEmotePicker() {
  const platform = state.sendTarget;
  const capabilities = getComposerCapabilities(platform);
  if (!capabilities.platformEmotes) return;
  const popover = $('#emotePopover');
  popover.classList.remove('hidden');
  $('#emoteSearch').value = '';
  $('#emoteStatus').textContent = 'Loading emotes…';
  emotePickerCatalog = [];
  activeEmoteSection = 'All';
  if (platform === 'twitch') {
    try {
      const catalog = await window.neonDesktop.getTwitchComposerEmotes(state.twitch.channel);
      if (state.sendTarget !== platform) return closeEmotePicker();
      emotePickerCatalog = catalog?.emotes || [];
    } catch (error) {
      $('#emoteStatus').textContent = error?.message || 'Twitch emotes are unavailable.';
      return;
    }
  } else if (platform === 'velora') {
    const seen = new Set();
    for (const emote of state.velora.emotes.values()) {
      const key = `${emote.name}|${emote.url}`;
      if (!emote.name || !emote.url || seen.has(key)) continue;
      seen.add(key); emotePickerCatalog.push({ ...emote, section: emote.provider || 'Velora' });
    }
  }
  const sections = [...new Set(['All', 'Global', 'My Emotes', ...emotePickerCatalog.map((emote) => emote.section).filter(Boolean)])];
  $('#emoteSections').replaceChildren(...sections.map((section) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `emote-section${section === activeEmoteSection ? ' active' : ''}`; button.textContent = section; button.dataset.emoteSection = section; return button;
  }));
  renderEmotePicker();
}

function updateComposerTools() {
  const capabilities = getComposerCapabilities(state.sendTarget);
  $('#emoteButton')?.classList.toggle('hidden', !capabilities.platformEmotes || state.sendTarget === 'all');
  $('#gifButton')?.classList.toggle('hidden', !capabilities.gifs || state.sendTarget === 'all');
  if (state.sendTarget === 'all') closeEmotePicker();
}

function refreshYouTubeEmotesForUnknownCodes(text) {
  if (!YOUTUBE_CHAT_ENABLED) return;
  const codes = String(text || '').match(/:[A-Za-z0-9_-]+:/g) || [];
  if (codes.some((code) => !state.youtube.emotes.has(code))) {
    loadYouTubeEmotes(state.youtube.broadcastId);
  }
}

function setSendTarget(target) {
  state.sendTarget = target;
  const labels = { all: 'All connected', twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', velora: 'Velora' };
  $('#targetLabel').textContent = labels[target] || target;
  $('#targetButton .platform-dot').className = `platform-dot ${target}`;
  const maxLength = (target === 'velora') ? 500 : 200;
  $('#messageInput').maxLength = maxLength;
  $('#charCount').textContent = `${$('#messageInput').value.length}/${maxLength}`;
  if ((target === 'velora' || target === 'all') && state.velora.connected && !state.velora.canSend) {
    startVeloraConnector(state.velora.channel, true);
  }
  updateComposerState();
}

function markYouTubeDisabledUI() {
  state.youtube.connecting = false;
  state.youtube.connected = false;
  state.youtube.liveChatId = '';
  state.youtube.broadcastId = '';
  state.youtube.channel = '';
  state.youtube.pageToken = '';
  state.youtube.canSend = false;
  if (state.youtube.timer) clearTimeout(state.youtube.timer);
  state.youtube.timer = null;
  const detail = $('article[data-provider="youtube"] small');
  if (detail) detail.textContent = 'Temporarily disabled';
  const button = $('article[data-provider="youtube"] button');
  if (button) {
    button.textContent = 'Disabled';
    button.classList.add('coming-soon');
    button.onclick = null;
  }
  updateComposerState();
}

function isBroadcasterForPlatform(platform) {
  if (platform === 'velora') {
    const targetChannel = String(state.velora.channel || '').trim().toLowerCase().replace(/^@/, '');
    if (!targetChannel) return false;
    const user = state.auth?.user || {};
    const userLogin = String(user.username || '').toLowerCase();
    const veloraLogin = String(user.velora_username || '').toLowerCase();
    const ownerLogin = String(state.velora.channelOwnerLogin || '').toLowerCase();
    if (state.velora.isOwner) return true;
    if (ownerLogin && (ownerLogin === userLogin || ownerLogin === veloraLogin || ownerLogin === targetChannel)) return true;
    if (targetChannel && (targetChannel === userLogin || targetChannel === veloraLogin)) return true;
    const saved = String(localStorage.getItem(scopedStorageKey('veloraChannel')) || '').toLowerCase();
    if (saved && saved === targetChannel) return true;
    return Boolean(state.velora.isBroadcaster || state.velora.canModerate);
  }
  if (platform === 'twitch') {
    const targetChannel = String(state.twitch.channel || '').trim().toLowerCase().replace(/^@/, '');
    if (!targetChannel) return false;
    const user = state.auth?.user || {};
    const userLogin = String(user.twitchUsername || user.twitch_username || user.username || '').toLowerCase();
    if (userLogin && userLogin === targetChannel) return true;
    const saved = String(localStorage.getItem(scopedStorageKey('twitchChannel')) || '').toLowerCase();
    if (saved && saved === targetChannel) return true;
    return Boolean(state.twitch.isBroadcaster || state.twitch.canModerate);
  }
  if (platform === 'youtube') {
    return Boolean(state.youtube.canSend || state.youtube.isOwner || state.auth?.user?.links?.youtube);
  }
  if (platform === 'kick') {
    const targetChannel = String(state.kick.channel || '').trim().toLowerCase().replace(/^@/, '');
    if (!targetChannel) return false;
    const user = state.auth?.user || {};
    const kickLogin = String(user.kickUsername || user.username || '').toLowerCase();
    if (kickLogin && kickLogin === targetChannel) return true;
    const saved = String(localStorage.getItem(scopedStorageKey('kickChannel')) || '').toLowerCase();
    if (saved && saved === targetChannel) return true;
    return Boolean(state.kick.connected);
  }
  return false;
}

function updateComposerState() {
  const isSpecificTarget = state.sendTarget !== 'all';
  const isBroadcasterTarget = isSpecificTarget && isBroadcasterForPlatform(state.sendTarget);

  const canSendYouTube = YOUTUBE_CHAT_ENABLED && Boolean(state.youtube?.connected) && (state.youtube?.canSend || (state.sendTarget === 'youtube' && isBroadcasterForPlatform('youtube'))) && (state.sendTarget === 'youtube' || state.sendTarget === 'all');
  const canSendVelora = Boolean(state.velora?.connected) && (state.velora?.canSend || (state.sendTarget === 'velora' && isBroadcasterForPlatform('velora'))) && (state.sendTarget === 'velora' || state.sendTarget === 'all');
  const twitchCapabilities = getComposerCapabilities('twitch');
  const canSendTwitch = Boolean(state.twitch?.connected) && twitchCapabilities.text && (state.sendTarget === 'twitch' || state.sendTarget === 'all');
  const canSendKick = Boolean(state.kick?.connected) && (state.sendTarget === 'kick' && isBroadcasterForPlatform('kick'));

  // If sendTarget is 'all', ONLY allow platforms with verified write permission (do NOT allow broadcaster override to blast across all channels)
  const canSendOnAll = (YOUTUBE_CHAT_ENABLED && Boolean(state.youtube?.connected && state.youtube?.canSend))
    || (Boolean(state.twitch?.connected) && twitchCapabilities.text)
    || (Boolean(state.velora?.connected) && (state.velora?.canSend || (isBroadcasterForPlatform('velora') && state.sendTarget !== 'all')));

  const canSend = state.sendTarget === 'all'
    ? canSendOnAll
    : (canSendYouTube || canSendVelora || canSendTwitch || canSendKick);

  $('#messageInput').disabled = !canSend;
  $('#sendButton').disabled = !canSend;

  const targetLabel = state.sendTarget === 'all'
    ? 'connected chats'
    : state.sendTarget === 'velora'
      ? 'Velora'
      : state.sendTarget === 'twitch'
        ? 'Twitch'
        : state.sendTarget === 'kick'
          ? 'Kick'
          : 'YouTube Live';

  const youtubeNeedsPermission = Boolean(state.youtube?.connected && !state.youtube?.canSend && !isBroadcasterTarget)
    && (state.sendTarget === 'youtube' || state.sendTarget === 'all');
  const veloraNeedsPermission = Boolean(state.velora?.connected && !state.velora?.canSend && !isBroadcasterTarget)
    && (state.sendTarget === 'velora' || state.sendTarget === 'all');

  const twitchNeedsReconnect = state.sendTarget === 'twitch' && Boolean(state.twitch?.connected) && (!state.twitch.authenticated || !state.twitch.canSendChat);
  $('#messageInput').placeholder = canSend
    ? (isBroadcasterTarget ? `Send to ${targetLabel} as broadcaster…` : `Send to ${targetLabel} as your linked account…`)
    : twitchNeedsReconnect
      ? (state.twitch.authenticated ? 'Reconnect Twitch to enable sending…' : 'Reconnect Twitch…')
    : youtubeNeedsPermission
      ? 'YouTube is connected in read-only mode…'
      : veloraNeedsPermission
        ? 'Velora chat:write permission required…'
        : 'Connect a supported account to send messages…';
  updateComposerTools();
}

function scheduleYouTubePoll(delay) {
  if (!YOUTUBE_CHAT_ENABLED || state.youtube.quotaBlocked || !state.youtube.connected) return;
  if (state.youtube.timer) clearTimeout(state.youtube.timer);
  state.youtube.timer = setTimeout(pollYouTubeMessages, Math.max(0, delay));
}

async function pollYouTubeMessages() {
  if (!YOUTUBE_CHAT_ENABLED || !state.youtube.connected || !state.youtube.liveChatId || state.youtube.quotaBlocked) return;
  try {
    const payload = await window.neonDesktop.getYouTubeMessages({
      liveChatId: state.youtube.liveChatId,
      pageToken: state.youtube.pageToken
    });
    state.youtube.pageToken = payload.next_page_token || state.youtube.pageToken;
    for (const message of payload.messages || []) {
      if (!message.id || state.youtube.seen.has(message.id)) continue;
      state.youtube.seen.add(message.id);
      refreshYouTubeEmotesForUnknownCodes(message.text);
      addMessage({
        platform: 'youtube',
        channel: state.youtube.channel,
        author: message.author,
        color: message.owner ? '#ff5252' : (message.member ? '#2ba640' : '#ff6b63'),
        badges: [...(message.owner ? ['owner'] : []), ...(message.member ? ['member'] : [])],
        text: message.text,
        at: message.published_at ? new Date(message.published_at) : new Date()
      });
    }
    if (state.youtube.seen.size > 3000) state.youtube.seen.clear();
    scheduleYouTubePoll(payload.polling_interval_ms || 5000);
  } catch (error) {
    const code = String(error?.message || '').toLowerCase();
    const isQuota = code.includes('quota') || code.includes('quotaexceeded') || code.includes('youtube_quota_exceeded');

    if (state.youtube.timer) clearTimeout(state.youtube.timer);
    state.youtube.timer = null;
    state.youtube.connected = false;

    if (isQuota) {
      state.youtube.quotaBlocked = true;
      stopYouTubeConnector({ quotaBlocked: true });
      addMessage({ system: true, platform: 'youtube', text: 'YouTube API daily quota exceeded. Live chat polling stopped for this session.' });
      const detail = $('article[data-provider="youtube"] small');
      if (detail) detail.textContent = 'Quota exceeded (resets daily)';
      const button = $('article[data-provider="youtube"] button');
      if (button) {
        button.textContent = 'Quota limit';
        button.onclick = () => window.neonDesktop.openExternal('https://teammidnite.tv/NeonLogin/account.php');
      }
      return;
    }

    addMessage({ system: true, platform: 'youtube', text: `YouTube Live disconnected: ${error?.message || 'unknown error'}` });
    const detail = $('article[data-provider="youtube"] small');
    if (detail) detail.textContent = 'Stream ended / offline';
    const button = $('article[data-provider="youtube"] button');
    if (button) {
      button.textContent = 'Check Live';
      button.onclick = () => startYouTubeConnector(true);
    }
  }
}

async function toggleNeonLogin() {
  const button = $('#neonLoginButton');
  button.disabled = true;
  try {
    if (state.auth.authenticated) {
      if (IS_BROWSER_CLIENT) {
        window.location.assign('/NeonLogin/account.php?action=logout');
        return;
      }
      renderAuth(await window.neonDesktop.signOutNeonLogin());
    } else {
      button.textContent = 'Waiting for browser…';
      if (IS_BROWSER_CLIENT) {
        browserNeonLogin();
        return;
      }
      const auth = await window.neonDesktop.signInWithNeonLogin();
      renderAuth(auth);
    }
  } catch (error) {
    addMessage({ system: true, text: `NeonLogin: ${error?.message || 'Sign-in could not be completed.'}` });
    renderAuth(state.auth);
  } finally {
    button.disabled = false;
  }
}

$('#tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  state.activeView = tab.dataset.view;
  state.settings.paneViews[0] = state.activeView;
  const firstPaneSelect = $('.chat-pane select');
  if (firstPaneSelect) firstPaneSelect.value = state.activeView;
  saveSettings();
  $$('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  $('#viewTitle').textContent = state.activeView === 'all'
    ? 'All connected streams'
    : (state.activeView === 'notices' || state.activeView === 'errors')
      ? 'Errors & system notices history'
      : `${state.activeView[0].toUpperCase()}${state.activeView.slice(1)} chat`;
  renderMessages();
});

$('#searchInput').addEventListener('input', renderMessages);
$('#pauseButton').addEventListener('click', () => {
  state.paused = !state.paused;
  $('#pauseButton').classList.toggle('active', state.paused);
  $('#pauseButton').title = state.paused ? 'Resume chat' : 'Pause chat';
  if (!state.paused) $$('.chat-log').forEach((log) => { log.scrollTop = log.scrollHeight; });
});
$('#clearChatButton').addEventListener('click', () => {
  const view = state.settings.paneViews[0] || state.activeView || 'all';
  clearChatHistory(view);
  if ((view === 'velora' || view === 'all') && state.velora.connected && state.velora.canModerate && window.neonDesktop?.clearVeloraChat) {
    window.neonDesktop.clearVeloraChat(state.velora.channel).catch(() => {});
  }
});

function openConnections() {
  $('#channelEntry').classList.remove('hidden');
  renderMonitoredChannels();
  updateAddChatForm();
  const veloraRegisterLink = $('#veloraRegisterLink');
  if (veloraRegisterLink) veloraRegisterLink.href = VELORA_REFERRAL_URL;
  const checkUpdatesBtn = $('#checkForUpdatesButton');
  if (checkUpdatesBtn) {
    checkUpdatesBtn.onclick = async () => {
      checkUpdatesBtn.disabled = true;
      const origText = checkUpdatesBtn.textContent;
      checkUpdatesBtn.textContent = 'Checking…';
      try {
        await window.neonDesktop.checkForUpdates();
      } catch {
      } finally {
        checkUpdatesBtn.disabled = false;
        checkUpdatesBtn.textContent = origText;
      }
    };
  }
  dialog.showModal();
}

function updateAddChatForm() {
  const platform = $('#addChatPlatform').value;
  const input = $('#channelInput');
  const help = $('#addChatHelp');
  input.classList.remove('hidden');
  input.placeholder = platform === 'twitch' ? 'Twitch username or URL'
    : platform === 'velora' ? 'Velora username or URL'
    : 'Kick username or URL';
  $('#joinChannelButton').textContent = 'Add Channel';
  const helpTexts = {
    twitch: 'Add an extra public Twitch channel to read alongside your main stream.',
    kick: 'Add an extra public Kick channel to read alongside your main stream.',
    velora: 'Add an extra public Velora channel to monitor alongside your main stream.'
  };
  if (platform === 'velora') {
    help.innerHTML = `${helpTexts.velora} <a class="provider-link" href="${VELORA_REFERRAL_URL}" target="_blank" rel="noopener noreferrer">No account? Register on Velora</a>`;
  } else {
    help.textContent = helpTexts[platform] || 'Add an extra public channel to read alongside your stream.';
  }
}

function addSelectedChat() {
  const platform = $('#addChatPlatform').value;
  const input = $('#channelInput');
  if (platform === 'twitch') monitorTwitchChannel(input.value);
  if (platform === 'kick') {
    const channel = String(input.value || '').trim().toLowerCase()
      .replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/^#/, '').replace(/[/?#].*$/, '');
    if (channel) {
      localStorage.setItem(scopedStorageKey('kickChannel'), channel);
      connectKick(channel);
    }
  }
  if (platform === 'velora') monitorVeloraChannel(input.value);
  if (platform === 'youtube') startYouTubeConnector(true);
  input.value = '';
}

function closeUserContextMenu() {
  userContextMenu.classList.add('hidden');
  contextMessage = null;
}

function closeVeloraProfileCard() {
  veloraProfileCard?.classList.add('hidden');
}

function veloraProfileImage(profile = {}) {
  return profile.banner || profile.bannerUrl || profile.profileBanner || profile.profileTheme?.banner
    || profile.profileTheme?.bannerUrl || profile.profileCanvas?.backgroundImage || '';
}

function veloraProfileBio(profile = {}) {
  const raw = String(profile.bio || profile.description || profile.about || '').trim();
  if (!raw) return '';
  const documentBody = new DOMParser().parseFromString(raw.replace(/<\s*br\s*\/?>/gi, '\n'), 'text/html').body;
  return String(documentBody.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function veloraAvatar(profile = {}) {
  return profile.avatar || profile.avatarUrl || profile.profileImage || profile.profileImageUrl || '';
}

async function openVeloraProfileCard(event, row) {
  const message = state.messages.find((item) => item.providerId && item.providerId === row?.dataset.messageId)
    || [...state.messages].reverse().find((item) => item.platform === 'velora' && item.author === row?.dataset.author);
  const username = String(message?.authorLogin || '').trim().replace(/^@/, '');
  if (!username || !window.neonDesktop?.getVeloraProfile) return;
  closeUserContextMenu();
  veloraProfileCard.classList.remove('hidden');
  $('#veloraProfileName').textContent = message.author || username;
  $('#veloraProfilePronouns').textContent = 'Loading…';
  $('#veloraProfileMeta').textContent = 'Velora profile';
  $('#veloraProfileBio').textContent = '';
  $('#veloraProfileAvatar').removeAttribute('src');
  $('#veloraProfileBanner').style.backgroundImage = '';
  $('#veloraProfileLink').href = `https://velora.tv/${encodeURIComponent(username)}`;
  const width = veloraProfileCard.offsetWidth;
  const height = veloraProfileCard.offsetHeight;
  veloraProfileCard.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  veloraProfileCard.style.top = `${Math.max(8, Math.min(event.clientY + 10, window.innerHeight - height - 8))}px`;
  try {
    let profile = veloraProfileCache.get(username.toLowerCase());
    if (!profile) {
      profile = await window.neonDesktop.getVeloraProfile(username);
      veloraProfileCache.set(username.toLowerCase(), profile);
    }
    const displayName = profile.displayName || profile.display_name || profile.username || username;
    const pronouns = profile.pronounsShort || profile.pronouns || '';
    const status = profile.isLive ? `● LIVE${profile.streamInfo?.category?.name ? ` · ${profile.streamInfo.category.name}` : ''}` : 'Velora';
    const avatar = veloraAvatar(profile);
    const banner = veloraProfileImage(profile);
    $('#veloraProfileName').textContent = displayName;
    $('#veloraProfilePronouns').textContent = pronouns ? `(${pronouns})` : '';
    $('#veloraProfileMeta').textContent = status;
    $('#veloraProfileBio').textContent = veloraProfileBio(profile) || 'No profile bio yet.';
    const avatarEl = $('#veloraProfileAvatar');
    if (avatar) avatarEl.src = avatar; else avatarEl.removeAttribute('src');
    $('#veloraProfileBanner').style.backgroundImage = banner ? `url("${String(banner).replaceAll('"', '%22')}")` : '';
    $('#veloraProfileLink').href = `https://velora.tv/${encodeURIComponent(profile.username || username)}`;
  } catch (error) {
    $('#veloraProfilePronouns').textContent = '';
    $('#veloraProfileMeta').textContent = 'Velora profile unavailable';
    $('#veloraProfileBio').textContent = error?.message || 'This public profile could not be loaded.';
  }
}

function openUserContextMenu(event, row) {
  const author = row?.dataset.author;
  if (!author) return;
  const message = state.messages.find((item) => item.providerId && item.providerId === row.dataset.messageId)
    || [...state.messages].reverse().find((item) => item.author === author && item.platform === row.dataset.platform);
  if (!message) return;
  event.preventDefault();
  contextMessage = message;
  $('#contextUserName').textContent = author;
  $('#contextPlatformBadge').innerHTML = platformGlyph(message.platform);
  $('#contextPlatformBadge').className = message.platform;
  const isPrimaryTwitch = message.platform === 'twitch' && (
    (!message.destinationChannel && (!message.channel || message.channel === state.twitch.channel)) ||
    message.destinationChannel === state.twitch.channel
  );
  const isVelora = message.platform === 'velora';
  const allowed = (isPrimaryTwitch && state.twitch.canModerate) || (isVelora && state.velora.canModerate);
  userContextMenu.querySelectorAll('[data-mod-action]').forEach((button) => {
    button.disabled = !allowed || (button.dataset.modAction === 'delete' && !message.providerId);
  });
  $('#contextMenuNote').textContent = allowed
    ? `Actions apply in #${message.destinationChannel || message.channel || (isVelora ? state.velora.channel : state.twitch.channel)}.`
    : message.platform === 'twitch'
      ? 'Moderator access is required in this channel.'
      : message.platform === 'velora'
        ? 'Velora chat:moderate permission required.'
        : `${message.platform} moderation is not available through this connection.`;
  userContextMenu.classList.remove('hidden');
  const menuWidth = userContextMenu.offsetWidth;
  const menuHeight = userContextMenu.offsetHeight;
  userContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - menuWidth - 8)}px`;
  userContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - menuHeight - 8)}px`;
}

$('#settingsButton').addEventListener('click', () => appearanceDialog.showModal());
$('#identityButton').addEventListener('click', openConnections);
$('#addChannelButton').addEventListener('click', openConnections);
$('#chatWorkspace').addEventListener('click', (event) => {
  if (event.target.closest('.empty-connect-button')) openConnections();
  const veloraName = event.target.closest('.message-row[data-platform="velora"] .message-author');
  if (veloraName) {
    openVeloraProfileCard(event, veloraName.closest('.message-row'));
    return;
  }
  const menu = event.target.closest('.moderation-menu');
  if (!menu) return;
  const row = menu.closest('.message-row');
  openUserContextMenu(event, row);
});
$('#chatWorkspace').addEventListener('contextmenu', (event) => {
  const name = event.target.closest('.message-author');
  if (!name) return;
  openUserContextMenu(event, name.closest('.message-row'));
});
$('#veloraProfileClose').addEventListener('click', closeVeloraProfileCard);
document.addEventListener('click', (event) => {
  if (!veloraProfileCard?.classList.contains('hidden') && !veloraProfileCard.contains(event.target) && !event.target.closest('.message-row[data-platform="velora"] .message-author')) closeVeloraProfileCard();
});
userContextMenu.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-mod-action]');
  if (!button || button.disabled || !contextMessage) return;
  const author = contextMessage.author;
  const action = button.dataset.modAction;

  if (contextMessage.platform === 'velora') {
    const targetMessage = contextMessage;
    const modChannel = targetMessage.channel || state.velora.channel;
    const modChannelId = state.velora.channelOwnerId;
    const targetUserId = targetMessage.userId || targetMessage.authorId || '';
    closeUserContextMenu();
    try {
      if (action === 'delete') {
        if (targetMessage.providerId) {
          state.messages = state.messages.filter((item) => item.providerId !== targetMessage.providerId);
          broadcastOverlayEvent({ type: 'delete', data: { id: targetMessage.providerId } });
          renderMessages();
          if (window.neonDesktop?.moderateVeloraUser) {
            await window.neonDesktop.moderateVeloraUser({
              channel: modChannel,
              channelId: modChannelId,
              action: 'delete',
              messageId: targetMessage.providerId,
              author,
              targetUsername: author,
              targetUserId
            });
          }
        }
      } else if (action === 'timeout-60') {
        moderateUser(targetMessage, 60);
        if (window.neonDesktop?.moderateVeloraUser) {
          await window.neonDesktop.moderateVeloraUser({
            channel: modChannel,
            channelId: modChannelId,
            action: 'timeout',
            author,
            targetUsername: author,
            targetUserId,
            duration: 60
          });
        }
      } else if (action === 'timeout-600') {
        moderateUser(targetMessage, 600);
        if (window.neonDesktop?.moderateVeloraUser) {
          await window.neonDesktop.moderateVeloraUser({
            channel: modChannel,
            channelId: modChannelId,
            action: 'timeout',
            author,
            targetUsername: author,
            targetUserId,
            duration: 600
          });
        }
      } else if (action === 'ban') {
        moderateUser(targetMessage);
        if (window.neonDesktop?.moderateVeloraUser) {
          await window.neonDesktop.moderateVeloraUser({
            channel: modChannel,
            channelId: modChannelId,
            action: 'ban',
            author,
            targetUsername: author,
            targetUserId
          });
        }
      }
    } catch (err) {
      addMessage({ system: true, platform: 'velora', text: `Moderation action failed: ${err?.message || 'unknown error'}` });
    }
    return;
  }

  const commands = {
    delete: contextMessage.providerId ? `/delete ${contextMessage.providerId}` : '',
    'timeout-60': `/timeout ${author} 60`,
    'timeout-600': `/timeout ${author} 600`,
    ban: `/ban ${author}`
  };
  const command = commands[button.dataset.modAction];
  if (command) {
    if (button.dataset.modAction === 'timeout-60') moderateUser(contextMessage, 60);
    if (button.dataset.modAction === 'timeout-600') moderateUser(contextMessage, 600);
    if (button.dataset.modAction === 'ban') moderateUser(contextMessage);
    sendTwitchCommand(command);
  }
  closeUserContextMenu();
});
$('#neonLoginButton').addEventListener('click', toggleNeonLogin);
$('#addChatPlatform').addEventListener('change', updateAddChatForm);

$$('.public-twitch').forEach((button) => button.addEventListener('click', () => {
  if (state.twitch.reconnectUrl) {
    window.neonDesktop.openExternal(state.twitch.reconnectUrl);
    return;
  }
  $('#channelEntry').classList.remove('hidden');
  $('#channelInput').focus();
}));

$$('.public-velora').forEach((button) => button.addEventListener('click', () => {
  $('#channelEntry').classList.remove('hidden');
  $('#addChatPlatform').value = 'velora';
  updateAddChatForm();
  $('#channelInput').focus();
}));

$('#joinChannelButton').addEventListener('click', () => {
  addSelectedChat();
});
$('#channelInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addSelectedChat();
  }
});
$('#monitoredChannels').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-channel]');
  if (!button) return;
  if (button.dataset.removePlatform === 'velora') stopMonitoringVelora(button.dataset.removeChannel);
  else stopMonitoringTwitch(button.dataset.removeChannel);
});

$('#targetButton').addEventListener('click', () => $('#targetMenu').classList.toggle('hidden'));
$('#targetMenu').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-target]');
  if (!button) return;
  setSendTarget(button.dataset.target);
  $('#targetMenu').classList.add('hidden');
});

$('#emoteButton').addEventListener('click', (event) => {
  event.stopPropagation();
  if ($('#emotePopover').classList.contains('hidden')) openEmotePicker();
  else closeEmotePicker();
});
$('#closeEmoteButton').addEventListener('click', closeEmotePicker);
$('#emoteSearch').addEventListener('input', renderEmotePicker);
$('#emoteSections').addEventListener('click', (event) => {
  const button = event.target.closest('[data-emote-section]');
  if (!button) return;
  activeEmoteSection = button.dataset.emoteSection;
  $$('.emote-section').forEach((item) => item.classList.toggle('active', item === button));
  renderEmotePicker();
});
$('#emoteGrid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-emote-name]');
  if (!button) return;
  const token = state.sendTarget === 'twitch' ? button.dataset.emoteName : `:${button.dataset.emoteName}:`;
  const input = $('#messageInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`.slice(0, Number(input.maxLength));
  input.focus(); input.setSelectionRange(start + token.length, start + token.length);
  $('#charCount').textContent = `${input.value.length}/${input.maxLength}`;
});

$('#messageInput').addEventListener('input', (event) => {
  $('#charCount').textContent = `${event.currentTarget.value.length}/${event.currentTarget.maxLength}`;
});

$('footer.chat-composer, footer')?.addEventListener('click', (event) => {
  if (event.target === $('#messageInput') || event.target.closest('#messageInput')) {
    if (state.velora.connected && !state.velora.canSend && (state.sendTarget === 'velora' || state.sendTarget === 'all')) {
      startVeloraConnector(state.velora.channel, true);
    }
  }
});

async function sendComposerMessage() {
  const input = $('#messageInput');
  const message = input.value.trim();
  if (!message) return;
  $('#sendButton').disabled = true;
  try {
    if (YOUTUBE_CHAT_ENABLED && (state.sendTarget === 'youtube' || state.sendTarget === 'all')) {
      if (state.youtube.connected && state.youtube.canSend) {
        await window.neonDesktop.sendYouTubeMessage({
          liveChatId: state.youtube.liveChatId,
          message
        });
      }
    }

    if ((state.sendTarget === 'velora' || state.sendTarget === 'all') && state.velora?.connected) {
      const veloraSendOk = state.velora.canSend ||
        (typeof isBroadcasterForPlatform === 'function' && isBroadcasterForPlatform('velora') &&
          state.sendTarget === 'velora');
      if (veloraSendOk) {
        if (window.neonDesktop?.sendVeloraMessage) {
          const senderLogin = (state.velora.connectedUsername || state.auth?.user?.veloraUsername || (state.velora.isOwner ? state.velora.channelOwnerLogin || state.velora.channel : '') || state.auth?.user?.username || state.velora.channel || '').toLowerCase();
          const senderUserId = state.velora.connectedUserId || (state.velora.isOwner ? state.velora.channelOwnerId : '') || state.auth?.user?.id || '';
          const profileCache = (typeof veloraProfileCache !== 'undefined' && veloraProfileCache) ? veloraProfileCache : null;
          let senderProfile = profileCache?.get?.(senderLogin) || (senderUserId && profileCache?.get?.(String(senderUserId).toLowerCase())) || state.velora.profile || null;
          if (!senderProfile && (senderLogin === state.velora.channel.toLowerCase() || state.velora.isOwner)) {
            senderProfile = profileCache?.get?.(state.velora.channel.toLowerCase()) || state.velora.profile || null;
          }

          const optimisticId = `optimistic_velora_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const optimisticRaw = {
            id: optimisticId,
            messageId: optimisticId,
            optimistic: true,
            source: 'developer_app',
            channelId: state.velora.channelOwnerId,
            channel: state.velora.channel,
            userId: senderUserId,
            username: senderProfile?.username || senderLogin,
            displayName: senderProfile?.displayName || senderProfile?.username || senderLogin,
            authorLogin: senderLogin,
            authorName: senderProfile?.displayName || senderProfile?.username || senderLogin,
            content: message,
            message: message,
            createdAt: new Date().toISOString(),
            badges: [],
            userRoles: [],
            badgeDetails: senderProfile?.badges || senderProfile?.badgeDetails || [],
            subscriptionBadge: senderProfile?.subscriptionBadge || null,
            sender: {
              id: senderUserId,
              userId: senderUserId,
              username: senderProfile?.username || senderLogin,
              displayName: senderProfile?.displayName || senderProfile?.username || senderLogin,
              accentColor: senderProfile?.accentColor || '#FFFFFF',
              pronouns: senderProfile?.pronounsFull || senderProfile?.pronouns || senderProfile?.pronounsShort || '',
              pronounsShort: senderProfile?.pronounsShort || '',
              tag: senderProfile?.tag || senderProfile?.secondaryHandle || '',
              secondaryHandle: senderProfile?.secondaryHandle || senderProfile?.tag || '',
              isBroadcaster: typeof isVeloraBroadcaster === 'function'
                ? isVeloraBroadcaster({ username: senderLogin, authorLogin: senderLogin }, { username: senderLogin }, state.velora.channel)
                : Boolean(state.velora.isOwner),
              role: senderProfile?.role || (state.velora.isOwner ? 'broadcaster' : '')
            }
          };

          let optimisticStored = null;
          if (typeof addVeloraMessage === 'function') {
            optimisticStored = addVeloraMessage(optimisticRaw, state.velora.channel);
          }

          const sendPromise = window.neonDesktop.sendVeloraMessage({
            channel: state.velora.channel,
            channelId: state.velora.channelOwnerId,
            message
          });

          sendPromise.then((sentResult) => {
            const returnedId = sentResult?.id || sentResult?.messageId || sentResult?.data?.id || sentResult?.data?.messageId;
            if (returnedId && optimisticStored) {
              optimisticStored.providerId = String(returnedId);
              optimisticStored.optimistic = false;
              state.velora.seen?.add?.(String(returnedId));
            }
          }).catch((err) => {
            if (optimisticStored) {
              optimisticStored.dimmed = true;
              optimisticStored.text += ` (failed to send: ${err.message || 'error'})`;
              if (typeof scheduleMessageRender === 'function') scheduleMessageRender();
            }
          });

          await sendPromise;
        }
      }
    }
    if ((state.sendTarget === 'twitch' || state.sendTarget === 'all') && state.twitch?.connected && getComposerCapabilities('twitch').text) {
      await sendTwitchMessage(message);
    }
    input.value = '';
    $('#charCount').textContent = `0/${input.maxLength}`;
  } catch (error) {
    if (String(error?.message || '').includes('youtube_write_authorization_required')) {
      const authorizeUrl = error?.details?.authorize_url || state.youtube.writeAuthorizeUrl;
      if (authorizeUrl) window.neonDesktop.openExternal(authorizeUrl);
    }
    addMessage({ system: true, platform: state.sendTarget, text: `Message send failed: ${error?.message || 'unknown error'}` });
  } finally {
    updateComposerState();
    input.focus();
  }
}

$('#sendButton').addEventListener('click', sendComposerMessage);
$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendComposerMessage();
  }
});

window.addEventListener('click', (event) => {
  if (!event.target.closest('.send-target')) $('#targetMenu').classList.add('hidden');
  if (!event.target.closest('#emotePopover') && !event.target.closest('#emoteButton')) closeEmotePicker();
  if (!event.target.closest('#userContextMenu') && !event.target.closest('.moderation-menu')) closeUserContextMenu();
});
window.addEventListener('blur', closeUserContextMenu);
window.addEventListener('resize', closeUserContextMenu);
window.addEventListener('pagehide', () => {
  if (historySaveTimer) clearTimeout(historySaveTimer);
  saveChatHistory();
});

['paneCount', 'density', 'fontSize', 'accent', 'timestamps', 'badges', 'system', 'animations'].forEach((key) => {
  const input = $(`#${key}Setting`);
  input.addEventListener('input', () => {
    const map = {
      paneCount: Number($('#paneCountSetting').value),
      density: $('#densitySetting').value,
      fontSize: Number($('#fontSizeSetting').value),
      accent: $('#accentSetting').value,
      timestamps: $('#timestampsSetting').checked,
      badges: $('#badgesSetting').checked,
      systemMessages: $('#systemSetting').checked,
      animations: $('#animationsSetting').checked
    };
    const settingKey = key === 'system' ? 'systemMessages' : key;
    state.settings[settingKey] = map[settingKey];
    saveSettings();
    applySettings(key === 'paneCount');
  });
});

$('#resetSettingsButton').addEventListener('click', () => {
  state.settings = { ...DEFAULT_SETTINGS, paneViews: [...DEFAULT_SETTINGS.paneViews], tabOrder: [...DEFAULT_SETTINGS.tabOrder] };
  saveSettings();
  reorderTabs();
  applySettings(true);
});

let draggedTab = null;
$$('.tab').forEach((tab) => {
  tab.draggable = true;
  tab.addEventListener('dragstart', () => {
    draggedTab = tab;
    tab.classList.add('dragging');
  });
  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
    draggedTab = null;
    state.settings.tabOrder = $$('.tab').map((item) => item.dataset.view);
    saveSettings();
  });
  tab.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (draggedTab && draggedTab !== tab) {
      const box = tab.getBoundingClientRect();
      $('#tabs').insertBefore(draggedTab, event.clientX < box.left + box.width / 2 ? tab : tab.nextSibling);
    }
  });
});

window.neonDesktop?.getAppInfo().then((info) => {
  document.title = 'Neon MultiStream Chat';
  const version = document.getElementById('appVersion');
  if (version) version.textContent = `VERSION ${info.version}`;
});

const authStatus = IS_BROWSER_CLIENT ? getBrowserNeonLoginStatus() : window.neonDesktop.getNeonLoginStatus();
authStatus.then((auth) => {
  renderAuth(auth);
  if (!IS_BROWSER_CLIENT) scheduleDesktopNotices();
}).catch(() => renderAuth({ authenticated: false }));
window.neonDesktop?.onNeonLoginChanged(renderAuth);
window.neonDesktop?.onVeloraEvent(handleVeloraEvent);
window.neonDesktop?.onVeloraRedeem?.(handleVeloraRedeem);
window.neonDesktop?.onVeloraJoin?.(handleVeloraJoin);
window.neonDesktop?.onTwitchRedemption(handleTwitchRedemption);

updateCounts();
reorderTabs();
applySettings(true);
loadVeloraBadgeCatalog().catch(() => {});

// ---------------------------------------------------------------------------
// OBS Overlay Dialog & Live Controls
// ---------------------------------------------------------------------------

const overlayDialog = $('#overlayDialog');
const botManagementDialog = $('#botManagementDialog');
let currentOverlayUrl = 'http://127.0.0.1:39111/overlay';
let overlayBotConfig = { knownBots: [], enabledKnownBots: {}, customBots: [] };

function renderOverlayBotManagement() {
  const knownList = $('#overlayKnownBotList');
  const customList = $('#overlayCustomBotList');
  if (!knownList || !customList) return;
  knownList.replaceChildren();
  customList.replaceChildren();
  const knownBots = Array.isArray(overlayBotConfig.knownBots) ? overlayBotConfig.knownBots : [];
  if (!knownBots.length) knownList.textContent = 'No known bots configured.';
  knownBots.forEach((bot) => {
    const key = bot.key || `${bot.platform}:${bot.platformUserId || bot.login}`;
    const row = document.createElement('label');
    row.className = 'bot-management-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = overlayBotConfig.enabledKnownBots[key] !== false;
    input.addEventListener('change', () => {
      overlayBotConfig.enabledKnownBots[key] = input.checked;
      saveOverlayDialogSettings();
    });
    const name = document.createElement('span');
    name.className = 'bot-name';
    name.textContent = bot.displayName || bot.login || key;
    const platform = document.createElement('small');
    platform.textContent = String(bot.platform || '').toUpperCase();
    row.append(input, name, platform);
    knownList.appendChild(row);
  });
  const customBots = Array.isArray(overlayBotConfig.customBots) ? overlayBotConfig.customBots : [];
  if (!customBots.length) customList.textContent = 'No custom bots added.';
  customBots.forEach((bot, index) => {
    const row = document.createElement('div');
    row.className = 'bot-management-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = bot.enabled !== false;
    input.addEventListener('change', () => {
      overlayBotConfig.customBots[index].enabled = input.checked;
      saveOverlayDialogSettings();
    });
    const name = document.createElement('span');
    name.className = 'bot-name';
    name.textContent = bot.displayName || bot.login || bot.platformUserId || 'Custom bot';
    const platform = document.createElement('small');
    platform.textContent = String(bot.platform || '').toUpperCase();
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'bot-remove-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      overlayBotConfig.customBots.splice(index, 1);
      renderOverlayBotManagement();
      saveOverlayDialogSettings();
    });
    row.append(input, name, platform, remove);
    customList.appendChild(row);
  });
}

function loadOverlayDialogSettings() {
  if (!window.neonDesktop?.getOverlaySettings) return;

  window.neonDesktop.getOverlayInfo?.().then((info) => {
    if (info?.url) {
      currentOverlayUrl = info.url;
      const display = $('#obsUrlDisplay');
      if (display) display.textContent = info.url;
    }
  }).catch(() => {});

  window.neonDesktop.getOverlaySettings().then((settings) => {
    if (!settings) return;
    if ($('#overlayThemeSetting')) $('#overlayThemeSetting').value = settings.theme || 'glass';
    if ($('#overlayFadeSetting')) $('#overlayFadeSetting').value = String(settings.fadeSeconds ?? 20);
    if ($('#overlayFontSizeSetting')) {
      $('#overlayFontSizeSetting').value = String(settings.fontSize || 18);
      if ($('#overlayFontSizeOutput')) $('#overlayFontSizeOutput').textContent = `${settings.fontSize || 18}px`;
    }
    if ($('#overlayMaxMsgSetting')) $('#overlayMaxMsgSetting').value = String(settings.maxMessages || 8);
    if ($('#overlayDirectionSetting')) $('#overlayDirectionSetting').value = settings.direction || 'bottom-up';
    if ($('#overlayColumnWidthSetting')) $('#overlayColumnWidthSetting').value = String(settings.columnWidth || 380);
    if ($('#overlayPositionSetting')) $('#overlayPositionSetting').value = settings.position || 'left';

    if ($('#overlayShowBadgesSetting')) $('#overlayShowBadgesSetting').checked = settings.showBadges !== false;
    if ($('#overlayShowPlatformIconsSetting')) $('#overlayShowPlatformIconsSetting').checked = settings.showPlatformIcons !== false;
    if ($('#overlayShowPronounsSetting')) $('#overlayShowPronounsSetting').checked = settings.showPronouns !== false;
    if ($('#overlayShowTimestampsSetting')) $('#overlayShowTimestampsSetting').checked = Boolean(settings.showTimestamps);
    if ($('#overlayHideBotMessagesSetting')) $('#overlayHideBotMessagesSetting').checked = Boolean(settings.hideBotMessages);
    if ($('#overlayAlwaysOnTopSetting')) $('#overlayAlwaysOnTopSetting').checked = settings.alwaysOnTop !== false;

    overlayBotConfig = {
      knownBots: Array.isArray(settings.knownBots) ? settings.knownBots : [],
      enabledKnownBots: { ...(settings.enabledKnownBots || {}) },
      customBots: Array.isArray(settings.customBots) ? settings.customBots.map((bot) => ({ ...bot })) : []
    };
    renderOverlayBotManagement();

    const platforms = settings.platforms || {};
    if ($('#overlayPlatformTwitch')) $('#overlayPlatformTwitch').checked = platforms.twitch !== false;
    if ($('#overlayPlatformYouTube')) $('#overlayPlatformYouTube').checked = platforms.youtube !== false;
    if ($('#overlayPlatformKick')) $('#overlayPlatformKick').checked = platforms.kick !== false;
    if ($('#overlayPlatformVelora')) $('#overlayPlatformVelora').checked = platforms.velora !== false;
  }).catch(() => {});
}

function saveOverlayDialogSettings() {
  if (!window.neonDesktop?.saveOverlaySettings) return;
  const newSettings = {
    theme: $('#overlayThemeSetting')?.value || 'glass',
    fadeSeconds: Number($('#overlayFadeSetting')?.value || 0),
    fontSize: Number($('#overlayFontSizeSetting')?.value || 18),
    maxMessages: Number($('#overlayMaxMsgSetting')?.value || 8),
    direction: $('#overlayDirectionSetting')?.value || 'bottom-up',
    position: $('#overlayPositionSetting')?.value || 'left',
    columnWidth: Math.min(600, Math.max(240, Number($('#overlayColumnWidthSetting')?.value) || 380)),
    showBadges: Boolean($('#overlayShowBadgesSetting')?.checked),
    showPlatformIcons: Boolean($('#overlayShowPlatformIconsSetting')?.checked),
    showPronouns: Boolean($('#overlayShowPronounsSetting')?.checked),
    showTimestamps: Boolean($('#overlayShowTimestampsSetting')?.checked),
    hideBotMessages: Boolean($('#overlayHideBotMessagesSetting')?.checked),
    knownBots: overlayBotConfig.knownBots,
    enabledKnownBots: overlayBotConfig.enabledKnownBots,
    customBots: overlayBotConfig.customBots,
    alwaysOnTop: Boolean($('#overlayAlwaysOnTopSetting')?.checked),
    platforms: {
      twitch: Boolean($('#overlayPlatformTwitch')?.checked),
      youtube: Boolean($('#overlayPlatformYouTube')?.checked),
      kick: Boolean($('#overlayPlatformKick')?.checked),
      velora: Boolean($('#overlayPlatformVelora')?.checked)
    }
  };
  window.neonDesktop.saveOverlaySettings(newSettings);
}

$('#obsOverlayButton')?.addEventListener('click', () => {
  loadOverlayDialogSettings();
  overlayDialog?.showModal();
});

$('#copyOverlayUrlBtn')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentOverlayUrl);
    const btn = $('#copyOverlayUrlBtn');
    const orig = btn.textContent;
    btn.textContent = '✓ URL Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2200);
  } catch {
    prompt('Copy OBS Browser Source URL:', currentOverlayUrl);
  }
});

$('#popoutOverlayBtn')?.addEventListener('click', () => {
  window.neonDesktop?.openOverlayPopout?.();
});

$('#sendOverlayTestBtn')?.addEventListener('click', () => {
  window.neonDesktop?.sendOverlayTest?.();
});

$('#manageOverlayBotsBtn')?.addEventListener('click', () => {
  renderOverlayBotManagement();
  botManagementDialog?.showModal();
});

$('#addOverlayCustomBotBtn')?.addEventListener('click', () => {
  const platform = $('#overlayCustomBotPlatform')?.value || 'twitch';
  const raw = String($('#overlayCustomBotUsername')?.value || '').trim().replace(/^@/, '');
  if (!raw) return;
  const isId = /^[A-Za-z0-9_-]{2,128}$/.test(raw) && /^\d+$/.test(raw);
  const login = isId ? '' : raw.toLowerCase();
  const duplicate = overlayBotConfig.customBots.some((bot) => String(bot.platform).toLowerCase() === platform && ((login && String(bot.login || '').toLowerCase() === login) || (isId && String(bot.platformUserId || '') === raw)));
  if (!duplicate) {
    overlayBotConfig.customBots.push({ platform, platformUserId: isId ? raw : '', login, displayName: raw, source: 'streamer-custom', enabled: true });
    $('#overlayCustomBotUsername').value = '';
    renderOverlayBotManagement();
    saveOverlayDialogSettings();
  }
});

$('#overlayFontSizeSetting')?.addEventListener('input', (event) => {
  if ($('#overlayFontSizeOutput')) $('#overlayFontSizeOutput').textContent = `${event.target.value}px`;
  saveOverlayDialogSettings();
});

[
  '#overlayThemeSetting',
  '#overlayFadeSetting',
  '#overlayMaxMsgSetting',
  '#overlayDirectionSetting',
  '#overlayPositionSetting',
  '#overlayColumnWidthSetting',
  '#overlayShowBadgesSetting',
  '#overlayShowPlatformIconsSetting',
  '#overlayShowPronounsSetting',
  '#overlayShowTimestampsSetting',
  '#overlayHideBotMessagesSetting',
  '#overlayAlwaysOnTopSetting',
  '#overlayPlatformTwitch',
  '#overlayPlatformYouTube',
  '#overlayPlatformKick',
  '#overlayPlatformVelora'
].forEach((selector) => {
  $(selector)?.addEventListener('change', saveOverlayDialogSettings);
});

$('#resetOverlaySettingsBtn')?.addEventListener('click', () => {
  const defaultOverlay = {
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
    knownBots: overlayBotConfig.knownBots,
    enabledKnownBots: {},
    customBots: [],
    alwaysOnTop: true,
    platforms: { twitch: true, youtube: true, kick: true, velora: true }
  };
  window.neonDesktop?.saveOverlaySettings?.(defaultOverlay);
  loadOverlayDialogSettings();
});
