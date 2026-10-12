const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');

test('OBS Overlay static assets and HTML exist and are non-empty', () => {
  const htmlPath = path.join(__dirname, '../app/overlay.html');
  const cssPath = path.join(__dirname, '../app/overlay.css');
  const jsPath = path.join(__dirname, '../app/overlay.js');

  assert.ok(fs.existsSync(htmlPath), 'overlay.html must exist');
  assert.ok(fs.existsSync(cssPath), 'overlay.css must exist');
  assert.ok(fs.existsSync(jsPath), 'overlay.js must exist');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  assert.ok(htmlContent.includes('overlay-container'), 'overlay.html must include overlay-container');
  assert.ok(htmlContent.includes('popout-header'), 'overlay.html must include popout-header');

  const cssContent = fs.readFileSync(cssPath, 'utf8');
  assert.ok(cssContent.includes('theme-glass'), 'overlay.css must define glass theme');
  assert.ok(cssContent.includes('theme-clean'), 'overlay.css must define clean theme');
  assert.ok(cssContent.includes('theme-glow'), 'overlay.css must define glow theme');
  assert.ok(cssContent.includes('theme-vertical-clean'), 'overlay.css must define vertical-clean theme');
  assert.ok(cssContent.includes('theme-horizontal'), 'overlay.css must define horizontal theme');
});

test('Vertical Clean theme has responsive narrow-width, compact content, and constrained badge/emote rules', () => {
  const cssPath = path.join(__dirname, '../app/overlay.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Verify vertical-clean rules
  assert.ok(cssContent.includes('.theme-vertical-clean'), 'Must contain .theme-vertical-clean');
  assert.ok(cssContent.includes('.overlay-message-content'), 'Must contain dedicated compact content rules');
  assert.ok(cssContent.includes('verticalSlideInUp'), 'Must define subtle micro-slide animation');

  // Verify badge & emote sizing constraints
  assert.ok(cssContent.includes('.user-badge-image'), 'Must constrain .user-badge-image');
  assert.ok(cssContent.includes('.velora-official-badge'), 'Must constrain .velora-official-badge');
  assert.ok(cssContent.includes('.velora-provider-badge'), 'Must constrain .velora-provider-badge');
  assert.ok(cssContent.includes('.chat-emote'), 'Must constrain .chat-emote');

  // Verify platform border indicators for vertical column
  assert.ok(cssContent.includes('.theme-vertical-clean .overlay-card[data-platform="twitch"]'), 'Must style Twitch vertical card');
  assert.ok(cssContent.includes('.theme-vertical-clean .overlay-card[data-platform="youtube"]'), 'Must style YouTube vertical card');
  assert.ok(cssContent.includes('.theme-vertical-clean .overlay-card[data-platform="kick"]'), 'Must style Kick vertical card');
  assert.ok(cssContent.includes('.theme-vertical-clean .overlay-card[data-platform="vpzone"]'), 'Must style VPZone vertical card');
  assert.ok(cssContent.includes('.theme-vertical-clean .overlay-card[data-platform="velora"]'), 'Must style Velora vertical card');
});

test('OBS Overlay local HTTP server serves files and handles SSE stream', async () => {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  };

  const overlaySettings = {
    theme: 'vertical-clean',
    fadeSeconds: 15,
    fontSize: 18,
    direction: 'bottom-up',
    platforms: { twitch: true, youtube: true, kick: true, velora: true }
  };

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = reqUrl.pathname;

    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'init', data: { settings: overlaySettings } })}\n\n`);
      return;
    }

    if (pathname === '/api/overlay/settings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(overlaySettings));
      return;
    }

    if (pathname === '/api/overlay/test' || pathname === '/api/overlay-test') {
      const testMsg = {
        id: `neon-test-${Date.now()}-test`,
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: testMsg }));
      return;
    }

    if (pathname === '/' || pathname === '/overlay') {
      const content = fs.readFileSync(path.join(__dirname, '../app/overlay.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // 1. Fetch overlay HTML
  const htmlRes = await fetch(`http://127.0.0.1:${port}/overlay`);
  assert.equal(htmlRes.status, 200);
  const htmlBody = await htmlRes.text();
  assert.ok(htmlBody.includes('overlayMessages'));

  // 2. Fetch settings API
  const settingsRes = await fetch(`http://127.0.0.1:${port}/api/overlay/settings`);
  assert.equal(settingsRes.status, 200);
  const settingsJson = await settingsRes.json();
  assert.equal(settingsJson.theme, 'vertical-clean');
  assert.equal(settingsJson.fontSize, 18);

  // 3. Test SSE initial event
  const sseChunk = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/events`, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.on('data', (chunk) => {
        resolve(chunk.toString());
        res.destroy();
      });
      res.on('error', reject);
    });
  });

  assert.ok(sseChunk.startsWith('data: '));
  const parsedData = JSON.parse(sseChunk.replace(/^data:\s*/, '').trim());
  assert.equal(parsedData.type, 'init');
  assert.equal(parsedData.data.settings.theme, 'vertical-clean');

  // 4. Test /api/overlay/test and /api/overlay-test
  const testMsgRes = await fetch(`http://127.0.0.1:${port}/api/overlay/test`);
  assert.equal(testMsgRes.status, 200);
  const testMsgJson = await testMsgRes.json();
  assert.equal(testMsgJson.ok, true);
  assert.equal(testMsgJson.message.author, 'Neon Test');
  assert.equal(testMsgJson.message.platform, 'neon');
  assert.equal(testMsgJson.message.isTest, true);
  assert.equal(testMsgJson.message.text, 'This is a Neon Multistream Chat overlay test.');

  const testMsgRes2 = await fetch(`http://127.0.0.1:${port}/api/overlay-test`);
  assert.equal(testMsgRes2.status, 200);
  const testMsgJson2 = await testMsgRes2.json();
  assert.equal(testMsgJson2.ok, true);
  assert.equal(testMsgJson2.message.author, 'Neon Test');

  server.close();
});

