import EmbyLogo from '@app/assets/services/emby.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import JellyfinLogo from '@app/assets/services/jellyfin.svg';
import LetterboxdLogo from '@app/assets/services/letterboxd.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import RTLogo from '@app/assets/services/rt.svg';
import SimklLogo from '@app/assets/services/simkl.svg';
import TmdbLogo from '@app/assets/services/tmdb.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import TvdbLogo from '@app/assets/services/tvdb.svg';
import useLocale from '@app/hooks/useLocale';
import useMediaServers from '@app/hooks/useMediaServers';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { JSX } from 'react';

type ExternalLinkType = 'movie' | 'tv' | 'person';

interface ExternalLinkBlockProps {
  mediaType: ExternalLinkType;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  rtUrl?: string;
  mediaUrl?: string;
  plexUrl?: string;
  jellyfinUrl?: string;
}

const ExternalLinkBlock = ({
  mediaType,
  tmdbId,
  tvdbId,
  imdbId,
  rtUrl,
  mediaUrl,
  plexUrl,
  jellyfinUrl,
}: ExternalLinkBlockProps) => {
  const { plexEnabled, jellyfinEnabled, jellyfinServerType } =
    useMediaServers();
  const { locale } = useLocale();

  // When several media servers are connected the same title can live on more
  // than one of them, so link to each server that actually has it. `mediaUrl`
  // is the primary server's link and covers callers that pass only that.
  const serverLinks = [
    plexEnabled && (plexUrl ?? (!jellyfinEnabled ? mediaUrl : undefined))
      ? { key: 'plex', url: plexUrl ?? mediaUrl, logo: <PlexLogo /> }
      : undefined,
    jellyfinEnabled && (jellyfinUrl ?? (!plexEnabled ? mediaUrl : undefined))
      ? {
          key: 'jellyfin',
          url: jellyfinUrl ?? mediaUrl,
          logo:
            jellyfinServerType === MediaServerType.EMBY ? (
              <EmbyLogo />
            ) : (
              <JellyfinLogo />
            ),
        }
      : undefined,
  ].filter(
    (link): link is { key: string; url: string; logo: JSX.Element } =>
      !!link?.url
  );

  return (
    <div className="flex w-full items-center justify-center space-x-2 sm:space-x-5">
      {serverLinks.map((link) => (
        <a
          key={link.key}
          href={link.url}
          className="w-12 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          {link.logo}
        </a>
      ))}
      {tmdbId && (
        <a
          href={`https://www.themoviedb.org/${mediaType}/${tmdbId}?language=${locale}`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <TmdbLogo />
        </a>
      )}
      {tvdbId && mediaType === MediaType.TV && (
        <a
          href={`http://www.thetvdb.com/?tab=series&id=${tvdbId}`}
          className="w-9 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <TvdbLogo />
        </a>
      )}
      {imdbId && mediaType !== 'person' && (
        <a
          href={`https://www.imdb.com/title/${imdbId}`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <ImdbLogo />
        </a>
      )}
      {imdbId && mediaType === 'person' && (
        <a
          href={`https://www.imdb.com/name/${imdbId}`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <ImdbLogo />
        </a>
      )}
      {rtUrl && (
        <a
          href={rtUrl}
          className="w-14 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <RTLogo />
        </a>
      )}
      {imdbId && mediaType !== 'person' && (
        <a
          href={`https://trakt.tv/${
            mediaType === 'movie' ? 'movies' : 'shows'
          }/${imdbId}`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <TraktLogo />
        </a>
      )}
      {imdbId && mediaType !== 'person' && (
        <a
          href={`https://api.simkl.com/redirect?to=Simkl&imdb=${encodeURIComponent(
            imdbId
          )}`}
          aria-label="Simkl"
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <SimklLogo />
        </a>
      )}
      {tmdbId && mediaType === MediaType.MOVIE && (
        <a
          href={`https://letterboxd.com/tmdb/${tmdbId}`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <LetterboxdLogo />
        </a>
      )}
    </div>
  );
};

export default ExternalLinkBlock;
