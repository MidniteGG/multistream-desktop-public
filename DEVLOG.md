# Neon Multistream Development Log

## 1.3.118 — 2026-10-08

- Added read-only Velora monitor channels so additional public channels can be
  watched alongside the main Velora connection without replacing it.
- Velora monitor channels persist, reconnect independently, and can be removed
  from the monitored-channel list; sending and moderation remain scoped to the
  primary Velora channel.
- Prevented Twitch EventSub authorization and point-redeem warnings when the
  current channel belongs to another broadcaster; Twitch chat still uses the
  authenticated user connection for reading and sending.
- Carries forward the production horizontal OBS overlay improvements completed
  during the 1.3.117 development cycle: full usernames and messages without
  internal ellipses, single-line natural-width groups, 8px spacing, viewport-
  boundary overflow clipping, bottom anchoring, and preserved badges, colors,
  and emotes.
- Promoted the tested Windows portable artifact to version `1.3.118` after
  multi-stream, same-platform, monitored-channel, and outbound-message tests.

## 1.3.117 — 2026-10-06

- Updated Velora chat badges so permanent identity badges remain visible while
  eligible event, team, subscription, and tenure badges rotate through one
  fixed-size badge slot without shifting the username or message layout.
- Restricted the rotating badge behavior to Velora; Twitch, YouTube, and Kick
  badge rendering is unchanged.
- Fixed Velora rotation timing so each badge item receives the duration needed
  to visibly transition through the full eligible badge set.

## 1.3.116 — 2026-10-06

### Platform-aware emote composer

- Added a capability-driven composer so each connected platform exposes only
  features its authenticated account can actually send.
- Twitch now loads the authenticated user's entitled emotes from Twitch's
  official `Get User Emotes` API, including channel, subscriber-entitled, and
  animated emotes where the OAuth grant permits them.
- Selected Twitch emotes are inserted as Twitch tokens and sent through the
  existing IRC pipeline; images are never uploaded or substituted for tokens.
- Added a compact floating, searchable emote picker with category navigation,
  previews, names, and provider attribution.
- Velora uses its own available emote catalog. YouTube and Kick do not show
  non-sendable custom emotes, and GIF/media controls remain hidden unless a
  platform reports a supported outbound capability.
- ALL/combined chat remains plain text plus ordinary Unicode emoji only, with
  no platform-specific emote, GIF, sticker, or media controls.
- Twitch emote metadata is cached per authenticated account and channel, with
  OAuth-token identity and expiry handling to prevent stale entitlement data.
- Corrected Twitch authentication detection so channel connectivity is not
  treated as send permission. The broker validates the stored User Access
  Token, refreshes it when possible, and reports actual scopes and user ID.
- Twitch sending uses Helix with the validated token user as `sender_id`; an
  existing token missing required scopes now prompts Twitch reauthorization.

### Validation

- `node --check` passed for renderer, preload, and Electron main-process files.
- `git diff --check` passed.
- Added overlay-only bot filtering under Visible Elements with a persisted
  `hideBotMessages` setting; main chat history, moderation, and rendering are
  unchanged.
- Added individually toggleable Neon-known bots and streamer-defined,
  platform-scoped custom bots with account ID-first matching and login fallback
  only when an incoming message has no account ID.
- Bot filtering runs before the overlay max-message queue, so hidden bots do
  not consume visible slots; ordinary overlay test messages remain visible.
- Rebuilt the unchanged-version Windows portable artifact. SHA-256:
  `09eda6b1c54979dff2d93164d5dc39636d553215720612f273fb3cdc09cdd2f0`.
- Fixed the standalone OBS/Pop-Out overlay bot-filter link: current settings
  are logged and synchronized, Twitch/Velora identities normalize from both
  flattened and nested message fields, and matching reports its sanitized
  source before the message can enter the visible queue.

## 1.3.115 — 2026-10-05

- Removed the column-width cap on horizontal overlay message cards so long
  messages grow along the bar to its available right edge, not vertically.
- Horizontal message content uses flex: 1 1 auto, min-width: 0, width: auto;
  metadata keeps its own allocation instead of taking the remaining space.
- No changes to fonts, source chips, media filtering, positioning, other
  overlay themes, or normal desktop chat.
- Browser-verified both horizontal themes at 320px, 960px, and 1920px,
  including a deliberately narrow columnWidth setting and one-line height.

## 1.3.114 — 2026-10-06

- Fixed timestamp/platform/author columns so desktop message bodies start at
  the same position regardless of author length, badges, pronouns, or media.
- Retained readable source chips beneath authors and rich desktop media.
- Made every overlay theme a single-line feed with fixed metadata geometry,
  ellipsized text, inline animated emotes, and no standalone media/previews.
- Filtered both initial messages and live updates; media-only overlay messages
  do not leave empty cards. Overlay payloads carry per-message source identity.
- Browser-tested desktop at 560px/380px and all six overlay themes at 320px,
  using both OBS SSE and Electron IPC, five author lengths, and three sources.

## 1.3.113 — 2026-10-05

- Replaced tiny source-channel labels with compact 10.5px chips beneath chat
  authors, including purple Twitch styling, a # marker, and full-name tooltips.
- Source chips prefer message.sourceChannelLogin and retain message-specific
  legacy provenance fields for previously stored messages.
- Browser-verified truncation, multiple source channels, text, GIFs, and emotes
  at 560px and 380px widths.

## 1.3.112 — 2026-10-05

- Kept text and media inside the same message-content cell and top-aligned
  author metadata on media messages, preventing tall GIFs from visually
  separating from their author.
- Corrected delayed image-load following so layout-driven scroll events do
  not prevent the newest media from becoming fully visible.
- Verified six message/media cases at 560px and 380px in Chromium, including
  delayed image loading and paused scrolling.

## 1.3.111 — 2026-10-06

- Fixed the live chat viewport re-anchoring after Twitch GIF layout changes so
  the newest GIF is fully visible instead of ending halfway below the viewport.
- Made Twitch GIF images block-level media inside their message rows.

## 1.3.110 — 2026-10-06

- Kept the live chat pinned to the newest message after Twitch GIF images
  finish loading and change the scroll height.
- Preserved manual scroll-up behavior and paused-chat behavior.

## 1.3.109 — 2026-10-05

- Restored Twitch native emote rendering after Shared Chat provenance
  enrichment.
- EventSub now updates source-channel attribution without overwriting IRC
  emote ranges and assets.

## 1.3.108 — 2026-10-05

- Simplified ordinary chat links to clean inline links without broken or
  duplicated external preview cards.
- Kept the combined chat pinned to the newest messages whenever chat is not
  paused.

## 1.3.107 — 2026-10-05

