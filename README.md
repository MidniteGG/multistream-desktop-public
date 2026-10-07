# Neon Multistream Desktop

Neon Multistream Desktop is a cross-platform chat client for streamers who
want Twitch, YouTube Live, Kick, and Velora conversations together in one
compact workspace.

<p>
  <a href="https://multistream.teammidnite.tv/NeonMulti/download.php?platform=windows"><strong>⬇️ Download Latest for Windows</strong></a>
  ·
  <a href="https://multistream.teammidnite.tv/">Visit the Product Page</a>
</p>

## Highlights

- Unified and per-platform chat views for Twitch, YouTube Live, Kick, and Velora
- One-, two-, or three-pane customizable workspace
- Draggable platform tabs, per-pane filters, search, pause, message counts, and send-target controls
- Adjustable density, font size, timestamps, badges, connection events, accent colors, and visual effects
- Persistent channel and layout preferences between launches
- Compact streamer-focused design that works beside OBS or on a second monitor

## Platform features

### Twitch

- Anonymous public read-only chat for channels that do not require account linking
- Authenticated account linking through NeonLogin
- Twitch IRC WebSocket chat transport with reconnect handling
- Shared Chat source-channel attribution
- Native Twitch emote rendering and authenticated emote discovery
- Twitch EventSub support for channel chat messages and point-redemption alerts
- Helix chat sending with scope and token validation

### YouTube Live

- Authenticated live-chat discovery through the TeamMidnite broker
- Live message polling
- Channel-owner message sending
- Google access-token refresh without exposing provider tokens to the desktop renderer

### Kick

- Account-link status through NeonLogin
- Channel chat integration where supported by the connected account
- Platform-aware send controls and capability handling

### Velora

- Public read-only channel chat
- Saved channel selection and Socket.IO reconnection
- Profile and role badge enrichment
- 7TV emote support
- Points-celebration and redemption-event rendering
- Duplicate-event protection for live and historical messages

## OBS and overlay tools

- Transparent OBS Browser Source overlay
- Frameless transparent desktop pop-out overlay
- Vertical Clean layout with left/right column positioning
- Horizontal Stream Bar layout with top/bottom positioning
- Platform and role accents, source-channel labels, timestamps, badges, and fade controls
- Overlay-only bot filtering with Neon-known and custom streamer-defined bots
- Configurable column width, message density, font size, visible elements, and max-message behavior
- URL parameters for direct OBS layout overrides

## Chat and moderation experience

- Platform-aware composer that exposes only capabilities available to the connected account
- Searchable emote picker with previews, categories, and provider attribution
- Platform-specific send targets in combined chat
- Inline animated emotes and supported GIF/media rendering
- Connection notices and reconnect state handling
- Account-aware identity, badge, role, and profile enrichment
- Main-chat bot visibility can remain independent from overlay bot filtering

## Privacy and security

- OAuth and provider tokens stay in server-side brokers or OS-protected session storage where supported
- Tokens are not embedded in the packaged desktop application
- Anonymous Twitch reading remains read-only
- Authenticated sending requires the appropriate provider scopes
- The desktop renderer does not receive provider refresh tokens

## Downloads

Native packages are available for:

- Windows x64 portable executable
- macOS DMG and ZIP packages for Intel and Apple Silicon
- Linux AppImage and Debian packages for x64 and arm64

Download the latest release from the [Multistream product page](https://multistream.teammidnite.tv/).

Windows releases may display an Unknown Publisher or SmartScreen warning while
the application is distributed without a paid commercial code-signing
certificate. Verify the release checksum shown on the product page when needed.

## Development updates

Read the [public Development Log](DEVLOG.md) for release notes, fixes,
validation details, and integration updates.

## Report problems or request features

Please [report a bug or request a feature](https://github.com/MidniteGG/multistream-desktop-public/issues/new).
Search existing issues first and include:

- App version
- Operating system and architecture
- Connected platform(s)
- Steps to reproduce
- Relevant logs, screenshots, or error messages

## Project status

Neon Multistream Desktop is under active development. Platform capabilities
depend on account authorization, provider API availability, and the scopes
granted through NeonLogin.
