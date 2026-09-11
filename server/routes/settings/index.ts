import type {
  JellyfinLibrary,
  JellyfinUserResponse,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { PlexConnection } from '@server/interfaces/api/plexInterfaces';
import type {
  LogMessage,
  LogsResultsResponse,
  MediaServerStatus,
  SettingsAboutResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { scheduledJobs, startJobs } from '@server/job/schedule';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import ImageProxy from '@server/lib/imageproxy';
import {
  forgetJellyfinServer,
  isDifferentJellyfinServer,
} from '@server/lib/jellyfinServerChange';
import {
  disableMediaServer,
  enableMediaServer,
  getEnabledMediaServers,
  getMediaServerName,
} from '@server/lib/mediaServers';
import { Permission } from '@server/lib/permissions';
import { jellyfinFullScanner } from '@server/lib/scanners/jellyfin';
import { plexFullScanner } from '@server/lib/scanners/plex';
import type { JobId, Library, MainSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import discoverSettingRoutes from '@server/routes/settings/discover';
import { ApiError } from '@server/types/error';
import { appDataPath } from '@server/utils/appDataVolume';
import { getAppVersion } from '@server/utils/appVersion';
import { dnsCache } from '@server/utils/dnsCache';
import { getHostname } from '@server/utils/getHostname';
import type { DnsEntries, DnsStats } from 'dns-caching';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { escapeRegExp, merge, omit, set, sortBy } from 'lodash';
import { rescheduleJob } from 'node-schedule';
import path from 'path';
import semver from 'semver';
import { URL } from 'url';
import { z } from 'zod';
import metadataRoutes from './metadata';
import notificationRoutes from './notifications';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';

const settingsRoutes = Router();

settingsRoutes.use('/notifications', notificationRoutes);
settingsRoutes.use('/radarr', radarrRoutes);
settingsRoutes.use('/sonarr', sonarrRoutes);
settingsRoutes.use('/discover', discoverSettingRoutes);
settingsRoutes.use('/metadatas', metadataRoutes);

const libraryUpdateSchema = z.object({
  enabled: z.boolean(),
});

const filteredMainSettings = (
  user: User,
  main: MainSettings
): Partial<MainSettings> => {
  if (!user?.hasPermission(Permission.ADMIN)) {
    return omit(main, 'apiKey');
  }

  return main;
};

settingsRoutes.get('/main', (req, res, next) => {
  const settings = getSettings();

  if (!req.user) {
    return next({ status: 400, message: 'User missing from request.' });
  }

  res.status(200).json(filteredMainSettings(req.user, settings.main));
});

settingsRoutes.post('/main', async (req, res) => {
  const settings = getSettings();

  settings.main = merge(settings.main, req.body);
  await settings.save();

  return res.status(200).json(settings.main);
});

settingsRoutes.get('/network', (req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.network);
});

settingsRoutes.post('/network', async (req, res) => {
  const settings = getSettings();

  settings.network = merge(settings.network, req.body);
  await settings.save();

  return res.status(200).json(settings.network);
});

settingsRoutes.post('/main/regenerate', async (req, res, next) => {
  const settings = getSettings();

  const main = await settings.regenerateApiKey();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request.' });
  }

  return res.status(200).json(filteredMainSettings(req.user, main));
});

const mediaServerTypeSchema = z.union([
  z.literal(MediaServerType.PLEX),
  z.literal(MediaServerType.JELLYFIN),
  z.literal(MediaServerType.EMBY),
]);

const mediaServerToggleSchema = z.object({
  type: mediaServerTypeSchema,
  enabled: z.boolean(),
});

const jellyfinConnectSchema = z
  .object({
    serverType: z.union([
      z.literal(MediaServerType.JELLYFIN),
      z.literal(MediaServerType.EMBY),
    ]),
    hostname: z.string().min(1),
    port: z.number().int().positive(),
    urlBase: z.string().optional(),
    useSsl: z.boolean().optional(),
    username: z.string().min(1),
    password: z.string().optional(),
    // Supplying an existing API key signs in without a password, which suits
    // servers where the admin account uses SSO or two-factor authentication.
    apiKey: z.string().optional(),
    // Set once the admin has confirmed replacing a different server.
    confirmReplace: z.boolean().optional(),
  })
  .refine((body) => !!body.apiKey || !!body.password, {
    message: 'Provide either an API key or a password.',
    path: ['apiKey'],
  });

/**
 * Reports every media server Seerr knows how to talk to, whether it is
 * currently connected, and whether it has enough configuration to be turned on.
 */
settingsRoutes.get('/mediaservers', async (_req, res) => {
  const settings = getSettings();
  const userRepository = getRepository(User);

  const admin = await userRepository.findOne({
    where: { id: 1 },
    select: ['id', 'plexToken', 'jellyfinUserId'],
    order: { id: 'ASC' },
  });

  const enabled = getEnabledMediaServers();
  const jellyfinConfigured =
    !!settings.jellyfin.ip && !!settings.jellyfin.apiKey;

  const mediaServers: MediaServerStatus[] = [
    MediaServerType.PLEX,
    MediaServerType.JELLYFIN,
    MediaServerType.EMBY,
  ].map((type) => {
    const isJellyfinLike = type !== MediaServerType.PLEX;

    return {
      type,
      name: getMediaServerName(type),
      enabled: enabled.includes(type),
      isPrimary: settings.main.mediaServerType === type,
      configured: isJellyfinLike ? jellyfinConfigured : !!settings.plex.ip,
      linked: isJellyfinLike ? !!admin?.jellyfinUserId : !!admin?.plexToken,
    };
  });

  return res.status(200).json(mediaServers);
});

/**
 * Connects or disconnects a media server. Seerr supports having Plex and
 * Jellyfin/Emby connected at the same time, so this only ever changes the one
 * server named in the request.
 */
settingsRoutes.post('/mediaservers', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);

  const bodyResult = mediaServerToggleSchema.safeParse(req.body);

  if (!bodyResult.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }

  const { type, enabled } = bodyResult.data;
  const serverName = getMediaServerName(type);

  if (!enabled) {
    if (getEnabledMediaServers().filter((s) => s !== type).length === 0) {
      return next({
        status: 400,
        message: 'At least one media server must stay connected.',
      });
    }

    disableMediaServer(type);
    await settings.save();
    startJobs();

    logger.info(`Disconnected ${serverName}`, { label: 'Settings' });

    return res.status(200).json({ type, enabled: false });
  }

  const admin = await userRepository.findOne({
    where: { id: 1 },
    select: ['id', 'plexToken', 'jellyfinUserId'],
    order: { id: 'ASC' },
  });

  if (type === MediaServerType.PLEX) {
    if (!admin?.plexToken) {
      return next({
        status: 400,
        message:
          'Link a Plex account to the admin user before connecting Plex.',
      });
    }
  } else if (!settings.jellyfin.ip || !settings.jellyfin.apiKey) {
    return next({
      status: 400,
      message: `Configure the ${serverName} server before connecting it.`,
    });
  } else if (!admin?.jellyfinUserId) {
    return next({
      status: 400,
      message: `Link a ${serverName} account to the admin user before connecting ${serverName}.`,
    });
  }

  enableMediaServer(type);
  await settings.save();
  startJobs();

  logger.info(`Connected ${serverName}`, { label: 'Settings' });

  return res.status(200).json({ type, enabled: true });
});

