import useMediaServers from '@app/hooks/useMediaServers';
import { useEffect, useState } from 'react';

interface useDeepLinksProps {
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
}

const useDeepLinks = ({
  mediaUrl,
  mediaUrl4k,
  iOSPlexUrl,
  iOSPlexUrl4k,
}: useDeepLinksProps) => {
  const [returnedMediaUrl, setReturnedMediaUrl] = useState(mediaUrl);
  const [returnedMediaUrl4k, setReturnedMediaUrl4k] = useState(mediaUrl4k);
  const { plexEnabled } = useMediaServers();

  useEffect(() => {
    // The iOS deep link is only built for titles that are actually on Plex, so
    // its presence is what decides whether to prefer the Plex app here.
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);

    if (plexEnabled && isIOS && (iOSPlexUrl || iOSPlexUrl4k)) {
      setReturnedMediaUrl(iOSPlexUrl);
      setReturnedMediaUrl4k(iOSPlexUrl4k);
    } else {
      setReturnedMediaUrl(mediaUrl);
      setReturnedMediaUrl4k(mediaUrl4k);
    }
  }, [iOSPlexUrl, iOSPlexUrl4k, mediaUrl, mediaUrl4k, plexEnabled]);

  return { mediaUrl: returnedMediaUrl, mediaUrl4k: returnedMediaUrl4k };
};

export default useDeepLinks;
