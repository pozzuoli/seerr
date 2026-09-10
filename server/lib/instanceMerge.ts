import { MediaStatus, MediaType } from '@server/constants/media';
import { Blocklist } from '@server/entity/Blocklist';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Watchlist } from '@server/entity/Watchlist';
import { Permission } from '@server/lib/permissions';
import type { DataSource, EntityManager } from 'typeorm';

/**
 * Merges the contents of a second Seerr instance's database into this one.
 *
 * This exists for installs that ran one instance per media server before Seerr
 * could connect to several at once. Media rows are matched on TMDB id so the
 * two instances' libraries fold together, and users are matched on their media
 * server identity or email so one person ends up as one account.
 *
 * Nothing in the source database is modified.
 */

export interface MergeCounts {
  created: number;
  updated: number;
  skipped: number;
}

export interface MergeSummary {
  users: MergeCounts;
  media: MergeCounts;
  seasons: MergeCounts;
  requests: MergeCounts;
  issues: MergeCounts;
  issueComments: MergeCounts;
  watchlists: MergeCounts;
  blocklist: MergeCounts;
  warnings: string[];
  applied: boolean;
}

export interface MergeOptions {
  /** The other instance's database. Only ever read from. */
  source: DataSource;
  /** This instance's database. */
  destination: DataSource;
  /** When false the merge runs and is then rolled back, reporting what it would have done. */
  apply: boolean;
  /**
   * Give users created by the merge the permissions they held on the source
   * instance. Off by default so a merge cannot hand out admin rights.
   */
  keepPermissions?: boolean;
  log?: (message: string) => void;
}

// Ranks media statuses by how available they are, so merging two rows keeps the
// better of the two. The enum's own order does not work for this because
// BLOCKLISTED and DELETED sort above AVAILABLE.
const STATUS_RANK: Record<MediaStatus, number> = {
  [MediaStatus.UNKNOWN]: 0,
  [MediaStatus.DELETED]: 1,
  [MediaStatus.BLOCKLISTED]: 2,
  [MediaStatus.PENDING]: 3,
  [MediaStatus.PROCESSING]: 4,
  [MediaStatus.PARTIALLY_AVAILABLE]: 5,
  [MediaStatus.AVAILABLE]: 6,
};

export const bestStatus = (
  current: MediaStatus,
  incoming: MediaStatus
): MediaStatus =>
  (STATUS_RANK[incoming] ?? 0) > (STATUS_RANK[current] ?? 0)
    ? incoming
    : current;

const emptyCounts = (): MergeCounts => ({ created: 0, updated: 0, skipped: 0 });

const mediaKey = (mediaType: MediaType, tmdbId: number) =>
  `${mediaType}:${tmdbId}`;

/** Thrown to roll the transaction back when the merge is only being previewed. */
class DryRunRollback extends Error {
  constructor() {
    super('Dry run: rolling back');
  }
}

const saveOptions = { listeners: false } as const;

/**
 * Copies a value across only when the destination has none, so a merge never
 * overwrites data the surviving instance already holds.
 */
const fillIfEmpty = <T extends object, K extends keyof T>(
  target: T,
  source: T,
  keys: K[]
): boolean => {
  let changed = false;

  for (const key of keys) {
    const incoming = source[key];
    const existing = target[key];

    if (
      (existing === null || existing === undefined || existing === '') &&
      incoming !== null &&
      incoming !== undefined &&
      incoming !== ''
    ) {
      target[key] = incoming;
      changed = true;
    }
  }

  return changed;
};

