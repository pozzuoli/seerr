import type { JellyfinLibraryItem } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import type { PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeason, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import type Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import {
  getEnabledMediaServers,
  getMediaServerName,
  isJellyfinEnabled,
  isPlexEnabled,
} from '@server/lib/mediaServers';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import { Brackets, In } from 'typeorm';

class AvailabilitySync {
  public running = false;
  private plexClient: PlexAPI;
  private plexSeasonsCache: Record<string, PlexMetadata[]>;
  private plexEpisodeExistsCache: Record<string, boolean>;

  private jellyfinClient: JellyfinAPI;
  private jellyfinSeasonsCache: Record<string, JellyfinLibraryItem[]>;
  private jellyfinEpisodeExistsCache: Record<string, boolean>;

  /**
   * Whether each connected media server could actually be reached this run. A
   * server we cannot query tells us nothing about availability, so its checks
   * report "still exists" to avoid wrongly deleting media.
   */
  private plexAvailable = false;
  private jellyfinAvailable = false;

  private sonarrSeasonsCache: Record<string, SonarrSeason[]>;
  private radarrServers: RadarrSettings[];
  private sonarrServers: SonarrSettings[];
  private enable4kMovie: boolean;
  private enable4kShow: boolean;

  readonly tmdb = new TheMovieDb();

  /** How many media rows each page of the sync loads. */
  pageSize = 50;

  async run() {
    // A second run would reset the caches and clients the first one is using.
    if (this.running) {
      logger.warn('Availability sync is already running.', {
        label: 'AvailabilitySync',
      });
      return;
    }

    const settings = getSettings();
    const enabledMediaServers = getEnabledMediaServers();
    const plexEnabled = isPlexEnabled();
    const jellyfinEnabled = isJellyfinEnabled();
    this.running = true;
    this.plexAvailable = false;
    this.jellyfinAvailable = false;
    this.plexSeasonsCache = {};
    this.plexEpisodeExistsCache = {};
    this.jellyfinSeasonsCache = {};
    this.jellyfinEpisodeExistsCache = {};
    this.sonarrSeasonsCache = {};
    this.radarrServers = settings.radarr;
    this.sonarrServers = settings.sonarr;
    this.enable4kMovie = this.radarrServers.some((server) => server.is4k);
    this.enable4kShow = this.sonarrServers.some((server) => server.is4k);

    try {
      logger.info(`Starting availability sync...`, {
        label: 'AvailabilitySync',
      });

      const userRepository = getRepository(User);

      if (enabledMediaServers.length === 0) {
        logger.error('No media server is configured.', {
          label: 'AvailabilitySync',
        });

        this.running = false;
        return;
      }

      // Plex authenticates as the admin's own account while Jellyfin/Emby uses
      // the admin's user id plus the server API key, so fetch both up front.
      const admin = await userRepository.findOne({
        where: { id: 1 },
        select: ['id', 'plexToken', 'jellyfinUserId', 'jellyfinDeviceId'],
        order: { id: 'ASC' },
      });

      if (!admin) {
        logger.error('An admin is not configured.', {
          label: 'AvailabilitySync',
        });

        this.running = false;
        return;
      }

      if (plexEnabled) {
        if (admin.plexToken) {
          this.plexClient = new PlexAPI({ plexToken: admin.plexToken });

          // Check Plex answers before trusting it, as Jellyfin is checked
          // below. Otherwise an outage reads as Plex no longer having
          // anything, and the "nothing reachable" guard cannot see it.
          try {
            await this.plexClient.getStatus();
            this.plexAvailable = true;
          } catch (e) {
            logger.error(
              'Plex is unreachable. Its availability will not be checked.',
              {
                label: 'AvailabilitySync',
                errorMessage: e.message,
              }
            );
          }
        } else {
          logger.error(
            'Plex admin is not configured. Plex availability will not be checked.',
            { label: 'AvailabilitySync' }
          );
        }
      }

      if (jellyfinEnabled) {
        this.jellyfinClient = new JellyfinAPI(
          getHostname(),
          settings.jellyfin.apiKey,
          admin.jellyfinDeviceId
        );

        this.jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

        try {
          await this.jellyfinClient.getSystemInfo();
          this.jellyfinAvailable = true;
        } catch (e) {
          logger.error(
            `${getMediaServerName(
              enabledMediaServers.includes(MediaServerType.EMBY)
                ? MediaServerType.EMBY
                : MediaServerType.JELLYFIN
            )} is unreachable. Its availability will not be checked.`,
            {
              label: 'AvailabilitySync',
              status: e.statusCode,
              error: e.name,
              errorMessage: e.errorCode,
            }
          );
        }
      }

      // Every connected media server failed to respond. Continuing would mark
      // media as deleted purely because we could not reach anything.
      if (!this.plexAvailable && !this.jellyfinAvailable) {
        logger.error(
          'No media server could be reached. Sync interrupted to avoid removing available media.',
          { label: 'AvailabilitySync' }
        );

        this.running = false;
        return;
      }

      for await (const media of this.loadAvailableMediaPaginated(
        this.pageSize
      )) {
        if (!this.running) {
          throw new Error('Job aborted');
        }

        // Check plex, radarr, and sonarr for that specific media and
        // if unavailable, then we change the status accordingly.
        // If a non-4k or 4k version exists in at least one of the instances, we will only update that specific version
        if (media.mediaType === 'movie') {
          const existsInRadarr = await this.mediaExistsInRadarr(media, false);
          const existsInRadarr4k = await this.mediaExistsInRadarr(media, true);

          const { existsInPlex } = await this.mediaExistsInPlex(media, false);
          const { existsInPlex: existsInPlex4k } = await this.mediaExistsInPlex(
            media,
            true
          );

          const { existsInJellyfin } = await this.mediaExistsInJellyfin(
            media,
            false
          );
          const { existsInJellyfin: existsInJellyfin4k } =
            await this.mediaExistsInJellyfin(media, true);

          // The media only needs to exist on one connected media server (or in
          // Radarr) for us to keep it.
          const movieExists =
            existsInRadarr || existsInPlex || existsInJellyfin;
          const movieExists4k =
            existsInRadarr4k || existsInPlex4k || existsInJellyfin4k;

          if (movieExists) {
            logger.debug(
              `The non-4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          if (movieExists4k) {
            logger.debug(
              `The 4K movie [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          if (!movieExists && media.status === MediaStatus.AVAILABLE) {
            await this.mediaUpdater(media, false, enabledMediaServers);
          }

          if (!movieExists4k && media.status4k === MediaStatus.AVAILABLE) {
            await this.mediaUpdater(media, true, enabledMediaServers);
          }
        }

        // If both versions still exist in plex, we still need
        // to check through sonarr to verify season availability
        if (media.mediaType === 'tv') {
          const { existsInPlex, seasonsMap: plexSeasonsMap = new Map() } =
            await this.mediaExistsInPlex(media, false);
          const {
            existsInPlex: existsInPlex4k,
            seasonsMap: plexSeasonsMap4k = new Map(),
          } = await this.mediaExistsInPlex(media, true);

          const {
            existsInJellyfin,
            seasonsMap: jellyfinSeasonsMap = new Map(),
          } = await this.mediaExistsInJellyfin(media, false);
          const {
            existsInJellyfin: existsInJellyfin4k,
            seasonsMap: jellyfinSeasonsMap4k = new Map(),
          } = await this.mediaExistsInJellyfin(media, true);

          const { existsInSonarr, seasonsMap: sonarrSeasonsMap } =
            await this.mediaExistsInSonarr(media, false);
          const {
            existsInSonarr: existsInSonarr4k,
            seasonsMap: sonarrSeasonsMap4k,
          } = await this.mediaExistsInSonarr(media, true);

          // The show only needs to exist on one connected media server (or in
          // Sonarr) for us to keep it.
          const showExists = existsInSonarr || existsInPlex || existsInJellyfin;
          const showExists4k =
            existsInSonarr4k || existsInPlex4k || existsInJellyfin4k;

          if (showExists) {
            logger.debug(
              `The non-4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          if (showExists4k) {
            logger.debug(
              `The 4K show [TMDB ID ${media.tmdbId}] still exists. Preventing removal.`,
              {
                label: 'AvailabilitySync',
              }
            );
          }

          // Here we will create a final map that will cross compare
          // with plex and sonarr. Filtered seasons will go through
          // each season and assume the season does not exist. If Plex or
          // Sonarr finds that season, we will change the final seasons value
          // to true.
          const filteredSeasonsMap: Map<number, boolean> = new Map();
          media.seasons
            .filter(
              (season) =>
                season.status === MediaStatus.AVAILABLE ||
                season.status === MediaStatus.PARTIALLY_AVAILABLE
            )
            .forEach((season) =>
              filteredSeasonsMap.set(season.seasonNumber, false)
            );

          const filteredSeasonsMap4k: Map<number, boolean> = new Map();
          media.seasons
            .filter(
              (season) =>
                season.status4k === MediaStatus.AVAILABLE ||
                season.status4k === MediaStatus.PARTIALLY_AVAILABLE
            )
            .forEach((season) =>
              filteredSeasonsMap4k.set(season.seasonNumber, false)
            );

          // Every server-specific map only ever records seasons that were
          // found, so merging them keeps a season alive if any connected
          // media server still has it.
          const finalSeasons: Map<number, boolean> = new Map([
            ...filteredSeasonsMap,
            ...plexSeasonsMap,
            ...jellyfinSeasonsMap,
            ...sonarrSeasonsMap,
          ]);
          const finalSeasons4k: Map<number, boolean> = new Map([
            ...filteredSeasonsMap4k,
            ...plexSeasonsMap4k,
            ...jellyfinSeasonsMap4k,
            ...sonarrSeasonsMap4k,
          ]);

          // We need to fetch from TMDB to get the episode count for each season
          let tvShow: TmdbTvScanDetails | TmdbTvDetails | undefined;
          try {
            if (media.tmdbId) {
              tvShow = await this.tmdb.getTvShowForScan({
                tvId: Number(media.tmdbId),
              });
            } else if (media.tvdbId) {
              tvShow = await this.tmdb.getShowByTvdbIdForScan({
                tvdbId: Number(media.tvdbId),
              });
            }
          } catch (e) {
            logger.debug(
              `Failed to fetch TMDB data for show [TMDB ID ${media.tmdbId}]. Skipping season enrichment.`,
              { label: 'AvailabilitySync', errorMessage: e.message }
            );
          }

          if (tvShow) {
            // fill the finalSeasons and finalSeasons4k maps with false for missing seasons
            media.seasons.forEach((season) => {
              // Specials don't count towards availability (baseScanner skips them too)
              // TODO: doesn't respect enableSpecialEpisodes; needs a shared predicate with baseScanner.ts
              if (season.seasonNumber === 0) {
                return;
              }
              if (
                !finalSeasons.has(season.seasonNumber) &&
                tvShow.seasons.find(
                  (s) => s.season_number === season.seasonNumber
                )?.episode_count
              ) {
                finalSeasons.set(season.seasonNumber, false);
              }
              if (
                !finalSeasons4k.has(season.seasonNumber) &&
                tvShow.seasons.find(
                  (s) => s.season_number === season.seasonNumber
                )?.episode_count
              ) {
                finalSeasons4k.set(season.seasonNumber, false);
              }
            });
          }

          if (
            !showExists &&
            (media.status === MediaStatus.AVAILABLE ||
              media.status === MediaStatus.PARTIALLY_AVAILABLE ||
              media.seasons.some(
                (season) => season.status === MediaStatus.AVAILABLE
              ) ||
              media.seasons.some(
                (season) => season.status === MediaStatus.PARTIALLY_AVAILABLE
              ))
          ) {
            await this.mediaUpdater(media, false, enabledMediaServers);
          }

          if (
            !showExists4k &&
            (media.status4k === MediaStatus.AVAILABLE ||
              media.status4k === MediaStatus.PARTIALLY_AVAILABLE ||
              media.seasons.some(
                (season) => season.status4k === MediaStatus.AVAILABLE
              ) ||
              media.seasons.some(
                (season) => season.status4k === MediaStatus.PARTIALLY_AVAILABLE
              ))
          ) {
            await this.mediaUpdater(media, true, enabledMediaServers);
          }

          // TODO: Figure out how to run seasonUpdater for each season

          if ([...finalSeasons.values()].includes(false)) {
            await this.seasonUpdater(
              media,
              finalSeasons,
              false,
              enabledMediaServers
            );
          }

          if ([...finalSeasons4k.values()].includes(false)) {
            await this.seasonUpdater(
              media,
              finalSeasons4k,
              true,
              enabledMediaServers
            );
          }
        }
      }
    } catch (ex) {
      logger.error('Failed to complete availability sync.', {
        errorMessage: ex.message,
        label: 'AvailabilitySync',
      });
    } finally {
      logger.info(`Availability sync complete.`, {
        label: 'AvailabilitySync',
      });
      this.running = false;
    }
  }

  public cancel() {
    this.running = false;
  }

  /**
   * Pages through media that is available in any form. Pages continue after
   * the last id seen rather than at an offset: the sync marks media deleted as
   * it goes, which shrinks the result set and would make an offset skip rows.
   */
  private async *loadAvailableMediaPaginated(pageSize: number) {
    const mediaRepository = getRepository(Media);
    const available = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];
    let lastId = 0;

    while (true) {
      const ids = (
        await mediaRepository
          .createQueryBuilder('media')
          .select('media.id', 'id')
          .distinct(true)
          .leftJoin('media.seasons', 'season')
          .where('media.id > :lastId', { lastId })
          .andWhere(
            new Brackets((qb) =>
              qb
                .where('media.status IN (:...available)', { available })
                .orWhere('media.status4k IN (:...available)')
                .orWhere('season.status IN (:...available)')
                .orWhere('season.status4k IN (:...available)')
            )
          )
          .orderBy('media.id', 'ASC')
          .limit(pageSize)
          .getRawMany<{ id: number }>()
      ).map((row) => Number(row.id));

      if (ids.length === 0) {
        return;
      }

      // Load the rows separately so every season comes with them, not only
      // the seasons that matched the filter.
      yield* await mediaRepository.find({
        where: { id: In(ids) },
        order: { id: 'ASC' },
      });

      lastId = ids[ids.length - 1];
    }
  }

  private async mediaUpdater(
    media: Media,
    is4k: boolean,
    mediaServers: MediaServerType[]
  ): Promise<void> {
    const mediaRepository = getRepository(Media);

    try {
      // Check if an approved request for this version is still in flight
      // to see if we need to keep the external metadata
      let isMediaProcessing = false;

      const requestRepository = getRepository(MediaRequest);

      const request = await requestRepository
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .where('(media.id = :id)', {
          id: media.id,
        })
        .andWhere(
          '(request.is4k = :is4k AND request.status = :requestStatus)',
          {
            requestStatus: MediaRequestStatus.APPROVED,
            is4k: is4k,
          }
        )
        .getOne();

      if (request) {
        isMediaProcessing = true;
      }

      // Set the non-4K or 4K media to deleted
      // and change related columns to null if media
      // is not processing
      media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      media[is4k ? 'serviceId4k' : 'serviceId'] = isMediaProcessing
        ? media[is4k ? 'serviceId4k' : 'serviceId']
        : null;
      media[is4k ? 'externalServiceId4k' : 'externalServiceId'] =
        isMediaProcessing
          ? media[is4k ? 'externalServiceId4k' : 'externalServiceId']
          : null;
      media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'] =
        isMediaProcessing
          ? media[is4k ? 'externalServiceSlug4k' : 'externalServiceSlug']
          : null;
      // We only get here once the media is missing from every connected media
      // server, so clear the id each of them stored for it.
      if (mediaServers.includes(MediaServerType.PLEX)) {
        media[is4k ? 'ratingKey4k' : 'ratingKey'] = isMediaProcessing
          ? media[is4k ? 'ratingKey4k' : 'ratingKey']
          : null;
      }

      if (
        mediaServers.includes(MediaServerType.JELLYFIN) ||
        mediaServers.includes(MediaServerType.EMBY)
      ) {
        media[is4k ? 'jellyfinMediaId4k' : 'jellyfinMediaId'] =
          isMediaProcessing
            ? media[is4k ? 'jellyfinMediaId4k' : 'jellyfinMediaId']
            : null;
      }
      logger.debug(
        `The ${is4k ? '4K' : 'non-4K'} ${
          media.mediaType === 'movie' ? 'movie' : 'show'
        } [TMDB ID ${media.tmdbId}] was not found in any ${
          media.mediaType === 'movie' ? 'Radarr' : 'Sonarr'
        } and ${mediaServers
          .map((serverType) => getMediaServerName(serverType).toLowerCase())
          .join('/')} instance. Status will be changed to deleted.`,
        { label: 'AvailabilitySync' }
      );

      await mediaRepository.save(media);
    } catch (ex) {
      logger.debug(
        `Failure updating the ${is4k ? '4K' : 'non-4K'} ${
          media.mediaType === 'tv' ? 'show' : 'movie'
        } [TMDB ID ${media.tmdbId}].`,
        {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        }
      );
    }
  }

  private async seasonUpdater(
    media: Media,
    seasons: Map<number, boolean>,
    is4k: boolean,
    mediaServers: MediaServerType[]
  ): Promise<void> {
    const mediaRepository = getRepository(Media);

    // Filter out only the values that are false
    // (media that should be deleted)
    const seasonsPendingRemoval = new Map(
      // Disabled linter as only the value is needed from the filter
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [...seasons].filter(([_, exists]) => !exists)
    );
    // Retrieve the season keys to pass into our log
    const seasonKeys = [...seasonsPendingRemoval.keys()];
    // Specials can still be marked DELETED below, but shouldn't demote the show
    const nonSpecialSeasonKeys = seasonKeys.filter((key) => key !== 0);

    try {
      for (const mediaSeason of media.seasons) {
        if (
          seasonsPendingRemoval.has(mediaSeason.seasonNumber) &&
          (mediaSeason[is4k ? 'status4k' : 'status'] ===
            MediaStatus.AVAILABLE ||
            mediaSeason[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE)
        ) {
          mediaSeason[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        }
      }

      if (
        nonSpecialSeasonKeys.length > 0 &&
        media[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
      ) {
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PARTIALLY_AVAILABLE;
        logger.debug(
          `Marking the ${
            is4k ? '4K' : 'non-4K'
          } show [TMDB ID ${media.tmdbId}] as PARTIALLY_AVAILABLE because season(s) [${nonSpecialSeasonKeys}] was not found in any ${
            media.mediaType === 'tv' ? 'Sonarr' : 'Radarr'
          } and ${mediaServers
            .map((serverType) => getMediaServerName(serverType).toLowerCase())
            .join('/')} instance.`,
          { label: 'AvailabilitySync' }
        );
      }

      media.lastSeasonChange = new Date();
      await mediaRepository.save(media);
    } catch (ex) {
      logger.debug(
        `Failure updating the ${
          is4k ? '4K' : 'non-4K'
        } season(s) [${seasonKeys}], TMDB ID ${media.tmdbId}.`,
        {
          errorMessage: ex.message,
          label: 'AvailabilitySync',
        }
      );
    }
  }

  private async mediaExistsInRadarr(
    media: Media,
    is4k: boolean
  ): Promise<boolean> {
    let existsInRadarr = false;

    const hasSameServerInBothModes = this.radarrServers.some((a) =>
      this.radarrServers.some(
        (b) =>
          a.is4k !== b.is4k && a.hostname === b.hostname && a.port === b.port
      )
    );

    // Check for availability in all of the available radarr servers
    // If any find the media, we will assume the media exists
    for (const server of this.radarrServers.filter(
      (server) => server.is4k === is4k
    )) {
      const radarrAPI = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        let radarr: RadarrMovie | undefined;

        if (media.externalServiceId && !is4k) {
          radarr = await radarrAPI.getMovie({
            id: media.externalServiceId,
          });
        }

        if (media.externalServiceId4k && is4k) {
          radarr = await radarrAPI.getMovie({
            id: media.externalServiceId4k,
          });
        }

        if (radarr && radarr.tmdbId !== media.tmdbId) {
          continue;
        }

        if (radarr && radarr.hasFile) {
          const resolution =
            radarr?.movieFile?.mediaInfo?.resolution?.split('x');
          const is4kMovie =
            resolution?.length === 2 && Number(resolution[0]) >= 2000;

          if (hasSameServerInBothModes && resolution?.length === 2) {
            // Same server in both modes then use resolution to distinguish
            existsInRadarr = is4k ? is4kMovie : !is4kMovie;
          } else {
            // One server type and if file exists, count it
            existsInRadarr = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInRadarr = true;
          logger.debug(
            `Failure retrieving the ${is4k ? '4K' : 'non-4K'} movie [TMDB ID ${
              media.tmdbId
            }] from Radarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }

      if (existsInRadarr) break;
    }

    return existsInRadarr;
  }

  private async mediaExistsInSonarr(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInSonarr: boolean; seasonsMap: Map<number, boolean> }> {
    let existsInSonarr = false;
    let preventSeasonSearch = false;

    // Check for availability in all of the available sonarr servers
    // If any find the media, we will assume the media exists
    for (const server of this.sonarrServers.filter((server) => {
      return server.is4k === is4k;
    })) {
      const sonarrAPI = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      try {
        let sonarr: SonarrSeries | undefined;

        if (media.externalServiceId && !is4k) {
          sonarr = await sonarrAPI.getSeriesById(media.externalServiceId);
        }

        if (media.externalServiceId4k && is4k) {
          sonarr = await sonarrAPI.getSeriesById(media.externalServiceId4k);
        }

        if (sonarr && media.tvdbId != null && sonarr.tvdbId !== media.tvdbId) {
          continue;
        }

        if (sonarr) {
          const externalServiceId = is4k
            ? media.externalServiceId4k
            : media.externalServiceId;
          this.sonarrSeasonsCache[`${server.id}-${externalServiceId}`] =
            sonarr.seasons;

          if (sonarr.statistics.episodeFileCount > 0) {
            existsInSonarr = true;
          }
        }
      } catch (ex) {
        if (!ex.message.includes('404')) {
          existsInSonarr = true;
          preventSeasonSearch = true;
          logger.debug(
            `Failure retrieving the ${is4k ? '4K' : 'non-4K'} show [TMDB ID ${
              media.tmdbId
            }] from Sonarr.`,
            {
              errorMessage: ex.message,
              label: 'AvailabilitySync',
            }
          );
        }
      }
    }

    // Here we check each season for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    const seasonsMap: Map<number, boolean> = new Map();

    if (!preventSeasonSearch) {
      const filteredSeasons = media.seasons.filter(
        (season) =>
          season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
          season[is4k ? 'status4k' : 'status'] ===
            MediaStatus.PARTIALLY_AVAILABLE
      );

      for (const season of filteredSeasons) {
        const seasonExists = await this.seasonExistsInSonarr(
          media,
          season,
          is4k
        );

        if (seasonExists) {
          seasonsMap.set(season.seasonNumber, true);
        }
      }
    }

    return { existsInSonarr, seasonsMap };
  }

  private async seasonExistsInSonarr(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    let seasonExists = false;

    // Check each sonarr instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInSonarr
    for (const server of this.sonarrServers.filter(
      (server) => server.is4k === is4k
    )) {
      let sonarrSeasons: SonarrSeason[] | undefined;

      if (media.externalServiceId && !is4k) {
        sonarrSeasons =
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId}`];
      }

      if (media.externalServiceId4k && is4k) {
        sonarrSeasons =
          this.sonarrSeasonsCache[`${server.id}-${media.externalServiceId4k}`];
      }

      const seasonIsAvailable = sonarrSeasons?.find(
        ({ seasonNumber, statistics }) =>
          season.seasonNumber === seasonNumber &&
          statistics?.episodeFileCount &&
          statistics?.episodeFileCount > 0
      );

      if (seasonIsAvailable && sonarrSeasons) {
        seasonExists = true;
      }
    }

    return seasonExists;
  }

  // Plex
  private async mediaExistsInPlex(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInPlex: boolean; seasonsMap?: Map<number, boolean> }> {
    if (!this.plexAvailable) {
      // Either Plex is not connected at all (it can rule nothing out) or it was
      // unreachable this run (we cannot rule the media out, so keep it).
      const unverified = isPlexEnabled();

      return {
        existsInPlex: unverified,
        seasonsMap: unverified
          ? new Map(media.seasons.map((season) => [season.seasonNumber, true]))
          : new Map(),
      };
    }

    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;
    let existsInPlex = false;
    let preventSeasonSearch = false;

    // Check each plex instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInPlex
    try {
      let plexMedia: PlexMetadata | undefined;

      if (ratingKey && !is4k) {
        plexMedia = await this.plexClient?.getMetadata(ratingKey);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey] =
            await this.plexClient?.getChildrenMetadata(ratingKey);
        }

        if (
          plexMedia &&
          media.mediaType === 'movie' &&
          this.enable4kMovie &&
          plexMedia.Media?.length &&
          !plexMedia.Media.some((mediaItem) => (mediaItem.width ?? 0) < 2000)
        ) {
          plexMedia = undefined;
        }
      }

      if (ratingKey4k && is4k) {
        plexMedia = await this.plexClient?.getMetadata(ratingKey4k);

        if (media.mediaType === 'tv') {
          this.plexSeasonsCache[ratingKey4k] =
            await this.plexClient?.getChildrenMetadata(ratingKey4k);
        }

        if (plexMedia) {
          if (
            plexMedia &&
            media.mediaType === 'movie' &&
            plexMedia.Media?.length &&
            !plexMedia.Media.some((mediaItem) => (mediaItem.width ?? 0) >= 2000)
          ) {
            plexMedia = undefined;
          }

          if (plexMedia && media.mediaType === 'tv') {
            const cachedSeasons = this.plexSeasonsCache[ratingKey4k];
            if (cachedSeasons?.length) {
              let has4kInAnySeason = false;
              let verifiedAnySeason = false;
              for (const season of cachedSeasons) {
                try {
                  const episodes = await this.plexClient?.getChildrenMetadata(
                    season.ratingKey
                  );
                  if (episodes?.some((episode) => episode.Media?.length)) {
                    verifiedAnySeason = true;
                  }
                  const has4kEpisode = episodes?.some((episode) =>
                    episode.Media?.some(
                      (mediaItem) => (mediaItem.width ?? 0) >= 2000
                    )
                  );
                  if (has4kEpisode) {
                    has4kInAnySeason = true;
                    break;
                  }
                } catch {
                  // If we can't fetch episodes for a season, continue checking other seasons
                }
              }
              if (verifiedAnySeason && !has4kInAnySeason) {
                plexMedia = undefined;
              }
            }
          }
        }
      }

      if (plexMedia) {
        existsInPlex = true;
      }
    } catch (ex) {
      if (!ex.message.includes('404')) {
        existsInPlex = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${is4k ? '4K' : 'non-4K'} ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } [TMDB ID ${media.tmdbId}] from Plex.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    // Here we check each season in plex for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    if (media.mediaType === 'tv') {
      const seasonsMap: Map<number, boolean> = new Map();

      if (!preventSeasonSearch) {
        const filteredSeasons = media.seasons.filter(
          (season) =>
            season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE
        );

        for (const season of filteredSeasons) {
          const seasonExists = await this.seasonExistsInPlex(
            media,
            season,
            is4k
          );

          if (seasonExists) {
            seasonsMap.set(season.seasonNumber, true);
          }
        }
      }

      return { existsInPlex, seasonsMap };
    }

    return { existsInPlex };
  }

  private async seasonExistsInPlex(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    const ratingKey = media.ratingKey;
    const ratingKey4k = media.ratingKey4k;
    let seasonExistsInPlex = false;

    let plexSeasons: PlexMetadata[] | undefined;

    if (ratingKey && !is4k) {
      plexSeasons = this.plexSeasonsCache[ratingKey];
    }

    if (ratingKey4k && is4k) {
      plexSeasons = this.plexSeasonsCache[ratingKey4k];
    }

    const seasonMeta = plexSeasons?.find(
      (plexSeason) => plexSeason.index === season.seasonNumber
    );

    if (seasonMeta) {
      const cacheKey = `${is4k ? '4k' : 'std'}-${seasonMeta.ratingKey}`;

      if (cacheKey in this.plexEpisodeExistsCache) {
        seasonExistsInPlex = this.plexEpisodeExistsCache[cacheKey];
      } else {
        try {
          // Season metadata exists, but we need to verify it has actual
          // episode files. Plex can keep empty season entries.
          const episodes = await this.plexClient?.getChildrenMetadata(
            seasonMeta.ratingKey
          );

          const episodeVersions =
            episodes?.flatMap((episode) => episode.Media ?? []) ?? [];

          if (is4k) {
            seasonExistsInPlex = episodeVersions.some(
              (mediaItem) => (mediaItem.width ?? 0) >= 2000
            );
          } else if (this.enable4kShow) {
            seasonExistsInPlex = episodeVersions.some(
              (mediaItem) => (mediaItem.width ?? 0) < 2000
            );
          } else {
            seasonExistsInPlex = episodeVersions.length > 0;
          }
        } catch {
          // If we can't fetch episodes, assume the season exists
          // to avoid false removal
          seasonExistsInPlex = true;
        }

        this.plexEpisodeExistsCache[cacheKey] = seasonExistsInPlex;
      }
    }

    return seasonExistsInPlex;
  }

  // Jellyfin
  private async mediaExistsInJellyfin(
    media: Media,
    is4k: boolean
  ): Promise<{ existsInJellyfin: boolean; seasonsMap?: Map<number, boolean> }> {
    if (!this.jellyfinAvailable) {
      // Either Jellyfin/Emby is not connected at all (it can rule nothing out)
      // or it was unreachable this run (we cannot rule the media out).
      const unverified = isJellyfinEnabled();

      return {
        existsInJellyfin: unverified,
        seasonsMap: unverified
          ? new Map(media.seasons.map((season) => [season.seasonNumber, true]))
          : new Map(),
      };
    }

    const ratingKey = media.jellyfinMediaId;
    const ratingKey4k = media.jellyfinMediaId4k;
    let existsInJellyfin = false;
    let preventSeasonSearch = false;

    // Check each jellyfin instance to see if the media still exists
    // If found, we will assume the media exists and prevent removal
    // We can use the cache we built when we fetched the series with mediaExistsInJellyfin
    try {
      let jellyfinMedia: JellyfinLibraryItem | undefined;

      if (ratingKey && !is4k) {
        jellyfinMedia = await this.jellyfinClient?.getItemData(ratingKey);

        if (media.mediaType === 'tv' && jellyfinMedia !== undefined) {
          this.jellyfinSeasonsCache[ratingKey] =
            await this.jellyfinClient?.getSeasons(ratingKey);
        }
      }

      if (ratingKey4k && is4k) {
        jellyfinMedia = await this.jellyfinClient?.getItemData(ratingKey4k);

        if (media.mediaType === 'tv' && jellyfinMedia !== undefined) {
          this.jellyfinSeasonsCache[ratingKey4k] =
            await this.jellyfinClient?.getSeasons(ratingKey4k);
        }
      }

      if (jellyfinMedia) {
        existsInJellyfin = true;
      }
    } catch (ex) {
      if (!ex.message.includes('404') && !ex.message.includes('500')) {
        existsInJellyfin = true;
        preventSeasonSearch = true;
        logger.debug(
          `Failure retrieving the ${is4k ? '4K' : 'non-4K'} ${
            media.mediaType === 'tv' ? 'show' : 'movie'
          } [TMDB ID ${media.tmdbId}] from Jellyfin.`,
          {
            errorMessage: ex.message,
            label: 'AvailabilitySync',
          }
        );
      }
    }

    // Here we check each season in jellyfin for availability
    // If the API returns an error other than a 404,
    // we will have to prevent the season check from happening
    if (media.mediaType === 'tv') {
      const seasonsMap: Map<number, boolean> = new Map();

      if (!preventSeasonSearch) {
        const filteredSeasons = media.seasons.filter(
          (season) =>
            season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE
        );

        for (const season of filteredSeasons) {
          const seasonExists = await this.seasonExistsInJellyfin(
            media,
            season,
            is4k
          );

          if (seasonExists) {
            seasonsMap.set(season.seasonNumber, true);
          }
        }
      }

      return { existsInJellyfin, seasonsMap };
    }

    return { existsInJellyfin };
  }

  private async seasonExistsInJellyfin(
    media: Media,
    season: Season,
    is4k: boolean
  ): Promise<boolean> {
    const ratingKey = media.jellyfinMediaId;
    const ratingKey4k = media.jellyfinMediaId4k;
    let seasonExistsInJellyfin = false;

    let jellyfinSeasons: JellyfinLibraryItem[] | undefined;

    if (ratingKey && !is4k) {
      jellyfinSeasons = this.jellyfinSeasonsCache[ratingKey];
    }

    if (ratingKey4k && is4k) {
      jellyfinSeasons = this.jellyfinSeasonsCache[ratingKey4k];
    }

    const seasonMeta = jellyfinSeasons?.find(
      (jellyfinSeason) => jellyfinSeason.IndexNumber === season.seasonNumber
    );

    if (seasonMeta) {
      const seriesId = is4k ? ratingKey4k : ratingKey;

      if (seriesId) {
        const cacheKey = `${seriesId}-${seasonMeta.Id}`;

        if (cacheKey in this.jellyfinEpisodeExistsCache) {
          seasonExistsInJellyfin = this.jellyfinEpisodeExistsCache[cacheKey];
        } else {
          try {
            // Season metadata exists, but we need to verify it has actual
            // episode files. Jellyfin keeps season entries even after all
            // episodes are deleted. getEpisodes already filters out
            // virtual episodes.
            const episodes = await this.jellyfinClient.getEpisodes(
              seriesId,
              seasonMeta.Id
            );

            seasonExistsInJellyfin = episodes.length > 0;
          } catch {
            // If we can't fetch episodes, assume the season exists
            // to avoid false removal
            seasonExistsInJellyfin = true;
          }

          this.jellyfinEpisodeExistsCache[cacheKey] = seasonExistsInJellyfin;
        }
      }
    }

    return seasonExistsInJellyfin;
  }
}

const availabilitySync = new AvailabilitySync();

export default availabilitySync;
