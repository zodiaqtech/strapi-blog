'use strict';

const path = require('path');

module.exports = ({ env }) => {
  const useAzureStorage = !!env('STORAGE_ACCOUNT', '');

  return {
    upload: useAzureStorage
      ? {
          config: {
            provider: path.resolve(__dirname, '../src/providers/upload-azure'),
            providerOptions: {
              account:       env('STORAGE_ACCOUNT'),
              accountKey:    env('STORAGE_ACCOUNT_KEY'),
              containerName: env('STORAGE_CONTAINER_NAME', 'strapi-uploads'),
              cdnBaseURL:    env('STORAGE_URL', ''),   // e.g. https://strapiblogmedia.blob.core.windows.net
            },
            actionOptions: {
              upload:       {},
              uploadStream: {},
              delete:       {},
            },
          },
        }
      : {},   // local disk storage when no Azure env vars set

    'users-permissions': {
      config: {
        jwt: {
          expiresIn: '7d',
        },
      },
    },
  };
};