const mergeUsers = async (
  source: DataSource,
  manager: EntityManager,
  summary: MergeSummary,
  keepPermissions: boolean
): Promise<Map<number, number>> => {
  const userMap = new Map<number, number>();

  // The credential columns are `select: false`, so ask for them explicitly.
  const sourceUsers = await source
    .getRepository(User)
    .createQueryBuilder('user')
    .addSelect([
      'user.password',
      'user.plexToken',
      'user.jellyfinDeviceId',
      'user.jellyfinAuthToken',
    ])
    .leftJoinAndSelect('user.settings', 'settings')
    .orderBy('user.id', 'ASC')
    .getMany();

  const destUsers = await manager
    .getRepository(User)
    .createQueryBuilder('user')
    .addSelect(['user.plexToken', 'user.jellyfinAuthToken'])
    .orderBy('user.id', 'ASC')
    .getMany();

  const byPlexId = new Map<number, User>();
  const byJellyfinUserId = new Map<string, User>();
  const byEmail = new Map<string, User>();

  for (const user of destUsers) {
    if (user.plexId) {
      byPlexId.set(user.plexId, user);
    }
    if (user.jellyfinUserId) {
      byJellyfinUserId.set(user.jellyfinUserId, user);
    }
    if (user.email) {
      byEmail.set(user.email.toLowerCase(), user);
    }
  }

  for (const sourceUser of sourceUsers) {
    // The same person can appear under either media server identity, or under
    // neither if they only ever used a local account.
    const existing =
      (sourceUser.plexId ? byPlexId.get(sourceUser.plexId) : undefined) ??
      (sourceUser.jellyfinUserId
        ? byJellyfinUserId.get(sourceUser.jellyfinUserId)
        : undefined) ??
      (sourceUser.email
        ? byEmail.get(sourceUser.email.toLowerCase())
        : undefined);

    if (existing) {
      const changed = fillIfEmpty(existing, sourceUser, [
        'plexId',
        'plexUsername',
        'plexToken',
        'jellyfinUserId',
        'jellyfinUsername',
        'jellyfinDeviceId',
        'jellyfinAuthToken',
      ]);

      if (changed) {
        await manager.getRepository(User).save(existing, saveOptions);
        summary.users.updated += 1;

        if (existing.plexId) {
          byPlexId.set(existing.plexId, existing);
        }
        if (existing.jellyfinUserId) {
          byJellyfinUserId.set(existing.jellyfinUserId, existing);
        }
      } else {
        summary.users.skipped += 1;
      }

      userMap.set(sourceUser.id, existing.id);
      continue;
    }

    const newUser = new User({
      email: sourceUser.email,
      username: sourceUser.username,
      password: sourceUser.password,
      plexUsername: sourceUser.plexUsername,
      plexId: sourceUser.plexId,
      plexToken: sourceUser.plexToken,
      jellyfinUsername: sourceUser.jellyfinUsername,
      jellyfinUserId: sourceUser.jellyfinUserId,
      jellyfinDeviceId: sourceUser.jellyfinDeviceId,
      jellyfinAuthToken: sourceUser.jellyfinAuthToken,
      userType: sourceUser.userType,
      avatar: sourceUser.avatar,
      movieQuotaLimit: sourceUser.movieQuotaLimit,
      movieQuotaDays: sourceUser.movieQuotaDays,
      tvQuotaLimit: sourceUser.tvQuotaLimit,
      tvQuotaDays: sourceUser.tvQuotaDays,
      permissions: sourceUser.permissions,
    });

    // The source instance's admin must not become an admin here just by being
    // merged in; the surviving instance already has its own.
    if (!keepPermissions) {
      newUser.permissions = 0;
      summary.warnings.push(
        `User "${sourceUser.email}" was created without the permissions it held on the other instance. Review it under Users.`
      );
    } else if (newUser.permissions & Permission.ADMIN) {
      newUser.permissions &= ~Permission.ADMIN;
      summary.warnings.push(
        `User "${sourceUser.email}" was an admin on the other instance; admin rights were not carried over.`
      );
    }

    if (sourceUser.settings) {
      const settings = new UserSettings({ ...sourceUser.settings });
      delete (settings as Partial<UserSettings>).id;
      delete (settings as Partial<UserSettings>).user;
      newUser.settings = settings;
    }

    await manager.getRepository(User).save(newUser, saveOptions);
    summary.users.created += 1;

    if (newUser.plexId) {
      byPlexId.set(newUser.plexId, newUser);
    }
    if (newUser.jellyfinUserId) {
      byJellyfinUserId.set(newUser.jellyfinUserId, newUser);
    }
    byEmail.set(newUser.email.toLowerCase(), newUser);

    userMap.set(sourceUser.id, newUser.id);
  }

  return userMap;
};

