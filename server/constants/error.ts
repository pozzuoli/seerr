export enum ApiErrorCode {
  InvalidUrl = 'INVALID_URL',
  InvalidCredentials = 'INVALID_CREDENTIALS',
  InvalidAuthToken = 'INVALID_AUTH_TOKEN',
  InvalidEmail = 'INVALID_EMAIL',
  NotAdmin = 'NOT_ADMIN',
  NoAdminUser = 'NO_ADMIN_USER',
  ConnectionError = 'CONNECTION_ERROR',
  SyncErrorGroupedFolders = 'SYNC_ERROR_GROUPED_FOLDERS',
  SyncErrorNoLibraries = 'SYNC_ERROR_NO_LIBRARIES',
  ServerReplaceUnconfirmed = 'SERVER_REPLACE_UNCONFIRMED',
  Unauthorized = 'UNAUTHORIZED',
  Unknown = 'UNKNOWN',
}