/**
 * Connects a Jellyfin or Emby server to an install that is already running
 * (for example one already using Plex). The admin signs in to the new server
 * so we can mint an API token and link their account to it.
 */
settingsRoutes.post('/jellyfin/connect', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);

  const bodyResult = jellyfinConnectSchema.safeParse(req.body);

  if (!bodyResult.success) {
    const issues = bodyResult.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');

    logger.error('Rejected a media server connection request', {
      label: 'Settings',
      issues,
    });

    return next({ status: 400, message: `Invalid request body. ${issues}` });
  }

  const body = bodyResult.data;
  const serverName = getMediaServerName(body.serverType);

  const hostname = getHostname({
    useSsl: body.useSsl,
    ip: body.hostname,
    port: body.port,
    urlBase: body.urlBase,
  });

  // Logged before anything is attempted so the container log always shows the
  // URL that was actually tried, which is the usual cause of a failed connect.
  logger.info(`Connecting to ${serverName} at ${hostname}`, {
    label: 'Settings',
    authMethod: body.apiKey ? 'api key' : 'password',
    username: body.username,
  });

  try {
    const admin = await userRepository.findOneOrFail({
      where: { id: 1 },
      select: ['id', 'email', 'jellyfinUserId'],
      order: { id: 'ASC' },
    });

    // The admin always uses the fixed device id, matching the login flow.
    const deviceId = 'BOT_seerr';

    // The server is not connected yet, so tell the client which of
    // Jellyfin/Emby it is talking to rather than letting it guess from
    // settings, which would still be pointing at the other media server.
    let apiKey = body.apiKey;
    let jellyfinUser: JellyfinUserResponse;
    let accessToken: string | undefined;

    if (apiKey) {
      // Sign in with an existing API key: no password needed, which suits
      // admin accounts behind SSO or two-factor authentication.
      const jellyfinClient = new JellyfinAPI(
        hostname,
        apiKey,
        deviceId,
        body.serverType
      );

      // Fails with InvalidAuthToken if the key is wrong, before anything is saved.
      await jellyfinClient.getSystemInfo();

      const { users } = await jellyfinClient.getUsers();
      const matchedUser = users.find(
        (user) => user.Name.toLowerCase() === body.username.toLowerCase()
      );

      if (!matchedUser) {
        logger.error(`No matching ${serverName} user was found`, {
          label: 'Settings',
          username: body.username,
          availableUsers: users.map((user) => user.Name).join(', '),
        });

        return next({
          status: 404,
          message: `No ${serverName} user named "${body.username}" was found on that server.`,
        });
      }

      jellyfinUser = matchedUser;
    } else {
      const jellyfinServer = new JellyfinAPI(
        hostname,
        undefined,
        deviceId,
        body.serverType
      );

      const account = await jellyfinServer.login(body.username, body.password);

      jellyfinUser = account.User;
      accessToken = account.AccessToken;
    }

    if (jellyfinUser.Policy.IsAdministrator === false) {
      throw new ApiError(403, ApiErrorCode.NotAdmin);
    }

    // Refuse to steal an identity that already belongs to another Seerr user.
    const conflictingUser = await userRepository.findOne({
      where: { jellyfinUserId: jellyfinUser.Id },
    });

    if (conflictingUser && conflictingUser.id !== admin.id) {
      logger.error(`That ${serverName} account is already linked`, {
        label: 'Settings',
        username: jellyfinUser.Name,
        linkedUserId: conflictingUser.id,
      });

      return next({
        status: 409,
        message: `That ${serverName} account is already linked to another user.`,
      });
    }

    // Item IDs belong to the server that issued them, so connecting a
    // different server means forgetting the old one's. Ask first.
    const replacesServer = isDifferentJellyfinServer(
      settings.jellyfin.serverId,
      jellyfinUser.ServerId
    );

    if (replacesServer && !body.confirmReplace) {
      logger.info(`Asked to confirm replacing the ${serverName} server`, {
        label: 'Settings',
        hostname,
      });

      return next({
        status: 409,
        message: ApiErrorCode.ServerReplaceUnconfirmed,
      });
    }

    // Only create an API key once every check has passed, so a refused
    // connection does not leave an unused key behind on the server.
    if (!apiKey) {
      apiKey = await new JellyfinAPI(
        hostname,
        accessToken,
        deviceId,
        body.serverType
      ).createApiToken('Seerr');
    }

    const namedClient = new JellyfinAPI(
      hostname,
      apiKey,
      deviceId,
      body.serverType
    );

    settings.jellyfin.name = await namedClient.getServerName();
    settings.jellyfin.serverId = jellyfinUser.ServerId;
    settings.jellyfin.ip = body.hostname;
    settings.jellyfin.port = body.port;
    settings.jellyfin.urlBase = body.urlBase ?? '';
    settings.jellyfin.useSsl = body.useSsl ?? false;
    settings.jellyfin.apiKey = apiKey;

    if (replacesServer) {
      const cleared = await forgetJellyfinServer();

      logger.warn(
        `Replaced the ${serverName} server and forgot its items on ${cleared} titles. Choose libraries and run a full scan.`,
        { label: 'Settings', hostname }
      );
    }

    // Link the new server to the existing admin user. Their user type stays
    // untouched so an existing Plex sign-in keeps working.
    const adminUser = await userRepository.findOneOrFail({
      where: { id: admin.id },
    });
    adminUser.jellyfinUsername = jellyfinUser.Name;
    adminUser.jellyfinUserId = jellyfinUser.Id;
    adminUser.jellyfinDeviceId = deviceId;
    adminUser.jellyfinAuthToken = accessToken ?? adminUser.jellyfinAuthToken;

    if (adminUser.userType !== UserType.PLEX) {
      adminUser.userType =
        body.serverType === MediaServerType.EMBY
          ? UserType.EMBY
          : UserType.JELLYFIN;
    }

    await userRepository.save(adminUser);

    enableMediaServer(body.serverType);
    await settings.save();
    startJobs();

    logger.info(`Connected ${serverName} server "${settings.jellyfin.name}"`, {
      label: 'Settings',
    });

    return res.status(200).json(settings.jellyfin);
  } catch (e) {
    // ApiError carries no message, only a code, so report both and say which
    // URL failed. A CONNECTION_ERROR here is usually TLS or DNS rather than
    // bad credentials.
    const errorCode = e.errorCode ?? ApiErrorCode.Unknown;

    logger.error(`Something went wrong connecting to ${serverName}`, {
      label: 'Settings',
      hostname,
      errorCode,
      status: e.statusCode ?? e.response?.status,
      errorMessage: e.message || undefined,
      cause: e.cause?.message ?? e.cause?.code,
    });

    return next({
      status: e.statusCode ?? 500,
      message: `${errorCode} (${hostname})`,
    });
  }
});

