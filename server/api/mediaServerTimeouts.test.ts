import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import type { PlexSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { ApiError } from '@server/types/error';
import http from 'node:http';

/**
 * A media server that accepts the connection and then either never answers
 * or answers after `replyAfterMs`. Without a timeout a request to it would
 * wait until the operating system gave up on the connection.
 */
let replyAfterMs = Number.POSITIVE_INFINITY;
let server: http.Server;
let baseUrl: string;
let port: number;

before(async () => {
  server = http.createServer((_req, res) => {
    if (!Number.isFinite(replyAfterMs)) {
      return;
    }

    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Items: [] }));
    }, replyAfterMs);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );

  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  getSettings().network.apiRequestTimeout = 200;
  replyAfterMs = Number.POSITIVE_INFINITY;
});

const createJellyfin = () =>
  new JellyfinAPI(baseUrl, 'api-key', 'device-id', MediaServerType.JELLYFIN);

describe('media server request timeouts', () => {
  it(
    'gives up on a Jellyfin server that never answers',
    { timeout: 5000 },
    async () => {
      await assert.rejects(
        createJellyfin().getSystemInfo(),
        (e: unknown) =>
          e instanceof ApiError && e.errorCode === ApiErrorCode.ConnectionError
      );
    }
  );

  it(
    'gives up on a Plex server that never answers',
    { timeout: 5000 },
    async () => {
      const plex = new PlexAPI({
        plexToken: 'plex-token',
        plexSettings: {
          name: 'Test',
          ip: '127.0.0.1',
          port,
          useSsl: false,
          libraries: [],
        } as unknown as PlexSettings,
      });

      await assert.rejects(plex.getStatus());
    }
  );

  it(
    'lets a whole-library listing run past the usual timeout',
    { timeout: 5000 },
    async () => {
      replyAfterMs = 500;

      assert.deepEqual(
        await createJellyfin().getLibraryContents('library'),
        []
      );
    }
  );
});