- Enabled Twitch EventSub provenance enrichment for all chat messages, not
  only GIF messages.
- Shared Chat messages now retain the source broadcaster while deduplicating
  against the matching IRC message.

## 1.3.106 — 2026-10-05

- Fixed Twitch Shared Chat provenance by using the originating broadcaster
  metadata instead of the connected channel target.
- Messages received from `#xthyqueen` now remain labeled `#xthyqueen` while
  messages from `#tehkluma` remain labeled `#tehkluma`.

## 1.3.105 — 2026-10-05

- Added readable per-message source badges in combined chat so each message
  clearly identifies Twitch, YouTube, Kick, or Velora.
- Fixed Twitch provenance attribution so a message received from `#xthyqueen`
  stays labeled `#xthyqueen` instead of inheriting the primary `#tehkluma`
  channel.
- Preserved channel attribution beneath each username and added source details
  to the platform badge tooltip.

## 1.3.97 - 2026-09-22

- Updated Velora built-in broadcaster, VIP, bot, staff, and community
  management badges to the latest cache-busted assets.
- Added role-name aliases and broader catalog field support so new Velora
  badges are discovered when the API publishes them.

## 1.3.96 — 2026-09-20

- **VPZone Sunset & Complete Removal from Multistream Chat**:
  - Fully sunsetted and removed VPZone chat integration, WebSocket connections, OAuth broker requests, and emote parsers across the desktop application.
  - Removed VPZone tabs, target selections, connection cards, and OBS overlay platform toggles from the user interface.
  - Streamlined active streaming platform connectors to Twitch, YouTube Live, Kick, and Velora.
  - Updated build manifests and release packages for Windows x64.


## 1.3.92 — 2026-09-19

- **Unified Velora Optimistic Send & Read/History Enrichment Pipeline**:
  - Unified optimistic send message resolution with the normal read/history event enrichment path (`addVeloraMessage` and `collectVeloraBadges`).
  - Fixed badge order resolution in `collectVeloraBadges` to preserve native Velora priority: `Broadcaster -> Staff/Admin -> Moderator -> VIP -> Subscriber -> Event/Profile Badges -> Team -> Bot`.
  - Resolved event badges (e.g. Pride Month 2026) and team badges (e.g. TeamMidnite) alongside role badges (Broadcaster, Admin) for developer app and optimistic messages.
  - Implemented immediate optimistic dispatch in `sendComposerMessage()` with user/profile decorations, pronoun badge ("He/Him"), secondary handle (@tag), and accent color.
  - Added seamless provider id reconciliation upon send confirmation and Socket.IO event receipt, preventing duplicate messages and preserving enriched badge metadata.
  - Rendered secondary handle / tag metadata next to message authors in both main chat and OBS overlay when different from author display name.
  - Ensured identical badge and profile decoration output across newly sent messages, incoming live messages, and reloaded chat history.

## 1.3.91 — 2026-09-19

- **Apache ProxyPass Fix for Velora Credential Broker**:
  - Excluded `/api/multistream-velora.php` from the generic Apache `/api` proxy pass rule to ensure requests are served by PHP rather than falling through to Node/503.
  - Added auto-refresh retry on HTTP 401 in `sendVeloraMessage` and `moderateVeloraUser` so expired tokens are automatically refreshed without interrupting the user.
  - Hardened server-side OAuth token refresh in `multistream-velora.php` by loading both production and user environments and guarding against undefined constant references.
  - Enabled active chat sending and moderation credentials to load automatically for linked channels (such as `#kluma`), transitioning connection status from read-only to full moderation and chat capabilities.

## 1.3.90 — 2026-09-19

- **Broadcaster Direct Chat on Platform Dropdown Selector**:
  - Broadcasters connected to their own channels on Velora, Twitch, and supported platforms can now chat directly in their own channel when that specific platform is chosen on the dropdown selector.
  - Cleared `Velora chat:write permission required…` placeholder when the channel owner/broadcaster selects Velora on the dropdown.
  - Placeholder reflects broadcaster status (`Send to <Platform> as broadcaster…`).
  - Strictly isolated `"All connected"` so broadcaster overrides only apply when specifically targeted, preventing unverified cross-channel broadcasts.
  - Added broker channel lookup parameter in `/api/multistream-velora.php`.

## 1.3.89 — 2026-09-19

- **Velora Instant Chat Permission Unlock & Token Scope Backfill**:
  - Removed `isOwner` requirement from Velora chat message sending (`canWrite = Boolean(creds?.access_token && (creds?.can_write ?? true))`), permitting all linked accounts with write access to chat across channels.
  - Enabled moderation actions for both channel owners and authorized channel moderators (`can_moderate || isOwner`).
  - Added auto-refresh of Velora permissions on target selection (`setSendTarget('velora')`), composer input click/focus, and login changes.
  - Preserved active connection state and cached emotes across permission refreshes.
  - Updated `/api/multistream-velora.php` and OAuth callback to recognize and backfill `chat:write` and `chat:moderate` for all active tokens.

## 1.3.88 — 2026-09-19

- **Explicit `:emote:` 7TV Lookup Signal & Allowlist Protection**:
  - Configured dynamic 7TV resolution to only trigger on explicit colon-delimited tokens (`:name:`), ignoring arbitrary normal words.
  - Restricted bare-word 7TV emote rendering to Velora's approved/popular allowlist (`VELORA_APPROVED_BARE_EMOTES`) and preloaded community sets.
  - Preserved original text verbatim when an explicit `:name:` lookup fails to resolve.
- **Auto-Updater Release Manifest**:
  - Bumped version to `1.3.88` across package manifests and remote endpoint to trigger in-app auto-update notifications.

## 1.3.87 — 2026-09-19

- Added **Velora Chat Sending and Moderation Powers**:
  - Granted and integrated OAuth scopes: `user:read chat:read chat:write chat:moderate`.
  - Added secure TeamMidnite credential broker `/api/multistream-velora.php` providing authenticated token refresh and scope inspection (`can_write`, `can_moderate`).
  - Added Velora chat message composer target with 500-character limits and write authorization checks.
  - Implemented chat moderation actions for Velora messages in user context menu:
    - **Delete this message**: invokes `/delete` endpoint / slash command and instantly strips message from local log and overlay.
    - **Timeout 1 minute** and **Timeout 10 minutes**: invokes `/timeout <user> <duration>` and suppresses messages locally.
    - **Ban user**: invokes `/ban <user>` and suppresses author across chat log.
    - **Clear chat**: integrated `#clearChatButton` and Velora WebSocket `chatCleared` event to synchronize remote room clears and OBS overlay wipes.
  - Added automated test suite `test/velora-moderation.test.cjs` verifying composer permissions, payload dispatch, moderation context menu access, and clear chat events.
