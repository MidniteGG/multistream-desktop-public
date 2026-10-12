const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');

function functionSource(name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) {
    start = source.indexOf(`function ${name}(`);
  }
  assert.ok(start >= 0, `Function ${name} not found in app.js`);
  let depth = 0;
  let inBraces = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
      inBraces = true;
    } else if (source[i] === '}') {
      depth--;
      if (inBraces && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return source.slice(start);
}

function setup() {
  const state = {
    messages: [],
    noticeHistory: [],
    velora: {
      channel: 'kluma',
      seen: new Set(),
      emotes: new Map(),
      emoteChannels: new Set(),
      emoteChannelsLoading: new Set()
    },
    twitch: { channel: 'kluma', emotes: new Map() }
  };
  const noop = () => {};
  const ctx = vm.createContext({
    state,
    Date,
    crypto: require('node:crypto'),
    $: () => null,
    veloraPending7TvLookups: new Set(),
    window: {
      setTimeout: noop,
      neonDesktop: {
        resolveSevenTvEmotes: async (names) => names.map((n) => ({
          name: n,
          code: n,
          url: `https://cdn.7tv.app/emote/${n}/2x.webp`,
          provider: '7TV'
        })),
        getVeloraEmotes: async () => ({ emotes: [] }),
        broadcastOverlay: noop,
        veloraMarkSeen: noop
      }
    },
    isModeratedUser: () => false,
    trimMessages: noop,
    scheduleChatHistorySave: noop,
    scheduleMessageRender: noop,
    renderMessages: noop,
    loadTwitchPronouns: noop,
    collectVeloraBadges: () => [],
    readableNameColor: (c) => c || '#e2af00',
    renderUserBadges: () => '',
    escapeHtml: (s) => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    linkifyText: (s) => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  });

  const functionsToLoad = [
    'formatVeloraEmoteTag',
    'isVeloraBareAllowed',
    'renderVeloraBareEmotes',
    // renderMessageBody renders non-colon text through the inline media
    // renderer, so those helpers must exist in the sandbox too.
    'renderInlineMediaText',
    'isInlineImageUrl',
    'isGifUrl',
    'renderVeloraMessageText',
    'renderMessageBody',
    'mergeVeloraEmotes',
    'addMessage',
    'addVeloraMessage',
    'checkAndResolveVelora7TvEmotes',
    'broadcastUpdatedOverlayMessages',
    'normalizeVeloraChannel',
    'loadVeloraSenderEmotes'
  ];

  const allowlistMatch = source.match(/const VELORA_APPROVED_BARE_EMOTES = new Set\(\[[^\]]+\]\);/);
  if (allowlistMatch) {
    vm.runInContext(allowlistMatch[0], ctx);
  }

  for (const name of functionsToLoad) {
    vm.runInContext(functionSource(name), ctx);
  }

  return ctx;
}

