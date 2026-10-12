const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');

// Set as early as possible — before any other app calls — so Windows taskbar,
// shortcuts, and notifications bind to this identity instead of Electron's.
app.setAppUserModelId('tv.teammidnite.neonmultistream');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { io } = require('socket.io-client');

let mainWindow;
let callbackServer;
let pendingAuthState = '';
let veloraSocket = null;
let veloraChannel = '';
let veloraChannelId = '';
let veloraCredentials = null;
const veloraMonitoredSockets = new Map();
const veloraSeenIds = new Set();
const { TwitchRedemptions } = require('./twitch-redemptions.cjs');
const twitchRedemptions = new TwitchRedemptions({
  WebSocket, broker: twitchRedemptionBroker,
  emit: (payload) => mainWindow?.webContents.send('twitch:redemption', payload)
});
let youtubeGenericEmotesPromise = null;
const twitchComposerEmoteCache = new Map();
let pronounCatalogPromise = null;
const pronounCache = new Map();

const NEONLOGIN_BASE = 'https://teammidnite.tv/NeonLogin';
const UPDATE_MANIFEST_URL = 'https://teammidnite.tv/NeonMulti/version.json';
const linkPreviewCache = new Map();

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function metadataValue(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtmlEntities(match[1]).trim();
  }
  return '';
}

function isPublicPreviewUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host === '::1') return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    return !private172 || Number(private172[1]) < 16 || Number(private172[1]) > 31;
  } catch {
    return false;
  }
}

async function getLinkPreview(rawUrl) {
  if (!isPublicPreviewUrl(rawUrl)) return null;
  const requestedUrl = new URL(rawUrl).href;
  if (linkPreviewCache.has(requestedUrl)) return linkPreviewCache.get(requestedUrl);
  const pending = (async () => {
    const response = await fetch(requestedUrl, {
      redirect: 'follow', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'NeonMultiStreamChat/1.3' }
    });
    if (!response.ok || !isPublicPreviewUrl(response.url)) return null;
    if (!String(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) return null;
    if (Number(response.headers.get('content-length') || 0) > 2_000_000) return null;
    const html = (await response.text()).slice(0, 1_000_000);
    const title = metadataValue(html, 'og:title') || metadataValue(html, 'twitter:title') ||
      decodeHtmlEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
    if (!title) return null;
    const description = metadataValue(html, 'og:description') || metadataValue(html, 'twitter:description') || metadataValue(html, 'description');
    const imageValue = metadataValue(html, 'og:image') || metadataValue(html, 'twitter:image');
    const finalUrl = response.url;
    let image = '';
    try { image = imageValue ? new URL(imageValue, finalUrl).href : ''; } catch { image = ''; }
    if (image && !isPublicPreviewUrl(image)) image = '';
    return {
      url: finalUrl, title: title.slice(0, 240), description: description.slice(0, 500), image,
      siteName: (metadataValue(html, 'og:site_name') || new URL(finalUrl).hostname.replace(/^www\./, '')).slice(0, 100)
    };
  })().catch(() => null);
  linkPreviewCache.set(requestedUrl, pending);
  return pending;
}

function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number(part) || 0);
  const b = String(right).split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

async function checkForUpdates(manual = false) {
  try {
    const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) {
      if (manual) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Update check failed',
          message: 'Unable to connect to the update server.',
          buttons: ['OK']
        });
      }
      return { success: false, reason: 'server_error' };
    }
    const release = await response.json();
    const currentVersion = app.getVersion();
    const hasUpdate = compareVersions(release.version, currentVersion) > 0;

    if (!hasUpdate) {
      if (manual) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Neon Multistream is up to date',
          message: `You are on the latest version (v${currentVersion}).`,
          buttons: ['OK']
        });
      }
      return { success: true, hasUpdate: false, version: currentVersion };
    }

    const downloadUrl = String(release.download_url || 'https://teammidnite.tv/NeonMulti/download.php');
    const twitchAuthNote = compareVersions(release.version, '1.3.99') >= 0
      ? '\n\nTwitch GIF setup: after updating, open the Auth Page at https://teammidnite.tv/NeonLogin/account.php, unauthorize Twitch, then re-authorize it if available so NeonLogin can request the chat permission required for GIFs.'
      : '';
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Neon Multistream update available',
      message: `Version ${release.version} is available`,
      detail: `You are using version ${currentVersion}. Download the latest version now?${twitchAuthNote}`,
      buttons: ['Download update', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (result.response === 0) shell.openExternal(downloadUrl);
    return { success: true, hasUpdate: true, version: release.version, downloadUrl };
  } catch (err) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Update check failed',
        message: err.message || 'An error occurred checking for updates.',
        buttons: ['OK']
      });
    }
    return { success: false, reason: err.message };
  }
}

function authFilePath() {
  return path.join(app.getPath('userData'), 'neonlogin-session.json');
}

function saveAuth(auth) {
  if (!auth) return;
  try {
    const serialized = JSON.stringify(auth);
    fs.writeFileSync(authFilePath(), serialized, { mode: 0o600 });
  } catch (error) {
    console.error('Failed to save auth:', error);
  }
}

function loadAuth() {
  try {
    const filePath = authFilePath();
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.encrypted && parsed.value) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(parsed.value, 'base64'));
        return JSON.parse(decrypted);
      } catch {
        return null;
      }
    }
    return parsed;
  } catch (error) {
    console.error('Failed to load auth:', error);
    return null;
  }
}

function clearAuth() {
  try {
    fs.unlinkSync(authFilePath());
  } catch {
    // Already signed out.
  }
}

async function postForm(url, values) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(values).toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `NeonLogin returned HTTP ${response.status}`);
  }
  return payload;
}

// YouTube chat integration for Neon Multistream.
const YOUTUBE_CHAT_ENABLED = true;

async function youtubeBrokerRequest(action, options = {}) {
  if (!YOUTUBE_CHAT_ENABLED) {
    const error = new Error('YouTube chat is temporarily disabled.');
    error.code = 'youtube_disabled';
    throw error;
  }
  let auth = loadAuth();
  const params = new URLSearchParams({ action });
  if (options.liveChatId) params.set('live_chat_id', options.liveChatId);
  if (options.pageToken) params.set('page_token', options.pageToken);
  const requestOptions = {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json'
    }
  };
  if (auth?.sessionToken) {
    requestOptions.headers.Authorization = `Bearer ${auth.sessionToken}`;
  }
  if (options.body) {
    requestOptions.headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(options.body);
  }
  let response = await fetch(`https://teammidnite.tv/api/multistream-youtube.php?${params}`, requestOptions);
  if (response.status === 401 && auth.refreshToken) {
    auth = await refreshAuth(auth);
    if (auth) {
      requestOptions.headers.Authorization = `Bearer ${auth.sessionToken}`;
      response = await fetch(`https://teammidnite.tv/api/multistream-youtube.php?${params}`, requestOptions);
    }
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.error || `YouTube broker returned HTTP ${response.status}`);
    error.details = payload;
    throw error;
  }
  return payload;
}



async function getVeloraMessages(options = {}) {
  const channel = String(options.channel || '').trim().replace(/^@/, '');
  const channelId = String(options.channelId || '').trim();
  if (channelId) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(channelId)) {
      throw new Error('Enter a valid Velora channel.');
    }
  } else if (!/^[A-Za-z0-9_.-]{1,64}$/.test(channel)) {
    throw new Error('Enter a valid Velora channel name.');
  }
  // Velora only serves chat history for the resolved channel UUID, not the
  // display username, so prefer the UUID when the caller has resolved it.
  const slug = channelId || channel;
  const url = new URL(`https://api.velora.tv/api/chat/channels/${encodeURIComponent(slug)}/history`);
  url.searchParams.set('limit', '100');
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `Velora chat returned HTTP ${response.status}`);
  }
  return {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    total: Number(payload.total || 0)
  };
}

async function getVeloraBadgeCatalog() {
  try {
    const response = await fetch('https://api.velora.tv/api/badges/catalog', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });
    if (!response.ok) return { badges: [] };
    return await response.json();
  } catch {
    return { badges: [] };
  }
}