- Added **Velora 7TV Emote Support** to Neon Multistream Chat and the OBS Overlay:
  - Supports bare word and `:emote:` formatted 7TV emotes across Velora chat messages (e.g. `LETHIMCOOK`, `BOOBA`, `popCat`, `AINTNOWAY`, `OMEGALUL`, `NODDERS`).
  - Preloads global 7TV emote sets, Velora community 7TV set (`01KF6FKR7APVXQ0CFJ5M1JHWB8`), and streamer channel sets resolved via 7TV API / Twitch link.
  - Added standalone 7TV pulling to the OBS overlay (`/api/overlay/emotes/velora` REST endpoint + direct 7TV API fallbacks) so browser source overlays independently parse and render 7TV emotes.
  - Implemented dynamic on-demand resolution via 7TV GraphQL query batching for unknown emote tokens appearing in chat messages with negative/positive caching.
  - Added real-time overlay sync (`update-message` event) to re-render in-flight overlay messages once dynamic emotes finish resolving.
  - Added zero-width emote stacking and tooltip attribution (`· 7TV` vs `· Velora`).
  - Added automated test suite `test/velora-7tv-emotes.test.cjs` covering emote parsing, zero-width wrapping, case-insensitivity, and overlay updates.
- **Removed Message Truncation (Full Paragraph & Multiline Wrapping)**:
  - Replaced single-line ellipsis truncation on message content with complete multiline text wrapping (`white-space: normal`, `overflow-wrap: anywhere`, `word-break: break-word`).
  - Removed fixed-height container limits (`max-height: none !important`, `overflow: visible !important`) so message rows grow vertically with message length.
  - Preserved single-line compact headers for username/badges while allowing the full message body to be completely displayed without cuts or ellipses.
- **Explicit `:emote:` 7TV Lookup Signal & Bare Allowlist Restriction**:
  - Configured dynamic 7TV resolution to only trigger on explicit colon-delimited tokens (`:name:`), ignoring arbitrary normal words.
  - Restricted bare-word 7TV emote rendering to Velora's approved/popular allowlist (`VELORA_APPROVED_BARE_EMOTES`) and community set emotes.
  - Preserved original text verbatim when an explicit `:name:` lookup fails to resolve.

### Release

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.87-x64.exe`.
- Public executable SHA-256:
  `6732e2cd34add52853f332833223fec45c93aec0d58b2c4c557c15b2b56ce37c`.
- Deployed installer to `https://teammidnite.tv/NeonMulti/download.php` as `Neon-Multistream-1.3.87-x64.exe` and `Neon-Multistream-Latest.exe`.

## 1.3.86 — 2026-09-14

- Restored the 2-row stacked visual hierarchy for **Horizontal Clean** matching the reference stream ticker design:
  - **Row 1**: Platform icon + badges + username (bold/uppercase) + pronouns.
  - **Row 2**: Message text and emotes directly underneath.
- Enforced strict single-line non-wrapping for the message row (`white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;`) so message text never wraps downward into a 3rd or 4th row.
- Maintained side-by-side horizontal alignment of multiple message segments across the transparent 1920px canvas with role/platform vertical left-border accents.

### Release

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.86-x64.exe`.
- Public executable SHA-256:
  `89f79429e66b83dee65904e406ac292cdb7c89f3982f5531a013d4df9ab92068`.
- Deployed installer to `https://teammidnite.tv/NeonMulti/download.php` as `Neon-Multistream-1.3.86-x64.exe` and `Neon-Multistream-Latest.exe`.


## 1.3.85 — 2026-09-14

- Fixed **Horizontal Clean** message text horizontal continuation: configured `.card-content` and child elements as inline elements with `white-space: nowrap !important` and `flex: 1 1 auto` to continue horizontally across the available canvas directly to the right of the compact identity/header.
- Removed narrow column constraints on horizontal cards, allowing message text to span across the 1920px canvas with ellipsis truncation only when the canvas boundary is reached.
- Preserved compact identity metadata, inline emotes, fixed 52px strip height, and bottom anchoring.

### Release

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.85-x64.exe`.
- Public executable SHA-256:
  `7c015160877e5583eabbde7ddbe3375bb50a39f159b2cbe57a7f34ea12aae88c`.
- Deployed installer to `https://teammidnite.tv/NeonMulti/download.php` as `Neon-Multistream-1.3.85-x64.exe` and `Neon-Multistream-Latest.exe`.


## 1.3.84 — 2026-09-14

- Reinforced **Horizontal Clean** with strict non-wrapping rules (`white-space: nowrap !important`, `word-break: normal !important`, `overflow-wrap: normal !important`) ensuring long messages stay on a single line and truncate with an ellipsis (`...`).
- Fixed strip container height (52px) and vertically centered single-row items.
- Enhanced text scaling (1.05em) and multi-layered text shadows for high contrast on 1920×1080 stream scenes.

### Release

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.84-x64.exe`.
- Public executable SHA-256:
  `e2d8d80fcaab12e5553d492b1e24730db035fb3b124428adba006e248518e023`.
- Deployed installer to `https://teammidnite.tv/NeonMulti/download.php` as `Neon-Multistream-1.3.84-x64.exe` and `Neon-Multistream-Latest.exe`.


## 1.3.83 — 2026-09-14

- Enforced strictly single-line, fixed-height horizontal chat ticker presentation for **Horizontal Clean** (`white-space: nowrap`, `flex-wrap: nowrap`, `overflow: hidden`, `text-overflow: ellipsis`).
- Fixed overlay strip height to 48px with vertically centered alignment and no multiline expansion.
- Structured single-row inline layout (`│ badges Username: message text with inline emotes… │`) with author colon separator and left-border accent lines.
- Long messages overflowing card width are neatly truncated with an ellipsis without wrapping onto a second line or breaking horizontal alignment.

### Release

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.83-x64.exe`.
- Public executable SHA-256:
  `05d116e2443a9001b626d6aad4039e2970a90bc517a368f2e9a66844985b88b0`.
- Deployed installer to `https://teammidnite.tv/NeonMulti/download.php` as `Neon-Multistream-1.3.83-x64.exe` and `Neon-Multistream-Latest.exe`.


## 1.3.82 — 2026-09-14

- Added a dedicated "Horizontal (Stream Bar)" OBS chat overlay theme designed for lower-third and ticker placements across full-width transparent canvases (1920×1080).
- Engineered a clean flex-row horizontal layout with vertical colored left-border accent lines indicating author roles (Broadcaster: magenta/red, Moderator: emerald green, VIP: electric pink, Subscriber: royal purple) and multi-platform color fallbacks.
- Structured compact two-tier message items with platform icon, badges, uppercase username, and pronouns on the top row, with message text and emotes directly underneath.
- Added smooth horizontal slide-in animations, queue management, and support for URL query parameter overrides: `?theme=horizontal&position=bottom` (or `?position=top`).