test('Velora renders 7TV emotes from bare words and colon codes with proper 7TV attribution', () => {
  const c = setup();

  c.mergeVeloraEmotes([
    {
      name: 'LETHIMCOOK',
      url: 'https://cdn.7tv.app/emote/01M0PBNBKEZMR02ZBTS6QPYJKY/2x.webp',
      provider: '7TV',
      isZeroWidth: false
    },
    {
      name: 'BOOBA',
      url: 'https://cdn.7tv.app/emote/01M0WX7Y3TFFY79ARA18KXJ0A0/2x.webp',
      provider: '7TV',
      isZeroWidth: false
    },
    {
      name: 'popCat',
      url: 'https://cdn.7tv.app/emote/01KZRHZTZRPR8G0FZRG17SCENF/2x.webp',
      provider: '7TV',
      isZeroWidth: false
    },
    {
      name: 'KlumaNodders',
      url: 'https://assets.velora.tv/emotes/channel-kluma/klumanodders/56.webp',
      provider: 'Velora',
      isZeroWidth: false
    }
  ]);

  // 1. Bare word 7TV emote (on approved allowlist)
  const htmlBare = c.renderVeloraMessageText('LETHIMCOOK');
  assert.ok(htmlBare.includes('class="chat-emote velora-emote seventv-emote"'), 'Must have seventv-emote class');
  assert.ok(htmlBare.includes('src="https://cdn.7tv.app/emote/01M0PBNBKEZMR02ZBTS6QPYJKY/2x.webp"'), 'Must have 7TV CDN URL');
  assert.ok(htmlBare.includes('title="LETHIMCOOK · 7TV"'), 'Must attribute 7TV in title tooltip');

  // 2. Colon-wrapped 7TV emote
  const htmlColon = c.renderVeloraMessageText(':LETHIMCOOK:');
  assert.ok(htmlColon.includes('class="chat-emote velora-emote seventv-emote"'), 'Colon code must render emote');
  assert.ok(htmlColon.includes('title="LETHIMCOOK · 7TV"'), 'Colon code must attribute 7TV');

  // 3. Mixed message with Velora native emote and 7TV emote
  const htmlMixed = c.renderVeloraMessageText('Look at BOOBA and KlumaNodders popCat');
  assert.ok(htmlMixed.includes('title="BOOBA · 7TV"'), 'BOOBA must be 7TV');
  assert.ok(htmlMixed.includes('title="KlumaNodders · Velora"'), 'KlumaNodders must be Velora');
  assert.ok(htmlMixed.includes('title="popCat · 7TV"'), 'popCat must be 7TV');

  // 4. Case-insensitivity support
  const htmlLower = c.renderVeloraMessageText('lethimcook booba popcat');
  assert.ok(htmlLower.includes('01M0PBNBKEZMR02ZBTS6QPYJKY'), 'Lowercase lethimcook resolves to 7TV');
  assert.ok(htmlLower.includes('01M0WX7Y3TFFY79ARA18KXJ0A0'), 'Lowercase booba resolves to 7TV');
});
test('Velora zero-width 7TV emotes render with zero-width wrapper', () => {
  const c = setup();

  c.mergeVeloraEmotes([
    {
      name: 'RainTime',
      url: 'https://cdn.7tv.app/emote/raintime/2x.webp',
      provider: '7TV',
      isZeroWidth: true
    }
  ]);

  const html = c.renderVeloraMessageText('RainTime');
  assert.ok(html.includes('class="velora-emote-wrapper zero-width"'), 'Must wrap zero-width emote');
  assert.ok(html.includes('zero-width-emote'), 'Must have zero-width class on img');
  assert.ok(html.includes('title="RainTime · 7TV"'), 'Must have 7TV title');
});
test('renderMessageBody for Velora platform calls 7TV-aware text rendering', () => {
  const c = setup();

  c.mergeVeloraEmotes([
    {
      name: 'NODDERS',
      url: 'https://cdn.7tv.app/emote/01M2KGMDZYA3VHPJA6RT9NYPA3/2x.webp',
      provider: '7TV'
    }
  ]);

  const msg = {
    platform: 'velora',
    text: 'Chat says NODDERS :NODDERS:'
  };

  const bodyHtml = c.renderMessageBody(msg);
  assert.ok(bodyHtml.includes('seventv-emote'), 'Rendered message body must contain seventv-emote');
  assert.ok(bodyHtml.includes('01M2KGMDZYA3VHPJA6RT9NYPA3'), 'Rendered message body must contain 7TV URL');
});

