import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaServerType,
  resolveEnabledMediaServers,
} from '@server/constants/server';
import { mainSettingsServerFields } from '@server/lib/mediaServers';

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