async function getVeloraProfile(channelValue = '') {
  const channel = String(channelValue || '').trim().replace(/^@/, '');
  if (!/^[a-z0-9_.-]{1,64}$/i.test(channel)) throw new Error('Enter a valid Velora username.');
  const response = await fetch(`https://api.velora.tv/api/users/${encodeURIComponent(channel)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  const profile = await response.json().catch(() => ({}));
  if (!response.ok || !profile?.id) throw new Error(profile.message || `Velora user @${channel} was not found.`);
  return profile;
}

// 7TV Emote Cache & Resolver for Velora & Multistream
const sevenTvEmoteCache = new Map(); // lowercase name -> emote object
const sevenTvNegativeCache = new Map(); // lowercase name -> timestamp
let sevenTvGlobalEmotesPromise = null;

function parse7TvEmote(emote) {
  const name = emote?.name || emote?.code;
  const host = emote?.data?.host || emote?.host;
  if (!name || !host?.url) return null;
  const file = host.files?.find((item) => item.name === '2x.webp') ||
    host.files?.find((item) => item.format === 'WEBP') || host.files?.[0];
  if (!file?.name) return null;
  const baseUrl = host.url.startsWith('//') ? `https:${host.url}` : host.url;
  const flags = Number(emote.data?.flags ?? emote.flags ?? 0);
  return {
    name,
    code: name,
    url: `${baseUrl}/${file.name}`,
    provider: '7TV',
    isZeroWidth: Boolean(flags & 1)
  };
}

const APPROVED_7TV_COMMUNITY_EMOTES = [
  'lethimcook', 'booba', 'letsgo', 'popcat', 'awkward', 'crunch',
  'peeposhy', 'aintnoway', 'petthemods', 'omegalul', 'nodders',
  'kekw', 'pog', 'pogu', 'monkas', 'monkaw', 'lulw', 'catjam', 'pepejam',
  'clueless', 'gigachad', 'copium', 'sadge', 'widepeepohappy', 'widepeeposad',
  'feelsgoodman', 'feelsbadman', '5head', 'ez', 'pausechamp', 'waitwhat',
  'prayge', 'bedge', 'wicked', 'pepelaugh', 'modcheck', 'hyperclap',
  'peped', 'ddcat', 'raintime', 'yep', 'nope', 'peepohappy', 'peeposad',
  'pepega', 'poggers', 'monkahmm', 'pepehands', 'susge', 'despair',
  'corpa', 'aware', 'giga', 'vibe', 'sigma'
];

async function getSevenTvGlobalEmotes() {
  if (!sevenTvGlobalEmotesPromise) {
    sevenTvGlobalEmotesPromise = (async () => {
      const list = [];
      try {
        const data = await fetchJson('https://7tv.io/v3/emote-sets/global', {});
        for (const e of data?.emotes || []) {
          const parsed = parse7TvEmote(e);
          if (parsed) {
            list.push(parsed);
            sevenTvEmoteCache.set(parsed.name.toLowerCase(), parsed);
          }
        }
      } catch {}

      try {
        const approved = await resolveSevenTvEmotes(APPROVED_7TV_COMMUNITY_EMOTES);
        for (const em of approved || []) {
          if (!list.some((existing) => existing.name.toLowerCase() === em.name.toLowerCase())) {
            list.push(em);
          }
        }
      } catch {}

      return list;
    })();
  }
  return sevenTvGlobalEmotesPromise;
}

async function resolveSevenTvEmotes(rawNames = []) {
  const list = Array.isArray(rawNames) ? rawNames : [rawNames];
  const resolved = [];
  const toFetch = [];
  const now = Date.now();

  for (const raw of list) {
    const clean = String(raw || '').replace(/^:+|:+$/g, '').trim();
    if (!clean || clean.length < 2 || clean.length > 50) continue;
    const key = clean.toLowerCase();

    const cached = sevenTvEmoteCache.get(key);
    if (cached) {
      resolved.push(cached);
      continue;
    }

    const negTime = sevenTvNegativeCache.get(key);
    if (negTime && (now - negTime < 300000)) continue;

    if (/^\d+$/.test(clean) || /^https?:\/\//i.test(clean)) continue;
    if (!toFetch.includes(clean)) toFetch.push(clean);
  }

  if (!toFetch.length) return resolved;

  // Batch query 7TV GQL in chunks of up to 10
  for (let i = 0; i < toFetch.length; i += 10) {
    const chunk = toFetch.slice(i, i + 10);
    try {
      const subqueries = chunk.map((name, idx) => {
        const safeName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `e${idx}: emotes(query: "${safeName}", filter: { exact_match: true }, limit: 1) { items { id name flags host { url files { name format } } } }`;
      }).join('\n');

      const response = await fetch('https://7tv.io/v3/gql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Neon-Multistream' },
        body: JSON.stringify({ query: `query {\n${subqueries}\n}` }),
        signal: AbortSignal.timeout(6000)
      });

      if (response.ok) {
        const json = await response.json().catch(() => ({}));
        chunk.forEach((name, idx) => {
          const items = json?.data?.[`e${idx}`]?.items || [];
          const match = items.find((it) => it.name.toLowerCase() === name.toLowerCase()) || items[0];
          if (match) {
            const parsed = parse7TvEmote(match);
            if (parsed) {
              sevenTvEmoteCache.set(name.toLowerCase(), parsed);
              sevenTvEmoteCache.set(parsed.name.toLowerCase(), parsed);
              resolved.push(parsed);
              return;
            }
          }
          sevenTvNegativeCache.set(name.toLowerCase(), Date.now());
        });
      }
    } catch (err) {
      // Upstream lookup timeout is non-fatal
    }
  }

  return resolved;
}

async function getVeloraEmotes(channelValue = '') {
  const channel = String(channelValue || '').trim().replace(/^@/, '');
  if (!/^[a-z0-9_.-]{1,64}$/i.test(channel)) return { emotes: [] };

  const emotes = new Map();
  const add = (name, url, provider = 'Velora', isZeroWidth = false, tier = null) => {
    if (name && url && !emotes.has(name)) {
      emotes.set(name, {
        name,
        code: name,
        url,
        provider,
        animated: Boolean(url.includes('.gif') || url.includes('/animated') || url.includes('.webp')),
        isZeroWidth: Boolean(isZeroWidth),
        tier
      });
    }
  };

  // 1. Fetch native Velora emotes
  const veloraPromise = fetch(`https://api.velora.tv/api/emotes?channel=${encodeURIComponent(channel)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Neon-Multistream' },
    signal: AbortSignal.timeout(8000)
  }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

  // 2. Fetch 7TV Global Emotes
  const sevenGlobalPromise = getSevenTvGlobalEmotes().catch(() => []);

  // 3. Fetch Velora community 7TV set (01KF6FKR7APVXQ0CFJ5M1JHWB8)
  const velora7TvSetPromise = fetchJson('https://7tv.io/v3/emote-sets/01KF6FKR7APVXQ0CFJ5M1JHWB8', {}).catch(() => ({}));

  // 4. Check for channel-specific 7TV emotes (via Twitch room ID or 7TV GQL user search)
  const channelTwitchIdPromise = fetchJson(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(channel)}`)
    .then((ffz) => String(ffz.room?.twitch_id || ''))
    .catch(() => '');

  const [veloraPayload, sevenGlobal, velora7TvSet, twitchId] = await Promise.all([
    veloraPromise,
    sevenGlobalPromise,
    velora7TvSetPromise,
    channelTwitchIdPromise
  ]);

  // 7TV Global Emotes
  for (const emote of sevenGlobal || []) {
    add(emote.name, emote.url, '7TV', emote.isZeroWidth);
  }

  // Velora community 7TV set
  for (const emote of velora7TvSet?.emotes || []) {
    const parsed = parse7TvEmote(emote);
    if (parsed) {
      add(parsed.name, parsed.url, '7TV', parsed.isZeroWidth);
      sevenTvEmoteCache.set(parsed.name.toLowerCase(), parsed);
    }
  }

  // Twitch 7TV Channel Emotes if linked
  if (twitchId) {
    try {
      const sevenUser = await fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`, {});
      for (const emote of sevenUser?.emote_set?.emotes || []) {
        const parsed = parse7TvEmote(emote);
        if (parsed) {
          add(parsed.name, parsed.url, '7TV', parsed.isZeroWidth);
          sevenTvEmoteCache.set(parsed.name.toLowerCase(), parsed);
        }
      }
    } catch { }
  } else {
    // Try 7TV user search for channel name or teh<channel>
    try {
      const searchRes = await fetch('https://7tv.io/v3/gql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Neon-Multistream' },
        body: JSON.stringify({
          query: `query { users(query: "${channel.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}") { username emote_sets { emotes { id name flags host { url files { name format } } } } } }`
        }),
        signal: AbortSignal.timeout(6000)
      });
      if (searchRes.ok) {
        const data = await searchRes.json().catch(() => ({}));
        const chLower = channel.toLowerCase();
        for (const u of data?.data?.users || []) {
          const uLower = (u.username || '').toLowerCase();
          if (uLower === chLower || uLower === `teh${chLower}` || chLower === `teh${uLower}`) {
            for (const set of u.emote_sets || []) {
              for (const emote of set.emotes || []) {
                const parsed = parse7TvEmote(emote);
                if (parsed) {
                  add(parsed.name, parsed.url, '7TV', parsed.isZeroWidth);
                  sevenTvEmoteCache.set(parsed.name.toLowerCase(), parsed);
                }
              }
            }
          }
        }
      }
    } catch { }
  }

  // Native Velora Emotes
  for (const collection of veloraPayload?.collections || []) {
    for (const emote of collection?.emotes || []) {
      const variants = emote.assetVariants || {};
      const url = variants.animated2x || variants.static2x || variants.animated1x || variants.static1x
        || variants.animated4x || variants.static4x || emote.url || '';
      const code = String(emote.code || emote.name || '').trim();
      const cleanCode = code.replace(/^:+|:+$/g, '');
      if (cleanCode && url) {
        add(cleanCode, url, 'Velora', false, emote.requiredTier ?? null);
      }
    }
  }

  return { emotes: [...emotes.values()] };
}