### Release

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.82-x64.exe`.
- Public executable SHA-256:
  `67b99435c89714ff29b134a8e144146376d3f960fe582f006bf8740cead48e0b`.
- Deployed installer to `https://teammidnite.tv/NeonMulti/download.php` as `Neon-Multistream-1.3.82-x64.exe` and `Neon-Multistream-Latest.exe`.


## 1.3.81 — 2026-09-14

- Converted "Vertical Clean" into a clean transparent OBS stream feed: removed dark card container backgrounds, blur backdrops, and borders in favor of transparent message items with crisp outline text shadows.
- Compacted message vertical hierarchy: platform pill, user badges, username, and pronouns sit together on the primary header row with wrapped message text, emotes, and links directly underneath.
- Preserved full 1920px transparent OBS canvas, configurable side column width (default 380px), left/right side anchoring, fade-out behavior, flow directions, moderation/filters, and self-generated Neon overlay diagnostics.

### Release

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.81-x64.exe`.
- Public executable SHA-256:
  `95515096862a40c6789a27e607c254e4081d394632efde6b58f60de6cd899ecf`.
- Deployed installer to `https://teammidnite.tv/NeonMulti/download.php` as `Neon-Multistream-1.3.81-x64.exe` and `Neon-Multistream-Latest.exe`.


## 1.3.80 — 2026-09-14

- Constrained the actual Vertical Clean container and cards to a responsive side column, with a configurable 380px default and Left/Right anchoring. The rest of the OBS canvas remains transparent.
- Preserved URL-selected overlay settings when live settings arrive and disabled caching of served overlay assets.
- Preserved the self-generated Neon Test messages and verified card widths, text wrapping, and both anchors in Chromium at 1920px and 320px canvas widths.

- Built Windows x64 portable executable: `Neon MultiStream Chat-1.3.80-x64.exe`.
- Build SHA-256: `cdc712d7017afcbed3155eb29041a7f3d8ce1dd1b9ff5ad29ee2154e76a0e281`.
- Verified packaged version and overlay assets against source; Windows runtime/OBS testing remains to be performed.

## 1.3.79 — 2026-09-14

- Refined the "Vertical Clean" OBS chat overlay layout to anchor a narrow 380px vertical column directly to either the Left or Right edge of full-width transparent canvases (1920×1080) without horizontal card stretching or centering.
- Enhanced compact message formatting: author badges, platform icon, username, and pronouns on the primary header row, with message text and inline emotes wrapped neatly below.
- Standardized "Send Test Message" as a self-generated Neon diagnostic overlay test (Author: "Neon Test", Platform: "neon", Message: "This is a Neon Multistream Chat overlay test.") that bypasses platform filters, omits external platform badges, and is accessible via `/api/overlay/test`, `/api/overlay-test`, and IPC `overlay:send-test`.

### Release

- Public executable SHA-256:
  `989fe5553a7eee54814dbfc46c3515942b1db03ca8b4cf25d4a1d4b782105f9b`.


## 1.3.78 — 2026-09-14

- Added a dedicated "Vertical Clean" OBS chat overlay theme designed specifically for narrow, vertical side column stream layouts (e.g. 350×900 or 450×1080).
- Engineered responsive vertical stacking with automatic message wrapping, subtle translucent background tint, crisp text shadowing, and micro-slide animations without horizontal scrollbars.

### Release

- Public executable SHA-256:
  `4bf0326a9e9ee117340c64f93d794295c4edb2aa8ea1d48e7eaab1e2bb5e15d9`.


## 1.3.77 — 2026-09-14

- Fixed oversized Velora broadcaster and event badge rendering in the OBS Overlay by strictly constraining `.user-badge-image`, `.velora-official-badge`, `.velora-provider-badge`, and inline emotes to proper chat font proportions.
- YouTube Live is currently being stubborn with live chat discovery / quota rate limits; investigating broker and stream polling improvements.

### Release

- Public executable SHA-256:
  `2c643c8251a65c2e6fa5e4e9ad8e4a9750394d1095a210751393c7b5beac2331`.


## 1.3.76 — 2026-09-14

- Added real-time OBS Chat Overlay integration featuring both a frameless transparent Pop-Out desktop window and a direct OBS Browser Source URL (`http://127.0.0.1:39111/overlay`).
- Embedded a lightweight local HTTP & Server-Sent Events (SSE) server for instant multi-platform chat streaming (Twitch, YouTube, Kick, VPZone, Velora) with zero lag.
- Built a comprehensive Overlay Customization modal with theme presets (Neon Glass, Clean Transparent, Cyber Glow, Solid Dark), message fade-out timers, font scaling, platform filters, and a one-click "Send Test Message" trigger.
- Added live moderation and clear synchronization: deleting messages or timing out users immediately removes their messages from the stream overlay.
- Fixed background Twitch Channel Point redemption auth failure (`not_authenticated`) by adding automatic NeonLogin session token refresh on 401 expiration.
- Added full unit test suite coverage for overlay asset integrity, local HTTP serving, and SSE event streaming.

### Release

- Public executable SHA-256:
  `52090f5e87c9ac267f28e163555430ad4bc123fc87751244c494481a194ef44f`.


## 1.3.75 — 2026-09-12

- Fix Twitch redemption connections reporting success before subscription confirmation. Recover from disconnects, missing keepalives, and network failures; transfer subscriptions correctly during Twitch-requested reconnects.
- Show authorization failures and stop the redemption connection on logout or account changes.
- Consume Velora's actual `pointsCelebration` event and `points-celebration` history cards, including `itemName`, `cost`, `message`, and `createdAt`. Remove duplicate live routing and deduplicate by redemption ID.
- Suppress duplicate Twitch reward chat messages in either arrival order, scoped to the channel, reward, viewer, and input.
- Validation: transport lifecycle tests and renderer tests for both providers. Live viewer redemptions still require verification in the updated desktop client.


## 1.3.74 — 2026-09-08

- Added full support for Velora Point redemption notices with gold accent styling, reward title, input text, and diamond (`◆`) point cost.
- Exposed `onVeloraRedeem` and `onVeloraJoin` in Electron preload bridge and normalized socket payload dispatching.
- Added Velora chatter join announcements with rate-limited deduplication.
- Fixed `addVeloraMessage` syntax parsing and resolved duplicate `velora:mark-seen` IPC handler registration.

