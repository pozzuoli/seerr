import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import path from 'path';
import request from 'supertest';

/**
 * Every API route has to appear in seerr-api.yml. The OpenAPI validator runs
 * ahead of the routers in server/index.ts, so a route missing from the spec is
 * rejected with a bare 404 "not found" and never reaches its handler, which
 * looks like a broken endpoint rather than a missing spec entry.
 */

const API_SPEC_PATH = path.join(__dirname, '../../seerr-api.yml');

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
    })
  );
  // Stands in for the real routers; reaching it means the spec allowed the path.
  app.use('/api/v1', (_req, res) => {
    res.status(200).json({ reached: true });
  });
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

/** The validator answers an unknown path with exactly this. */
const isUnknownPath = (status: number, body: { message?: string }) =>
  status === 404 && body.message === 'not found';

describe('API spec coverage', () => {
  it('rejects a path that is not in the spec', async () => {
    const res = await request(app).post('/api/v1/settings/not-a-real-route');

    assert.ok(
      isUnknownPath(res.status, res.body),
      'an unknown path should be rejected by the validator'
    );
  });

  it('knows the media server status endpoints', async () => {
    const get = await request(app).get('/api/v1/settings/mediaservers');
    assert.ok(!isUnknownPath(get.status, get.body));

    const post = await request(app)
      .post('/api/v1/settings/mediaservers')
      .send({ type: 3, enabled: true });
    assert.ok(!isUnknownPath(post.status, post.body));
  });

  it('knows the Jellyfin/Emby connect endpoint', async () => {
    const res = await request(app)
      .post('/api/v1/settings/jellyfin/connect')
      .send({
        serverType: 3,
        hostname: 'emby.example.com',
        port: 443,
        urlBase: '',
        useSsl: true,
        username: 'admin',
        apiKey: 'key-123',
      });

    assert.ok(!isUnknownPath(res.status, res.body));
  });

  it('accepts a connect request that authenticates with a password', async () => {
    const res = await request(app)
      .post('/api/v1/settings/jellyfin/connect')
      .send({
        serverType: 2,
        hostname: 'jellyfin.example.com',
        port: 8096,
        useSsl: false,
        username: 'admin',
        password: 'hunter2',
      });

    assert.ok(!isUnknownPath(res.status, res.body));
  });
});