function disconnectVelora() {
  if (veloraSocket) {
    veloraSocket.removeAllListeners();
    try { veloraSocket.disconnect(); } catch { }
    veloraSocket = null;
  }
  veloraChannel = '';
  veloraChannelId = '';
  veloraSeenIds.clear();
}

function stopAllVeloraMonitors() {
  for (const entry of veloraMonitoredSockets.values()) {
    try { entry.socket.disconnect(); } catch { }
  }
  veloraMonitoredSockets.clear();
}

async function monitorVeloraChannel(channelValue) {
  const channel = String(channelValue || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/.test(channel)) throw new Error('Enter a valid Velora channel name.');
  if (channel === veloraChannel || veloraMonitoredSockets.has(channel)) return { connected: true, channel };

  const [profileResponse, emoteCatalog] = await Promise.all([
    fetch(`https://api.velora.tv/api/users/${encodeURIComponent(channel)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000)
    }),
    getVeloraEmotes(channel).catch(() => ({ emotes: [] }))
  ]);
  const profile = await profileResponse.json().catch(() => ({}));
  const channelId = String(profile.id || '');
  if (!profileResponse.ok || !channelId) {
    throw new Error(profile.message || `Velora channel @${channel} was not found.`);
  }

  const socket = io('https://api.velora.tv/chat', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    timeout: 10000
  });
  veloraMonitoredSockets.set(channel, { socket, channelId });
  socket.on('connect', () => {
    socket.emit('joinChannel', { channelId }, (ack = {}) => {
      if (!ack?.success) {
        mainWindow?.webContents.send('velora:event', {
          type: 'monitor_error', monitorChannel: channel,
          message: ack?.error || `Velora channel #${channel} could not be joined.`
        });
        return;
      }
      mainWindow?.webContents.send('velora:event', {
        type: 'monitor_connected', monitorChannel: channel, channelId: ack.channelId || channelId,
        channelOwnerId: channelId, channelOwnerLogin: channel,
        channelProfile: profile, emotes: emoteCatalog.emotes || []
      });
    });
  });
  socket.onAny((eventName, ...args) => {
    const normalized = args.length <= 1 ? args[0] : args;
    mainWindow?.webContents.send('velora:event', {
      type: 'provider_event', event: eventName, payload: normalized, monitorChannel: channel
    });
  });
  socket.on('disconnect', (reason) => {
    if (veloraMonitoredSockets.get(channel)?.socket !== socket) return;
    mainWindow?.webContents.send('velora:event', {
      type: 'monitor_disconnected', monitorChannel: channel, message: reason || ''
    });
  });
  socket.on('connect_error', (error) => {
    mainWindow?.webContents.send('velora:event', {
      type: 'monitor_error', monitorChannel: channel,
      message: error.message || 'Velora monitor connection failed.'
    });
  });
  return { connected: true, channel, channelId, channelOwnerId: channelId, channelOwnerLogin: channel };
}

function stopMonitoringVelora(channelValue) {
  const channel = String(channelValue || '').trim().replace(/^@/, '').toLowerCase();
  const entry = veloraMonitoredSockets.get(channel);
  if (!entry) return { connected: false, channel };
  veloraMonitoredSockets.delete(channel);
  try { entry.socket.disconnect(); } catch { }
  return { connected: false, channel };
}

async function getVeloraCredentials(targetChannel = veloraChannel) {
  let auth = loadAuth();
  const headers = { Accept: 'application/json' };
  if (auth?.sessionToken) {
    headers.Authorization = `Bearer ${auth.sessionToken}`;
  }
  const cleanTarget = String(targetChannel || veloraChannel || '').trim().toLowerCase().replace(/^@/, '');
  const url = cleanTarget
    ? `https://teammidnite.tv/api/multistream-velora.php?channel=${encodeURIComponent(cleanTarget)}`
    : 'https://teammidnite.tv/api/multistream-velora.php';
  let response = await fetch(url, { headers }).catch(() => null);
  if (response?.status === 401 && auth?.refreshToken) {
    auth = await refreshAuth(auth);
    if (auth?.sessionToken) {
      headers.Authorization = `Bearer ${auth.sessionToken}`;
      response = await fetch(url, { headers }).catch(() => null);
    }
  }
  if (!response || !response.ok) return null;
  const payload = await response.json().catch(() => null);
  if (payload?.success) {
    veloraCredentials = payload;
    return payload;
  }
  return null;
}

async function connectVelora(channelValue) {
  const channel = String(channelValue || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/.test(channel)) throw new Error('Enter a valid Velora channel name.');
  const [profileResponse, emoteCatalog, creds] = await Promise.all([
    fetch(`https://api.velora.tv/api/users/${encodeURIComponent(channel)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    }),
    getVeloraEmotes(channel).catch(() => ({ emotes: [] })),
    getVeloraCredentials(channel).catch(() => null)
  ]);
  const profile = await profileResponse.json().catch(() => ({}));
  const channelId = String(profile.id || '');
  if (!profileResponse.ok || !channelId) {
    throw new Error(profile.message || `Velora channel @${channel} was not found.`);
  }
  const channelOwnerId = String(profile.id || profile.userId || channelId || '');
  const channelOwnerLogin = channel.toLowerCase();
  const isOwner = Boolean(creds && (
    (creds.velora_user_id && creds.velora_user_id === channelOwnerId) ||
    (creds.channel && creds.channel.toLowerCase() === channelOwnerLogin) ||
    (creds.username && creds.username.toLowerCase() === channelOwnerLogin)
  ));
  const canWrite = Boolean(creds?.access_token && (creds?.can_write ?? true));
  const canModerate = Boolean(creds?.access_token && (creds?.can_moderate || isOwner));

  let userProfile = profileResponse.ok ? profile : null;
  if (creds?.username && creds.username.toLowerCase() !== channelOwnerLogin) {
    try {
      const uRes = await fetch(`https://api.velora.tv/api/users/${encodeURIComponent(creds.username)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000)
      });
      if (uRes.ok) {
        userProfile = await uRes.json().catch(() => profile);
      }
    } catch {}
  }

  if (veloraSocket?.connected && veloraChannel === channel) {
    const result = {
      connected: true,
      channel,
      channelId: veloraChannelId || channelId,
      channelOwnerId,
      channelOwnerLogin,
      connectedUsername: creds?.username || (isOwner ? channelOwnerLogin : ''),
      connectedUserId: creds?.velora_user_id || (isOwner ? channelOwnerId : ''),
      read_only: !canWrite,
      can_write: canWrite,
      can_moderate: canModerate,
      is_owner: isOwner,
      profile: userProfile,
      channelProfile: profileResponse.ok ? profile : null,
      emotes: emoteCatalog.emotes || []
    };
    mainWindow?.webContents.send('velora:event', { type: 'connected', ...result });
    return result;
  }
  disconnectVelora();
  veloraChannel = channel;
  veloraChannelId = channelId;

  const socket = io('https://api.velora.tv/chat', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    timeout: 10000
  });
  veloraSocket = socket;
  let initialSettled = false;
  let resolveInitial;
  let rejectInitial;
  const initialConnection = new Promise((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  const initialTimeout = setTimeout(() => {
    if (initialSettled) return;
    initialSettled = true;
    rejectInitial(new Error('Velora did not confirm the chat connection within 12 seconds.'));
  }, 12000);
  socket.on('connect', () => {
    socket.emit('joinChannel', { channelId }, (ack = {}) => {
      if (!ack || !ack.success) {
        const message = ack?.error || 'Velora channel was not found.';
        mainWindow?.webContents.send('velora:event', { type: 'error', message });
        if (!initialSettled) {
          initialSettled = true;
          clearTimeout(initialTimeout);
          rejectInitial(new Error(message));
        }
        return;
      }
      const result = {
        connected: true,
        channel,
        channelId: ack.channelId || channelId,
        channelOwnerId,
        channelOwnerLogin,
        connectedUsername: creds?.username || (isOwner ? channelOwnerLogin : ''),
        connectedUserId: creds?.velora_user_id || (isOwner ? channelOwnerId : ''),
        read_only: !canWrite,
        can_write: canWrite,
        can_moderate: canModerate,
        is_owner: isOwner,
        profile: userProfile,
        channelProfile: profileResponse.ok ? profile : null,
        emotes: emoteCatalog.emotes || []
      };
      mainWindow?.webContents.send('velora:event', { type: 'connected', ...result });
      if (!initialSettled) {
        initialSettled = true;
        clearTimeout(initialTimeout);
        resolveInitial(result);
      }
    });
  });
  socket.onAny((eventName, ...args) => {
    const normalized = args.length <= 1 ? args[0] : args;
    mainWindow?.webContents.send('velora:event', {
      type: 'provider_event', event: eventName, payload: normalized
    });
    if (eventName === 'join' && normalized && typeof normalized === 'object') {
      mainWindow?.webContents.send('velora:join', { type: 'join', event: normalized });
    }
    if (eventName === 'chatCleared') {
      mainWindow?.webContents.send('velora:event', { type: 'chat_cleared', channel: veloraChannel });
    }
  });
  socket.on('disconnect', (reason) => {
    mainWindow?.webContents.send('velora:event', { type: 'disconnected', message: reason || '' });
  });
  socket.on('connect_error', (error) => {
    const message = error.message || 'Velora chat connection failed.';
    mainWindow?.webContents.send('velora:event', { type: 'error', message });
  });
  return initialConnection;
}

async function sendVeloraMessage(options) {
  const message = typeof options === 'string' ? options : options?.message;
  const channel = options?.channel || veloraChannel;
  const channelId = options?.channelId || veloraChannelId;
  if (!message || !message.trim()) return { success: false, error: 'Message cannot be empty' };

  let creds = veloraCredentials;
  if (!creds?.access_token) {
    creds = await getVeloraCredentials(channel);
  }
  if (!creds?.access_token) {
    throw new Error('Sign in with a linked Velora account in NeonLogin to send messages.');
  }

  const targetChannelId = channelId || creds.velora_user_id;
  const doSend = async (token) => {
    return fetch(`https://api.velora.tv/api/integrations/oauth/chat/channels/${encodeURIComponent(targetChannelId)}/messages`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        message: message.trim(),
        sendAsBot: false
      })
    });
  };

  let response = await doSend(creds.access_token);
  if (response.status === 401) {
    creds = await getVeloraCredentials(channel);
    if (creds?.access_token) {
      response = await doSend(creds.access_token);
    }
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `Velora returned HTTP ${response.status}`);
  }
  return payload;
}

