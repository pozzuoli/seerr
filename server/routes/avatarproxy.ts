import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import ImageProxy from '@server/lib/imageproxy';
import { getJellyfinServerType } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getAppVersion } from '@server/utils/appVersion';
import { getHostname } from '@server/utils/getHostname';
import axios from 'axios';
import { Router } from 'express';
import gravatarUrl from 'gravatar-url';
import { createHash } from 'node:crypto';

const router = Router();

let _avatarImageProxy: ImageProxy | null = null;

async function initAvatarImageProxy() {
  if (!_avatarImageProxy) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOne({
      where: { id: 1 },
      select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
      order: { id: 'ASC' },
    });
    const deviceId = admin?.jellyfinDeviceId || 'BOT_seerr';
    const authToken = getSettings().jellyfin.apiKey;
    _avatarImageProxy = new ImageProxy('avatar', '', {
      headers: {
        'X-Emby-Authorization': `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="${deviceId}", Version="${
          getJellyfinServerType() === MediaServerType.EMBY
            ? '1.0.0'
            : getAppVersion()
        }", Token="${authToken}"`,
      },
    });
  }
  return _avatarImageProxy;
}

function getJellyfinAvatarUrl(userId: string) {
  return getJellyfinServerType() === MediaServerType.EMBY
    ? `${getHostname()}/Users/${userId}/Images/Primary?quality=90`
    : `${getHostname()}/UserImage?UserId=${userId}`;
}

function computeImageHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function checkAvatarChanged(
  user: User
): Promise<{ changed: boolean; etag?: string }> {
  try {
    if (!user || !user.jellyfinUserId) {
      return { changed: false };
    }

    const jellyfinAvatarUrl = getJellyfinAvatarUrl(user.jellyfinUserId);

    let headResponse;
    try {
      headResponse = await axios.head(jellyfinAvatarUrl);
      if (headResponse.status !== 200) {
        return { changed: false };
      }
    } catch {
      return { changed: false };
    }

    const jellyfinServerType = getJellyfinServerType();
    let remoteVersion: string;
    if (jellyfinServerType === MediaServerType.JELLYFIN) {
      const remoteLastModifiedStr = headResponse.headers['last-modified'] || '';
      remoteVersion = (
        Date.parse(remoteLastModifiedStr) || Date.now()
      ).toString();
    } else if (jellyfinServerType === MediaServerType.EMBY) {
      remoteVersion =
        headResponse.headers['etag']?.replace(/"/g, '') ||
        Date.now().toString();
    } else {
      remoteVersion = Date.now().toString();
    }

    if (user.avatarVersion && user.avatarVersion === remoteVersion) {
      return { changed: false, etag: user.avatarETag ?? undefined };
    }

    const avatarImageCache = await initAvatarImageProxy();
    await avatarImageCache.clearCachedImage(jellyfinAvatarUrl);
    const imageData = await avatarImageCache.getImage(
      jellyfinAvatarUrl,
      gravatarUrl(user.email || 'none', { default: 'mm', size: 200 })
    );

    const newHash = computeImageHash(imageData.imageBuffer);

    const hasChanged = user.avatarETag !== newHash;

    user.avatarVersion = remoteVersion;
    if (hasChanged) {
      user.avatarETag = newHash;
    }

    await getRepository(User).save(user);

    return { changed: hasChanged, etag: newHash };
  } catch (error) {
    logger.error('Error checking avatar changes', {
      errorMessage: error.message,
    });
    return { changed: false };
  }
}

router.get('/:jellyfinUserId', async (req, res) => {
  try {
    if (!req.params.jellyfinUserId.match(/^[a-f0-9]{32}$/)) {
      throw new Error(
        `Provided URL is not ${
          getJellyfinServerType() === MediaServerType.EMBY
            ? 'an Emby'
            : 'a Jellyfin'
        } avatar.`
      );
    }

    const avatarImageCache = await initAvatarImageProxy();

    const userEtag = req.headers['if-none-match'];

    const versionParam = req.query.v;

    const user = await getRepository(User).findOne({
      where: { jellyfinUserId: req.params.jellyfinUserId },
    });

    const fallbackUrl = gravatarUrl(user?.email || 'none', {
      default: 'mm',
      size: 200,
    });

    const jellyfinAvatarUrl = getJellyfinAvatarUrl(req.params.jellyfinUserId);

    let imageData;
    if (user?.avatarVersion) {
      imageData = await avatarImageCache.getImage(
        jellyfinAvatarUrl,
        fallbackUrl
      );
      if (imageData.meta.extension === 'json') {
        imageData = await avatarImageCache.getImage(fallbackUrl);
      }
    } else {
      imageData = await avatarImageCache.getImage(fallbackUrl);
    }

    if (userEtag && userEtag === `"${imageData.meta.etag}"` && !versionParam) {
      return res.status(304).end();
    }

    res.writeHead(200, {
      'Content-Type': `image/${imageData.meta.extension}`,
      'Content-Length': imageData.imageBuffer.length,
      'Cache-Control': `public, max-age=${imageData.meta.curRevalidate}`,
      ETag: `"${imageData.meta.etag}"`,
      'OS-Cache-Key': imageData.meta.cacheKey,
      'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
    });

    res.end(imageData.imageBuffer);
  } catch (e) {
    logger.error('Failed to proxy avatar image', {
      errorMessage: e.message,
    });
  }
});

export default router;
