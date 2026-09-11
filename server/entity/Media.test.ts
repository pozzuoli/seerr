import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';

const connect = (primary: MediaServerType, enabled: MediaServerType[]) => {
  const settings = getSettings();
  settings.main.mediaServerType = primary;
  settings.main.enabledMediaServers = enabled;
};

const loaded = (init: Partial<Media>): Media => {
  const media = new Media({ tmdbId: 1, mediaType: MediaType.MOVIE, ...init });
  media.setPlexUrls();
  return media;
};

describe('Media deep links', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.plex.machineId = 'plex-machine';
    settings.jellyfin.serverId = 'jellyfin-server';
    settings.jellyfin.ip = 'jellyfin.local';
  });

  it('opens the primary server when it has the title', () => {
    connect(MediaServerType.PLEX, [MediaServerType.PLEX, MediaServerType.EMBY]);

    const media = loaded({ ratingKey: 'plex-1', jellyfinMediaId: 'emby-1' });

    assert.equal(media.mediaUrl, media.plexUrl);
    assert.equal(media.mediaUrlServer, MediaServerType.PLEX);
  });

  it('opens the other server, and says which, when only it has the title', () => {
    connect(MediaServerType.PLEX, [MediaServerType.PLEX, MediaServerType.EMBY]);

    const media = loaded({ jellyfinMediaId: 'emby-1' });

    assert.equal(media.mediaUrl, media.jellyfinUrl);
    assert.equal(media.mediaUrlServer, MediaServerType.EMBY);
  });

  it('works out the 4K link on its own', () => {
    connect(MediaServerType.EMBY, [MediaServerType.PLEX, MediaServerType.EMBY]);

    const media = loaded({ jellyfinMediaId: 'emby-1', ratingKey4k: 'plex-4k' });

    assert.equal(media.mediaUrlServer, MediaServerType.EMBY);
    assert.equal(media.mediaUrl4k, media.plexUrl4k);
    assert.equal(media.mediaUrl4kServer, MediaServerType.PLEX);
  });

  it('has no link or server when no server has the title', () => {
    connect(MediaServerType.PLEX, [MediaServerType.PLEX]);

    const media = loaded({});

    assert.equal(media.mediaUrl, undefined);
    assert.equal(media.mediaUrlServer, undefined);
  });
});
