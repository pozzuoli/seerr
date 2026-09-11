import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';

/**
 * Seerr can now connect to several media servers at once. Existing
 * configurations only recorded a single `mediaServerType`, so seed the new
 * `enabledMediaServers` list from it. The primary server is left untouched.
 */
const migrateMultiMediaServer = (settings: any): AllSettings => {
  if (Array.isArray(settings.main?.enabledMediaServers)) {
    return settings;
  }

  const mediaServerType = settings.main?.mediaServerType;

  settings.main ??= {};
  settings.main.enabledMediaServers =
    mediaServerType && mediaServerType !== MediaServerType.NOT_CONFIGURED
      ? [mediaServerType]
      : [];

  return settings;
};

export default migrateMultiMediaServer;
