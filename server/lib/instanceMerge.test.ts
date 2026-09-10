import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { UserType } from '@server/constants/user';
import dataSource from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { bestStatus, mergeInstance } from '@server/lib/instanceMerge';
import { Permission } from '@server/lib/permissions';
import type { DataSourceOptions } from 'typeorm';
import { DataSource } from 'typeorm';

// Two throwaway in-memory databases stand in for the two instances being
// merged. Subscribers are left off so nothing tries to notify or reach out to
// Radarr/Sonarr.
const buildDataSource = (name: string) =>
  new DataSource({
    name,
    type: 'sqlite',
    database: ':memory:',
    synchronize: true,
    dropSchema: true,
    logging: false,
    entities: dataSource.options.entities,
    subscribers: [],
  } as DataSourceOptions);

let source: DataSource;
let destination: DataSource;

const saveOptions = { listeners: false } as const;

const createUser = async (ds: DataSource, init: Partial<User>) =>
  ds.getRepository(User).save(new User({ avatar: '', ...init }), saveOptions);

const createMedia = async (ds: DataSource, init: Partial<Media>) =>
  ds
    .getRepository(Media)
    .save(new Media({ seasons: [], ...init }), saveOptions);

describe('bestStatus', () => {
  it('keeps the more available of two statuses', () => {
    assert.equal(
      bestStatus(MediaStatus.UNKNOWN, MediaStatus.AVAILABLE),
      MediaStatus.AVAILABLE
    );
    assert.equal(
      bestStatus(MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE),
      MediaStatus.AVAILABLE
    );
  });

  it('prefers an available status over a deleted one, despite the enum order', () => {
    assert.equal(
      bestStatus(MediaStatus.DELETED, MediaStatus.AVAILABLE),
      MediaStatus.AVAILABLE
    );
    assert.equal(
      bestStatus(MediaStatus.AVAILABLE, MediaStatus.DELETED),
      MediaStatus.AVAILABLE
    );
  });
});

