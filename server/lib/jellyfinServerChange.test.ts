import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  forgetJellyfinServer,
  isDifferentJellyfinServer,
} from '@server/lib/jellyfinServerChange';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

describe('isDifferentJellyfinServer', () => {
  it('is false when no server was recorded before', () => {
    assert.equal(isDifferentJellyfinServer(undefined, 'server-b'), false);
    assert.equal(isDifferentJellyfinServer('', 'server-b'), false);
  });

  it('is false when reconnecting the same server', () => {
    assert.equal(isDifferentJellyfinServer('server-a', 'server-a'), false);
  });

  it('is false when the new server did not report an ID', () => {
    assert.equal(isDifferentJellyfinServer('server-a', undefined), false);
  });

  it('is true when switching to a different server', () => {
    assert.equal(isDifferentJellyfinServer('server-a', 'server-b'), true);
  });
});

describe('forgetJellyfinServer', () => {
  setupTestDb();

  it('clears Jellyfin item IDs and libraries but keeps Plex IDs', async () => {
    const mediaRepository = getRepository(Media);

    const both = await mediaRepository.save(
      new Media({
        tmdbId: 100,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: 'plex-100',
        jellyfinMediaId: 'jellyfin-100',
      })
    );
    const only4k = await mediaRepository.save(
      new Media({
        tmdbId: 101,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        jellyfinMediaId4k: 'jellyfin-101-4k',
      })
    );
    const plexOnly = await mediaRepository.save(
      new Media({
        tmdbId: 102,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: 'plex-102',
      })
    );

    getSettings().jellyfin.libraries = [
      { id: 'movies', name: 'Movies', enabled: true } as Library,
    ];

    const cleared = await forgetJellyfinServer();

    assert.equal(cleared, 2);
    assert.deepEqual(getSettings().jellyfin.libraries, []);

    const [afterBoth, afterOnly4k, afterPlexOnly] = await Promise.all(
      [both, only4k, plexOnly].map((m) =>
        mediaRepository.findOneOrFail({ where: { id: m.id } })
      )
    );

    assert.equal(afterBoth.jellyfinMediaId, null);
    assert.equal(afterBoth.ratingKey, 'plex-100');
    assert.equal(afterOnly4k.jellyfinMediaId4k, null);
    assert.equal(afterPlexOnly.ratingKey, 'plex-102');
  });
});