### Release

- Public executable SHA-256:
  `e33f2b77a8f61135da08e77b4bdb57548f63e2e34fb0d398ee879a15a695b3bf`.

## 1.3.73 — 2026-09-08

- Support colon-wrapped Velora subscriber and channel emotes (e.g. `:KlumaNodders:`) alongside bare emote codes so picker and typed colon codes render as images rather than literal text.
- Ensure all Velora emote collections are loaded without skipping subscriber collections.
- Index clean, lowercase, and colon-wrapped variants in the Velora emote catalog for fast lookups.
- Fix sender emote discovery for colon-prefixed codes in live messages and historical chat.

### Release

- Public executable SHA-256:
  `7ae3c95cad375f9946569d8cadc7346594f65056c71fb665a94fbe14d9a6c84b`.

## 1.3.72 — 2026-08-28

- Use the official supplied Velora gold SVG mark in inline creator previews.
- Convert rich Velora bio HTML into readable plain text so formatting tags never appear in chat cards.

## 1.3.71 — 2026-08-28

- Replaced generic website previews for direct `velora.tv/<creator>` links with Velora-style creator cards embedded in chat.
- Creator cards place public profile text over the creator banner, with avatar, display name, pronouns, live/category status, and bio.

## 1.3.70 — 2026-08-28

- Added click-to-open Velora chatter profile cards with public banner artwork, avatar, display name, pronouns, live/category metadata, bio, and a direct Velora profile link.
- Profiles load on demand and are cached during the session to keep unified chat responsive.

## 1.3.69 — 2026-08-21

- Show VPZone connection attempts and failures in chat and the persistent Notices
  view instead of silently updating only the Connections panel.
- Detect stalled VPZone WebSocket handshakes after 12 seconds, report the failure,
  and continue automatic reconnection attempts.

## 1.3.68 — 2026-08-16

- Handled Kick/Pusher protocol reconnect advisories (`code: 4200` and `4201`) silently and immediately instead of misreporting them as subscription rejection errors.
- Improved WebSocket reconnect handling to smoothly re-establish chatroom subscription without backoff delay or false alarm notices.

### Release

- Public executable SHA-256:
  `4520c9dd8ebae6f4bb893dcd04275552d283d4824aed141f1e5828d241ca07ae`.

## 1.3.67 — 2026-08-16

- Added Velora API exact badge slug mapping for `staff-community` to render the Community Staff badge image asset.
- Removed arbitrary fallback placeholder dots for unknown/unmapped badges, preventing stray square dots from rendering in chat.

### Release

- Public executable SHA-256:
  `78427b746340a4fd482fafd255ae92c30a21370a6a2b3ac62619d0a4840bc7cf`.

## 1.3.66 — 2026-08-16

- Upgraded badge key resolution to inspect `slug`, `name`, `id`, and `role` before generic `type` descriptors so Community Staff and role badges never degrade to placeholder icons.
- Mapped all Velora Community Staff badge aliases and direct image URLs across active and historical messages.

### Release

- Public executable SHA-256:
  `4cbc6498e103812897a9ac1deba8c6f9e68d3c606c2cb7b9b25ff6e5b20748ae`.

## 1.3.65 — 2026-08-16

- Fixed system notice layout alignment and column spacing so platform tags never overlap notice text.
- Added official Velora Community Staff badge asset mapping (`https://velora.tv/velora-badges/VeloraCommunityManagement.png`).
- Renamed the error log tab to **Notices**, retaining historical provider connection state, errors, and system events permanently for the session.
- Excluded high-volume chat join notices from the permanent Notices log so it stays clean and focused on connection state and errors.

### Release

- Public executable SHA-256:
  `f2b249221d2530d02d10f09e48977180a06266aee46881410e251d0506920bb1`.

## 1.3.64 — 2026-08-16

- Renamed the combined stream tab label to **ALL** to maximize tab bar room.
- Added a dedicated **Errors** history tab and view to review historical connection failures, disconnect notices, and YouTube API quota limits.
- Error events and system notices are now retained in the Errors event log across the entire session with quick search filtering and manual clearing support.

### Release

- Public executable SHA-256:
  `6364e8e7e9f51b22bbef0e394ae7be5cee969441c1805756c2091d3728e305ac`.

## 1.3.63 — 2026-08-16

- Upgraded Velora real-time chat connector with dual WebSocket and Polling transport fallback.
- Streamlined `joinChannel` socket handshake callback handling to prevent false timeout rejections.
- Preserved Velora badge catalog cache across channel switches and reconnects.

### Release

- Public executable SHA-256:
  `50e98e5186d68891ef8c0c715ad9b702be9521e7be7ba7149719a8a18b57fb97`.

## 1.3.62 — 2026-08-16

- Added Pusher WebSocket keepalive ping intervals (30s) for Kick chat to prevent idle socket dropouts.
- Cached resolved Kick chatroom IDs in both memory and Electron main process to eliminate redundant HTTP lookups and Cloudflare edge blocks during reconnection.
- Reconnections to Kick now subscribe directly to known chatroom channels with zero discovery overhead.
- Suppressed repetitive "Connected to Kick channel" system messages on silent background reconnections.

### Release

- Public executable SHA-256:
  `62fea3d7ea9f4316c51a8842eac2fe283d4fb2630dea4475fbab4333e5bf6883`.

## 1.3.61 — 2026-08-15

- Decouple YouTube account authentication from live chat polling to prevent API quota burn.
- Restrict broadcast discovery strictly to active livestreams (`broadcastStatus=active`), ignoring scheduled or upcoming broadcasts.
- Eliminate the automatic 15-second background status retry loop when no active broadcast exists.
- Implement sticky session-level quota protection (`quotaBlocked`) to instantly halt all YouTube API calls when `quotaExceeded` is returned by Google.
- Maintain separate UI states for account linking (`Linked`) vs active broadcast connectivity (`Live`).

### Release

- Public executable SHA-256:
  `77cadbf55316efd0d1d4013d56020613355acc4587ef9b20c615965ccbcbe53c`.

## 1.3.60 — 2026-08-15

- Fix the Windows taskbar/application icon showing the default Electron atom by
  embedding the Neon MultiStream icon (and version metadata) into the packaged
  executable.
- Ship the application icon with the packaged app and point the BrowserWindow
  icon at the shipped file so the window icon also loads correctly at runtime.

### Release

- Public executable SHA-256:
  `7da83cad072c532db6dfc685fadb3fd3b4d4f4b63359ad3964d26f0cb6744253`.

## 1.3.59 — 2026-08-15

- Updated MultiStream desktop app icon to the official TeamMidnite channel icon.

### Release