settingsRoutes.get('/plex', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.plex);
});

settingsRoutes.post('/plex', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });

    Object.assign(settings.plex, req.body);

    const plexClient = new PlexAPI({ plexToken: admin.plexToken });

    const result = await plexClient.getStatus();

    if (!result?.MediaContainer?.machineIdentifier) {
      throw new Error('Server not found');
    }

    settings.plex.machineId = result.MediaContainer.machineIdentifier;
    settings.plex.name = result.MediaContainer.friendlyName;

    await settings.save();
  } catch (e) {
    logger.error('Something went wrong testing Plex connection', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to connect to Plex.',
    });
  }

  return res.status(200).json(settings.plex);
});

settingsRoutes.get('/plex/devices/servers', async (req, res, next) => {
  const userRepository = getRepository(User);
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plexTvClient = admin.plexToken
      ? new PlexTvAPI(admin.plexToken)
      : null;
    const devices = (await plexTvClient?.getDevices())?.filter((device) => {
      return device.provides.includes('server') && device.owned;
    });
    const settings = getSettings();

    if (devices) {
      await Promise.all(
        devices.map(async (device) => {
          const plexDirectConnections: PlexConnection[] = [];

          device.connection.forEach((connection) => {
            const url = new URL(connection.uri);

            if (url.hostname !== connection.address) {
              const plexDirectConnection = { ...connection };
              plexDirectConnection.address = url.hostname;
              plexDirectConnections.push(plexDirectConnection);

              // Connect to IP addresses over HTTP
              connection.protocol = 'http';
            }
          });

          plexDirectConnections.forEach((plexDirectConnection) => {
            device.connection.push(plexDirectConnection);
          });

          await Promise.all(
            device.connection.map(async (connection) => {
              const plexDeviceSettings = {
                ...settings.plex,
                ip: connection.address,
                port: connection.port,
                useSsl: connection.protocol === 'https',
              };
              const plexClient = new PlexAPI({
                plexToken: admin.plexToken,
                plexSettings: plexDeviceSettings,
                timeout: 5000,
              });

              try {
                await plexClient.getStatus();
                connection.status = 200;
                connection.message = 'OK';
              } catch (e) {
                connection.status = 500;
                connection.message = e.message.split(':')[0];
              }
            })
          );
        })
      );
    }
    return res.status(200).json(devices);
  } catch (e) {
    logger.error('Something went wrong retrieving Plex server list', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve Plex server list.',
    });
  }
});