const mergeMedia = async (
  source: DataSource,
  manager: EntityManager,
  summary: MergeSummary
): Promise<Map<number, number>> => {
  const mediaMap = new Map<number, number>();

  const sourceMedia = await source.getRepository(Media).find({
    order: { id: 'ASC' },
  });
  const destMedia = await manager.getRepository(Media).find();

  const byTmdb = new Map<string, Media>();
  const usedTvdbIds = new Set<number>();

  for (const media of destMedia) {
    byTmdb.set(mediaKey(media.mediaType, media.tmdbId), media);
    if (media.tvdbId) {
      usedTvdbIds.add(media.tvdbId);
    }
  }

  for (const incoming of sourceMedia) {
    const existing = byTmdb.get(mediaKey(incoming.mediaType, incoming.tmdbId));

    if (!existing) {
      const created = new Media({
        mediaType: incoming.mediaType,
        tmdbId: incoming.tmdbId,
        imdbId: incoming.imdbId,
        status: incoming.status,
        status4k: incoming.status4k,
        serviceId: incoming.serviceId,
        serviceId4k: incoming.serviceId4k,
        externalServiceId: incoming.externalServiceId,
        externalServiceId4k: incoming.externalServiceId4k,
        externalServiceSlug: incoming.externalServiceSlug,
        externalServiceSlug4k: incoming.externalServiceSlug4k,
        ratingKey: incoming.ratingKey,
        ratingKey4k: incoming.ratingKey4k,
        jellyfinMediaId: incoming.jellyfinMediaId,
        jellyfinMediaId4k: incoming.jellyfinMediaId4k,
        mediaAddedAt: incoming.mediaAddedAt,
        lastSeasonChange: incoming.lastSeasonChange,
      });

      // tvdbId is unique across all media, so drop one that is already spoken
      // for rather than failing the whole merge over it.
      if (incoming.tvdbId && !usedTvdbIds.has(incoming.tvdbId)) {
        created.tvdbId = incoming.tvdbId;
        usedTvdbIds.add(incoming.tvdbId);
      } else if (incoming.tvdbId) {
        summary.warnings.push(
          `TVDB ID ${incoming.tvdbId} is already used by other media here, so it was left off TMDB ID ${incoming.tmdbId}.`
        );
      }

      created.seasons = incoming.seasons.map(
        (season) =>
          new Season({
            seasonNumber: season.seasonNumber,
            status: season.status,
            status4k: season.status4k,
          })
      );

      await manager.getRepository(Media).save(created, saveOptions);

      summary.media.created += 1;
      summary.seasons.created += created.seasons.length;
      byTmdb.set(mediaKey(created.mediaType, created.tmdbId), created);
      mediaMap.set(incoming.id, created.id);
      continue;
    }

    mediaMap.set(incoming.id, existing.id);

    // The same title can be on both media servers, so keep whichever status is
    // further along and fill in the ids the other instance knew about.
    let changed = fillIfEmpty(existing, incoming, [
      'imdbId',
      'serviceId',
      'serviceId4k',
      'externalServiceId',
      'externalServiceId4k',
      'externalServiceSlug',
      'externalServiceSlug4k',
      'ratingKey',
      'ratingKey4k',
      'jellyfinMediaId',
      'jellyfinMediaId4k',
    ]);

    if (
      !existing.tvdbId &&
      incoming.tvdbId &&
      !usedTvdbIds.has(incoming.tvdbId)
    ) {
      existing.tvdbId = incoming.tvdbId;
      usedTvdbIds.add(incoming.tvdbId);
      changed = true;
    }

    const mergedStatus = bestStatus(existing.status, incoming.status);
    const mergedStatus4k = bestStatus(existing.status4k, incoming.status4k);

    if (mergedStatus !== existing.status) {
      existing.status = mergedStatus;
      changed = true;
    }

    if (mergedStatus4k !== existing.status4k) {
      existing.status4k = mergedStatus4k;
      changed = true;
    }

    const existingSeasons = new Map(
      existing.seasons.map((season) => [season.seasonNumber, season])
    );

    for (const incomingSeason of incoming.seasons) {
      const existingSeason = existingSeasons.get(incomingSeason.seasonNumber);

      if (!existingSeason) {
        existing.seasons.push(
          new Season({
            seasonNumber: incomingSeason.seasonNumber,
            status: incomingSeason.status,
            status4k: incomingSeason.status4k,
          })
        );
        summary.seasons.created += 1;
        changed = true;
        continue;
      }

      const seasonStatus = bestStatus(
        existingSeason.status,
        incomingSeason.status
      );
      const seasonStatus4k = bestStatus(
        existingSeason.status4k,
        incomingSeason.status4k
      );

      if (
        seasonStatus !== existingSeason.status ||
        seasonStatus4k !== existingSeason.status4k
      ) {
        existingSeason.status = seasonStatus;
        existingSeason.status4k = seasonStatus4k;
        summary.seasons.updated += 1;
        changed = true;
      }
    }

    if (changed) {
      await manager.getRepository(Media).save(existing, saveOptions);
      summary.media.updated += 1;
    } else {
      summary.media.skipped += 1;
    }
  }

  return mediaMap;
};

