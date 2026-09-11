import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaServerType } from '@server/constants/server';
import migrateMultiMediaServer from '@server/lib/settings/migrations/0009_multi_media_server';

// Migrations receive settings.json as parsed, so the input is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrate = (settings: any) => migrateMultiMediaServer(settings);

describe('0009_multi_media_server', () => {
  it('seeds the list from the single server an install was using', () => {
    const migrated = migrate({
      main: { mediaServerType: MediaServerType.EMBY },
    });

    assert.deepEqual(migrated.main.enabledMediaServers, [MediaServerType.EMBY]);
    assert.strictEqual(migrated.main.mediaServerType, MediaServerType.EMBY);
  });

  it('leaves an existing list alone', () => {
    const migrated = migrate({
      main: {
        mediaServerType: MediaServerType.PLEX,
        enabledMediaServers: [MediaServerType.PLEX, MediaServerType.JELLYFIN],
      },
    });

    assert.deepEqual(migrated.main.enabledMediaServers, [
      MediaServerType.PLEX,
      MediaServerType.JELLYFIN,
    ]);
  });

  it('leaves an existing empty list alone', () => {
    const migrated = migrate({
      main: {
        mediaServerType: MediaServerType.PLEX,
        enabledMediaServers: [],
      },
    });

    assert.deepEqual(migrated.main.enabledMediaServers, []);
  });

  it('starts with an empty list when no server is configured', () => {
    const migrated = migrate({
      main: { mediaServerType: MediaServerType.NOT_CONFIGURED },
    });

    assert.deepEqual(migrated.main.enabledMediaServers, []);
  });

  it('handles settings without a main section', () => {
    const migrated = migrate({});

    assert.deepEqual(migrated.main.enabledMediaServers, []);
  });
});
