// Run with an installed Playwright package, or PLAYWRIGHT_MODULE_PATH pointing to it.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appPath = path.join(__dirname, '../app');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const producer = main.slice(main.indexOf('function generateNeonTestMessage()'), main.indexOf('function startOverlayServer('));
const neonTest = vm.runInNewContext(producer + '\ngenerateNeonTestMessage()');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { window.overlayStream = this; }
        close() {}
      };
    });
    await page.route('http://overlay.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/overlay/settings') return route.fulfill({ json: { theme: 'glass', fadeSeconds: 0 } });
      if (pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      const file = pathname === '/' ? 'overlay.html' : pathname.slice(1);
      await route.fulfill({ path: path.join(appPath, file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
    });
    const send = event => page.evaluate(event => window.overlayStream.onmessage({ data: JSON.stringify(event) }), event);
    for (const canvasWidth of [1920, 320]) {
      await page.setViewportSize({ width: canvasWidth, height: 1080 });
      for (const position of ['left', 'right']) {
        await page.goto(`http://overlay.test/?theme=vertical-clean&position=${position}`);
        await page.waitForFunction(() => window.overlayStream?.onmessage);
        // Simulate settings arriving after URL selection; theme and position must survive.
        await send({ type: 'settings', data: { theme: 'glass', position: position === 'left' ? 'right' : 'left', platforms: { neon: false } } });
        await send({ type: 'message', data: neonTest });
        await send({ type: 'message', data: { ...neonTest, id: 'long-message', text: 'A long message '.repeat(35), bodyHtml: 'A long message '.repeat(35) } });
        await page.waitForTimeout(300);
        const measurements = await page.evaluate(() => {
          const list = document.querySelector('.overlay-messages').getBoundingClientRect();
          const cards = [...document.querySelectorAll('.overlay-card')];
          const content = cards[1].querySelector('.card-content');
          return { left: list.left, right: list.right, width: list.width,
            cards: cards.map(card => ({ width: card.getBoundingClientRect().width, scroll: card.scrollWidth, client: card.clientWidth })),
            lines: content.getBoundingClientRect().height / parseFloat(getComputedStyle(content).lineHeight),
            background: getComputedStyle(document.body).backgroundColor,
            badges: cards[0].querySelectorAll('.platform-pill, .user-badge-image').length,
            author: cards[0].querySelector('.author-name').textContent };
        });
        assert.equal(measurements.width, Math.min(380, canvasWidth - 32));
        assert.equal(position === 'left' ? measurements.left : canvasWidth - measurements.right, 16);
        assert.equal(measurements.cards.length, 2);
        for (const card of measurements.cards) { assert.equal(card.width, measurements.width); assert.ok(card.scroll <= card.client); }
        assert.ok(measurements.lines <= 1.05, 'long messages must occupy exactly one line');
        assert.equal(measurements.background, 'rgba(0, 0, 0, 0)');
        assert.equal(measurements.author, 'Neon Test');
        assert.equal(measurements.badges, 0);
        console.log(`PASS ${canvasWidth}px ${position}: ${measurements.width}px cards, single-line, transparent canvas, Neon Test preserved`);
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('http://overlay.test/');
    await page.waitForFunction(() => window.overlayStream?.onmessage);
    await send({ type: 'settings', data: { theme: 'vertical-clean', position: 'right', columnWidth: 350 } });
    assert.equal(await page.locator('.overlay-messages').evaluate(el => el.getBoundingClientRect().width), 350);
    await send({ type: 'settings', data: { theme: 'glass' } });
    assert.equal(await page.locator('.overlay-messages').evaluate(el => el.getBoundingClientRect().width), 1892);
    console.log('PASS live configurable width and switching back to full-width Glass');
    const emote = '<img class="chat-emote twitch-gif" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" title="Animated emote">';
    const attachment = '<img class="chat-emote twitch-gif" data-chat-media="attachment" title="Twitch GIF" src="https://media.test/attachment.gif">';
    const media = '<a class="chat-media-link"><img class="chat-inline-image chat-inline-gif" src="https://media.test/preview.gif"></a>';
    for (const transport of ['sse', 'ipc']) {
      if (transport === 'ipc') await page.addInitScript(() => {
        window.neonDesktop = { onOverlayEvent(fn) { window.overlayIPC = fn; } };
      });
      const deliver = event => page.evaluate(event => {
        if (window.overlayIPC) window.overlayIPC(event);
        else window.overlayStream.onmessage({ data: JSON.stringify(event) });
      }, event);
      for (const theme of ['glass', 'clean', 'glow', 'vertical-clean', 'horizontal', 'horizontal-clean']) {
        await page.setViewportSize({ width: 320, height: 1080 });
        await page.goto(`http://overlay.test/?theme=${theme}`);
        await page.waitForFunction(() => window.overlayIPC || window.overlayStream?.onmessage);
        await deliver({ type: 'settings', data: { fadeSeconds: 0, maxMessages: 20 } });
        const fixtures = ['Short message', 'x'.repeat(500), attachment + media,
          'Text with GIF ' + attachment + media, emote, emote.repeat(4),
          '<div>First line</div><div>Second line</div><br>Third line',
          'Preview <span class="chat-media-preview">hidden preview</span>'];
        for (const [index, bodyHtml] of fixtures.entries()) await deliver({ type: 'message', data: {
          id: `compact-${index}`, platform: 'twitch', author: ['tehKluma','Sery_Bot','DontBlameLexi','a','VeryLongUsernameHere'][index % 5],
          badgesHtml: index % 2 ? '<span class="user-badge moderator">M</span>' : '', pronouns: index === 1 ? 'He/Him' : '',
          sourceChannelLogin: ['tehkluma', 'xthyqueen', 'Lil_Lexi'][index % 3], channel: 'wrong-default', bodyHtml
        } });
        await page.waitForTimeout(350);
        const result = await page.evaluate(() => [...document.querySelectorAll('.overlay-card')].map(card => {
          const body = card.querySelector('.overlay-message-content');
          const header = card.querySelector('.card-header');
          const rect = body.getBoundingClientRect();
          const chip = card.querySelector('.channel-tag');
          const c = getComputedStyle(body);
          return { id: card.dataset.id, height: rect.height, line: parseFloat(c.lineHeight), width: rect.width, left: rect.left - card.getBoundingClientRect().left,
            bodyTop: rect.top, headerTop: header.getBoundingClientRect().top, ellipsis: c.textOverflow,
            overflow: c.overflow, nowrap: c.whiteSpace, source: chip.textContent, title: chip.title,
            chipVisible: chip.getBoundingClientRect().right <= header.getBoundingClientRect().right + 1,
            media: body.querySelectorAll('.chat-media-link, .chat-media-preview, .chat-inline-image, [data-chat-media]').length,
            emotes: [...body.querySelectorAll('img')].map(img => img.getBoundingClientRect().height) };
        }));
        assert.equal(result.length, 7, `${transport}/${theme}: media-only card must not be inserted`);
        if (!theme.startsWith('horizontal')) assert.ok(Math.max(...result.map(card => card.left)) - Math.min(...result.map(card => card.left)) < 1, `${theme}: content X must not depend on author width: ${result.map(card => card.left)}`);
        for (const card of result) {
          assert.equal(card.media, 0);
          assert.ok(card.height <= card.line + 1, `${theme}: ${card.id} wraps`);
          assert.ok(card.width > 0, `${theme}: text has no room`);
          assert.ok(Math.abs(card.bodyTop - card.headerTop) < 8, `${theme}: metadata on separate row`);
          assert.equal(card.ellipsis, 'ellipsis');
          assert.equal(card.nowrap, 'nowrap');
          assert.equal(card.overflow, 'hidden');
          assert.ok(card.chipVisible, `${theme}: source badge clipped`);
          assert.ok(['#tehkluma', '#xthyqueen', '#Lil_Lexi'].includes(card.source));
          assert.equal(card.title, card.source);
          for (const height of card.emotes) assert.ok(height <= card.line, 'emote must fit line height');
        }
        assert.equal(result.find(card => card.id === 'compact-4').emotes.length, 1);
        assert.equal(result.find(card => card.id === 'compact-5').emotes.length, 4);
        await deliver({ type: 'update-message', data: { id: 'compact-0', bodyHtml: 'Updated ' + media + attachment + emote } });
        assert.equal(await page.locator('[data-id="compact-0"] .chat-emote').count(), 1);
        assert.equal(await page.locator('[data-id="compact-0"] .chat-media-link').count(), 0);
        await deliver({ type: 'update-message', data: { id: 'compact-0', bodyHtml: attachment } });
        assert.equal(await page.locator('[data-id="compact-0"]').count(), 0);
        console.log(`PASS ${transport}/${theme}: narrow one-line feed, correct sources, filtered media, animated emotes and updates`);
      }
    }
    // Horizontal messages are natural-width, single-line groups clipped only
    // by the outer viewport.
    for (const theme of ['horizontal', 'horizontal-clean']) {
      for (const width of [1280, 1920, 2560]) {
        await page.setViewportSize({ width, height: 1080 });
        await page.goto(`http://overlay.test/?theme=${theme}`);
        await page.waitForFunction(() => window.overlayIPC || window.overlayStream?.onmessage);
        const deliver = event => page.evaluate(event => {
          if (window.overlayIPC) window.overlayIPC(event);
          else window.overlayStream.onmessage({ data: JSON.stringify(event) });
        }, event);
        await deliver({ type: 'settings', data: { fadeSeconds: 0, columnWidth: 240 } });
        await deliver({ type: 'message', data: { id: 'remaining-width', platform: 'twitch', author: 'VeryLongUsernameThatMustRemainVisible', sourceChannelLogin: 'tehkluma', bodyHtml: 'Requirements: Keep this entire message on one horizontal line. '.repeat(30) } });
        await deliver({ type: 'message', data: { id: 'remaining-width-2', platform: 'twitch', author: 'A', sourceChannelLogin: 'x', badgesHtml: '<span class="user-badge moderator">M</span>', bodyHtml: 'A second complete message with different metadata. '.repeat(30) } });
        await page.waitForTimeout(350);
        const layout = await page.evaluate(() => {
          const cards = [...document.querySelectorAll('.overlay-card')];
          const bar = document.querySelector('.overlay-messages');
          const r = bar.getBoundingClientRect();
          return { barWidth: r.width, outerHeight: document.querySelector('.overlay-container').getBoundingClientRect().height,
            outerOverflow: getComputedStyle(document.querySelector('.overlay-container')).overflow,
            cards: cards.map(card => {
            const c = card.getBoundingClientRect();
            const body = card.querySelector('.overlay-message-content');
            const b = body.getBoundingClientRect();
            return { cardWidth: c.width, bodyWidth: b.width, bodyLeft: b.left - c.left,
              left: c.left,
              height: b.height, line: parseFloat(getComputedStyle(body).lineHeight),
              flex: getComputedStyle(body).flex, overflow: getComputedStyle(body).overflow,
              ellipsis: getComputedStyle(body).textOverflow, nowrap: getComputedStyle(body).whiteSpace,
              scroll: body.scrollWidth, client: body.clientWidth };
          }) };
        });
        assert.equal(layout.cards.length, 2, JSON.stringify(layout));
        const [first, second] = layout.cards;
        assert.equal(layout.outerOverflow, 'hidden');
        assert.ok(layout.outerHeight <= first.line + 8, JSON.stringify(layout));
        assert.ok(Math.abs(second.left - first.left - first.cardWidth - 8) < 1, JSON.stringify(layout));
        assert.equal(first.flex, '0 0 auto');
        assert.equal(second.flex, '0 0 auto');
        assert.equal(first.ellipsis, 'clip');
        assert.equal(first.nowrap, 'nowrap');
        assert.equal(first.overflow, 'visible');
        assert.ok(first.scroll <= first.client + 1, JSON.stringify(layout));
        assert.ok(second.scroll <= second.client + 1, JSON.stringify(layout));
        for (const card of layout.cards) assert.ok(card.height <= card.line + 1);
        console.log(`PASS ${theme}/${width}px: natural-width one-line groups with outer clipping`);
      }
    }
    await page.screenshot({ path: '/tmp/neon-overlay-compact-verified.png' });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
