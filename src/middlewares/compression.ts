import type { Core } from '@strapi/strapi';
// @ts-ignore — no types for koa-compress
import compress from 'koa-compress';
import { constants } from 'zlib';

export default (config: object, { strapi }: { strapi: Core.Strapi }) => {
  const middleware = compress({
    br: {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 4, // 0-11; 4 = fast + good ratio
      },
    },
    gzip: {
      level: 6,
    },
    deflate: false,
    threshold: 1024, // only compress responses > 1KB
    filter(contentType: string) {
      // Compress JSON, HTML, CSS, JS, SVG — not already-compressed images/video
      return /text|json|javascript|svg/.test(contentType);
    },
  });

  return async (ctx: any, next: () => Promise<void>) => {
    await middleware(ctx, next);
  };
};