async function moderateVeloraUser(options = {}) {
  const { action, author, targetUserId, messageId, duration } = options;
  const channel = options.channel || veloraChannel;
  const channelId = options.channelId || veloraChannelId;

  let creds = veloraCredentials;
  if (!creds?.access_token) {
    creds = await getVeloraCredentials(channel);
  }
  const isOwner = Boolean(creds && (
    (creds.channel && creds.channel.toLowerCase() === veloraChannel.toLowerCase()) ||
    (creds.username && creds.username.toLowerCase() === veloraChannel.toLowerCase()) ||
    (creds.velora_user_id && creds.velora_user_id === veloraChannelId)
  ));
  if (!creds?.access_token || (!creds?.can_moderate && !isOwner)) {
    throw new Error('Moderator permissions on Velora are required for this action.');
  }

  const targetChannelId = channelId || creds.velora_user_id;
  let endpoint = `https://api.velora.tv/api/integrations/oauth/chat/channels/${encodeURIComponent(targetChannelId)}/moderate`;

  const targetUser = options.targetUsername || options.username || options.author || author || '';
  const targetId = options.targetUserId || options.userId || targetUserId || '';
  const msgId = messageId || options.messageId || '';

  let body = { action };
  if (targetUser) {
    body.targetUsername = targetUser;
  }
  if (targetId) {
    body.targetUserId = targetId;
  }
  if (options.reason) {
    body.reason = options.reason;
  }

  if (action === 'delete') {
    body.action = 'delete';
    if (msgId) body.messageId = msgId;
  } else if (action === 'timeout' || action === 'timeout-60' || action === 'timeout-600') {
    body.action = 'timeout';
    body.duration = Number(duration || (action === 'timeout-60' ? 60 : 600));
  } else if (action === 'ban') {
    body.action = 'ban';
  } else if (action === 'clear') {
    body.action = 'clear';
  }

  const doModerate = async (token) => {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    }).catch(() => null);
  };

  let response = await doModerate(creds.access_token);
  if (response?.status === 401) {
    creds = await getVeloraCredentials(channel);
    if (creds?.access_token) {
      response = await doModerate(creds.access_token);
    }
  }

  if (response && (response.ok || response.status === 200 || response.status === 201 || response.status === 204)) {
    return { success: true };
  }

  // Log the full response so we can diagnose what the moderate endpoint returns
  const errPayload = response ? await response.json().catch(() => ({})) : {};
  const status = response?.status ?? 0;
  console.error('[velora:moderate] endpoint failed', { status, body: errPayload, action, targetChannelId });
  throw new Error(
    errPayload.message || errPayload.error ||
    `Velora moderation failed (HTTP ${status}). Action: ${action}`
  );
}

async function clearVeloraChat(channel = veloraChannel) {
  return moderateVeloraUser({ action: 'clear', channel });
}

async function exchangeSsoToken(token) {
  const payload = await postForm(`${NEONLOGIN_BASE}/api/sso.php`, { token });
  const auth = {
    sessionToken: payload.session_token,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || '',
    user: payload.user,
    savedAt: Date.now()
  };
  twitchRedemptions.stop();
  saveAuth(auth);
  return sanitizeAuth(auth);
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

async function refreshAuth(auth) {
  if (!auth?.refreshToken) return null;
  const response = await fetch(`${NEONLOGIN_BASE}/api/refresh.php`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: auth.refreshToken })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) return null;
  const existingAvatar = auth.user?.avatar_url || auth.user?.avatar || '';
  const incomingAvatar = payload.user?.avatar_url || payload.user?.avatar || '';
  const mergedUser = { ...auth.user, ...payload.user };
  if (!isDefaultOrPlaceholderAvatar(existingAvatar) && isDefaultOrPlaceholderAvatar(incomingAvatar)) {
    mergedUser.avatar_url = existingAvatar;
  }
  const refreshed = {
    sessionToken: payload.session_token,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    user: mergedUser,
    savedAt: Date.now()
  };
  saveAuth(refreshed);
  return refreshed;
}

async function refreshNeonUser(auth) {
  if (!auth?.accessToken) return auth;
  try {
    const response = await fetch(`${NEONLOGIN_BASE}/api/validate.php`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${auth.accessToken}` },
      signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success || !payload.user) return auth;
    const existingAvatar = auth.user?.avatar_url || auth.user?.avatar || '';
    const incomingAvatar = payload.user?.avatar_url || payload.user?.avatar || '';
    const mergedUser = { ...auth.user, ...payload.user };
    if (!isDefaultOrPlaceholderAvatar(existingAvatar) && isDefaultOrPlaceholderAvatar(incomingAvatar)) {
      mergedUser.avatar_url = existingAvatar;
    }
    const refreshed = { ...auth, user: mergedUser, savedAt: Date.now() };
    saveAuth(refreshed);
    return refreshed;
  } catch {
    return auth;
  }
}

function sanitizeAuth(auth) {
  if (!auth?.user) return { authenticated: false };
  const user = auth.user;
  let avatarUrl = user.avatar_url || user.avatar || user.profile_image_url || user.picture || user.thumbnail || '';
  if (isDefaultOrPlaceholderAvatar(avatarUrl)) {
    avatarUrl = '';
  } else if (avatarUrl.startsWith('/')) {
    avatarUrl = `https://teammidnite.tv${avatarUrl}`;
  }
  const twitchUsername = user.twitch_username || user.twitch_login || '';
  return {
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      avatarUrl: avatarUrl,
      twitchUsername: twitchUsername,
      kickUsername: user.kick_slug || user.kick_username || user.kick_login || '',
      veloraUsername: user.velora_username || user.velora_id || '',
      youtubeTitle: user.youtube_channel_title || user.youtube_title || user.display_name || user.username,
      links: {
        twitch: Boolean(user.twitch_id),
        youtube: Boolean(user.youtube_id),
        kick: Boolean(user.kick_id),
        velora: Boolean(user.velora_id || user.velora_username || user.links?.velora)
      },
      twitchAuth: getTwitchSessionSnapshot(auth, false)
    }
  };
}

