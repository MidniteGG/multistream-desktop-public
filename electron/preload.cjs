const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neonDesktop', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getDesktopNotices: () => ipcRenderer.invoke('app:desktop-notices'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-for-updates'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  getLinkPreview: (url) => ipcRenderer.invoke('app:link-preview', url),
  getNeonLoginStatus: () => ipcRenderer.invoke('neonlogin:status'),
  signInWithNeonLogin: () => ipcRenderer.invoke('neonlogin:login'),
  signOutNeonLogin: () => ipcRenderer.invoke('neonlogin:logout'),
  onNeonLoginChanged: (callback) => {
    const listener = (_event, auth) => callback(auth);
    ipcRenderer.on('neonlogin:changed', listener);
    return () => ipcRenderer.removeListener('neonlogin:changed', listener);
  },
  getYouTubeStatus: () => ipcRenderer.invoke('youtube:status'),
  getYouTubeEmotes: (broadcastId) => ipcRenderer.invoke('youtube:emotes', broadcastId),
  getYouTubeMessages: (options) => ipcRenderer.invoke('youtube:messages', options),
  sendYouTubeMessage: (options) => ipcRenderer.invoke('youtube:send', options),
  getTwitchSession: () => ipcRenderer.invoke('twitch:session'),
  getTwitchLiveStatus: (channel) => ipcRenderer.invoke('twitch:live-status', channel),
  getTwitchEmotes: (channel) => ipcRenderer.invoke('twitch:emotes', channel),
  getTwitchComposerEmotes: (channel) => ipcRenderer.invoke('twitch:composer-emotes', channel),
  sendTwitchMessage: (options) => ipcRenderer.invoke('twitch:send', options),
  getTwitchChatAssets: (channel) => ipcRenderer.invoke('twitch:chat-assets', channel),
  getTwitchPronouns: (username) => ipcRenderer.invoke('twitch:pronouns', username),
  connectTwitchRedemptions: () => ipcRenderer.invoke('twitch:redemptions-connect'),
  onTwitchRedemption: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('twitch:redemption', listener);
    return () => ipcRenderer.removeListener('twitch:redemption', listener);
  },
  getKickChatroom: (channel) => ipcRenderer.invoke('kick:chatroom', channel),
  getVeloraMessages: (options) => ipcRenderer.invoke('velora:messages', options),
  getVeloraProfile: (channel) => ipcRenderer.invoke('velora:profile', channel),
  getVeloraBadgeCatalog: () => ipcRenderer.invoke('velora:badge-catalog'),
  getVeloraEmotes: (channel) => ipcRenderer.invoke('velora:emotes', channel),
  resolveSevenTvEmotes: (names) => ipcRenderer.invoke('velora:resolve-7tv-emotes', names),
  connectVelora: (channel) => ipcRenderer.invoke('velora:connect', channel),
  monitorVelora: (channel) => ipcRenderer.invoke('velora:monitor', channel),
  stopMonitoringVelora: (channel) => ipcRenderer.invoke('velora:monitor-stop', channel),
  disconnectVelora: () => ipcRenderer.invoke('velora:disconnect'),
  sendVeloraMessage: (options) => ipcRenderer.invoke('velora:send', options),
  moderateVeloraUser: (options) => ipcRenderer.invoke('velora:moderate', options),
  clearVeloraChat: (channel) => ipcRenderer.invoke('velora:clear-chat', channel),
  veloraMarkSeen: (ids) => ipcRenderer.invoke('velora:mark-seen', ids),
  onVeloraEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('velora:event', listener);
    return () => ipcRenderer.removeListener('velora:event', listener);
  },
  onVeloraRedeem: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('velora:redeem', listener);
    return () => ipcRenderer.removeListener('velora:redeem', listener);
  },
  onVeloraJoin: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('velora:join', listener);
    return () => ipcRenderer.removeListener('velora:join', listener);
  },
  // OBS Overlay
  getOverlayInfo: () => ipcRenderer.invoke('overlay:info'),
  openOverlayPopout: () => ipcRenderer.invoke('overlay:open-popout'),
  closeOverlayPopout: () => ipcRenderer.invoke('overlay:close-popout'),
  toggleOverlayPopout: () => ipcRenderer.invoke('overlay:toggle-popout'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('overlay:set-always-on-top', flag),
  broadcastOverlay: (payload) => ipcRenderer.invoke('overlay:broadcast', payload),
  getOverlaySettings: () => ipcRenderer.invoke('overlay:get-settings'),
  saveOverlaySettings: (settings) => ipcRenderer.invoke('overlay:save-settings', settings),
  sendOverlayTest: () => ipcRenderer.invoke('overlay:send-test'),
  onOverlayEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('overlay:event', listener);
    return () => ipcRenderer.removeListener('overlay:event', listener);
  }
});