settingsRoutes.get('/plex/library', (_req, res) => {
  const settings = getSettings();

  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.put('/plex/library/:libraryId', async (req, res, next) => {
  const settings = getSettings();

  const bodyResult = libraryUpdateSchema.safeParse(req.body);

  if (!bodyResult.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }

  const library = settings.plex.libraries.find(
    (l) => l.id === req.params.libraryId
  );

  if (!library) {
    return next({ status: 404, message: 'Library does not exist.' });
  }

  library.enabled = bodyResult.data.enabled;
  await settings.save();

  return res.status(200).json(library);
});

settingsRoutes.post('/plex/library/sync', async (_req, res, next) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: { id: true, plexToken: true },
    where: { id: 1 },
  });
  const plexapi = new PlexAPI({ plexToken: admin.plexToken });

  try {
    await plexapi.syncLibraries();
  } catch (e) {
    return next({
      status: e.statusCode ?? 500,
      message: e.errorCode ?? ApiErrorCode.Unknown,
    });
  }

  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.get('/plex/sync', (_req, res) => {
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.post('/plex/sync', (req, res) => {
  if (req.body.cancel) {
    plexFullScanner.cancel();
  } else if (req.body.start) {
    plexFullScanner.run();
  }
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.get('/jellyfin', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.jellyfin);
});

settingsRoutes.post('/jellyfin', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();

  try {
    const admin = await userRepository.findOneOrFail({
      where: { id: 1 },
      select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
      order: { id: 'ASC' },
    });

    const tempJellyfinSettings = { ...settings.jellyfin, ...req.body };

    const jellyfinClient = new JellyfinAPI(
      getHostname(tempJellyfinSettings),
      tempJellyfinSettings.apiKey,
      admin.jellyfinDeviceId ?? ''
    );

    const result = await jellyfinClient.getSystemInfo();

    if (!result?.Id) {
      throw new ApiError(result?.status, ApiErrorCode.InvalidUrl);
    }

    Object.assign(settings.jellyfin, req.body);
    settings.jellyfin.serverId = result.Id;
    settings.jellyfin.name = result.ServerName;
    await settings.save();
  } catch (e) {
    if (e instanceof ApiError) {
      logger.error('Something went wrong testing Jellyfin connection', {
        label: 'API',
        status: e.statusCode,
        errorMessage: ApiErrorCode.InvalidUrl,
      });

      return next({
        status: e.statusCode,
        message: ApiErrorCode.InvalidUrl,
      });
    } else {
      logger.error('Something went wrong', {
        label: 'API',
        errorMessage: e.message,
      });

      return next({
        status: e.statusCode ?? 500,
        message: ApiErrorCode.Unknown,
      });
    }
  }

  return res.status(200).json(settings.jellyfin);
});

settingsRoutes.get('/jellyfin/library', (_req, res) => {
  const settings = getSettings();

  return res.status(200).json(settings.jellyfin.libraries);
});

settingsRoutes.put('/jellyfin/library/:libraryId', async (req, res, next) => {
  const settings = getSettings();

  const bodyResult = libraryUpdateSchema.safeParse(req.body);

  if (!bodyResult.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }

  const library = settings.jellyfin.libraries.find(
    (l) => l.id === req.params.libraryId
  );

  if (!library) {
    return next({ status: 404, message: 'Library does not exist.' });
  }

  library.enabled = bodyResult.data.enabled;
  await settings.save();

  return res.status(200).json(library);
});

settingsRoutes.post('/jellyfin/library/sync', async (_req, res, next) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
    where: { id: 1 },
    order: { id: 'ASC' },
  });
  const jellyfinClient = new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId ?? ''
  );

  jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

  let libraries: JellyfinLibrary[];

  try {
    libraries = await jellyfinClient.getLibraries();

    if (libraries.length === 0) {
      // Check if no libraries are found due to the fallback to user views
      // This only affects LDAP users
      const account = await jellyfinClient.getUser();

      // Automatic Library grouping is not supported when user views are used to get library
      if (account.Configuration.GroupedFolders?.length > 0) {
        return next({
          status: 501,
          message: ApiErrorCode.SyncErrorGroupedFolders,
        });
      }

      return next({ status: 404, message: ApiErrorCode.SyncErrorNoLibraries });
    }
  } catch (e) {
    return next({
      status: e.statusCode ?? 500,
      message: e.errorCode ?? ApiErrorCode.Unknown,
    });
  }

  const newLibraries: Library[] = libraries.map((library) => {
    const existing = settings.jellyfin.libraries.find(
      (l) => l.id === library.key
    );

    return {
      id: library.key,
      name: library.title,
      enabled: existing?.enabled ?? false,
      type: library.type,
      lastScan: existing?.lastScan,
    };
  });

  settings.jellyfin.libraries = newLibraries;
  await settings.save();

  return res.status(200).json(settings.jellyfin.libraries);
});

