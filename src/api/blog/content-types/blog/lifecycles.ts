import { clearCacheBySlug, clearCacheByPath } from '../../../../middlewares/response-cache';

/**
 * Blog lifecycle hooks — automatic cache invalidation
 *
 * On every blog create / update / delete / publish / unpublish:
 *   1. Clears the Strapi in-memory cache for that slug
 *   2. Calls the Next.js /api/revalidate endpoint with { secret, slug, locale }
 *      so the frontend page is immediately refreshed (or removed on delete)
 *
 * For delete we fire a second revalidation without a slug so that listing
 * pages (category / sub-category / home) also pick up the change.
 *
 * Required env vars (same as the /api/cache/revalidate controller):
 *   REVALIDATION_SECRET   — shared secret with Next.js
 *   NEXTJS_SITE_URL       — e.g. https://www.myzodiaq.in
 */

async function revalidateNextJs(slug?: string, locale?: string): Promise<void> {
  const nextjsUrl = process.env.NEXTJS_SITE_URL;
  const secret    = process.env.REVALIDATION_SECRET;

  if (!nextjsUrl || !secret) {
    strapi.log.warn('[lifecycle] NEXTJS_SITE_URL or REVALIDATION_SECRET not set — skipping Next.js revalidation');
    return;
  }

  try {
    const body: Record<string, string> = { secret };
    if (slug)   body.slug   = slug;
    if (locale) body.locale = locale;

    const res = await fetch(`${nextjsUrl}/api/revalidate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (res.ok) {
      strapi.log.info(`[lifecycle] Next.js revalidated: slug="${slug ?? 'all'}" locale="${locale ?? 'all'}"`);
    } else {
      const text = await res.text().catch(() => '');
      strapi.log.warn(`[lifecycle] Next.js revalidation failed: HTTP ${res.status} — ${text}`);
    }
  } catch (err: any) {
    strapi.log.warn(`[lifecycle] Next.js revalidation error: ${err.message}`);
  }
}

export default {
  /** Blog created (new draft or direct publish) */
  async afterCreate(event: any) {
    const { slug, locale } = event.result ?? {};
    if (!slug) return;
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories'); // listing pages must show this new blog
    await revalidateNextJs(slug, locale);
  },

  /** Blog updated (content edit, publish, unpublish) */
  async afterUpdate(event: any) {
    const { slug, locale } = event.result ?? {};
    if (!slug) return;
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories'); // listing pages must reflect any visibility change
    await revalidateNextJs(slug, locale);
  },

  /**
   * Blog deleted.
   * Two revalidations:
   *  1. Targeted — removes the cached page for this slug (Next.js will 404 it)
   *  2. All listings — clears category/sub-category listing pages that referenced this blog
   */
  async afterDelete(event: any) {
    const { slug, locale } = event.result ?? {};
    if (!slug) return;
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories'); // listing pages must no longer show this blog
    await revalidateNextJs(slug, locale);   // bust the specific blog page
    await revalidateNextJs();               // bust all listing/category pages
  },

};
