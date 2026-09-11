import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  MediaServerType,
  resolveEnabledMediaServers,
} from '@server/constants/server';
import {
  disableMediaServer,
  enableMediaServer,
  getEnabledMediaServers,
  getJellyfinServerType,
  isJellyfinEnabled,
  isPlexEnabled,
  mainSettingsServerFields,
} from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';

const setServers = (
  mediaServerType: MediaServerType,
  enabledMediaServers: MediaServerType[] = []
) => {
  const { main } = getSettings();
  main.mediaServerType = mediaServerType;
  main.enabledMediaServers = enabledMediaServers;
};

const currentServers = () => ({
  enabled: getEnabledMediaServers(),
  primary: getSettings().main.mediaServerType,
});

describe('connecting and disconnecting media servers', () => {
  beforeEach(() => {
    setServers(MediaServerType.NOT_CONFIGURED);
  });

  it('makes the first connected server the primary', () => {
    enableMediaServer(MediaServerType.EMBY);

    assert.deepEqual(currentServers(), {
      enabled: [MediaServerType.EMBY],
      primary: MediaServerType.EMBY,
    });
  });

  it('keeps the primary when a second server connects', () => {
    enableMediaServer(MediaServerType.PLEX);
    enableMediaServer(MediaServerType.JELLYFIN);

    assert.deepEqual(currentServers(), {
      enabled: [MediaServerType.PLEX, MediaServerType.JELLYFIN],
      primary: MediaServerType.PLEX,
    });
    assert.ok(isPlexEnabled());
    assert.ok(isJellyfinEnabled());
  });

  it('replaces Jellyfin when Emby connects, and moves the primary with it', () => {
    enableMediaServer(MediaServerType.JELLYFIN);
    enableMediaServer(MediaServerType.PLEX);

    enableMediaServer(MediaServerType.EMBY);

    assert.deepEqual(currentServers(), {
      enabled: [MediaServerType.PLEX, MediaServerType.EMBY],
      primary: MediaServerType.EMBY,
    });
    assert.strictEqual(getJellyfinServerType(), MediaServerType.EMBY);
  });

  it('keeps a server from before the list existed when another connects', () => {
    setServers(MediaServerType.JELLYFIN);

    enableMediaServer(MediaServerType.PLEX);

    assert.deepEqual(currentServers(), {
      enabled: [MediaServerType.JELLYFIN, MediaServerType.PLEX],
      primary: MediaServerType.JELLYFIN,
    });
  });

  it('ignores NOT_CONFIGURED', () => {
    enableMediaServer(MediaServerType.NOT_CONFIGURED);

    assert.deepEqual(currentServers(), {
      enabled: [],
      primary: MediaServerType.NOT_CONFIGURED,
    });
  });

  it('promotes the remaining server when the primary disconnects', () => {
    enableMediaServer(MediaServerType.PLEX);
    enableMediaServer(MediaServerType.EMBY);

    disableMediaServer(MediaServerType.PLEX);

    assert.deepEqual(currentServers(), {
      enabled: [MediaServerType.EMBY],
      primary: MediaServerType.EMBY,
    });
    assert.ok(!isPlexEnabled());
  });

  it('keeps the primary when another server disconnects', () => {
    enableMediaServer(MediaServerType.PLEX);
    enableMediaServer(MediaServerType.EMBY);

    disableMediaServer(MediaServerType.EMBY);

    assert.deepEqual(currentServers(), {
      enabled: [MediaServerType.PLEX],
      primary: MediaServerType.PLEX,
    });
    assert.strictEqual(getJellyfinServerType(), undefined);
  });

  it('returns to not configured when the last server disconnects', () => {
    enableMediaServer(MediaServerType.JELLYFIN);

    disableMediaServer(MediaServerType.JELLYFIN);

    assert.deepEqual(currentServers(), {
      enabled: [],
      primary: MediaServerType.NOT_CONFIGURED,
    });
  });
});

describe('resolveEnabledMediaServers', () => {
  it('returns the connected servers', () => {
    assert.deepEqual(
      resolveEnabledMediaServers({
        mediaServerType: MediaServerType.PLEX,
        enabledMediaServers: [MediaServerType.PLEX, MediaServerType.EMBY],
      }),
      [MediaServerType.PLEX, MediaServerType.EMBY]
    );
  });

  it('drops duplicates and anything that is not a media server', () => {
    assert.deepEqual(
      resolveEnabledMediaServers({
        mediaServerType: MediaServerType.PLEX,
        enabledMediaServers: [
          MediaServerType.PLEX,
          MediaServerType.NOT_CONFIGURED,
          MediaServerType.PLEX,
          99 as MediaServerType,
        ],
      }),
      [MediaServerType.PLEX]
    );
  });

  it('falls back to the primary server for settings from before the list existed', () => {
    assert.deepEqual(
      resolveEnabledMediaServers({ mediaServerType: MediaServerType.JELLYFIN }),
      [MediaServerType.JELLYFIN]
    );
    assert.deepEqual(
      resolveEnabledMediaServers({
        mediaServerType: MediaServerType.EMBY,
        enabledMediaServers: [],
      }),
      [MediaServerType.EMBY]
    );
  });

  it('is empty when no media server is configured', () => {
    assert.deepEqual(
      resolveEnabledMediaServers({
        mediaServerType: MediaServerType.NOT_CONFIGURED,
      }),
      []
    );
  });
});

describe('mainSettingsServerFields', () => {
  const current = {
    mediaServerType: MediaServerType.PLEX,
    enabledMediaServers: [MediaServerType.PLEX, MediaServerType.EMBY],
  };

  it('finds nothing in an ordinary general settings update', () => {
    assert.deepEqual(
      mainSettingsServerFields(
        { applicationTitle: 'Seerr', locale: 'en' },
        current
      ),
      []
    );
  });

  it('allows posting back the current values', () => {
    assert.deepEqual(
      mainSettingsServerFields(
        {
          applicationTitle: 'Seerr',
          mediaServerType: MediaServerType.PLEX,
          enabledMediaServers: [MediaServerType.PLEX, MediaServerType.EMBY],
        },
        current
      ),
      []
    );
  });

  it('names the media server fields a general settings update tries to change', () => {
    assert.deepEqual(
      mainSettingsServerFields(
        {
          applicationTitle: 'Seerr',
          enabledMediaServers: [MediaServerType.PLEX],
          mediaServerType: MediaServerType.EMBY,
        },
        current
      ),
      ['enabledMediaServers', 'mediaServerType']
    );
  });

  it('ignores a body that is not an object', () => {
    assert.deepEqual(mainSettingsServerFields(undefined, current), []);
    assert.deepEqual(mainSettingsServerFields('mediaServerType', current), []);
  });
});