async function getTwitchLiveStatus(channel) {
  const url = new URL('https://teammidnite.tv/api/check-twitch-status.php');
  url.searchParams.set('username', channel);
  url.searchParams.set('channel', channel);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Twitch status returned HTTP ${response.status}`);
  const payload = await response.json();
  const value = payload.live ?? payload.is_live ?? payload.online ?? payload.data?.is_live;
  if (typeof value !== 'boolean' && value !== 0 && value !== 1 && value !== '0' && value !== '1') {
    throw new Error('Twitch status response did not contain a live state.');
  }
  return {
    live: value === true || value === 1 || value === '1',
    profileImageUrl: String(payload.profile_image_url || '')
  };
}

async function fetchJson(url, fallback = {}) {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000)
    });
    return response.ok ? await response.json() : fallback;
  } catch {
    return fallback;
  }
}

async function getTwitchEmotes(channel) {
  const emotes = new Map();
  const add = (name, url, provider) => {
    if (name && url && !emotes.has(name)) emotes.set(name, { name, url, provider });
  };
  const ffz = await fetchJson(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(channel)}`);
  Object.values(ffz.sets || {}).flatMap((set) => set.emoticons || []).forEach((emote) => {
    const url = emote.urls?.['2'] || emote.urls?.['1'];
    add(emote.name, url?.startsWith('//') ? `https:${url}` : url, 'FrankerFaceZ');
  });

  const twitchId = String(ffz.room?.twitch_id || '');
  const [bttvGlobal, bttvUser, sevenGlobal, sevenUser] = await Promise.all([
    fetchJson('https://api.betterttv.net/3/cached/emotes/global', []),
    twitchId ? fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`) : {},
    fetchJson('https://7tv.io/v3/emote-sets/global'),
    twitchId ? fetchJson(`https://7tv.io/v3/users/twitch/${twitchId}`) : {}
  ]);
  [...(bttvGlobal || []), ...(bttvUser.channelEmotes || []), ...(bttvUser.sharedEmotes || [])].forEach((emote) => {
    add(emote.code, `https://cdn.betterttv.net/emote/${emote.id}/2x`, 'BetterTTV');
  });
  [...(sevenGlobal.emotes || []), ...(sevenUser.emote_set?.emotes || [])].forEach((emote) => {
    const host = emote.data?.host;
    const file = host?.files?.find((item) => item.name === '2x.webp') ||
      host?.files?.find((item) => item.format === 'WEBP') || host?.files?.[0];
    if (host?.url && file?.name) add(emote.name, `${host.url.startsWith('//') ? 'https:' : ''}${host.url}/${file.name}`, '7TV');
  });
  return { emotes: [...emotes.values()], twitchId };
}

async function getTwitchComposerEmotes(channel) {
  const normalizedChannel = String(channel || '').trim().toLowerCase().replace(/^#/, '');
  if (!/^[a-z0-9_]{2,25}$/.test(normalizedChannel)) throw new Error('Enter a valid Twitch channel.');
  const session = await getTwitchSession(normalizedChannel);
  if (!session.canUseTwitchEmotes) throw new Error('Reconnect Twitch to enable user emotes.');
  const cacheKey = `${session.userId}:${normalizedChannel}:${session.scopes.join(',')}`;
  const cached = twitchComposerEmoteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const payload = await twitchRedemptionBroker('emotes', null, { channel: normalizedChannel });
  const emotes = (payload.emotes || []).map((emote) => {
    const formats = Array.isArray(emote.format) ? emote.format : ['static'];
    const format = formats.includes('animated') ? 'animated' : 'static';
    const scale = (Array.isArray(emote.scale) && emote.scale.includes('2.0')) ? '2.0' : '1.0';
    const themeMode = Array.isArray(emote.theme_mode) && emote.theme_mode.includes('dark') ? 'dark' : 'dark';
    const template = String(emote.images?.url_template || emote.url_template || '');
    const url = template
      ? template.replaceAll('{{id}}', encodeURIComponent(String(emote.id)))
        .replaceAll('{{format}}', format).replaceAll('{{theme_mode}}', themeMode).replaceAll('{{scale}}', scale)
      : `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emote.id)}/${format}/${themeMode}/${scale}`;
    return {
      id: String(emote.id), name: String(emote.name || ''), token: String(emote.name || ''), url,
      emote_type: String(emote.emote_type || ''), emote_set_id: String(emote.emote_set_id || ''),
      owner_id: String(emote.owner_id || ''), format: emote.format || [], scale: emote.scale || [],
      theme_mode: emote.theme_mode || [], animated: format === 'animated',
      setId: String(emote.emote_set_id || ''), source: 'Twitch',
      section: String(emote.emote_type || '').toLowerCase() === 'global' ? 'Global' : 'My Emotes'
    };
  }).filter((emote) => emote.name && emote.id);
  const diagnostics = payload.diagnostics || {};
  console.info('[Twitch Emotes]', JSON.stringify({
    authenticatedUser: session.username, userId: session.userId,
    pagesFetched: diagnostics.pagesFetched || 0, userEmotes: diagnostics.userEmotes || emotes.length,
    globalEmotes: diagnostics.globalEmotes || 0, channelRelevant: diagnostics.channelRelevant || 0,
    deduplicatedTotal: diagnostics.deduplicatedTotal || emotes.length,
  }));
  const value = { emotes, diagnostics, account: session.username, channel: normalizedChannel, fetchedAt: Date.now() };
  twitchComposerEmoteCache.set(cacheKey, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
  return value;
}

async function sendTwitchMessage(options = {}) {
  const channel = String(options.channel || '').trim().toLowerCase().replace(/^#/, '');
  const message = String(options.message || '').trim();
  if (!/^[a-z0-9_]{2,25}$/.test(channel)) throw new Error('Enter a valid Twitch channel.');
  if (!message) return { success: false };
  return twitchRedemptionBroker('send', { message }, { channel });
}

async function getTwitchChatAssets(channel) {
  const normalized = String(channel || '').trim().toLowerCase();
  if (!/^(?:[a-z0-9_]{2,25}|[0-9]{1,20})$/.test(normalized)) return { badges: [] };
  const response = await fetch(
    `https://teammidnite.tv/api/multistream-twitch-assets.php?channel=${encodeURIComponent(normalized)}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Twitch badge service returned HTTP ${response.status}`);
  }
  return payload;
}

async function getTwitchPronouns(username) {
  const login = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(login)) return { display: '' };
  const cached = pronounCache.get(login);
  if (cached && cached.expiresAt > Date.now()) return { display: cached.display };

  if (!pronounCatalogPromise) {
    pronounCatalogPromise = fetch('https://api.pronouns.alejo.io/v1/pronouns', {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000)
    }).then((response) => response.ok ? response.json() : {}).catch(() => ({}));
  }
  const [catalog, currentUserResponse] = await Promise.all([
    pronounCatalogPromise,
    fetch(`https://api.pronouns.alejo.io/v1/users/${encodeURIComponent(login)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000)
    }).then((response) => response.ok ? response.json() : null).catch(() => null)
  ]);
  let userResponse = currentUserResponse;
  if (!userResponse?.pronoun_id) {
    userResponse = await fetch(`https://pronouns.alejo.io/api/users/${encodeURIComponent(login)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000)
    }).then((response) => response.ok ? response.json() : []).catch(() => []);
  }
  const pronounId = String(
    userResponse?.pronoun_id || (Array.isArray(userResponse) ? userResponse[0]?.pronoun_id : '') || ''
  );
  const pronoun = catalog?.[pronounId] || null;
  const display = pronoun
    ? String(pronoun.singular ? pronoun.subject : `${pronoun.subject}/${pronoun.object}`)
    : '';
  pronounCache.set(login, {
    display,
    expiresAt: Date.now() + (display ? 60 * 60 * 1000 : 2 * 60 * 1000)
  });
  return { display };
}

