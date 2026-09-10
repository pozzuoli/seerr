import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import type { MediaServerStatus } from '@server/interfaces/api/settingsInterfaces';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsMediaServers', {
  mediaservers: 'Media Servers',
  mediaserversDescription:
    'Connect Seerr to your media servers. Plex and Jellyfin/Emby can be connected at the same time, so a single instance can serve users on both.',
  connected: 'Connected',
  notConnected: 'Not Connected',
  primary: 'Primary',
  connect: 'Connect',
  disconnect: 'Disconnect',
  notConfigured: 'Not configured',
  notLinked: 'No linked account',
  plexNotLinked:
    'Link a Plex account to your admin user under your profile settings before connecting Plex.',
  connectJellyfin: 'Connect a Jellyfin or Emby Server',
  connectJellyfinDescription:
    'Sign in with an administrator account on the server you want to add. Seerr creates an API key on that server and links the account to your admin user.',
  serverType: 'Server Type',
  hostname: 'Hostname or IP Address',
  port: 'Port',
  urlBase: 'URL Base',
  enablessl: 'Use SSL',
  username: 'Username',
  password: 'Password',
  apiKey: 'API Key',
  authMethod: 'Sign In With',
  authPassword: 'Password',
  authApiKey: 'API Key',
  apiKeyTip:
    'Create the key on your server under Settings, API Keys. The username tells Seerr which account to link to your admin user.',
  passwordTip:
    'Sign in as an administrator. Seerr creates an API key on that server for you.',
  connecting: 'Connecting…',
  toggleSuccess:
    '{serverName} {enabled, select, true {connected} other {disconnected}} successfully!',
  toggleFailure: 'Something went wrong updating {serverName}.',
  connectSuccess: '{serverName} connected successfully!',
  connectFailure: 'Something went wrong connecting to {serverName}.',
  primaryNote:
    'The primary server decides which name and deep links Seerr shows by default.',
  validationHostnameRequired: 'You must provide a valid hostname or IP address',
  validationPortRequired: 'You must provide a valid port number',
  validationUsernameRequired: 'You must provide a username',
  validationPasswordRequired: 'You must provide a password',
  validationApiKeyRequired: 'You must provide an API key',
  validationUrlBaseLeadingSlash: 'URL base must have a leading slash',
  validationUrlBaseTrailingSlash: 'URL base must not end in a trailing slash',
});