test('All 11 emotes from screenshot render as 7TV emotes', () => {
  const c = setup();

  const screenshotEmotes = [
    'LETHIMCOOK',
    'BOOBA',
    'LETSGO',
    'popCat',
    'Awkward',
    'crunch',
    'peepoShy',
    'AINTNOWAY',
    'PETTHEMODS',
    'OMEGALUL',
    'NODDERS'
  ];

  c.mergeVeloraEmotes(
    screenshotEmotes.map((name) => ({
      name,
      code: name,
      url: `https://cdn.7tv.app/emote/${name}/2x.webp`,
      provider: '7TV'
    }))
  );

  for (const emote of screenshotEmotes) {
    // Check bare word
    const bareHtml = c.renderVeloraMessageText(emote);
    assert.ok(bareHtml.includes('class="chat-emote velora-emote seventv-emote"'), `Bare ${emote} must render as 7TV`);
    assert.ok(bareHtml.includes(`title="${emote} · 7TV"`), `Bare ${emote} must attribute 7TV`);

    // Check colon wrapped
    const colonHtml = c.renderVeloraMessageText(`:${emote}:`);
    assert.ok(colonHtml.includes('class="chat-emote velora-emote seventv-emote"'), `Colon :${emote}: must render as 7TV`);
    assert.ok(colonHtml.includes(`title="${emote} · 7TV"`), `Colon :${emote}: must attribute 7TV`);
  }
});

test('Dynamic 7TV lookup only triggers on explicit :emote: colon syntax and ignores arbitrary words', async () => {
  const c = setup();
  let requestedLookups = [];

  c.window.neonDesktop.resolveSevenTvEmotes = async (names) => {
    requestedLookups.push(...names);
    return names.map((n) => ({
      name: n,
      code: n,
      url: `https://cdn.7tv.app/emote/${n}/2x.webp`,
      provider: '7TV'
    }));
  };

  // Case 1: Normal words with no colons should NOT trigger any 7TV lookup
  await c.checkAndResolveVelora7TvEmotes('Broadcasting Live? oh this chat message window is great', 'kluma');
  assert.equal(requestedLookups.length, 0, 'Must not dynamically resolve arbitrary normal words');

  // Case 2: Explicit :colon: token triggers 7TV lookup with inner name
  await c.checkAndResolveVelora7TvEmotes('Look at :Awkward: right now', 'kluma');
  assert.deepEqual(requestedLookups, ['Awkward'], 'Must trigger lookup for inner name Awkward');
});

test('Bare-word 7TV rendering is restricted to allowlist and preserves unresolved :name: text', () => {
  const c = setup();

  c.mergeVeloraEmotes([
    // Approved allowlist emote
    {
      name: 'LETHIMCOOK',
      url: 'https://cdn.7tv.app/emote/lethimcook/2x.webp',
      provider: '7TV'
    },
    // Non-allowlist custom 7TV emote
    {
      name: 'CustomSpecialEmote',
      url: 'https://cdn.7tv.app/emote/customspecialemote/2x.webp',
      provider: '7TV'
    }
  ]);

  // Approved bare emote renders
  const allowlistBareHtml = c.renderVeloraMessageText('LETHIMCOOK');
  assert.ok(allowlistBareHtml.includes('seventv-emote'), 'Approved emote renders as bare word');

  // Non-allowlist 7TV emote does NOT render as bare word
  const nonAllowlistBareHtml = c.renderVeloraMessageText('CustomSpecialEmote');
  assert.ok(!nonAllowlistBareHtml.includes('seventv-emote'), 'Non-allowlist emote must not render as bare word');
  assert.equal(nonAllowlistBareHtml, 'CustomSpecialEmote', 'Bare word must remain plain text');

  // Non-allowlist 7TV emote DOES render with explicit :name: syntax
  const nonAllowlistColonHtml = c.renderVeloraMessageText(':CustomSpecialEmote:');
  assert.ok(nonAllowlistColonHtml.includes('seventv-emote'), 'Explicit :name: syntax renders non-allowlist emote');

  // Unresolved explicit :name: preserves original text
  const unresolvedColonHtml = c.renderVeloraMessageText('Check out :NonExistentEmote123: today');
  assert.ok(unresolvedColonHtml.includes(':NonExistentEmote123:'), 'Must preserve original text when :name: does not resolve');
});