describe('mergeInstance', () => {
  before(async () => {
    source = buildDataSource('merge-test-source');
    destination = buildDataSource('merge-test-destination');
    await source.initialize();
    await destination.initialize();
  });

  after(async () => {
    await source.destroy();
    await destination.destroy();
  });

  beforeEach(async () => {
    await source.synchronize(true);
    await destination.synchronize(true);
  });

  it('links a person who exists on both instances instead of duplicating them', async () => {
    await createUser(destination, {
      email: 'sam@example.com',
      plexId: 42,
      plexUsername: 'sam',
      userType: UserType.PLEX,
      permissions: Permission.ADMIN,
    });

    await createUser(source, {
      email: 'SAM@example.com',
      jellyfinUserId: 'jf-sam',
      jellyfinUsername: 'sam',
      userType: UserType.EMBY,
    });

    const summary = await mergeInstance({ source, destination, apply: true });

    const users = await destination.getRepository(User).find();
    assert.equal(users.length, 1, 'the same person should stay one account');
    assert.equal(users[0].plexId, 42, 'the existing Plex identity is kept');
    assert.equal(
      users[0].jellyfinUserId,
      'jf-sam',
      'the Emby identity is linked onto the existing account'
    );
    assert.equal(summary.users.updated, 1);
    assert.equal(summary.users.created, 0);
  });

  it('creates a source-only user without carrying over admin rights', async () => {
    await createUser(destination, {
      email: 'admin@example.com',
      plexId: 1,
      permissions: Permission.ADMIN,
    });

    await createUser(source, {
      email: 'otheradmin@example.com',
      jellyfinUserId: 'jf-admin',
      permissions: Permission.ADMIN,
    });

    await mergeInstance({
      source,
      destination,
      apply: true,
      keepPermissions: true,
    });

    const merged = await destination.getRepository(User).findOneOrFail({
      where: { email: 'otheradmin@example.com' },
    });

    assert.equal(
      merged.permissions & Permission.ADMIN,
      0,
      'admin rights must not transfer between instances'
    );
  });

  it('folds media onto the existing row and keeps both server ids', async () => {
    await createMedia(destination, {
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      ratingKey: 'plex-550',
    });

    await createMedia(source, {
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'jf-550',
    });

    await createMedia(source, {
      mediaType: MediaType.MOVIE,
      tmdbId: 680,
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'jf-680',
    });

    const summary = await mergeInstance({ source, destination, apply: true });

    const shared = await destination.getRepository(Media).findOneOrFail({
      where: { tmdbId: 550 },
    });

    assert.equal(shared.ratingKey, 'plex-550');
    assert.equal(shared.jellyfinMediaId, 'jf-550');
    assert.equal(
      shared.status4k,
      MediaStatus.AVAILABLE,
      'the better 4K status wins'
    );

    const sourceOnly = await destination.getRepository(Media).findOneOrFail({
      where: { tmdbId: 680 },
    });
    assert.equal(sourceOnly.jellyfinMediaId, 'jf-680');

    assert.equal(summary.media.created, 1);
    assert.equal(summary.media.updated, 1);
  });

  it('merges seasons by season number', async () => {
    const destMedia = await createMedia(destination, {
      mediaType: MediaType.TV,
      tmdbId: 1399,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      seasons: [new Season({ seasonNumber: 1, status: MediaStatus.AVAILABLE })],
    });

    await createMedia(source, {
      mediaType: MediaType.TV,
      tmdbId: 1399,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      seasons: [
        new Season({ seasonNumber: 1, status: MediaStatus.UNKNOWN }),
        new Season({ seasonNumber: 2, status: MediaStatus.AVAILABLE }),
      ],
    });

    await mergeInstance({ source, destination, apply: true });

    const merged = await destination.getRepository(Media).findOneOrFail({
      where: { id: destMedia.id },
    });

    const seasons = merged.seasons.sort(
      (a, b) => a.seasonNumber - b.seasonNumber
    );

    assert.equal(seasons.length, 2);
    assert.equal(seasons[0].status, MediaStatus.AVAILABLE);
    assert.equal(seasons[1].status, MediaStatus.AVAILABLE);
  });

  it('carries requests over and remaps them to the merged user and media', async () => {
    await createUser(destination, { email: 'sam@example.com', plexId: 42 });
    const sourceUser = await createUser(source, {
      email: 'sam@example.com',
      jellyfinUserId: 'jf-sam',
    });
    const sourceMedia = await createMedia(source, {
      mediaType: MediaType.MOVIE,
      tmdbId: 680,
      status: MediaStatus.AVAILABLE,
    });

    await source.getRepository(MediaRequest).save(
      new MediaRequest({
        status: MediaRequestStatus.COMPLETED,
        media: sourceMedia,
        requestedBy: sourceUser,
        type: MediaType.MOVIE,
        is4k: false,
      }),
      saveOptions
    );

    const summary = await mergeInstance({ source, destination, apply: true });

    const requests = await destination.getRepository(MediaRequest).find({
      relations: { media: true, requestedBy: true },
    });

    assert.equal(summary.requests.created, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].media.tmdbId, 680);
    assert.equal(requests[0].requestedBy.email, 'sam@example.com');
    assert.equal(requests[0].status, MediaRequestStatus.COMPLETED);
  });

  it('does not duplicate a request the surviving instance already has', async () => {
    const destUser = await createUser(destination, {
      email: 'sam@example.com',
      plexId: 42,
    });
    const destMedia = await createMedia(destination, {
      mediaType: MediaType.MOVIE,
      tmdbId: 680,
      status: MediaStatus.AVAILABLE,
    });
    await destination.getRepository(MediaRequest).save(
      new MediaRequest({
        status: MediaRequestStatus.COMPLETED,
        media: destMedia,
        requestedBy: destUser,
        type: MediaType.MOVIE,
        is4k: false,
      }),
      saveOptions
    );

    const sourceUser = await createUser(source, {
      email: 'sam@example.com',
      jellyfinUserId: 'jf-sam',
    });
    const sourceMedia = await createMedia(source, {
      mediaType: MediaType.MOVIE,
      tmdbId: 680,
      status: MediaStatus.AVAILABLE,
    });
    await source.getRepository(MediaRequest).save(
      new MediaRequest({
        status: MediaRequestStatus.COMPLETED,
        media: sourceMedia,
        requestedBy: sourceUser,
        type: MediaType.MOVIE,
        is4k: false,
      }),
      saveOptions
    );

    const summary = await mergeInstance({ source, destination, apply: true });

    assert.equal(summary.requests.created, 0);
    assert.equal(summary.requests.skipped, 1);
    assert.equal(await destination.getRepository(MediaRequest).count(), 1);
  });

  it('carries watchlist entries over', async () => {
    await createUser(destination, { email: 'sam@example.com', plexId: 42 });
    const sourceUser = await createUser(source, {
      email: 'sam@example.com',
      jellyfinUserId: 'jf-sam',
    });
    const sourceMedia = await createMedia(source, {
      mediaType: MediaType.MOVIE,
      tmdbId: 680,
      status: MediaStatus.AVAILABLE,
    });

    await source.getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: 'jf-680',
        mediaType: MediaType.MOVIE,
        title: 'Pulp Fiction',
        tmdbId: 680,
        requestedBy: sourceUser,
        media: sourceMedia,
      }),
      saveOptions
    );

    const summary = await mergeInstance({ source, destination, apply: true });

    assert.equal(summary.watchlists.created, 1);
    assert.equal(await destination.getRepository(Watchlist).count(), 1);
  });

  it('writes nothing on a dry run', async () => {
    await createUser(source, {
      email: 'sam@example.com',
      jellyfinUserId: 'jf-sam',
    });
    await createMedia(source, {
      mediaType: MediaType.MOVIE,
      tmdbId: 680,
      status: MediaStatus.AVAILABLE,
    });

    const summary = await mergeInstance({ source, destination, apply: false });

    assert.equal(summary.applied, false);
    assert.equal(
      summary.users.created,
      1,
      'the summary still reports what would happen'
    );
    assert.equal(summary.media.created, 1);
    assert.equal(await destination.getRepository(User).count(), 0);
    assert.equal(await destination.getRepository(Media).count(), 0);
  });

  it('leaves the source database untouched', async () => {
    await createUser(source, {
      email: 'sam@example.com',
      jellyfinUserId: 'jf-sam',
    });
    await createMedia(source, {
      mediaType: MediaType.MOVIE,
      tmdbId: 680,
      status: MediaStatus.AVAILABLE,
    });

    await mergeInstance({ source, destination, apply: true });

    assert.equal(await source.getRepository(User).count(), 1);
    assert.equal(await source.getRepository(Media).count(), 1);
    assert.equal(await source.getRepository(MediaRequest).count(), 0);
  });
});