settingsRoutes.get('/jellyfin/users', async (req, res) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
    where: { id: 1 },
    order: { id: 'ASC' },
  });
  const jellyfinClient = new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId ?? ''
  );

  jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
  const resp = await jellyfinClient.getUsers();
  const users = resp.users.map((user) => ({
    username: user.Name,
    id: user.Id,
    thumb: `/avatarproxy/${user.Id}`,
    email: user.Name,
  }));

  return res.status(200).json(users);
});

settingsRoutes.get('/jellyfin/sync', (_req, res) => {
  return res.status(200).json(jellyfinFullScanner.status());
});

settingsRoutes.post('/jellyfin/sync', (req, res) => {
  if (req.body.cancel) {
    jellyfinFullScanner.cancel();
  } else if (req.body.start) {
    jellyfinFullScanner.run();
  }
  return res.status(200).json(jellyfinFullScanner.status());
});
settingsRoutes.get('/tautulli', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.tautulli);
});

settingsRoutes.post('/tautulli', async (req, res, next) => {
  const settings = getSettings();

  Object.assign(settings.tautulli, req.body);

  if (settings.tautulli.hostname) {
    try {
      const tautulliClient = new TautulliAPI(settings.tautulli);

      const result = await tautulliClient.getInfo();

      if (!semver.gte(semver.coerce(result?.tautulli_version) ?? '', '2.9.0')) {
        throw new Error('Tautulli version not supported');
      }

      await settings.save();
    } catch (e) {
      logger.error('Something went wrong testing Tautulli connection', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to connect to Tautulli.',
      });
    }
  }

  return res.status(200).json(settings.tautulli);
});

