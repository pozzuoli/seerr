export enum MediaServerType {
  PLEX = 1,
  JELLYFIN,
  EMBY,
  NOT_CONFIGURED,
}

const MEDIA_SERVER_TYPES = [
  MediaServerType.PLEX,
  MediaServerType.JELLYFIN,
  MediaServerType.EMBY,
];

const isMediaServer = (serverType: MediaServerType): boolean =>
  MEDIA_SERVER_TYPES.includes(serverType);

/**
 * Every connected media server. Configurations that predate multi media
 * server support only have `mediaServerType`, so fall back to it when the list
 * is missing or empty.
 *
 * Lives here rather than in `@server/lib/mediaServers` so the client and the
 * settings module can share it without importing server code.
 */
export const resolveEnabledMediaServers = ({
  mediaServerType,
  enabledMediaServers,
}: {
  mediaServerType: MediaServerType;
  enabledMediaServers?: MediaServerType[];
}): MediaServerType[] => {
  const enabled = (enabledMediaServers ?? []).filter(isMediaServer);

  if (enabled.length > 0) {
    return [...new Set(enabled)];
  }

  return isMediaServer(mediaServerType) ? [mediaServerType] : [];
};

export enum ServerType {
  JELLYFIN = 'Jellyfin',
  EMBY = 'Emby',
}
