import logger from '@server/logger';
import { existsSync } from 'fs';
import path from 'path';

const COMMIT_TAG_PATH = path.join(__dirname, '../../committag.json');
let commitTag = 'local';

if (existsSync(COMMIT_TAG_PATH)) {
  // The Docker image always writes committag.json, but leaves the tag empty
  // when the image was built without the COMMIT_TAG build argument. Keep the
  // 'local' default in that case so this matches what the client falls back to
  // in next.config.ts; otherwise the two disagree and the client shows the
  // "app updated, please reload" prompt on every page load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  commitTag = require(COMMIT_TAG_PATH).commitTag || 'local';
  logger.info(`Commit Tag: ${commitTag}`);
}

export const getCommitTag = (): string => {
  return commitTag;
};

export const getAppVersion = (): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../../package.json');

  let finalVersion = version;

  if (version === '0.1.0') {
    finalVersion = `develop-${getCommitTag()}`;
  }

  return finalVersion;
};
