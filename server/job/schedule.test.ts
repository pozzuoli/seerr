import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { MediaServerType } from '@server/constants/server';
import { scheduledJobs, startJobs } from '@server/job/schedule';
import { getSettings } from '@server/lib/settings';

const PLEX_JOBS = [
  'plex-recently-added-scan',
  'plex-full-scan',
  'plex-refresh-token',
  'plex-watchlist-sync',
];
const JELLYFIN_JOBS = ['jellyfin-recently-added-scan', 'jellyfin-full-scan'];
const SHARED_JOBS = [
  'radarr-scan',
  'sonarr-scan',
  'availability-sync',
  'download-sync',
  'download-sync-reset',
  'image-cache-cleanup',
  'process-blocklisted-tags',
];

const setServers = (
  mediaServerType: MediaServerType,
  enabledMediaServers: MediaServerType[]
) => {
  const { main } = getSettings();
  main.mediaServerType = mediaServerType;
  main.enabledMediaServers = enabledMediaServers;
};

const scheduledIds = () => scheduledJobs.map((job) => job.id).sort();

describe('startJobs', () => {
  afterEach(() => {
    // Cancel the real schedules so the test process can exit.
    for (const scheduledJob of scheduledJobs.splice(0)) {
      scheduledJob.job.cancel();
    }
  });

  it('schedules only the Plex jobs when Plex is the only server', () => {
    setServers(MediaServerType.PLEX, [MediaServerType.PLEX]);

    startJobs();

    assert.deepEqual(scheduledIds(), [...PLEX_JOBS, ...SHARED_JOBS].sort());
  });

  it('schedules the Jellyfin jobs for Emby', () => {
    setServers(MediaServerType.EMBY, [MediaServerType.EMBY]);

    startJobs();

    assert.deepEqual(scheduledIds(), [...JELLYFIN_JOBS, ...SHARED_JOBS].sort());
  });

  it('schedules the jobs for both servers when Plex and Jellyfin are connected', () => {
    setServers(MediaServerType.PLEX, [
      MediaServerType.PLEX,
      MediaServerType.JELLYFIN,
    ]);

    startJobs();

    assert.deepEqual(
      scheduledIds(),
      [...PLEX_JOBS, ...JELLYFIN_JOBS, ...SHARED_JOBS].sort()
    );
  });

  it('replaces the previous schedule instead of adding to it', () => {
    setServers(MediaServerType.PLEX, [
      MediaServerType.PLEX,
      MediaServerType.EMBY,
    ]);

    startJobs();
    const firstJobs = scheduledJobs.map((scheduledJob) => scheduledJob.job);

    startJobs();

    assert.deepEqual(
      scheduledIds(),
      [...PLEX_JOBS, ...JELLYFIN_JOBS, ...SHARED_JOBS].sort()
    );
    for (const job of firstJobs) {
      assert.strictEqual(
        job.nextInvocation(),
        null,
        `${job.name} from the first schedule must be cancelled`
      );
    }
  });

  it('drops a server’s jobs once it is disconnected', () => {
    setServers(MediaServerType.PLEX, [
      MediaServerType.PLEX,
      MediaServerType.JELLYFIN,
    ]);
    startJobs();

    setServers(MediaServerType.PLEX, [MediaServerType.PLEX]);
    startJobs();

    assert.deepEqual(scheduledIds(), [...PLEX_JOBS, ...SHARED_JOBS].sort());
  });
});