test('Vertical Clean left/right alignment anchoring rules exist in CSS', () => {
  const cssPath = path.join(__dirname, '../app/overlay.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  assert.ok(cssContent.includes('.theme-vertical-clean.align-left .overlay-messages'), 'Must have align-left rule');
  assert.ok(cssContent.includes('.theme-vertical-clean.align-right .overlay-messages'), 'Must have align-right rule');
  assert.ok(cssContent.includes('margin-right: auto;'), 'Left aligned column margins');
  assert.ok(cssContent.includes('margin-left: auto;'), 'Right aligned column margins');
});

test('Horizontal theme has flex-row layout, role left border accents, and slide animations', () => {
  const cssPath = path.join(__dirname, '../app/overlay.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  assert.ok(cssContent.includes('.overlay-container.theme-horizontal'), 'Must style .overlay-container.theme-horizontal');
  const horizontalRules = cssContent.slice(cssContent.indexOf('/* 6. Horizontal Clean Theme'));
  assert.ok(horizontalRules.includes('.overlay-card .overlay-message-content'), 'Must isolate horizontal message content');
  assert.ok(horizontalRules.includes('width: max-content !important'), 'Horizontal groups must use natural content width');
  assert.ok(!horizontalRules.includes('text-overflow: ellipsis'), 'Horizontal groups must not ellipsize content');
  assert.ok(cssContent.includes('.overlay-container.theme-horizontal') && cssContent.includes('overflow: hidden !important'), 'Only the horizontal outer viewport may clip overflow');
  assert.ok(cssContent.includes('flex-direction: row'), 'Must arrange messages in horizontal row');
  assert.ok(cssContent.includes('.theme-horizontal .overlay-card[data-role="broadcaster"]'), 'Must style broadcaster accent');
  assert.ok(cssContent.includes('.theme-horizontal .overlay-card[data-role="moderator"]'), 'Must style moderator accent');
  assert.ok(cssContent.includes('.theme-horizontal .overlay-card[data-role="vip"]'), 'Must style VIP accent');
  assert.ok(cssContent.includes('.theme-horizontal .overlay-card[data-role="subscriber"]'), 'Must style subscriber accent');
  assert.ok(cssContent.includes('horizontalSlideIn'), 'Must define horizontal slide animation');
  assert.ok(horizontalRules.includes('inset: auto 0 0 0'), 'Must keep horizontal overlay bottom anchored');
  assert.ok(horizontalRules.includes('.overlay-card .card-content'), 'Must style Horizontal card content');
  assert.ok(cssContent.includes('white-space: nowrap'), 'Must enforce single line nowrap for header');
  assert.ok(cssContent.includes('text-overflow: clip'), 'Must preserve full horizontal text without ellipsis');
  assert.ok(cssContent.includes('white-space: nowrap !important'), 'Must keep compact message content on one line');
});

test('Overlay JavaScript includes self-contained Velora 7TV emote pulling and rendering', () => {
  const jsPath = path.join(__dirname, '../app/overlay.js');
  const jsContent = fs.readFileSync(jsPath, 'utf8');

  assert.ok(jsContent.includes('pullVelora7TvEmotes'), 'Must contain pullVelora7TvEmotes function');
  assert.ok(jsContent.includes('enhanceVeloraContent'), 'Must contain enhanceVeloraContent function');
  assert.ok(jsContent.includes('renderVeloraTextWith7Tv'), 'Must contain renderVeloraTextWith7Tv function');
  assert.ok(jsContent.includes('01KF6FKR7APVXQ0CFJ5M1JHWB8'), 'Must reference Velora community 7TV set ID');
  assert.ok(jsContent.includes('api/overlay/emotes/velora'), 'Must query overlay server emotes endpoint');
  assert.ok(jsContent.includes('.card-content, .message-body'), 'Must update card-content on update-message events');
});