async function twitchRedemptionBroker(action, body = null, query = {}) {
  let auth = loadAuth();
  let token = auth?.sessionToken || auth?.accessToken;
  if (!token) throw new Error('Sign in with NeonLogin to receive Twitch point redeems.');
  const requestOptions = {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  };
  const queryString = new URLSearchParams({ action, ...query }).toString();
  let response = await fetch(`https://teammidnite.tv/api/multistream-twitch-redemptions.php?${queryString}`, requestOptions);
  if (response.status === 401 && auth?.refreshToken) {
    const refreshed = await refreshAuth(auth);
    if (refreshed) {
      auth = refreshed;
      token = auth.sessionToken || auth.accessToken;
      requestOptions.headers.Authorization = `Bearer ${token}`;
      response = await fetch(`https://teammidnite.tv/api/multistream-twitch-redemptions.php?${queryString}`, requestOptions);
    }
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const errorMsg = payload.error === 'twitch_reconnect_required'
      ? 'Reconnect Twitch in NeonLogin.'
      : String(payload.error || '').startsWith('missing_scope:')
        ? `Reconnect Twitch to enable ${String(payload.error).slice('missing_scope:'.length)}.`
      : payload.error === 'not_authenticated'
        ? 'NeonLogin session expired. Please sign in again.'
        : payload.error || `Twitch redemption service returned HTTP ${response.status}`;
    const error = new Error(errorMsg);
    error.reconnectUrl = payload.reconnect_url || '';
    throw error;
  }
  return payload;
}

function getTwitchSessionSnapshot(auth = loadAuth(), includeToken = true) {
  const user = auth?.user || {};
  const token = user.twitch_access_token || user.twitch_token ||
    auth?.twitchAccessToken || auth?.twitch_access_token || '';
  const scopes = user.twitch_scopes || auth?.twitchScopes || auth?.twitch_scopes || [];
  const normalizedScopes = Array.isArray(scopes)
    ? scopes
    : String(scopes || '').split(/[ ,]+/).filter(Boolean);
  const twitchUser = user.twitch_username || user.twitch_login || '';
  const session = { available: Boolean(token), username: twitchUser, scopes: normalizedScopes };
  if (includeToken) session.accessToken = String(token).replace(/^oauth:/, '');
  return session;
}

async function getTwitchSession(channel = '') {
  try {
    const status = await twitchRedemptionBroker('status', null, channel ? { channel } : {});
    const scopes = Array.isArray(status.scopes) ? status.scopes.map((scope) => String(scope).toLowerCase()) : [];
    const session = {
      available: true,
      authenticated: status.authenticated === true,
      tokenType: status.token_type || 'user',
      userId: String(status.user_id || ''),
      username: String(status.login || ''),
      scopes,
      canReadChat: status.can_read_chat === true,
      canSendChat: status.can_send_chat === true,
      canUseTwitchEmotes: status.can_read_user_emotes === true,
      broadcasterId: String(status.broadcaster_id || ''),
      reconnectUrl: String(status.reconnect_url || '')
    };
    console.info('[Twitch Auth]', JSON.stringify({
      authenticated: session.authenticated, tokenType: session.tokenType,
      userId: session.userId, login: session.username, scopes: session.scopes,
      canReadChat: session.canReadChat,
      canSendChat: session.canSendChat || false,
      canReadUserEmotes: session.canUseTwitchEmotes,
      ...(session.canReadChat ? {} : { canReadChatReason: 'missing_scope:user:read:chat' }),
      ...(session.canSendChat ? {} : { canSendChatReason: 'missing_scope:user:write:chat' }),
      ...(session.canUseTwitchEmotes ? {} : { canReadUserEmotesReason: 'missing_scope:user:read:emotes' })
    }));
    if (!session.canReadChat) console.info('[Twitch Auth] canReadChat=false reason=missing_scope:user:read:chat');
    if (!session.canSendChat) console.info('[Twitch Auth] canSendChat=false reason=missing_scope:user:write:chat');
    if (!session.canUseTwitchEmotes) console.info('[Twitch Auth] canReadUserEmotes=false reason=missing_scope:user:read:emotes');
    return session;
  } catch (error) {
    console.warn('[Twitch Auth]', JSON.stringify({ authenticated: false, reason: error?.message || 'validation_failed' }));
    return {
      available: false, authenticated: false, tokenType: 'user', userId: '', username: '', scopes: [],
      canReadChat: false, canSendChat: false, canUseTwitchEmotes: false,
      reconnectUrl: error?.reconnectUrl || 'https://teammidnite.tv/NeonLogin/account.php'
    };
  }
}

async function getDesktopNotices() {
  let auth = loadAuth();
  let token = auth?.sessionToken || auth?.accessToken;
  if (!token) return { notices: [] };
  const request = () => fetch('https://teammidnite.tv/api/multistream-notices.php', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  });
  let response = await request();
  if (response.status === 401 && auth?.refreshToken) {
    const refreshed = await refreshAuth(auth);
    if (refreshed) {
      auth = refreshed;
      token = auth.sessionToken || auth.accessToken;
      response = await request();
    }
  }
  if (!response.ok) return { notices: [] };
  const payload = await response.json().catch(() => ({}));
  return { notices: Array.isArray(payload.notices) ? payload.notices : [] };
}

function connectTwitchRedemptions() {
  return twitchRedemptions.connect();
}

const kickChatroomCache = new Map();

async function getKickChatroom(channelValue) {
  const channel = String(channelValue || '').trim().toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?kick\.com\//, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9_-]{2,30}$/.test(channel)) throw new Error('Enter a valid Kick channel name.');
  if (kickChatroomCache.has(channel)) {
    return { channel, chatroomId: kickChatroomCache.get(channel) };
  }
  const endpoints = [
    `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}/chatroom`,
    `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(channel)}`
  ];
  let lastStatus = 0;
  for (const url of endpoints) {
    try {
      // Use Electron's Chromium session instead of renderer fetch. Kick's edge
      // currently rejects requests carrying a file:// renderer origin.
      const response = await mainWindow.webContents.session.fetch(url, {
        headers: {
          Accept: 'application/json',
          Referer: `https://kick.com/${channel}`,
          'User-Agent': mainWindow.webContents.getUserAgent()
        }
      });
      lastStatus = response.status;
      if (!response.ok) continue;
      const payload = await response.json();
      const chatroom = payload?.chatroom || payload?.data?.chatroom || payload?.data || payload;
      const chatroomId = String(chatroom?.id || payload?.chatroom_id || '');
      if (chatroomId) {
        kickChatroomCache.set(channel, chatroomId);
        return { channel, chatroomId };
      }
    } catch {
      // Try the next compatible public endpoint.
    }
  }
  // Kick intermittently rejects background API requests at its edge. Fall back
  // to a real, hidden Kick page and perform the lookup from Kick's own origin,
  // matching the request context used by the public web chat. This is generic
  // for every channel and never relies on a built-in username.
  let kickWindow = null;
  try {
    kickWindow = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    await kickWindow.loadURL(`https://kick.com/${encodeURIComponent(channel)}`);
    const resolved = await kickWindow.webContents.executeJavaScript(`(async () => {
      const slug = ${JSON.stringify(channel)};
      const paths = [
        '/api/v2/channels/' + encodeURIComponent(slug) + '/chatroom',
        '/api/v2/channels/' + encodeURIComponent(slug),
        '/api/v1/channels/' + encodeURIComponent(slug)
      ];
      for (const path of paths) {
        try {
          const response = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!response.ok) continue;
          const payload = await response.json();
          const room = payload?.chatroom || payload?.data?.chatroom || payload?.data || payload;
          const id = String(room?.id || payload?.chatroom_id || '');
          if (id) return { chatroomId: id };
        } catch {}
      }
      return { chatroomId: '' };
    })()`, true);
    if (resolved?.chatroomId) {
      const chatroomId = String(resolved.chatroomId);
      kickChatroomCache.set(channel, chatroomId);
      return { channel, chatroomId };
    }
  } catch {
    // The actionable provider error below is shown in the connection card.
  } finally {
    if (kickWindow && !kickWindow.isDestroyed()) kickWindow.destroy();
  }
  throw new Error(lastStatus === 403
    ? `Kick blocked chat discovery for #${channel}. Retry shortly; reconnecting the account is not required.`
    : `Kick channel #${channel} could not be resolved.`);
}

