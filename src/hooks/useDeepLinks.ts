import useMediaServers from '@app/hooks/useMediaServers';
import { MediaServerType } from '@server/constants/server';
import { useEffect, useState } from 'react';

interface useDeepLinksProps {
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
  /** Which media server each link opens, when the caller knows. */
  mediaUrlServer?: MediaServerType;
  mediaUrl4kServer?: MediaServerType;
}

// Only a Plex link can be swapped for the Plex app link. Callers that do not
// say which server a link opens are passing Plex's own links.
const isPlexLink = (server?: MediaServerType) =>
  server === undefined || server === MediaServerType.PLEX;

const useDeepLinks = ({
  mediaUrl,
  mediaUrl4k,
  iOSPlexUrl,
  iOSPlexUrl4k,
  mediaUrlServer,
  mediaUrl4kServer,
}: useDeepLinksProps) => {
  const [returnedMediaUrl, setReturnedMediaUrl] = useState(mediaUrl);
  const [returnedMediaUrl4k, setReturnedMediaUrl4k] = useState(mediaUrl4k);
  const { plexEnabled } = useMediaServers();

  useEffect(() => {
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
    const preferPlexApp = plexEnabled && isIOS;

    // Each link is swapped on its own, so a title with only a 4K copy on
    // Plex keeps its other link, and a link to another server is left alone.
    setReturnedMediaUrl(
      preferPlexApp && iOSPlexUrl && isPlexLink(mediaUrlServer)
        ? iOSPlexUrl
        : mediaUrl
    );
    setReturnedMediaUrl4k(
      preferPlexApp && iOSPlexUrl4k && isPlexLink(mediaUrl4kServer)
        ? iOSPlexUrl4k
        : mediaUrl4k
    );
  }, [
    iOSPlexUrl,
    iOSPlexUrl4k,
    mediaUrl,
    mediaUrl4k,
    mediaUrlServer,
    mediaUrl4kServer,
    plexEnabled,
  ]);

  return { mediaUrl: returnedMediaUrl, mediaUrl4k: returnedMediaUrl4k };
};

export default useDeepLinks;
