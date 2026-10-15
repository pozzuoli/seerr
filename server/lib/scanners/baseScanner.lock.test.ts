import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { setupTestDb } from '@server/test/db';

/**
 * Stands in for the Plex and Jellyfin scanners: each real scanner is its own
 * instance, and with both servers connected their scans run at the same time.
 */
class TestScanner extends BaseScanner<unknown> {
  constructor(name: string) {
    super(name);
  }

  public addMovie(
    tmdbId: number,
    ids: { ratingKey?: string; jellyfinMediaId?: string }
  ) {
    return this.processMovie(tmdbId, { ...ids, title: `Movie ${tmdbId}` });
  }

  public addShow(
    tmdbId: number,
    tvdbId: number,
    ids: { ratingKey?: string; jellyfinMediaId?: string }
  ) {
    return this.processShow(
      tmdbId,
      tvdbId,
      [{ seasonNumber: 1, totalEpisodes: 10, episodes: 10, episodes4k: 0 }],
      { ...ids, title: `Show ${tmdbId}` }
    );
  }
}

describe('BaseScanner', () => {
  setupTestDb();

  it('creates one media row when two scanners add the same new movie at once', async () => {
    const plexScanner = new TestScanner('Plex Scan');
    const jellyfinScanner = new TestScanner('Jellyfin Sync');

    await Promise.all([
      plexScanner.addMovie(603, { ratingKey: 'plex-603' }),
      jellyfinScanner.addMovie(603, { jellyfinMediaId: 'jellyfin-603' }),
    ]);

    const rows = await getRepository(Media).find({
      where: { tmdbId: 603, mediaType: MediaType.MOVIE },
    });

    assert.equal(rows.length, 1, 'expected a single media row');
    assert.equal(rows[0].ratingKey, 'plex-603');
    assert.equal(rows[0].jellyfinMediaId, 'jellyfin-603');
  });

  it('creates one media row when two scanners add the same new show at once', async () => {
    const plexScanner = new TestScanner('Plex Scan');
    const jellyfinScanner = new TestScanner('Jellyfin Sync');

    // Shows also carry a unique tvdbId, so without serialising the scanners
    // the second insert fails outright instead of creating a duplicate.
    await Promise.all([
      plexScanner.addShow(1399, 121361, { ratingKey: 'plex-1399' }),
      jellyfinScanner.addShow(1399, 121361, {
        jellyfinMediaId: 'jellyfin-1399',
      }),
    ]);

    const rows = await getRepository(Media).find({
      where: { tmdbId: 1399, mediaType: MediaType.TV },
    });

    assert.equal(rows.length, 1, 'expected a single media row');
    assert.equal(rows[0].ratingKey, 'plex-1399');
    assert.equal(rows[0].jellyfinMediaId, 'jellyfin-1399');
  });

  it('does not hold up different titles behind each other', async () => {
    const plexScanner = new TestScanner('Plex Scan');
    const jellyfinScanner = new TestScanner('Jellyfin Sync');

    await Promise.all([
      plexScanner.addMovie(603, { ratingKey: 'plex-603' }),
      jellyfinScanner.addMovie(604, { jellyfinMediaId: 'jellyfin-604' }),
    ]);

    const count = await getRepository(Media).count({
      where: { mediaType: MediaType.MOVIE },
    });

    assert.equal(count, 2);
  });
});