- Public executable SHA-256:
  `8f2bddbcda8c1fa9543a4893c59660cfc4e74bdfda4bbc129f70e69ce42ff28e`.

## 1.3.58 — 2026-08-15

- Dynamic sync with Velora badge catalog endpoint (`/api/badges/catalog`).
- Support for official Velora event badges including Pride Month 2026, New Year 2026, Christmas 2025, and Halloween 2025.
- Automatic animated and static asset rendering for all present and future catalog badges.

### Release

- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `ceb7a6f7b9266234d952eb9ce78d46b4ba499ebb1436d80a8ea486e6031e0477`.

## 1.3.57 — 2026-08-15

- Render verified official Velora PNG badge assets for Broadcaster, VIP, Bot, and Staff.
- Retain clean vector provider badge fallbacks for customizable or unmapped badge types.

### Release

- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `2931842b385c2fc3e452e262446142118c3006907f55f18780343dd518b2d130`.

## 1.3.56 — 2026-08-15

- Consume Velora presentation badges directly from message payload for 1-to-1 fidelity with Velora chat.
- Evaluate channel ownership authoritatively using `message.userId === message.channelId`.
- Eliminate synthetic badge manufacture from generic user roles or global permissions.

### Release

- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `d872a4f4303fa2506e971f72e14a6ad8f3fb42baf3e36662d9b71abc534db99f`.

## 1.3.55 — 2026-08-15

- Directly consume raw Velora badge arrays and suppress redundant channel-level subscriber/moderator badges for the broadcaster.
- Preserve legitimate user badges for all other chatters (moderators, subscribers, VIPs, verified, and partners).
- Add Velora bot badge styling and support for automated system accounts.

### Release

- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `1039e5a3fc58da2be78d99e86375b153ec6dc4614932fbd48a73ce2de540a6f4`.

## 1.3.54 — 2026-08-15

- Separate the Velora source platform mark from user identity badges so general Velora chatter accounts no longer manufacture broadcaster status.
- Render genuine Velora channel/site badges (subscriber, moderator, VIP, verified, partner, staff, admin, and custom badge assets).
- Deterministically award the pink camera Broadcaster badge only when the sender's user ID or login matches the connected channel owner.
- Preserve legitimate user badges without discarding them when the broadcaster speaks.

### Release

- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `d063aac45f2535bd5eae720559d35ce8c1f69c329b29efbc7d4a6f9e5f9a08bd`.

## 1.3.53 — 2026-08-14

- Re-enable YouTube Live chat connection card and dedicated tab with active polling and message sending.
- Support both `youtube.readonly` (view YouTube account / read live chat) and `youtube` (manage live chat messages) OAuth scopes.
- Restore account user avatars for all signed-in NeonLogin accounts, properly resolving profile picture URLs and fallbacks.

### Release

- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `d7e051354a7d2dd019b6e9f42bac958372c4ce34d8ce7b630237eb703447a042`.

## 1.3.52 — 2026-08-12

- Announce Twitch viewers who join chat with a brief "just joined" system
  notice on the primary connection and every monitored channel.
- Notices appear for JOIN lines only (no PART/leave notices), expire after 20
  seconds like other system messages, and are deduplicated per user for 60
  seconds so repeated joins and duplicate deliveries do not repeat.
- The connector's own anonymous or logged-in nickname is never announced.

### Release

- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `20d5c3d197de3d56bedd9174334be2307ac5f5fd3b058c52df7dda7a7a721b62`.

## 1.3.51 — 2026-08-12

- Temporarily disable YouTube chat behind the YOUTUBE_CHAT_ENABLED flag while
  duplicate-message ingestion and Data API quota consumption are investigated.
- The YouTube platform tab and connection card stay visible but are clearly
  marked OFF; no status, message, emote, or send request is issued while the
  flag is false.

## 1.3.50 — 2026-08-12

- Fix Twitch point redeems not connecting: the server-side redemption broker
  was excluded from the Apache PHP allow-list, so every request was proxied to
  the Node API and returned 503. The broker now serves directly again.
- Allow already-linked Twitch accounts to re-authorize through NeonLogin so
  grants missing `channel:read:redemptions` can be upgraded without unlinking.
- Turn the Twitch card into a clickable Reconnect action when redemptions need
  a new grant, retry automatically after re-authorization, and restore the
  reading detail once redeems start flowing.

## 1.3.49 — 2026-08-12

- Subscribe to Twitch's official Channel Points custom reward redemption
  EventSub so redeems appear even when the viewer provides no chat input.
- Render reward title, viewer input, and point cost in a dedicated redemption
  notice and deduplicate the IRC copy produced by input-required rewards.
- Provide a clear one-time Twitch reconnect requirement for existing grants
  that do not include `channel:read:redemptions`.

## 1.3.48 — 2026-08-12

- Make the existing platform filter tabs share the available width with
  responsive padding, gaps, and type sizing instead of forcing 130px per tab.
- Preserve horizontal overflow for exceptionally narrow layouts while hiding
  the native browser scrollbar.

## 1.3.47 — 2026-08-12

- Normalize restored Velora badge aliases, user-role arrays, and subscriber,
  moderator, and VIP flags into the same badges used for live chat.
- Render provider-supplied historical badge images when available and suppress
  non-display roles instead of showing generic gray dots.
- Apply the correction while rendering so already-saved chat history is fixed
  without requiring users to clear it.

## 1.3.46 — 2026-08-12

- Keep the author badge, username, and pronouns at the top of rich-preview
  messages beside the linked text instead of vertically centering them against
  the full preview card.

## 1.3.45 — 2026-08-12

- Keep author identity, timestamps, and provider badges aligned at the top of
  messages containing rich link preview cards.
- Render Velora's provider-specific broadcaster camera and role badge styling
  instead of generic symbolic Twitch-style fallbacks.
- Match Velora's badge priority by hiding redundant subscriber status when the
  broadcaster badge is present.

## 1.3.44 — 2026-08-12

- Make web links clickable in Twitch, YouTube, Kick, VPZone, and Velora chat,
  opening them safely in the user's default browser.
- Add cached Open Graph link previews with the destination image, site name,
  title, and description, matching the rich preview experience on Velora.
- Reject local and private-network targets from metadata preview fetching.

## 1.3.43 — 2026-08-12

- Restore the animated star field on Velora Galaxy message effects by matching
  the provider's underscore-based effect keys.
- Add two depth layers of brighter, twinkling stars while keeping chat content
  above the effect and preserving the reduced-animation setting.

## 1.3.42 — 2026-08-12

- Add a real same-origin Kick page fallback when Kick rejects background channel
  discovery requests, without hardcoding or assuming any creator username.