async function getYouTubeEmotes(broadcastId) {
  if (!YOUTUBE_CHAT_ENABLED) return { emotes: [] };
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(broadcastId)) return { emotes: [] };
  if (!youtubeGenericEmotesPromise) {
    youtubeGenericEmotesPromise = fetch(
      'https://www.gstatic.com/youtube/img/emojis/emojis-png-15.1.json',
      { signal: AbortSignal.timeout(8000) }
    ).then((response) => response.ok ? response.json() : []).catch(() => []);
  }
  const [response, genericCatalog] = await Promise.all([
    fetch(`https://www.youtube.com/live_chat?v=${encodeURIComponent(broadcastId)}`, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(8000)
    }),
    youtubeGenericEmotesPromise
  ]);
  if (!response.ok) throw new Error(`YouTube live chat returned HTTP ${response.status}`);
  const html = await response.text();
  const emotes = new Map();
  for (const emoji of genericCatalog) {
    const thumbnails = emoji.image?.thumbnails || [];
    const url = thumbnails[thumbnails.length - 1]?.url || thumbnails[0]?.url;
    for (const shortcut of emoji.shortcuts || []) {
      if (shortcut && url && !emotes.has(shortcut)) {
        emotes.set(shortcut, { name: shortcut, url, source: 'generic' });
      }
    }
  }
  const pattern = /"shortcuts":(\[[^\]]+\]).{0,1200}?"image":\{"thumbnails":\[\{"url":("(?:\\.|[^"\\])*")/g;
  for (const match of html.matchAll(pattern)) {
    try {
      const shortcuts = JSON.parse(match[1]);
      const url = JSON.parse(match[2]);
      for (const shortcut of shortcuts) {
        if (shortcut && url) emotes.set(shortcut, { name: shortcut, url, source: 'live-chat' });
      }
    } catch { }
  }
  return { emotes: [...emotes.values()] };
}

function finishBrowserAuth(html) {
  return `<!doctype html><meta charset="utf-8"><title>Neon Multistream</title>
    <style>body{margin:0;display:grid;place-items:center;height:100vh;background:#080910;color:#e9ebf4;font:16px Segoe UI,sans-serif}.card{text-align:center;padding:32px;border:1px solid #2b3040;border-radius:12px;background:#12141d}b{color:#25e6ff}</style>
    <div class="card"><h2><b>NeonLogin</b> complete</h2><p>${html}</p><p>You can close this window.</p></div>`;
}

async function beginNeonLogin() {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }
  pendingAuthState = crypto.randomBytes(24).toString('hex');

  const callback = await new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      if (requestUrl.pathname !== '/neonlogin/callback') {
        response.writeHead(404).end();
        return;
      }
      const token = requestUrl.searchParams.get('sso_token');
      const state = requestUrl.searchParams.get('state');
      if (!token || state !== pendingAuthState) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(finishBrowserAuth('The sign-in response was invalid. Please return to the app and try again.'));
        reject(new Error('Invalid NeonLogin callback state or missing SSO token.'));
        server.close();
        callbackServer = null;
        return;
      }
      try {
        const auth = await exchangeSsoToken(token);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(finishBrowserAuth('You are signed in to Neon Multistream.'));
        mainWindow?.webContents.send('neonlogin:changed', auth);
        resolve(auth);
      } catch (error) {
        response.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(finishBrowserAuth('NeonLogin could not complete the session exchange.'));
        reject(error);
      } finally {
        server.close();
        callbackServer = null;
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      callbackServer = server;
      const { port } = server.address();
      const returnUrl = `http://127.0.0.1:${port}/neonlogin/callback?state=${pendingAuthState}`;
      const loginUrl = `${NEONLOGIN_BASE}/?redirect=${encodeURIComponent(returnUrl)}`;
      shell.openExternal(loginUrl);
    });
    setTimeout(() => {
      if (callbackServer === server) {
        server.close();
        callbackServer = null;
        reject(new Error('NeonLogin sign-in timed out.'));
      }
    }, 5 * 60 * 1000).unref();
  });

  return callback;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 578,
    height: 1000,
    minWidth: 578,
    minHeight: 240,
    title: 'Neon Multistream',
    backgroundColor: '#090a0f',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : '../build/neon-multistream-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../app/index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// OBS Overlay Local HTTP Server & Pop-out Window
// ---------------------------------------------------------------------------

let overlayServer = null;
let overlayPort = 39111;
const overlaySseClients = new Set();
const overlayMessageHistory = [];
let overlayWindow = null;

const DEFAULT_OVERLAY_SETTINGS = {
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
  knownBots: [
    { key: 'twitch:nightbot', platform: 'twitch', login: 'nightbot', displayName: 'Nightbot', source: 'neon-known', verified: true },
    { key: 'twitch:streamelements', platform: 'twitch', login: 'streamelements', displayName: 'StreamElements', source: 'neon-known', verified: true },
    { key: 'twitch:streamlabs', platform: 'twitch', login: 'streamlabs', displayName: 'Streamlabs', source: 'neon-known', verified: true },
    { key: 'twitch:moobot', platform: 'twitch', login: 'moobot', displayName: 'Moobot', source: 'neon-known', verified: true },
    { key: 'twitch:fossabot', platform: 'twitch', login: 'fossabot', displayName: 'Fossabot', source: 'neon-known', verified: true },
    { key: 'twitch:wizebot', platform: 'twitch', login: 'wizebot', displayName: 'Wizebot', source: 'neon-known', verified: true },
    { key: 'twitch:phantombot', platform: 'twitch', login: 'phantombot', displayName: 'PhantomBot', source: 'neon-known', verified: true }
  ],
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

function overlaySettingsPath() {
  return path.join(app.getPath('userData'), 'neonmultistream-overlay-settings.json');
}

function loadOverlaySettings() {
  try {
    const filePath = overlaySettingsPath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw) return { ...DEFAULT_OVERLAY_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('Failed to load overlay settings:', err);
  }
  return { ...DEFAULT_OVERLAY_SETTINGS };
}

function saveOverlaySettings(settings) {
  try {
    const merged = { ...loadOverlaySettings(), ...settings };
    fs.writeFileSync(overlaySettingsPath(), JSON.stringify(merged, null, 2), 'utf8');
    broadcastToOverlays({ type: 'settings', data: merged });
    if (overlayWindow && !overlayWindow.isDestroyed() && typeof merged.alwaysOnTop === 'boolean') {
      overlayWindow.setAlwaysOnTop(merged.alwaysOnTop);
    }
    return merged;
  } catch (err) {
    console.error('Failed to save overlay settings:', err);
    return loadOverlaySettings();
  }
}

function broadcastToOverlays(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'message' && event.data) {
    overlayMessageHistory.push(event.data);
    if (overlayMessageHistory.length > 30) overlayMessageHistory.shift();
  } else if (event.type === 'clear') {
    const platform = event.data && event.data.platform ? String(event.data.platform).toLowerCase() : '';
    if (platform) {
      for (let i = overlayMessageHistory.length - 1; i >= 0; i -= 1) {
        if (String(overlayMessageHistory[i] && overlayMessageHistory[i].platform || '').toLowerCase() === platform) {
          overlayMessageHistory.splice(i, 1);
        }
      }
    } else {
      overlayMessageHistory.length = 0;
    }
  }

  let payloadStr = '';
  try {
    payloadStr = `data: ${JSON.stringify(event)}\n\n`;
  } catch (err) {
    console.error('[NeonMultistream] Overlay broadcast dropped, payload could not be serialized:', err && err.message);
    return;
  }

  // Send to all SSE clients (OBS Studio Browser Sources)
  for (const client of overlaySseClients) {
    try {
      if (client.writableEnded || client.destroyed) {
        overlaySseClients.delete(client);
        continue;
      }
      client.write(payloadStr);
    } catch (err) {
      overlaySseClients.delete(client);
      console.error('[NeonMultistream] Overlay SSE client write failed:', err && err.message);
    }
  }

  // Send to pop-out window if open
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send('overlay:event', event);
    } catch (err) {
      console.error('[NeonMultistream] Overlay pop-out delivery failed:', err && err.message);
    }
  }
}