settingsRoutes.get(
  '/plex/users',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const qb = userRepository.createQueryBuilder('user');

    try {
      const admin = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const plexApi = new PlexTvAPI(admin.plexToken ?? '');
      const plexUsers = (await plexApi.getUsers()).MediaContainer.User.map(
        (user) => user.$
      ).filter((user) => user.email);

      const unimportedPlexUsers: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      }[] = [];

      const plexIds = plexUsers.map((plexUser) => plexUser.id);
      const plexEmails = plexUsers.map((plexUser) =>
        plexUser.email.toLowerCase()
      );
      if (!plexIds.length) plexIds.push('-1');
      if (!plexEmails.length) plexEmails.push('@');

      const existingUsers = await qb
        .where('user.plexId IN (:...plexIds)', { plexIds })
        .orWhere('user.email IN (:...plexEmails)', { plexEmails })
        .getMany();

      await Promise.all(
        plexUsers.map(async (plexUser) => {
          if (
            !existingUsers.find(
              (user) =>
                user.plexId === parseInt(plexUser.id) ||
                user.email === plexUser.email.toLowerCase()
            ) &&
            (await plexApi.checkUserAccess(parseInt(plexUser.id)))
          ) {
            unimportedPlexUsers.push(plexUser);
          }
        })
      );

      return res.status(200).json(sortBy(unimportedPlexUsers, 'username'));
    } catch (e) {
      logger.error('Something went wrong getting unimported Plex users', {
        label: 'API',
        errorMessage: e.message,
      });
      next({
        status: 500,
        message: 'Unable to retrieve unimported Plex users.',
      });
    }
  }
);

