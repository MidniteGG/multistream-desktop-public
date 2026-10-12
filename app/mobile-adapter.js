/*
 * Browser/PWA transport boundary.
 *
 * The desktop client receives these calls from Electron IPC. The mobile
 * client keeps the same app surface but talks to same-origin HTTPS brokers,
 * so provider credentials never enter the browser bundle.
 */
(function installMobileAdapter() {
  if (window.neonDesktop || window.neonMobile) return;

  const api = (path, options = {}) => fetch(path, {
    credentials: 'include',
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    ...options
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const error = new Error(payload.error || payload.message || `Mobile API returned HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  });

  const query = (path, values = {}) => {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    });
    return api(`${path}${params.toString() ? `?${params}` : ''}`);
  };

  const mobile = {
    __browserAdapter: true,
    getAppInfo: async () => ({ version: 'mobile-beta', platform: 'web' }),
    getNeonLoginStatus: async () => {
      try {
        const profile = await api('/NeonLogin/api/userinfo.php');
        return {
          authenticated: true,
          user: {
            id: profile.id,
            username: profile.username,
            displayName: profile.display_name || profile.name || profile.username,
            avatarUrl: profile.avatar_url || profile.picture || '',
            links: profile.links || {},
            twitchAuth: profile.twitchAuth || {}
          }
        };
      } catch {
        return { authenticated: false };
      }
    },
    signInWithNeonLogin: async () => {
      const redirect = `${window.location.origin}${window.location.pathname}${window.location.search}`;
      window.location.assign(`/NeonLogin/?redirect=${encodeURIComponent(redirect)}`);
      return { authenticated: false };
    },
    signOutNeonLogin: async () => {
      window.location.assign('/NeonLogin/account.php?action=logout');
      return { authenticated: false };
    },
    openExternal: (url) => window.open(String(url || ''), '_blank', 'noopener,noreferrer'),
    getDesktopNotices: () => query('/api/multistream-notices.php'),
    checkForUpdates: async () => ({ current: true, version: 'mobile-beta' }),

    getTwitchSession: (channel) => query('/api/multistream-twitch-redemptions.php', { action: 'status', channel }),
    getTwitchLiveStatus: (channel) => query('/api/check-twitch-status.php', { username: channel, channel }),
    getTwitchChatAssets: (channel) => query('/api/multistream-twitch-assets.php', { channel }),
    getTwitchEmotes: (channel) => query('/api/multistream-twitch-assets.php', { channel }),
    getTwitchComposerEmotes: () => Promise.resolve({ emotes: [] }),
    getTwitchPronouns: () => Promise.resolve({ display: '' }),
    connectTwitchRedemptions: () => Promise.resolve({ connected: false, mobile: true }),
    sendTwitchMessage: (options = {}) => api('/api/multistream-twitch-redemptions.php?action=send', { method: 'POST', body: JSON.stringify(options) }),

    getYouTubeStatus: () => query('/api/multistream-youtube.php', { action: 'status' }),
    getYouTubeMessages: (options = {}) => query('/api/multistream-youtube.php', { action: 'messages', ...options }),
    getYouTubeEmotes: () => Promise.resolve({ emotes: [] }),
    sendYouTubeMessage: (options = {}) => api('/api/multistream-youtube.php?action=send', { method: 'POST', body: JSON.stringify(options) }),

    getVeloraMessages: (options = {}) => {
      const channel = options.channelId || options.channel || '';
      return query('/api/multistream-velora.php', { action: 'history', channel });
    },
    getVeloraProfile: (channel) => query('/api/multistream-velora.php', { action: 'profile', channel }),
    getVeloraBadgeCatalog: () => query('/api/multistream-velora.php', { action: 'badges' }),
    getVeloraEmotes: (channel) => query('/api/multistream-velora.php', { action: 'emotes', channel }),
    resolveSevenTvEmotes: () => Promise.resolve({ emotes: [] }),
    connectVelora: (channel) => query('/api/multistream-velora.php', { action: 'connect', channel }),
    monitorVelora: () => Promise.resolve({ connected: false, mobile: true }),
    stopMonitoringVelora: () => Promise.resolve({}),
    disconnectVelora: () => Promise.resolve({}),
    sendVeloraMessage: () => Promise.reject(new Error('Velora sending is being moved to the secure mobile broker.')),
    moderateVeloraUser: () => Promise.reject(new Error('Velora moderation is not available in the mobile beta yet.')),
    clearVeloraChat: () => Promise.resolve({}),
    veloraMarkSeen: () => Promise.resolve({}),

    getOverlaySettings: async () => ({}),
    saveOverlaySettings: async (settings) => settings,
    getOverlayInfo: async () => ({ url: '', isOpen: false }),
    broadcastOverlay: async () => {},
    onNeonLoginChanged: () => () => {},
    onVeloraEvent: () => () => {},
    onVeloraRedeem: () => () => {},
    onVeloraJoin: () => () => {},
    onTwitchRedemption: () => () => {}
  };

  window.neonMobile = mobile;
  // Keep the existing renderer unchanged while it migrates away from IPC.
  window.neonDesktop = mobile;
}());