- Detect missing and rejected Pusher chat subscriptions instead of leaving Kick
  in an indefinite connecting state, then retry with bounded backoff.
- Clarify that Kick edge blocking does not require an account reconnect.

## 1.3.41 — 2026-08-12

- Resolve Kick chatrooms through Electron's Chromium network session so Kick's
  edge does not reject the desktop renderer's `file://` request origin.
- Report Kick as connected only after Pusher confirms the channel subscription,
  with visible errors and automatic reconnects when discovery or chat drops.
- Treat Velora channel identities and subscriber-emote codes case-insensitively
  so restored sender catalogs survive provider capitalization changes.
- Use “Neon MultiStream Chat” as the clean product/window title and move the
  version into the Connections panel.

## 1.3.40 — 2026-08-12

- Fix VPZone follows and other recent events disappearing from the combined chat
  after the first socket reconnect, because VPZone replays recent events on every
  connection and the client was discarding them as duplicates.
- Accept the per-connection event replay after each reconnect while still
  preventing duplicate floods against messages already rendered.

## 1.3.39 — 2026-08-12

- Add "Register on Velora" links to the connection card and the add-channel form.
- Render official Kick and VPZone logos in chat badges and connection cards in
  place of the K and V text placeholders.
- Restyle Kick and VPZone message badges with tinted, bordered frames so each
  brand logo stays visible.
- Fix restored Velora chat history by requesting it with the resolved channel
  UUID, which Velora requires, so historical messages actually load.
- Preload sender emote catalogs when history restores so subscriber emotes render
  in older messages and preserve sender accent colors.

## 1.3.38 — 2026-08-12

- Discover a Velora sender's channel emote set when they use a subscriber emote
  outside their own channel.
- Cache sender emote catalogs per connection and rerender the original message
  once the external emote asset is available.

## 1.3.37 — 2026-08-11

- Increase Velora emotes from 42px to 52px when the sender applies Gigantify.
- Preserve the existing larger 42px presentation for ordinary Velora emotes.

## 1.3.36 — 2026-08-11

- Deliver Velora's emote catalog with the confirmed chat connection so emotes cannot be lost to a post-connect race.
- Correct compound glow and galaxy effect selectors so each Velora color renders accurately.
- Restrict the animated star field to galaxy effects instead of applying it to every effect.

## 1.3.35 — 2026-08-11

- Load Velora's public, channel-aware emote collections when chat connects.
- Render exact Velora emote codes with their animated provider-hosted WebP assets.

## 1.3.34 — 2026-08-11

- Replace the placeholder Velora chat "V" with the official supplied SVG mark.
- Use the mark on the Velora connection card and individual Velora message badges.

## 1.3.33 — 2026-08-11

- Resolve Velora channels to their provider UUID before joining real-time chat.
- Wait for Velora's confirmed channel-join acknowledgement before reporting a successful connection.
- Add explicit handshake timeouts, actionable failure text, and an Experimental label while stability testing continues.

## 1.3.32 — 2026-08-11

- Replace the Velora polling prototype with its public real-time Socket.IO chat connection.
- Render Velora glow, galaxy, rainbow, and Gigantify message effects in the unified chat.
- Carry Velora pronouns, badges, author colors, timestamps, and message deletion events into the desktop view.

## 1.3.31 — 2026-08-11

- Add Velora as a first-class chat tab and pane option.
- Read public Velora channel chat through the supported history endpoint with automatic polling and deduplication.
- Save the selected Velora channel per NeonLogin identity and clearly mark the connector as read-only.

## 1.3.30 — 2026-08-02

- Send an active Twitch IRC keepalive every minute so quiet chats remain connected.
- Only reconnect after the keepalive itself receives no server response, eliminating three-minute false disconnects during streams.
- Apply the same connection health behavior to primary and extra monitored Twitch chats.

## 1.3.29 — 2026-08-02

- Constrain the chat pane correctly so its message list is a real scrollable viewport.
- Follow new messages automatically while the viewer is at the bottom.
- Preserve manual scroll position when the viewer scrolls up to read older messages.

## 1.3.28 — 2026-08-02

- Keep primary and extra Twitch chats alive with independent watchdogs and automatic reconnects.
- Prevent emote refreshes from accidentally disabling the primary Twitch connection watchdog.
- Cap retained in-memory chat history and coalesce message renders and storage writes to prevent long-running chats from exhausting resources.

## 1.3.27 — 2026-08-02

- Use Alejo Pereyra's current `api.pronouns.alejo.io/v1` API, matching current Chatterino.
- Retain a legacy API fallback during Alejo's data migration.
- Recheck users without a pronoun after two minutes instead of caching a missing result for 30 minutes.

## 1.3.26 — 2026-08-02

- Render official Twitch global and channel-specific chat badge images from Twitch Helix.
- Show opt-in Twitch pronouns from Alejo Pereyra's Pronouns API beside chat identities.
- Cache pronoun results and retain symbolic badge fallbacks when either API is unavailable.

## 1.3.25 — 2026-08-02

- Discover linked VPZone accounts through the authenticated broker even when NeonLogin's initial payload omits VPZone fields.
- Connect to VPZone public read-only chat when OAuth tokens are missing, including while the stream is offline.
- Refresh expiring VPZone OAuth tokens with rotation and keep automatic WebSocket recovery enabled.

## 1.3.24 — 2026-08-02

- Show the signed-in user's current Twitch profile picture in the account avatar.
- Fall back to a generic Twitch logo when Twitch has no profile picture or the image cannot load.

## 1.3.23 — 2026-08-02

- Replace the generic Twitch “T” chat badge with the recognizable Twitch logo glyph.

## 1.3.22 — 2026-08-02

- Reconnect Twitch chat automatically after network interruptions, computer sleep, or stale IRC connections.
- Keep retrying VPZone chat with exponential backoff instead of remaining disconnected after a socket or broker failure.
- Add WebSocket heartbeat checks so silent VPZone connection failures are detected and repaired.

## 1.3.21 — 2026-08-02

- Open the desktop window at 578 × 1000 by default.
- Keep the window resizable while enforcing a 578-pixel minimum width so the platform tabs cannot be compressed.

## 1.3.20 — 2026-08-01

- Hide the setup-connections empty state when a chat provider is already linked or configured.
- Show a quiet connected-state message while waiting for the first chat message.
- Show a distinct no-results message when filtering chat.

## 1.3.19 — 2026-08-01

- Isolated saved chat history and monitored channels by NeonLogin identity.
- Removed hardcoded developer-channel auto-connections.
- Only auto-connect linked Twitch and Kick identities, using the linked provider username.
- Fully reset live connections and visible messages when the signed-in identity changes.
- Ignore late Kick socket events from a previous identity.

