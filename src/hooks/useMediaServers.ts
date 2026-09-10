import useSettings from '@app/hooks/useSettings';
import { MediaServerType } from '@server/constants/server';
import { useMemo } from 'react';

export const getMediaServerName = (serverType: MediaServerType): string => {
  switch (serverType) {
    case MediaServerType.PLEX:
      return 'Plex';
    case MediaServerType.JELLYFIN:
      return 'Jellyfin';
    case MediaServerType.EMBY:
      return 'Emby';
    default:
      return '';
  }
};

interface MediaServers {
  /** Every media server the install is connected to */
  enabled: MediaServerType[];
  /** The server that drives naming and deep link defaults */
  primary: MediaServerType;
  plexEnabled: boolean;
  /** Jellyfin and Emby share one connection, so this covers both */
  jellyfinEnabled: boolean;
  /** Whichever of Jellyfin/Emby is connected, if either is */
  jellyfinServerType?: MediaServerType.JELLYFIN | MediaServerType.EMBY;
  /** True when more than one media server is connected */
  hasMultiple: boolean;
  /** Display name of the primary server */
  primaryName: string;
  /** Display name of the connected Jellyfin/Emby server */
  jellyfinName: string;
}

/**
 * Resolves which media servers this install is connected to. Configurations
 * that predate multi media server support only report `mediaServerType`, so
 * fall back to it when the list is missing.
 */
const useMediaServers = (): MediaServers => {
  const { currentSettings } = useSettings();

  return useMemo(() => {
    const configured = (currentSettings.enabledMediaServers ?? []).filter(
      (serverType) => serverType !== MediaServerType.NOT_CONFIGURED
    );

    const enabled =
      configured.length > 0
        ? [...new Set(configured)]
        : currentSettings.mediaServerType !== MediaServerType.NOT_CONFIGURED
          ? [currentSettings.mediaServerType]
          : [];

    const jellyfinServerType = enabled.includes(MediaServerType.EMBY)
      ? MediaServerType.EMBY
      : enabled.includes(MediaServerType.JELLYFIN)
        ? MediaServerType.JELLYFIN
        : undefined;

    return {
      enabled,
      primary: currentSettings.mediaServerType,
      plexEnabled: enabled.includes(MediaServerType.PLEX),
      jellyfinEnabled: !!jellyfinServerType,
      jellyfinServerType,
      hasMultiple: enabled.length > 1,
      primaryName: getMediaServerName(currentSettings.mediaServerType),
      jellyfinName: jellyfinServerType
        ? getMediaServerName(jellyfinServerType)
        : '',
    };
  }, [currentSettings.enabledMediaServers, currentSettings.mediaServerType]);
};

export default useMediaServers;
