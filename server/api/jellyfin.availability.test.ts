import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import availabilitySync from '@server/lib/availabilitySync';
import { ApiError } from '@server/types/error';

const serverError = () =>
  Object.assign(new Error('Request failed with status code 500'), {
    response: { status: 500 },
  });

let getImpl: (endpoint: string) => Promise<unknown> = async () => ({
  Items: [],
});
let systemInfoImpl: () => Promise<unknown> = async () => ({ Id: 'server' });
let systemInfoCalls = 0;

Object.defineProperty(JellyfinAPI.prototype, 'get', {
  get() {
    return async (endpoint: string) => getImpl(endpoint);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(JellyfinAPI.prototype, 'getSystemInfo', {
  get() {
    return async () => {
      systemInfoCalls += 1;
      return systemInfoImpl();
    };
  },
  set() {},
  configurable: true,
});

const createClient = () =>
  new JellyfinAPI(
    'http://jellyfin.test',
    'api-key',
    'device-id',
    MediaServerType.JELLYFIN
  );

describe('JellyfinAPI.getItemData during an availability sync', () => {
  beforeEach(() => {
    getImpl = async () => {
      throw serverError();
    };
    systemInfoImpl = async () => ({ Id: 'server' });
    systemInfoCalls = 0;
    availabilitySync.running = true;
  });

  afterEach(() => {
    availabilitySync.running = false;
  });

  it('treats a 500 as a missing item while the server itself is healthy', async () => {
    assert.equal(await createClient().getItemData('item-id'), undefined);
  });

  it('reports a connection error instead of a missing item when the server itself is failing', async () => {
    systemInfoImpl = async () => {
      throw new ApiError(502, ApiErrorCode.ConnectionError);
    };

    await assert.rejects(
      createClient().getItemData('item-id'),
      (e: unknown) =>
        e instanceof ApiError && e.errorCode === ApiErrorCode.ConnectionError
    );
  });

  it('checks the server once for a run of 500s', async () => {
    const jellyfin = createClient();

    await jellyfin.getItemData('item-a');
    await jellyfin.getItemData('item-b');
    await jellyfin.getItemData('item-c');

    assert.equal(systemInfoCalls, 1);
  });

  it('still reports a 500 as an error outside an availability sync', async () => {
    availabilitySync.running = false;

    await assert.rejects(
      createClient().getItemData('item-id'),
      (e: unknown) => e instanceof ApiError && e.statusCode === 500
    );
  });
});
