'use strict';

module.exports = [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'market-assets.strapi.io',
            `https://${process.env.STORAGE_ACCOUNT || 'yourstorageaccount'}.blob.core.windows.net`,
          ],
          'media-src': [
            "'self'",
            'data:',
            'blob:',
            `https://${process.env.STORAGE_ACCOUNT || 'yourstorageaccount'}.blob.core.windows.net`,
          ],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      formLimit: '256mb',
      jsonLimit: '256mb',
      textLimit: '256mb',
      multipart: true,
    },
  },
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  'global::compression',
  {
    name: 'global::response-cache',
    config: {},
  },
];
