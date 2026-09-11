import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MediaServerType } from '@server/constants/server';
import { jellyfinFullScanner } from '@server/lib/scanners/jellyfin';
import { plexFullScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

type LogEntry = Record<string, unknown>;

let entries: LogEntry[] = [];
const originalInfo = logger.info;

// `log` is protected; the scanners are used exactly as the app uses them.
const logFrom = (scanner: unknown): LogEntry | undefined => {
  (scanner as { log(message: string, level: 'info'): void }).log(
    'Scanning',
    'info'
  );
  return entries.at(-1);
};

const setServers = (enabledMediaServers: MediaServerType[]) => {
  const { main } = getSettings();
  main.mediaServerType = enabledMediaServers[0];
  main.enabledMediaServers = enabledMediaServers;
};

describe('scanner log context', () => {
  beforeEach(() => {
    entries = [];
    logger.info = ((message: string, meta: LogEntry) => {
      entries.push({ message, ...meta });
      return logger;
    }) as typeof logger.info;
  });

  afterEach(() => {
    logger.info = originalInfo;
  });

  it('tags Plex scan lines with the server', () => {
    setServers([MediaServerType.PLEX]);

    const entry = logFrom(plexFullScanner);

    assert.strictEqual(entry?.label, 'Plex Scan');
    assert.strictEqual(entry?.server, 'Plex');
  });

  it('names Emby when the Jellyfin scanner is syncing Emby', () => {
    setServers([MediaServerType.PLEX, MediaServerType.EMBY]);

    const entry = logFrom(jellyfinFullScanner);

    assert.strictEqual(entry?.label, 'Emby Sync');
    assert.strictEqual(entry?.server, 'Emby');
  });

  it('names Jellyfin when the Jellyfin scanner is syncing Jellyfin', () => {
    setServers([MediaServerType.JELLYFIN]);

    const entry = logFrom(jellyfinFullScanner);

    assert.strictEqual(entry?.label, 'Jellyfin Sync');
    assert.strictEqual(entry?.server, 'Jellyfin');
  });

  it('leaves the server out for scanners that are not a media server', () => {
    setServers([MediaServerType.PLEX]);

    const entry = logFrom(radarrScanner);

    assert.strictEqual(entry?.label, 'Radarr Scan');
    assert.ok(entry && !('server' in entry));
  });
});