function generateNeonTestMessage() {
  return {
    id: `neon-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    platform: 'neon',
    isTest: true,
    author: 'Neon Test',
    color: '#00e5ff',
    channel: '',
    pronouns: '',
    text: 'This is a Neon Multistream Chat overlay test.',
    bodyHtml: 'This is a Neon Multistream Chat overlay test.',
    badgesHtml: ''
  };
}

function startOverlayServer(preferredPort = 39111) {
  if (overlayServer) return;

  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8'
  };

  const server = http.createServer((req, res) => {
    // CORS headers for local OBS integration
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = reqUrl.pathname;

    // 1. SSE event stream
    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({
        type: 'init',
        data: {
          settings: loadOverlaySettings(),
          history: overlayMessageHistory.slice(-10)
        }
      })}\n\n`);

      overlaySseClients.add(res);
      const releaseSseClient = () => {
        clearInterval(heartbeat);
        overlaySseClients.delete(res);
      };
      const heartbeat = setInterval(() => {
        try {
          if (res.writableEnded || res.destroyed) {
            releaseSseClient();
            return;
          }
          // Heartbeat keeps half-open sockets detectable on both ends and is
          // ignored by the overlay's event switch.
          res.write(`data: ${JSON.stringify({ type: 'ping', data: { at: Date.now() } })}\n\n`);
        } catch (err) {
          console.error('[NeonMultistream] Overlay SSE heartbeat failed:', err && err.message);
          releaseSseClient();
        }
      }, 20000);
      req.on('close', releaseSseClient);
      res.on('error', (err) => {
        console.error('[NeonMultistream] Overlay SSE client error:', err && err.message);
        releaseSseClient();
      });
      return;
    }

    // 2. Settings REST API
    if (pathname === '/api/overlay/settings') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const saved = saveOverlaySettings(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(saved));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadOverlaySettings()));
      return;
    }

    // 2b. Test Message REST API
    if (pathname === '/api/overlay/test' || pathname === '/api/overlay-test') {
      const testMsg = generateNeonTestMessage();
      broadcastToOverlays({ type: 'message', data: testMsg });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: testMsg }));
      return;
    }

    // 2c. Velora & 7TV Emotes REST API for Overlay
    if (pathname === '/api/overlay/emotes/velora' || pathname === '/api/overlay/velora-emotes') {
      const channel = reqUrl.searchParams.get('channel') || veloraChannel || '';
      getVeloraEmotes(channel).then((result) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300'
        });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, emotes: [] }));
      });
      return;
    }

    // 3. Static Files (overlay.html, overlay.css, overlay.js, icons, etc.)
    let filePath = '';
    if (pathname === '/' || pathname === '/overlay' || pathname === '/overlay.html') {
      filePath = path.join(__dirname, '../app/overlay.html');
    } else {
      const sanitized = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
      filePath = path.join(__dirname, '../app', sanitized);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[NeonMultistream] Port ${preferredPort} in use, trying ${preferredPort + 1}`);
      startOverlayServer(preferredPort + 1);
    } else {
      console.error('Overlay server error:', err);
    }
  });

  server.listen(preferredPort, '127.0.0.1', () => {
    overlayPort = preferredPort;
    overlayServer = server;
    console.log(`[NeonMultistream] OBS Overlay server listening on http://127.0.0.1:${overlayPort}/overlay`);
  });
}

function createOverlayPopoutWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
    return overlayWindow;
  }

  const settings = loadOverlaySettings();

  overlayWindow = new BrowserWindow({
    width: 440,
    height: 700,
    minWidth: 260,
    minHeight: 180,
    frame: false,
    transparent: true,
    alwaysOnTop: settings.alwaysOnTop !== false,
    title: 'Neon Multistream - OBS Overlay',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : '../build/neon-multistream-icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  overlayWindow.loadFile(path.join(__dirname, '../app/overlay.html'), {
    query: { mode: 'popout' }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

app.whenReady().then(() => {
  createWindow();
  startOverlayServer();
  setTimeout(checkForUpdates, 2500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  twitchRedemptions.stop();
  if (overlayServer) {
    try { overlayServer.close(); } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform
}));
ipcMain.handle('app:desktop-notices', () => getDesktopNotices());
ipcMain.handle('app:check-for-updates', () => checkForUpdates(true));
ipcMain.handle('app:link-preview', (_event, url) => getLinkPreview(String(url || '')));

// OBS Overlay IPC Handlers
ipcMain.handle('overlay:info', () => ({
  port: overlayPort,
  url: `http://127.0.0.1:${overlayPort}/overlay`,
  isOpen: Boolean(overlayWindow && !overlayWindow.isDestroyed())
}));
ipcMain.handle('overlay:open-popout', () => {
  createOverlayPopoutWindow();
  return { ok: true, isOpen: true };
});
ipcMain.handle('overlay:close-popout', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  return { ok: true, isOpen: false };
});
ipcMain.handle('overlay:toggle-popout', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    return { ok: true, isOpen: false };
  } else {
    createOverlayPopoutWindow();
    return { ok: true, isOpen: true };
  }
});
ipcMain.handle('overlay:set-always-on-top', (_event, flag) => {
  const isTop = Boolean(flag);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setAlwaysOnTop(isTop);
  }
  return { ok: true, alwaysOnTop: isTop };
});
ipcMain.handle('overlay:broadcast', (_event, payload) => {
  broadcastToOverlays(payload);
  return { ok: true };
});
ipcMain.handle('overlay:get-settings', () => loadOverlaySettings());
ipcMain.handle('overlay:save-settings', (_event, newSettings) => saveOverlaySettings(newSettings));
ipcMain.handle('overlay:send-test', () => {
  const testMsg = generateNeonTestMessage();
  broadcastToOverlays({ type: 'message', data: testMsg });
  return { ok: true, message: testMsg };
});

ipcMain.handle('neonlogin:status', async () => {
  let auth = loadAuth();
  if (!auth) return { authenticated: false };
  if (Date.now() - Number(auth.savedAt || 0) > 20 * 60 * 60 * 1000) {
    const refreshed = await refreshAuth(auth);
    if (refreshed) {
      auth = refreshed;
    }
  }
  auth = await refreshNeonUser(auth);
  return sanitizeAuth(auth);
});

ipcMain.handle('neonlogin:login', () => beginNeonLogin());

ipcMain.handle('neonlogin:logout', async () => {
  twitchRedemptions.stop();
  disconnectVelora();
  stopAllVeloraMonitors();
  clearAuth();
  mainWindow?.webContents.send('neonlogin:changed', { authenticated: false });
  return { authenticated: false };
});

ipcMain.handle('youtube:status', () => youtubeBrokerRequest('status'));
ipcMain.handle('youtube:emotes', (_event, broadcastId) => getYouTubeEmotes(String(broadcastId || '')));
ipcMain.handle('youtube:messages', (_event, options = {}) => youtubeBrokerRequest('messages', options));
ipcMain.handle('youtube:send', (_event, options = {}) => youtubeBrokerRequest('send', {
  method: 'POST',
  liveChatId: options.liveChatId,
  body: { message: options.message }
}));
ipcMain.handle('twitch:session', (_event, channel) => getTwitchSession(String(channel || '')));
ipcMain.handle('twitch:live-status', (_event, channel) => getTwitchLiveStatus(String(channel || '')));
ipcMain.handle('twitch:emotes', (_event, channel) => getTwitchEmotes(String(channel || '')));
ipcMain.handle('twitch:composer-emotes', (_event, channel) => getTwitchComposerEmotes(String(channel || '')));
ipcMain.handle('twitch:send', (_event, options = {}) => sendTwitchMessage(options));
ipcMain.handle('twitch:chat-assets', (_event, channel) => getTwitchChatAssets(String(channel || '')));
ipcMain.handle('twitch:pronouns', (_event, username) => getTwitchPronouns(String(username || '')));
ipcMain.handle('twitch:redemptions-connect', () => connectTwitchRedemptions());
ipcMain.handle('kick:chatroom', (_event, channel) => getKickChatroom(String(channel || '')));
ipcMain.handle('velora:messages', (_event, options = {}) => getVeloraMessages(options));
ipcMain.handle('velora:profile', (_event, channel) => getVeloraProfile(channel));
ipcMain.handle('velora:badge-catalog', () => getVeloraBadgeCatalog());
ipcMain.handle('velora:emotes', (_event, channel) => getVeloraEmotes(channel));
ipcMain.handle('velora:resolve-7tv-emotes', (_event, names) => resolveSevenTvEmotes(names));
ipcMain.handle('velora:connect', (_event, channel) => connectVelora(channel));
ipcMain.handle('velora:monitor', (_event, channel) => monitorVeloraChannel(channel));
ipcMain.handle('velora:monitor-stop', (_event, channel) => stopMonitoringVelora(channel));
ipcMain.handle('velora:disconnect', () => {
  disconnectVelora();
  stopAllVeloraMonitors();
  return { connected: false };
});

ipcMain.handle('velora:mark-seen', (_event, ids = []) => {
  if (!Array.isArray(ids)) return { ok: false };
  ids.forEach((id) => veloraSeenIds.add(String(id)));
  if (veloraSeenIds.size > 5000) {
    const toDelete = [...veloraSeenIds].slice(0, 2000);
    toDelete.forEach((id) => veloraSeenIds.delete(id));
  }
  return { ok: true };
});

ipcMain.on('velora:redeem', (_event, payload) => {
  if (!mainWindow) return;
  if (!payload || typeof payload !== 'object') return;
  mainWindow.webContents.send('velora:redeem', payload);
});

ipcMain.on('velora:join', (_event, payload) => {
  if (!mainWindow) return;
  if (!payload || typeof payload !== 'object') return;
  mainWindow.webContents.send('velora:join', payload);
});

ipcMain.handle('velora:send', (_event, options) => sendVeloraMessage(options));
ipcMain.handle('velora:moderate', (_event, options) => moderateVeloraUser(options));
ipcMain.handle('velora:clear-chat', (_event, channel) => clearVeloraChat(channel));

ipcMain.on('app:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});
