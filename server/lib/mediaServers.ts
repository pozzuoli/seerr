import {
  MediaServerType,
  resolveEnabledMediaServers,
} from '@server/constants/server';
import type { MainSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { isEqual } from 'lodash';

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

export const getEnabledMediaServers = (): MediaServerType[] =>
  resolveEnabledMediaServers(getSettings().main);

const SERVER_FIELDS = ['enabledMediaServers', 'mediaServerType'] as const;

/**
 * The media server fields a general settings update would change. Connecting
 * and disconnecting servers goes through `enableMediaServer` and
 * `disableMediaServer`, which keep the list and the primary consistent, so
 * `POST /settings/main` refuses to change them. Posting back the current
 * values is allowed, so a settings round trip keeps working.
 */
export const mainSettingsServerFields = (
  body: unknown,
  current: Pick<MainSettings, (typeof SERVER_FIELDS)[number]>
): string[] => {
  if (!body || typeof body !== 'object') {
    return [];
  }

  return SERVER_FIELDS.filter(
    (field) =>
      field in body &&
      !isEqual((body as Record<string, unknown>)[field], current[field])
  );
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
