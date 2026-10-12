# Neon Multistream

A compact cross-platform multistream chat client branded for NeonDestiny × TeamMidnite.

## Current prototype

- Native Electron desktop shell and Windows packaging configuration
- Chatterino-inspired compact multi-tab chat interface
- Combined and per-platform views for Twitch, YouTube Live, Kick, VPZone, and Velora
- Persistent-feeling desktop layout with search, pause, message counts, and send-target controls
- Live public Twitch chat reading over Twitch IRC WebSocket
- NeonLogin browser SSO with a localhost callback and one-time token exchange
- OS-encrypted persistent NeonLogin session storage where supported
- Streaming account-link status sourced from NeonLogin
- Original Neon Multistream application icon (not the NeonChat icon)
- One-, two-, or three-pane customizable chat workspace
- Per-pane platform filters and draggable platform-tab ordering
- Saved density, font size, timestamps, badges, connection events, accent, and effects preferences
- Authenticated YouTube Live chat discovery through the TeamMidnite broker
- YouTube Live message polling and channel-owner message sending
- Automatic Google access-token refresh without exposing provider tokens to the desktop renderer
- Authenticated VPZone WebSocket chat using `chat:read` and `chat:write`
- VPZone presence/system-event handling and chat message sending
- Public read-only Velora chat with saved channel selection and Socket.IO reconnection
- Server-side VPZone refresh-token rotation; access tokens stay outside the renderer
- No Discord or Spotify integration

The public Twitch reader is deliberately anonymous and read-only. Sending and authenticated connectors require OAuth scopes and server-side token handling; tokens should never be embedded in the packaged application.

## Run

```bash
npm install
npm start
```

## Build desktop releases

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

The Windows build produces a portable x64 executable. The macOS build produces
signed-when-configured DMG/ZIP packages for Intel and Apple Silicon. The Linux
build produces AppImage and Debian packages for x64 and arm64. Artifacts are
written to `release/`. macOS artifacts must be built on macOS; Linux artifacts
can be built on Linux, and Windows artifacts can be built on Windows or Linux.

`npm run build:all` is available for CI runners that can build all requested
targets, but separate OS-native jobs are recommended for release publishing.

## Connector roadmap

1. TeamMidnite account-link OAuth broker
2. Authenticated Twitch EventSub + Send Chat Message API
3. YouTube Live `liveChatMessages.streamList` and `insert`
4. Authenticated Kick sending after chat scopes and production API access are confirmed
5. Authenticated Velora sending after a documented third-party write flow is published

## Point redemption alerts

Twitch uses the NeonLogin redemption broker (`/api/multistream-twitch-redemptions.php`) and an EventSub WebSocket owned by the Electron main process. The broker subscribes to custom reward redemptions for the linked broadcaster. Reading another public Twitch channel does not authorize its redemption feed. Existing accounts without the required permission must use **Reconnect Twitch** once.

The desktop connection confirms readiness after subscription creation, retries transient failures, monitors keepalives, and transfers subscriptions during requested reconnects. Logout stops the feed. See [Twitch WebSocket lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).

Velora uses the public `/chat` Socket.IO namespace after `joinChannel`. Its `pointsCelebration` event supplies `id`, `itemName`, `cost`, `username`, `displayName`, `message`, and `createdAt`; history can supply the same payload in a `points-celebration` card. Both routes converge on the same renderer and deduplicate by channel and redemption ID. This contract was checked against the public [Velora channel frontend](https://velora.tv/tehkluma) on September 12, 2026. No point-spending request is made by this connector.

Run `npm test` for transport lifecycle and redemption rendering coverage. A live viewer redemption on each platform is the remaining end-to-end acceptance check after installing a release.


### Vertical Clean & Horizontal OBS Overlays

- **Vertical Clean**: Keep the OBS Browser Source canvas at your scene resolution (e.g. 1920×1080). Select Vertical Clean in the overlay dialog, set Column Position to Left or Right, and set Column Width (default 380px, configurable from 240–600px). Transparent message feed with compact vertical spacing and high-contrast text shadowing. URL override: `?theme=vertical-clean&position=right&columnWidth=380`.
- **Horizontal Stream Bar**: Places a horizontal stream bar along the bottom (or top) of the canvas with side-by-side message cards and colored left-border role/platform accents. URL override: `?theme=horizontal&position=bottom` (or `?position=top`).

An individual Browser Source can override settings with URL query parameters. URL overrides remain in effect when live settings arrive; omit those parameters to follow the desktop controls. Restart/rebuild the desktop app to serve updated overlay assets, then refresh the OBS source. The Neon Test generator and delivery paths are unchanged.

The browser layout regression check is `node test/overlay-layout.browser.cjs` with Playwright and its Chromium browser installed (`PLAYWRIGHT_MODULE_PATH` can specify an existing Playwright package). It measures real card widths at 1920px and 320px, both anchors, wrapping, transparent backgrounds, live width changes, and Neon Test rendering.