settingsRoutes.get(
  '/logs',
  rateLimit({ windowMs: 60 * 1000, max: 50 }),
  (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 25;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const search = (req.query.search as string) ?? '';
    const searchRegexp = new RegExp(escapeRegExp(search), 'i');

    let filter: string[] = [];
    switch (req.query.filter) {
      case 'debug':
        filter.push('debug');
      // falls through
      case 'info':
        filter.push('info');
      // falls through
      case 'warn':
        filter.push('warn');
      // falls through
      case 'error':
        filter.push('error');
        break;
      default:
        filter = ['debug', 'info', 'warn', 'error'];
    }

    const logFile = process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs.json`
      : path.join(__dirname, '../../../config/logs/.machinelogs.json');
    const logs: LogMessage[] = [];
    const logMessageProperties = [
      'timestamp',
      'level',
      'label',
      'message',
      'data',
    ];

    const deepValueStrings = (obj: Record<string, unknown>): string[] => {
      const values = [];

      for (const val of Object.values(obj)) {
        if (typeof val === 'string') {
          values.push(val);
        } else if (typeof val === 'number') {
          values.push(val.toString());
        } else if (val !== null && typeof val === 'object') {
          values.push(...deepValueStrings(val as Record<string, unknown>));
        }
      }

      return values;
    };

    try {
      fs.readFileSync(logFile, 'utf-8')
        .split('\n')
        .forEach((line) => {
          if (!line.length) return;

          const logMessage = JSON.parse(line);

          if (!filter.includes(logMessage.level)) {
            return;
          }

          if (
            !Object.keys(logMessage).every((key) =>
              logMessageProperties.includes(key)
            )
          ) {
            Object.keys(logMessage)
              .filter((prop) => !logMessageProperties.includes(prop))
              .forEach((prop) => {
                set(logMessage, `data.${prop}`, logMessage[prop]);
              });
          }

          if (req.query.search) {
            if (
              // label and data are sometimes undefined
              !searchRegexp.test(logMessage.label ?? '') &&
              !searchRegexp.test(logMessage.message) &&
              !deepValueStrings(logMessage.data ?? {}).some((val) =>
                searchRegexp.test(val)
              )
            ) {
              return;
            }
          }

          logs.push(logMessage);
        });

      const displayedLogs = logs.reverse().slice(skip, skip + pageSize);

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(logs.length / pageSize),
          pageSize,
          results: logs.length,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: displayedLogs,
      } as LogsResultsResponse);
    } catch (error) {
      logger.error('Something went wrong while retrieving logs', {
        label: 'Logs',
        errorMessage: error.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve logs.',
      });
    }
  }
);

settingsRoutes.get('/jobs', (_req, res) => {
  return res.status(200).json(
    scheduledJobs.map((job) => ({
      id: job.id,
      name: job.name,
      type: job.type,
      interval: job.interval,
      cronSchedule: job.cronSchedule,
      nextExecutionTime: job.job.nextInvocation(),
      running: job.running ? job.running() : false,
    }))
  );
});

settingsRoutes.post<{ jobId: string }>('/jobs/:jobId/run', (req, res, next) => {
  const scheduledJob = scheduledJobs.find((job) => job.id === req.params.jobId);

  if (!scheduledJob) {
    return next({ status: 404, message: 'Job not found.' });
  }

  scheduledJob.job.invoke();

  return res.status(200).json({
    id: scheduledJob.id,
    name: scheduledJob.name,
    type: scheduledJob.type,
    interval: scheduledJob.interval,
    cronSchedule: scheduledJob.cronSchedule,
    nextExecutionTime: scheduledJob.job.nextInvocation(),
    running: scheduledJob.running ? scheduledJob.running() : false,
  });
});

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/cancel',
  (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    if (scheduledJob.cancelFn) {
      scheduledJob.cancelFn();
    }

    return res.status(200).json({
      id: scheduledJob.id,
      name: scheduledJob.name,
      type: scheduledJob.type,
      interval: scheduledJob.interval,
      cronSchedule: scheduledJob.cronSchedule,
      nextExecutionTime: scheduledJob.job.nextInvocation(),
      running: scheduledJob.running ? scheduledJob.running() : false,
    });
  }
);

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/schedule',
  async (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    const result = rescheduleJob(scheduledJob.job, req.body.schedule);
    const settings = getSettings();

    if (result) {
      settings.jobs[scheduledJob.id].schedule = req.body.schedule;
      await settings.save();

      scheduledJob.cronSchedule = req.body.schedule;

      return res.status(200).json({
        id: scheduledJob.id,
        name: scheduledJob.name,
        type: scheduledJob.type,
        interval: scheduledJob.interval,
        cronSchedule: scheduledJob.cronSchedule,
        nextExecutionTime: scheduledJob.job.nextInvocation(),
        running: scheduledJob.running ? scheduledJob.running() : false,
      });
    } else {
      return next({ status: 400, message: 'Invalid job schedule.' });
    }
  }
);

settingsRoutes.get('/cache', async (_req, res) => {
  const cacheManagerCaches = cacheManager.getAllCaches();

  const apiCaches = Object.values(cacheManagerCaches).map((cache) => ({
    id: cache.id,
    name: cache.name,
    stats: cache.getStats(),
  }));

  const tmdbImageCache = await ImageProxy.getImageStats('tmdb');
  const avatarImageCache = await ImageProxy.getImageStats('avatar');

  const stats: DnsStats | undefined = dnsCache?.getStats();
  const entries: DnsEntries | undefined = dnsCache?.getCacheEntries();

  return res.status(200).json({
    apiCaches,
    imageCache: {
      tmdb: tmdbImageCache,
      avatar: avatarImageCache,
    },
    dnsCache: {
      stats,
      entries,
    },
  });
});

settingsRoutes.post<{ cacheId: AvailableCacheIds }>(
  '/cache/:cacheId/flush',
  (req, res, next) => {
    const cache = cacheManager.getCache(req.params.cacheId);

    if (cache) {
      cache.flush();
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post<{ dnsEntry: string }>(
  '/cache/dns/:dnsEntry/flush',
  (req, res, next) => {
    const dnsEntry = req.params.dnsEntry;

    if (dnsCache) {
      dnsCache.clear(dnsEntry);
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post(
  '/initialize',
  isAuthenticated(Permission.ADMIN),
  async (_req, res) => {
    const settings = getSettings();

    settings.public.initialized = true;
    await settings.save();

    return res.status(200).json(settings.public);
  }
);

settingsRoutes.get('/about', async (req, res) => {
  const mediaRepository = getRepository(Media);
  const mediaRequestRepository = getRepository(MediaRequest);

  const totalMediaItems = await mediaRepository.count();
  const totalRequests = await mediaRequestRepository.count();

  return res.status(200).json({
    version: getAppVersion(),
    totalMediaItems,
    totalRequests,
    tz: process.env.TZ,
    appDataPath: appDataPath(),
  } as SettingsAboutResponse);
});

export default settingsRoutes;
