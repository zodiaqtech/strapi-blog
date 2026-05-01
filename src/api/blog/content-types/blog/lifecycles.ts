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
  /** Blog created — only revalidate if created as published (visible to users) */
  async afterCreate(event: any) {
    const { slug, locale, publishedAt } = event.result ?? {};
    if (!slug || !publishedAt) return;
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories');
    await revalidateNextJs(slug, locale);
  },

  /**
   * Snapshot publishedAt before the update so afterUpdate can detect
   * publish/unpublish transitions and skip draft-only saves.
   */
  async beforeUpdate(event: any) {
    const id = event.params?.where?.id;
    if (id) {
      try {
        const existing = await strapi.db.query('api::blog.blog').findOne({
          where: { id },
          select: ['publishedAt'],
        });
        event.state = { wasPublished: !!existing?.publishedAt };
      } catch {
        event.state = { wasPublished: false };
      }
    }
  },

  /** Blog updated — only revalidate on publish/unpublish transitions */
  async afterUpdate(event: any) {
    const { slug, locale, publishedAt } = event.result ?? {};
    if (!slug) return;

    const wasPublished = event.state?.wasPublished ?? false;
    const isPublished = !!publishedAt;

    if (wasPublished === isPublished) {
      strapi.log.debug(`[lifecycle] Skipping revalidation for "${slug}" — publish state unchanged`);
      return;
    }

    strapi.log.info(`[lifecycle] Publish state changed for "${slug}": ${wasPublished} → ${isPublished}`);
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories');
    await revalidateNextJs(slug, locale);
  },

  /** Blog deleted — only revalidate if the deleted entry was published */
  async afterDelete(event: any) {
    const { slug, locale, publishedAt } = event.result ?? {};
    if (!slug || !publishedAt) return;
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories');
    await revalidateNextJs(slug, locale);
    await revalidateNextJs();
  },

};