## 1.3.18 — 2026-07-31

### VPZone button state binding & Check for Updates integration

- Drove VPZone row subtitle and button state from single authoritative isLinked boolean.
- Updated VPZone button state to Linked when connected, matching YouTube and Kick.
- Added Check for Updates button to Streaming connections modal.

## 1.3.17 — 2026-07-31

### In-app update downloader target fix

- Updated in-app update prompt target URL to point to the secure download broker.
- Guarantees instant update download without static path 404 issues.

## 1.3.16 — 2026-07-31

### Download headers & build cache-busting release

- Updated downloads directory headers to prevent browser/CDN 404 caching.
- Fresh build v1.3.16 for desktop client.

## 1.3.15 — 2026-07-31

### VPZone & platform account link state-binding fix

- Fixed VPZone connection state binding in Streaming connections modal.
- Ensured backend account-link data is the single source of truth.
- Disentangled account linked status from active live-chat session status across all platform rows.
- Added diagnostic logging for VPZone account link state & user identification.

## 1.3.14 — 2026-07-31

### Streamlined connections menu & Join Extra Channels interface

- Re-worded the "Add a chat" section into "JOIN EXTRA CHANNELS" with explicit Twitch/Kick channel inputs.
- Updated VPZone initial card status and button handlers.

## 1.3.13 — 2026-07-31

### Unified platform channel display & connection status

- Updated all platform cards to explicitly show "Connected to #user" with authenticated channel handles.
- Refined YouTube and VPZone offline and linked connection status details.

## 1.3.12 — 2026-07-31

### Multi-platform user account isolation & VPZone disconnect controls

- Removed all hardcoded fallback defaults across Twitch, YouTube Live, Kick, and VPZone.
- Ensured every chat connector dynamically connects to the authenticated user's own linked accounts.
- Added interactive Connect and Disconnect controls for VPZone in the Connections menu.
- Updated unlinked platform states to show clear prompts and link-account actions.

## 1.3.11 — 2026-07-30

### Chat clearing and automatic cleanup

- Added a toolbar clear button that removes messages from the selected platform,
  or all messages when All Streams is selected.
- Automatically remove a monitored Twitch creator's messages when that channel
  is removed.
- Clear the previous creator's messages when the primary Twitch or Kick channel
  is replaced.
- Clear stored YouTube and VPZone messages when those connectors are unhooked.
- Synchronize every clear operation with local history so removed messages do
  not return after the app restarts.
- Published the versioned Windows build and updated the website, release
  manifest, devlog, and `Neon-Multistream-Latest.exe`.
- Public executable SHA-256:
  `06878e015d8353a359d77b001ee521be1dbb84ad5b9e69d253e989b7ba3e74e2`.

## 1.3.10 — 2026-07-30

### User badges and channel attribution

- Added Twitch broadcaster, moderator, VIP, subscriber, and founder badges.
- Added YouTube owner/member badges and support for badge metadata supplied by
  Kick and VPZone.
- Added a compact channel label beneath each username so messages in combined
  chat identify the creator's chat where they were posted.
- Store badge and channel metadata with locally retained messages.

## 1.3.9 — 2026-07-30

### Automatic update notifications

- Added a no-cache release-manifest check shortly after every app launch.
- Compare semantic versions and prompt only when a newer release is available.
- Open the official TeamMidnite installer when the user chooses to update.
- Keep update checks silent when the installed version is current or the device
  is offline.

## 1.3.8 — 2026-07-30

### Multi-chat monitoring and persistent history

- Changed Add Channel into a platform chooser for Twitch, Kick, YouTube Live,
  and VPZone.
- Added simultaneous public Twitch chat monitoring with saved, removable
  channel connections.
- Added persistent local retention for the latest 500 chat messages.
- Restore retained messages at full brightness after restart.
- Added a proper right-click moderation menu for delete, timeout, and ban
  actions when Twitch confirms moderator access.
- Automatically correct dark username colors to a WCAG-style contrast target
  against the chat background.

## 1.3.7 — 2026-07-30

This release completes the multistream chat emote, live-state, moderation, and
message-lifecycle work developed across versions 1.3.1 through 1.3.7.

### Twitch

- Render native Twitch emotes, including subscriber emotes, from IRC emote tags.
- Load channel and global emotes from FrankerFaceZ, BetterTTV, and 7TV.
- Fetch third-party catalogs in Electron's main process to avoid renderer CORS
  failures, with provider timeouts and automatic retry.
- Prevent duplicate IRC connections and ignore events from superseded sockets.
- Use linked Twitch credentials when available and expose delete, timeout, and
  ban controls only when IRC confirms broadcaster or moderator privileges.
- Apply Twitch deletion, timeout, ban, and clear-chat events locally.
- Check stream state every 10 seconds and retain previous messages as readable
  history when the stream goes offline.

### YouTube

- Render YouTube custom emoji shortcuts using image metadata from the active
  broadcast's public live-chat page.
- Load and cache YouTube's public generic emoji catalog once per app session:
  3,782 entries and 2,120 text shortcuts at the time of implementation.
- Refresh public live-chat metadata only when an unknown colon code appears.
  This discovers member/subscriber emotes after they are used without consuming
  additional YouTube Data API quota.

### Kick

- Parse Kick's `[emote:<id>:<name>]` message tokens.
- Render consecutive static or animated Kick emotes through Kick's public CDN.

### VPZone

- Follow the official public chat embed's behavior by consuming the `emoteMap`
  included with each WebSocket message.
- Render both bare emote names and colon-wrapped emote codes.
- Retain discovered mappings for later messages and use the public channel
  emote catalog as an optional fallback.
- Prevent duplicate VPZone connection attempts while the WebSocket is opening.

### Chat experience

- Operational system notices remain visible for 16 seconds, fade for 4 seconds,
  and are removed after 20 seconds so they do not crowd out viewer chat.
- Added shared inline emote styling and hover-accessible moderation controls.
- Preserved previous-stream messages as readable local history.

### Release and deployment

- Restored unique version numbers after the original 1.3.0 filename caused
  browser/CDN cache collisions.
- Published unique Windows builds for each subsequent release and updated both
  the versioned website link and `Neon-Multistream-Latest.exe`.
- Version 1.3.7 public executable SHA-256:
  `78af97a6a368f22e49c36e3d5edb7cd2e512de2f8d879ca32ece028f6148adaa`.

### Validation

- `node --check` passed for renderer, preload, and Electron main-process files.
- `git diff --check` passed.
- `npm run build:win` completed successfully for version 1.3.7.
- The deployed versioned executable and Latest alias matched the local build
  checksum, and the public versioned URL returned HTTP 200.
