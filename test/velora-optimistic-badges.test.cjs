const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appJs = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');

function functionSource(name) {
  let marker = `function ${name}`;
  let start = appJs.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${marker}`);
  if (start >= 6 && appJs.slice(start - 6, start) === 'async ') {
    start -= 6;
  }
  const paramEnd = appJs.indexOf(')', start);
  const bodyStart = appJs.indexOf('{', paramEnd);
  let depth = 0;
  for (let i = bodyStart; i < appJs.length; i++) {
    const ch = appJs[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return appJs.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Could not find end of ${name}`);
}

function createAppContext(overrides = {}) {
  const messages = [];
  const state = {
    activeView: 'all',
    sendTarget: 'velora',
    messages,
    velora: {
      connected: true,
      canSend: true,
      canModerate: true,
      channel: 'kluma',
      channelOwnerId: 'channel-kluma-uuid',
      channelOwnerLogin: 'kluma',
      connectedUsername: 'Kluma',
      connectedUserId: 'user-kluma-uuid',
      isOwner: true,
      seen: new Set(),
      emotes: new Map(),
      badgeCatalog: new Map()
    },
    auth: {
      authenticated: true,
      user: {
        id: 'user-kluma-uuid',
        username: 'Kluma',
        displayName: 'Kluma',
        veloraUsername: 'Kluma'
      }
    },
    settings: { paneViews: ['all'] },
    twitch: { connected: false, badgeCatalogs: new Map() },
    youtube: { connected: false },
    ...overrides.state
  };

  const elements = {
    '#messageInput': { value: 'Hello from Kluma!', disabled: false, maxLength: 500, focus() {} },
    '#sendButton': { disabled: false },
    '#charCount': { textContent: '17/500' }
  };

  const ctx = vm.createContext({
    state,
    veloraProfileCache: new Map(),
    veloraOfficialAssets: {},
    YOUTUBE_CHAT_ENABLED: true,
    $: (sel) => elements[sel] || null,
    $$: () => [],
    addMessage: (msg) => {
      const stored = { id: `msg_${Date.now()}_${Math.random()}`, ...msg };
      state.messages.push(stored);
      return stored;
    },
    scheduleMessageRender: () => {},
    updateComposerState: () => {},
    escapeHtml: (v) => String(v ?? ''),
    readableNameColor: (v) => v || '#FFFFFF',
    timestamp: () => '12:00',
    platformGlyph: () => 'V',
    renderMessageBody: (m) => m.text,
    renderLinkPreview: () => '',
    document: {
      createElement: (tag) => {
        return {
          tagName: tag,
          className: '',
          classList: { add() {}, remove() {}, toggle() {} },
          style: { setProperty() {} },
          dataset: {},
          innerHTML: '',
          textContent: '',
          querySelector() { return null; },
          appendChild(child) {
            this.children = this.children || [];
            this.children.push(child);
          }
        };
      }
    },
    window: {
      neonDesktop: {
        sendVeloraMessage: async (options) => {
          return {
            success: true,
            id: 'devapp_msg_12345',
            channelId: options.channelId,
            message: options.message
          };
        }
      }
    },
    ...overrides
  });

  const fns = [
    'messageLinks',
    'normalizeVeloraChannel',
    'normalizeVeloraBadgeKey',
    'resolveVeloraBadgeKey',
    'isVeloraBroadcaster',
    'collectVeloraBadges',
    'renderUserBadges',
    'visibleMessageBadges',
    'platformDisplayName',
    'createMessageRow',
    'addVeloraMessage',
    'sendComposerMessage'
  ];

  for (const fn of fns) {
    vm.runInContext(functionSource(fn), ctx);
  }

  return { ctx, state, elements };
}