const mergeRequests = async (
  source: DataSource,
  manager: EntityManager,
  summary: MergeSummary,
  userMap: Map<number, number>,
  mediaMap: Map<number, number>
): Promise<void> => {
  const sourceRequests = await source.getRepository(MediaRequest).find({
    relations: { media: true, requestedBy: true, modifiedBy: true },
    order: { id: 'ASC' },
  });

  const destRequests = await manager.getRepository(MediaRequest).find({
    relations: { media: true, requestedBy: true },
  });

  const requestKey = (mediaId: number, is4k: boolean, userId: number) =>
    `${mediaId}:${is4k}:${userId}`;

  const existingKeys = new Set(
    destRequests.map((request) =>
      requestKey(request.media.id, request.is4k, request.requestedBy.id)
    )
  );

  for (const incoming of sourceRequests) {
    const mediaId = mediaMap.get(incoming.media?.id);
    const requestedById = userMap.get(incoming.requestedBy?.id);

    if (!mediaId || !requestedById) {
      summary.requests.skipped += 1;
      continue;
    }

    const key = requestKey(mediaId, incoming.is4k, requestedById);

    if (existingKeys.has(key)) {
      summary.requests.skipped += 1;
      continue;
    }

    const modifiedById = incoming.modifiedBy
      ? userMap.get(incoming.modifiedBy.id)
      : undefined;

    const request = new MediaRequest({
      status: incoming.status,
      media: { id: mediaId } as Media,
      requestedBy: { id: requestedById } as User,
      modifiedBy: modifiedById ? ({ id: modifiedById } as User) : undefined,
      createdAt: incoming.createdAt,
      type: incoming.type,
      is4k: incoming.is4k,
      serverId: incoming.serverId,
      profileId: incoming.profileId,
      rootFolder: incoming.rootFolder,
      languageProfileId: incoming.languageProfileId,
      tags: incoming.tags,
      isAutoRequest: incoming.isAutoRequest,
      ignoreQuota: incoming.ignoreQuota,
    });

    // Saved with listeners off: re-inserting historic requests must not fire
    // notifications or push anything to Radarr/Sonarr.
    await manager.getRepository(MediaRequest).save(request, saveOptions);

    if (incoming.type === MediaType.TV) {
      const sourceSeasons = await source.getRepository(SeasonRequest).find({
        where: { request: { id: incoming.id } },
      });

      for (const season of sourceSeasons) {
        await manager.getRepository(SeasonRequest).save(
          new SeasonRequest({
            seasonNumber: season.seasonNumber,
            status: season.status,
            request,
            createdAt: season.createdAt,
          }),
          saveOptions
        );
      }
    }

    existingKeys.add(key);
    summary.requests.created += 1;
  }
};

