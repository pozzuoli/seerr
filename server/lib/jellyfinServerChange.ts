import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import { IsNull, Not } from 'typeorm';

/**
 * Whether connecting to a Jellyfin/Emby server would replace a different
 * one. Installs from before the server ID was recorded have none stored,
 * and are treated as reconnecting the same server.
 */
export const isDifferentJellyfinServer = (
  storedServerId?: string | null,
  newServerId?: string | null
): boolean =>
  !!storedServerId && !!newServerId && storedServerId !== newServerId;

/**
 * Forgets what pointed at the previous Jellyfin/Emby server: the item IDs
 * stored on media and the library selection. Item IDs belong to the server
 * that issued them, so after a switch they would open the wrong item or
 * none, and a server answering 500 for them could get media marked deleted.
 *
 * Plex IDs and users' linked accounts are left alone. Returns how many media
 * rows were cleared. Callers are responsible for saving settings.
 */
export const forgetJellyfinServer = async (): Promise<number> => {
  const mediaRepository = getRepository(Media);

  const cleared = await mediaRepository.count({
    where: [
      { jellyfinMediaId: Not(IsNull()) },
      { jellyfinMediaId4k: Not(IsNull()) },
    ],
  });

  await mediaRepository.update(
    { jellyfinMediaId: Not(IsNull()) },
    { jellyfinMediaId: null }
  );
  await mediaRepository.update(
    { jellyfinMediaId4k: Not(IsNull()) },
    { jellyfinMediaId4k: null }
  );

  getSettings().jellyfin.libraries = [];

  return cleared;
};