test('Velora optimistic send path and incoming/history path produce identical badge and profile enrichment', async () => {
  const { ctx, state, elements } = createAppContext();

  // Seed Kluma's profile in cache (simulating profile returned on connect)
  const klumaProfile = {
    id: 'user-kluma-uuid',
    username: 'Kluma',
    displayName: 'Kluma',
    role: 'admin',
    accentColor: '#FFFFFF',
    pronouns: 'He/Him',
    pronounsShort: 'he',
    tag: 'KlumaTag',
    secondaryHandle: 'KlumaTag',
    badges: [
      {
        id: 'badge_pride',
        slug: 'pride-month-2026',
        name: 'Pride Month 2026',
        staticAssetUrl: 'https://assets.velora.tv/badges/catalog/pride-month-2026/static.png'
      }
    ],
    teamMemberships: [
      {
        role: 'owner',
        team: {
          slug: 'midnite',
          displayName: 'TeamMidnite',
          iconUrl: 'https://assets.velora.tv/teams/icon-midnite.png'
        }
      }
    ]
  };
  ctx.veloraProfileCache.set('kluma', klumaProfile);
  state.velora.profile = klumaProfile;

  // 1. Optimistic send execution
  await ctx.sendComposerMessage();

  assert.equal(state.messages.length, 1, 'Optimistic message added to state.messages');
  const optimistic = state.messages[0];
  assert.equal(optimistic.author, 'Kluma');
  assert.equal(optimistic.authorLogin, 'kluma');
  assert.equal(optimistic.pronouns, 'He/Him');
  assert.equal(optimistic.secondaryHandle, 'KlumaTag');
  assert.equal(optimistic.color, '#FFFFFF');
  assert.equal(optimistic.text, 'Hello from Kluma!');

  // Check badges order and composition: Broadcaster -> Staff/Admin -> Event Badge -> Team
  assert.ok(Array.isArray(optimistic.badges), 'Badges is an array');
  assert.equal(optimistic.badges.length, 4, 'Has Broadcaster, Admin, Pride Month 2026, and Team');

  assert.equal(optimistic.badges[0], 'broadcaster', '1st badge is broadcaster');
  assert.equal(optimistic.badges[1], 'admin', '2nd badge is admin');
  assert.equal(optimistic.badges[2].slug, 'pride-month-2026', '3rd badge is event badge Pride Month 2026');
  assert.equal(optimistic.badges[2].imageUrl, 'https://assets.velora.tv/badges/catalog/pride-month-2026/static.png');
  assert.equal(optimistic.badges[3].slug, 'midnite', '4th badge is team badge with midnite slug');
  assert.equal(optimistic.badges[3].title, 'TeamMidnite', '4th badge title is TeamMidnite');
  assert.equal(optimistic.badges[3].imageUrl, 'https://assets.velora.tv/teams/icon-midnite.png');

  // Provider ID should be resolved from send promise
  assert.equal(optimistic.providerId, 'devapp_msg_12345');

  // 2. Incoming Socket.IO message event arrives from Velora's chat server
  const incomingSocketPayload = {
    id: 'devapp_msg_12345',
    userId: 'user-kluma-uuid',
    username: 'Kluma',
    displayName: 'Kluma',
    message: 'Hello from Kluma!',
    content: 'Hello from Kluma!',
    channelId: 'channel-kluma-uuid',
    source: 'developer_app',
    badges: [],
    userRoles: [],
    accentColor: '#FFFFFF',
    createdAt: new Date().toISOString()
  };

  const incomingResult = ctx.addVeloraMessage(incomingSocketPayload, 'kluma');
  assert.equal(incomingResult, optimistic, 'Reconciled with existing optimistic message');
  assert.equal(state.messages.length, 1, 'Did not create duplicate message');
  assert.equal(optimistic.optimistic, false, 'Optimistic flag cleared');
  assert.equal(optimistic.badges.length, 4, 'Retained full enriched badges');

  // 3. Simulating history reload / refresh
  // In history reload, the message from REST history arrives:
  state.messages.length = 0; // Clear messages array as upon history reload
  state.velora.seen.clear();

  const historyMessage = {
    id: 'devapp_msg_12345',
    userId: 'user-kluma-uuid',
    username: 'Kluma',
    displayName: 'Kluma',
    message: 'Hello from Kluma!',
    source: 'developer_app',
    badges: [],
    userRoles: [],
    accentColor: '#FFFFFF',
    timestamp: new Date().toISOString()
  };

  const reloaded = ctx.addVeloraMessage(historyMessage, 'kluma');
  assert.equal(reloaded.author, optimistic.author);
  assert.equal(reloaded.pronouns, optimistic.pronouns);
  assert.equal(reloaded.secondaryHandle, optimistic.secondaryHandle);
  assert.equal(reloaded.color, optimistic.color);
  assert.deepEqual(reloaded.badges, optimistic.badges, 'History reload produces identical enriched badges');

  // 4. Verify createMessageRow renders secondary handle and pronoun badge
  const row = ctx.createMessageRow(reloaded);
  assert.ok(row.innerHTML.includes('class="secondary-handle"'), 'Row includes secondary-handle class');
  assert.ok(row.innerHTML.includes('@KlumaTag'), 'Row renders @KlumaTag');
  assert.ok(row.innerHTML.includes('class="pronoun-badge"'), 'Row includes pronoun-badge');
  assert.ok(row.innerHTML.includes('He/Him'), 'Row renders He/Him');
  assert.ok(row.innerHTML.includes('title="Velora pronouns"'), 'Row pronoun title references Velora pronouns');
});


test('Velora official badge fallbacks use cache-busted 20260922 assets', () => {
  assert.match(appJs, /VELORA_BADGE_ASSET_VERSION = '20260922'/);
  assert.match(appJs, /StreamerBroadcasterBadge\.png'\)\, title: 'Broadcaster'/);
  assert.doesNotMatch(appJs, /https:\/\/velora\.tv\/velora-badges\/[A-Za-z0-9_-]+\.png'/);
});