const mergeIssues = async (
  source: DataSource,
  manager: EntityManager,
  summary: MergeSummary,
  userMap: Map<number, number>,
  mediaMap: Map<number, number>
): Promise<void> => {
  const sourceIssues = await source.getRepository(Issue).find({
    relations: {
      media: true,
      createdBy: true,
      modifiedBy: true,
      comments: { user: true },
    },
    order: { id: 'ASC' },
  });

  const destIssues = await manager.getRepository(Issue).find({
    relations: { media: true, createdBy: true },
  });

  const issueKey = (
    mediaId: number,
    userId: number,
    issueType: number,
    season: number,
    episode: number
  ) => `${mediaId}:${userId}:${issueType}:${season}:${episode}`;

  const existingKeys = new Set(
    destIssues.map((issue) =>
      issueKey(
        issue.media.id,
        issue.createdBy.id,
        issue.issueType,
        issue.problemSeason,
        issue.problemEpisode
      )
    )
  );

  for (const incoming of sourceIssues) {
    const mediaId = mediaMap.get(incoming.media?.id);
    const createdById = userMap.get(incoming.createdBy?.id);

    if (!mediaId || !createdById) {
      summary.issues.skipped += 1;
      continue;
    }

    const key = issueKey(
      mediaId,
      createdById,
      incoming.issueType,
      incoming.problemSeason,
      incoming.problemEpisode
    );

    if (existingKeys.has(key)) {
      summary.issues.skipped += 1;
      continue;
    }

    const modifiedById = incoming.modifiedBy
      ? userMap.get(incoming.modifiedBy.id)
      : undefined;

    const issue = new Issue({
      issueType: incoming.issueType,
      status: incoming.status,
      problemSeason: incoming.problemSeason,
      problemEpisode: incoming.problemEpisode,
      media: { id: mediaId } as Media,
      createdBy: { id: createdById } as User,
      modifiedBy: modifiedById ? ({ id: modifiedById } as User) : undefined,
      createdAt: incoming.createdAt,
    });

    await manager.getRepository(Issue).save(issue, saveOptions);

    for (const comment of incoming.comments ?? []) {
      const commentUserId = userMap.get(comment.user?.id);

      if (!commentUserId) {
        continue;
      }

      await manager.getRepository(IssueComment).save(
        new IssueComment({
          message: comment.message,
          issue,
          user: { id: commentUserId } as User,
          createdAt: comment.createdAt,
        }),
        saveOptions
      );

      summary.issueComments.created += 1;
    }

    existingKeys.add(key);
    summary.issues.created += 1;
  }
};

