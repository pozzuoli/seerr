import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';

/**
 * Seerr supports connecting to more than one media server at a time (for
 * example Plex and Emby side by side). `main.mediaServerType` remains the
 * *primary* server, which drives defaults such as the media server name shown
 * in the UI, while `main.enabledMediaServers` holds every server that is
 * currently connected.
 *
 * Configurations created before multi media server support only have
 * `mediaServerType`, so every helper here falls back to it when the list is
 * missing or empty.
 */

export const getEnabledMediaServers = (): MediaServerType[] => {
  const { main } = getSettings();

  const enabled = (main.enabledMediaServers ?? []).filter(
    (serverType) =>
      serverType === MediaServerType.PLEX ||
      serverType === MediaServerType.JELLYFIN ||
      serverType === MediaServerType.EMBY
  );

  if (enabled.length > 0) {
    return [...new Set(enabled)];
  }

  // Fall back to the primary server for configurations that predate
  // multi media server support.
  if (main.mediaServerType !== MediaServerType.NOT_CONFIGURED) {
    return [main.mediaServerType];
  }

  return [];
};

export const isMediaServerEnabled = (serverType: MediaServerType): boolean =>
  getEnabledMediaServers().includes(serverType);

export const isPlexEnabled = (): boolean =>
  isMediaServerEnabled(MediaServerType.PLEX);

/**
 * Jellyfin and Emby share the same API client, settings and scanners, so they
 * are treated as a single connection everywhere except for naming and a few
 * API quirks.
 */
export const isJellyfinEnabled = (): boolean =>
  isMediaServerEnabled(MediaServerType.JELLYFIN) ||
  isMediaServerEnabled(MediaServerType.EMBY);

/**
 * Returns whichever of Jellyfin/Emby is connected, or undefined if neither is.
 */
export const getJellyfinServerType = ():
  | MediaServerType.JELLYFIN
  | MediaServerType.EMBY
  | undefined => {
  const enabled = getEnabledMediaServers();

  if (enabled.includes(MediaServerType.EMBY)) {
    return MediaServerType.EMBY;
  }

  if (enabled.includes(MediaServerType.JELLYFIN)) {
    return MediaServerType.JELLYFIN;
  }

  return undefined;
};

export const isMediaServerConfigured = (): boolean =>
  getEnabledMediaServers().length > 0;

export const getMediaServerName = (serverType: MediaServerType): string => {
  switch (serverType) {
    case MediaServerType.PLEX:
      return 'Plex';
    case MediaServerType.JELLYFIN:
      return 'Jellyfin';
    case MediaServerType.EMBY:
      return 'Emby';
    default:
      return 'Media server';
  }
};

/**
 * Adds a media server to the enabled list. The first server to be connected
 * also becomes the primary one. Callers are responsible for saving settings.
 */
export const enableMediaServer = (serverType: MediaServerType): void => {
  if (serverType === MediaServerType.NOT_CONFIGURED) {
    return;
  }

  const settings = getSettings();
  const enabled = new Set(getEnabledMediaServers());

  // Jellyfin and Emby share one connection; connecting one replaces the other.
  if (
    serverType === MediaServerType.JELLYFIN ||
    serverType === MediaServerType.EMBY
  ) {
    enabled.delete(MediaServerType.JELLYFIN);
    enabled.delete(MediaServerType.EMBY);
  }

  enabled.add(serverType);

  settings.main.enabledMediaServers = [...enabled];

  if (settings.main.mediaServerType === MediaServerType.NOT_CONFIGURED) {
    settings.main.mediaServerType = serverType;
  } else if (
    // Keep the primary pointing at a server that is still connected.
    !enabled.has(settings.main.mediaServerType)
  ) {
    settings.main.mediaServerType = serverType;
  }
};

/**
 * Removes a media server from the enabled list, promoting another connected
 * server to primary if needed. Callers are responsible for saving settings.
 */
export const disableMediaServer = (serverType: MediaServerType): void => {
  const settings = getSettings();
  const enabled = new Set(getEnabledMediaServers());

  enabled.delete(serverType);
  settings.main.enabledMediaServers = [...enabled];

  if (settings.main.mediaServerType === serverType) {
    settings.main.mediaServerType =
      [...enabled][0] ?? MediaServerType.NOT_CONFIGURED;
  }
};