const SettingsMediaServers = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);

  const {
    data: mediaServers,
    error,
    mutate: revalidate,
  } = useSWR<MediaServerStatus[]>('/api/v1/settings/mediaservers');

  const jellyfinServer = mediaServers?.find(
    (server) => server.type !== MediaServerType.PLEX && server.enabled
  );
  const plexServer = mediaServers?.find(
    (server) => server.type === MediaServerType.PLEX
  );

  const toggleServer = async (server: MediaServerStatus, enabled: boolean) => {
    setIsUpdating(true);

    try {
      await axios.post('/api/v1/settings/mediaservers', {
        type: server.type,
        enabled,
      });

      addToast(
        intl.formatMessage(messages.toggleSuccess, {
          serverName: server.name,
          enabled: String(enabled),
        }),
        { autoDismiss: true, appearance: 'success' }
      );

      revalidate();
    } catch (e) {
      addToast(
        e?.response?.data?.message ??
          intl.formatMessage(messages.toggleFailure, {
            serverName: server.name,
          }),
        { autoDismiss: true, appearance: 'error' }
      );
    } finally {
      setIsUpdating(false);
    }
  };

  const ConnectSchema = Yup.object().shape({
    hostname: Yup.string()
      .nullable()
      .required(intl.formatMessage(messages.validationHostnameRequired)),
    port: Yup.number()
      .typeError(intl.formatMessage(messages.validationPortRequired))
      .nullable()
      .required(intl.formatMessage(messages.validationPortRequired)),
    urlBase: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationUrlBaseLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'trailing-slash',
        intl.formatMessage(messages.validationUrlBaseTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    username: Yup.string()
      .nullable()
      .required(intl.formatMessage(messages.validationUsernameRequired)),
    password: Yup.string().when('authMethod', {
      is: 'password',
      then: (schema) =>
        schema
          .nullable()
          .required(intl.formatMessage(messages.validationPasswordRequired)),
      otherwise: (schema) => schema.nullable(),
    }),
    apiKey: Yup.string().when('authMethod', {
      is: 'apiKey',
      then: (schema) =>
        schema
          .nullable()
          .required(intl.formatMessage(messages.validationApiKeyRequired)),
      otherwise: (schema) => schema.nullable(),
    }),
  });

  if (!mediaServers && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.mediaservers)}</h3>
        <p className="description">
          {intl.formatMessage(messages.mediaserversDescription)}
        </p>
      </div>
      <div className="section">
        <ul className="space-y-3">
          {mediaServers?.map((server) => {
            // Jellyfin and Emby share one connection, so only offer the one
            // that is already configured once either has been set up.
            if (
              server.type !== MediaServerType.PLEX &&
              jellyfinServer &&
              jellyfinServer.type !== server.type
            ) {
              return null;
            }

            const canEnable = server.configured && server.linked;

            return (
              <li
                key={server.type}
                className="flex flex-col gap-3 rounded-md border border-gray-700 bg-gray-800 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-semibold text-white">
                    {server.name}
                  </span>
                  <Badge badgeType={server.enabled ? 'success' : 'default'}>
                    {intl.formatMessage(
                      server.enabled
                        ? messages.connected
                        : messages.notConnected
                    )}
                  </Badge>
                  {server.isPrimary && (
                    <Badge badgeType="primary">
                      {intl.formatMessage(messages.primary)}
                    </Badge>
                  )}
                  {!server.configured && (
                    <Badge badgeType="warning">
                      {intl.formatMessage(messages.notConfigured)}
                    </Badge>
                  )}
                  {server.configured && !server.linked && (
                    <Badge badgeType="warning">
                      {intl.formatMessage(messages.notLinked)}
                    </Badge>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {server.enabled ? (
                    <Button
                      buttonType="danger"
                      disabled={isUpdating}
                      onClick={() => toggleServer(server, false)}
                    >
                      {intl.formatMessage(messages.disconnect)}
                    </Button>
                  ) : (
                    <Button
                      buttonType="primary"
                      disabled={isUpdating || !canEnable}
                      onClick={() => toggleServer(server, true)}
                    >
                      {intl.formatMessage(messages.connect)}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-sm text-gray-400">
          {intl.formatMessage(messages.primaryNote)}
        </p>
        {plexServer && !plexServer.linked && (
          <div className="mt-4">
            <Alert type="info" title={plexServer.name}>
              {intl.formatMessage(messages.plexNotLinked)}
            </Alert>
          </div>
        )}
      </div>

      {!jellyfinServer && (
        <>
          <div className="mb-6 mt-10">
            <h3 className="heading">
              {intl.formatMessage(messages.connectJellyfin)}
            </h3>
            <p className="description">
              {intl.formatMessage(messages.connectJellyfinDescription)}
            </p>
          </div>
          <div className="section">
            <Formik
              initialValues={{
                serverType: MediaServerType.JELLYFIN,
                authMethod: 'password',
                hostname: '',
                port: 8096,
                urlBase: '',
                useSsl: false,
                username: '',
                password: '',
                apiKey: '',
              }}
              validationSchema={ConnectSchema}
              onSubmit={async (values, { resetForm }) => {
                try {
                  await axios.post('/api/v1/settings/jellyfin/connect', {
                    serverType: Number(values.serverType),
                    hostname: values.hostname,
                    port: Number(values.port),
                    urlBase: values.urlBase,
                    useSsl: values.useSsl,
                    username: values.username,
                    ...(values.authMethod === 'apiKey'
                      ? { apiKey: values.apiKey }
                      : { password: values.password }),
                  });

                  addToast(
                    intl.formatMessage(messages.connectSuccess, {
                      serverName:
                        Number(values.serverType) === MediaServerType.EMBY
                          ? 'Emby'
                          : 'Jellyfin',
                    }),
                    { autoDismiss: true, appearance: 'success' }
                  );

                  resetForm();
                  revalidate();
                } catch (e) {
                  addToast(
                    e?.response?.data?.message ??
                      intl.formatMessage(messages.connectFailure, {
                        serverName:
                          Number(values.serverType) === MediaServerType.EMBY
                            ? 'Emby'
                            : 'Jellyfin',
                      }),
                    { autoDismiss: true, appearance: 'error' }
                  );
                }
              }}
            >
              {({
                errors,
                touched,
                isSubmitting,
                isValid,
                handleSubmit,
                values,
                setFieldValue,
              }) => (
                <form className="section" onSubmit={handleSubmit}>
                  <div className="form-row">
                    <label htmlFor="serverType" className="text-label">
                      {intl.formatMessage(messages.serverType)}
                    </label>
                    <div className="form-input-area">
                      <Field as="select" id="serverType" name="serverType">
                        <option value={MediaServerType.JELLYFIN}>
                          Jellyfin
                        </option>
                        <option value={MediaServerType.EMBY}>Emby</option>
                      </Field>
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="hostname" className="text-label">
                      {intl.formatMessage(messages.hostname)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          id="hostname"
                          name="hostname"
                          type="text"
                          placeholder="192.168.1.100"
                        />
                      </div>
                      {errors.hostname && touched.hostname && (
                        <div className="error">{errors.hostname}</div>
                      )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="port" className="text-label">
                      {intl.formatMessage(messages.port)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        id="port"
                        name="port"
                        type="text"
                        inputMode="numeric"
                        className="short"
                      />
                      {errors.port && touched.port && (
                        <div className="error">{errors.port}</div>
                      )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="urlBase" className="text-label">
                      {intl.formatMessage(messages.urlBase)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field id="urlBase" name="urlBase" type="text" />
                      </div>
                      {errors.urlBase && touched.urlBase && (
                        <div className="error">{errors.urlBase}</div>
                      )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="useSsl" className="checkbox-label">
                      {intl.formatMessage(messages.enablessl)}
                    </label>
                    <div className="form-input-area">
                      <Field
                        type="checkbox"
                        id="useSsl"
                        name="useSsl"
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          const useSsl = e.target.checked;
                          setFieldValue('useSsl', useSsl);

                          // A server behind a reverse proxy is usually on the
                          // default HTTPS port rather than Jellyfin's 8096.
                          if (useSsl && Number(values.port) === 8096) {
                            setFieldValue('port', 443);
                          } else if (!useSsl && Number(values.port) === 443) {
                            setFieldValue('port', 8096);
                          }
                        }}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="username" className="text-label">
                      {intl.formatMessage(messages.username)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field id="username" name="username" type="text" />
                      </div>
                      {errors.username && touched.username && (
                        <div className="error">{errors.username}</div>
                      )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="authMethod" className="text-label">
                      {intl.formatMessage(messages.authMethod)}
                    </label>
                    <div className="form-input-area">
                      <Field as="select" id="authMethod" name="authMethod">
                        <option value="password">
                          {intl.formatMessage(messages.authPassword)}
                        </option>
                        <option value="apiKey">
                          {intl.formatMessage(messages.authApiKey)}
                        </option>
                      </Field>
                      <span className="mt-1 block text-sm text-gray-500">
                        {intl.formatMessage(
                          values.authMethod === 'apiKey'
                            ? messages.apiKeyTip
                            : messages.passwordTip
                        )}
                      </span>
                    </div>
                  </div>
                  {values.authMethod === 'apiKey' ? (
                    <div className="form-row">
                      <label htmlFor="apiKey" className="text-label">
                        {intl.formatMessage(messages.apiKey)}
                      </label>
                      <div className="form-input-area">
                        <div className="form-input-field">
                          <SensitiveInput
                            as="field"
                            id="apiKey"
                            name="apiKey"
                            autoComplete="off"
                          />
                        </div>
                        {errors.apiKey && touched.apiKey && (
                          <div className="error">{errors.apiKey}</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="form-row">
                      <label htmlFor="password" className="text-label">
                        {intl.formatMessage(messages.password)}
                      </label>
                      <div className="form-input-area">
                        <div className="form-input-field">
                          <SensitiveInput
                            as="field"
                            id="password"
                            name="password"
                            autoComplete="off"
                          />
                        </div>
                        {errors.password && touched.password && (
                          <div className="error">{errors.password}</div>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="actions">
                    <div className="flex justify-end">
                      <span className="ml-3 inline-flex rounded-md shadow-sm">
                        <Button
                          buttonType="primary"
                          type="submit"
                          disabled={isSubmitting || !isValid}
                        >
                          {isSubmitting
                            ? intl.formatMessage(messages.connecting)
                            : intl.formatMessage(messages.connect)}
                        </Button>
                      </span>
                    </div>
                  </div>
                </form>
              )}
            </Formik>
          </div>
        </>
      )}
    </>
  );
};

export default SettingsMediaServers;