const mergeWatchlists = async (
  source: DataSource,
  manager: EntityManager,
  summary: MergeSummary,
  userMap: Map<number, number>,
  mediaMap: Map<number, number>
): Promise<void> => {
  const sourceWatchlists = await source.getRepository(Watchlist).find({
    relations: { requestedBy: true, media: true },
    order: { id: 'ASC' },
  });

  const destWatchlists = await manager.getRepository(Watchlist).find({
    relations: { requestedBy: true },
  });

  const key = (tmdbId: number, mediaType: MediaType, userId: number) =>
    `${tmdbId}:${mediaType}:${userId}`;

  const existingKeys = new Set(
    destWatchlists.map((watchlist) =>
      key(watchlist.tmdbId, watchlist.mediaType, watchlist.requestedBy.id)
    )
  );

  for (const incoming of sourceWatchlists) {
    const requestedById = userMap.get(incoming.requestedBy?.id);
    const mediaId = mediaMap.get(incoming.media?.id);

    if (!requestedById || !mediaId) {
      summary.watchlists.skipped += 1;
      continue;
    }

    const watchlistKey = key(
      incoming.tmdbId,
      incoming.mediaType,
      requestedById
    );

    if (existingKeys.has(watchlistKey)) {
      summary.watchlists.skipped += 1;
      continue;
    }

    await manager.getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: incoming.ratingKey,
        mediaType: incoming.mediaType,
        title: incoming.title,
        tmdbId: incoming.tmdbId,
        requestedBy: { id: requestedById } as User,
        media: { id: mediaId } as Media,
      }),
      saveOptions
    );

    existingKeys.add(watchlistKey);
    summary.watchlists.created += 1;
  }
};

const mergeBlocklist = async (
  source: DataSource,
  manager: EntityManager,
  summary: MergeSummary,
  userMap: Map<number, number>,
  mediaMap: Map<number, number>
): Promise<void> => {
  const sourceBlocklist = await source.getRepository(Blocklist).find({
    relations: { media: true },
    order: { id: 'ASC' },
  });

  const destBlocklist = await manager.getRepository(Blocklist).find();

  const existingKeys = new Set(
    destBlocklist.map((item) => `${item.tmdbId}:${item.mediaType}`)
  );

  for (const incoming of sourceBlocklist) {
    const blocklistKey = `${incoming.tmdbId}:${incoming.mediaType}`;

    if (existingKeys.has(blocklistKey)) {
      summary.blocklist.skipped += 1;
      continue;
    }

    const mediaId = incoming.media
      ? mediaMap.get(incoming.media.id)
      : undefined;
    const userId = incoming.user ? userMap.get(incoming.user.id) : undefined;

    await manager.getRepository(Blocklist).save(
      new Blocklist({
        mediaType: incoming.mediaType,
        title: incoming.title,
        tmdbId: incoming.tmdbId,
        blocklistedTags: incoming.blocklistedTags,
        user: userId ? ({ id: userId } as User) : undefined,
        media: mediaId ? ({ id: mediaId } as Media) : undefined,
      }),
      saveOptions
    );

    existingKeys.add(blocklistKey);
    summary.blocklist.created += 1;
  }
};

export const mergeInstance = async ({
  source,
  destination,
  apply,
  keepPermissions = false,
  log = () => undefined,
}: MergeOptions): Promise<MergeSummary> => {
  const summary: MergeSummary = {
    users: emptyCounts(),
    media: emptyCounts(),
    seasons: emptyCounts(),
    requests: emptyCounts(),
    issues: emptyCounts(),
    issueComments: emptyCounts(),
    watchlists: emptyCounts(),
    blocklist: emptyCounts(),
    warnings: [],
    applied: apply,
  };

  try {
    // The whole merge runs in one transaction so a dry run can roll back and a
    // real run either lands completely or not at all.
    await destination.transaction(async (manager) => {
      log('Merging users...');
      const userMap = await mergeUsers(
        source,
        manager,
        summary,
        keepPermissions
      );

      log('Merging media...');
      const mediaMap = await mergeMedia(source, manager, summary);

      log('Merging requests...');
      await mergeRequests(source, manager, summary, userMap, mediaMap);

      log('Merging issues...');
      await mergeIssues(source, manager, summary, userMap, mediaMap);

      log('Merging watchlists...');
      await mergeWatchlists(source, manager, summary, userMap, mediaMap);

      log('Merging blocklist...');
      await mergeBlocklist(source, manager, summary, userMap, mediaMap);

      if (!apply) {
        throw new DryRunRollback();
      }
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) {
      throw e;
    }
  }

  return summary;
};

export default mergeInstance;
