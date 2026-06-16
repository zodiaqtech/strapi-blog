import { clearCacheBySlug, clearCacheByPath } from '../../../../middlewares/response-cache';

/**
 * Blog lifecycle hooks — automatic cache invalidation
 *
 * On every blog create / update / delete / publish / unpublish:
 *   1. Clears the Strapi in-memory cache for that slug
 *   2. Calls the Next.js /api/revalidate endpoint using the Strapi webhook format
 *      (model, event, x-revalidation-secret header) so the route handler can
 *      apply targeted tag invalidation without cascading to unrelated pages.
 *
 * Required env vars:
 *   REVALIDATION_SECRET   — shared secret with Next.js
 *   NEXTJS_SITE_URL       — e.g. https://www.myzodiaq.in
 */

/**
 * Look up the category and sub-category slugs for a blog by its database ID.
 *
 * In Strapi v5, event.result does NOT auto-populate relations — category will
 * only contain { documentId } without any other fields including slug. An
 * explicit DB query is required to get the slug values reliably.
 */
async function fetchBlogRelationSlugs(
  blogId: number,
): Promise<{ categorySlug: string | null; subCategorySlug: string | null }> {
  try {
    const blog = await strapi.db.query('api::blog.blog').findOne({
      where: { id: blogId },
      populate: ['category', 'sub_category'],
    });
    return {
      categorySlug:    blog?.category?.slug    ?? null,
      subCategorySlug: blog?.sub_category?.slug ?? null,
    };
  } catch (err: any) {
    strapi.log.warn(`[lifecycle:blog] Failed to fetch relation slugs for blog id=${blogId}: ${err.message}`);
    return { categorySlug: null, subCategorySlug: null };
  }
}

/**
 * Send a revalidation request to the Next.js /api/revalidate endpoint.
 */
async function revalidateNextJs(
  event: string,
  slug: string,
  locale?: string,
  categorySlug?: string | null,
  subCategorySlug?: string | null,
): Promise<void> {
  const nextjsUrl = process.env.NEXTJS_SITE_URL;
  const secret    = process.env.REVALIDATION_SECRET;

  if (!nextjsUrl || !secret) {
    strapi.log.warn('[lifecycle:blog] NEXTJS_SITE_URL or REVALIDATION_SECRET not set — skipping');
    return;
  }

  try {
    const res = await fetch(`${nextjsUrl}/api/revalidate`, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'x-revalidation-secret': secret,
      },
      body: JSON.stringify({
        event,
        model: 'blog',
        entry: {
          slug,
          locale:           locale          ?? null,
          categorySlug:     categorySlug    ?? null,
          subCategorySlug:  subCategorySlug ?? null,
        },
      }),
    });

    if (res.ok) {
      strapi.log.info(`[lifecycle:blog] Next.js revalidated: event="${event}" slug="${slug}" category="${categorySlug ?? 'unknown'}" locale="${locale ?? 'all'}"`);
    } else {
      const text = await res.text().catch(() => '');
      strapi.log.warn(`[lifecycle:blog] Next.js revalidation failed: HTTP ${res.status} — ${text}`);
    }
  } catch (err: any) {
    strapi.log.warn(`[lifecycle:blog] Next.js revalidation error: ${err.message}`);
  }
}

export default {
  /** Blog created — only revalidate if created as published (visible to users) */
  async afterCreate(event: any) {
    const { id, slug, locale, publishedAt } = event.result ?? {};
    if (!slug || !publishedAt) return;
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories');
    // event.result does not auto-populate relations in Strapi v5 — fetch explicitly
    const { categorySlug, subCategorySlug } = await fetchBlogRelationSlugs(id);
    await revalidateNextJs('entry.create', slug, locale, categorySlug, subCategorySlug);
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

  /**
   * Blog updated — revalidate whenever the published row is touched.
   *
   * Cases:
   *   draft save (unpublished → unpublished): wasPublished=false, isPublished=false → SKIP
   *   first publish:                          wasPublished=false, isPublished=true  → revalidate
   *   edit + re-publish (already published):  wasPublished=true,  isPublished=true  → revalidate ✅
   *   unpublish:                              wasPublished=true,  isPublished=false → revalidate
   */
  async afterUpdate(event: any) {
    const { slug, locale, publishedAt } = event.result ?? {};
    if (!slug) return;

    const wasPublished = event.state?.wasPublished ?? false;
    const isPublished = !!publishedAt;

    // Only skip pure draft saves — both before and after are unpublished
    if (!wasPublished && !isPublished) {
      strapi.log.debug(`[lifecycle:blog] Skipping revalidation for "${slug}" — draft save, not published`);
      return;
    }

    // Use a descriptive event name so the Next.js handler can route correctly.
    // "entry.publish" covers first publish AND re-save of already-published blog.
    // "entry.unpublish" covers unpublish (publishedAt becomes null).
    const strapiEvent = isPublished ? 'entry.publish' : 'entry.unpublish';
    strapi.log.info(`[lifecycle:blog] Revalidating "${slug}" (event=${strapiEvent})`);
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories');
    // event.result does not auto-populate relations in Strapi v5 — fetch explicitly
    const { id } = event.result ?? {};
    const { categorySlug, subCategorySlug } = await fetchBlogRelationSlugs(id);
    await revalidateNextJs(strapiEvent, slug, locale, categorySlug, subCategorySlug);
  },

  /**
   * Blog deleted — only revalidate if the deleted entry was published.
   *
   * NOTE: We do NOT fire a second no-slug revalidation. The old pattern of
   * calling revalidateNextJs() without a slug triggered revalidateTag("blog")
   * which cascaded ALL 20K blog detail pages — far too broad for a single delete.
   * Listing pages will update on the next category event or 30-day TTL expiry.
   */
  async afterDelete(event: any) {
    const { id, slug, locale, publishedAt } = event.result ?? {};
    if (!slug || !publishedAt) return;
    clearCacheBySlug(slug, locale);
    clearCacheByPath('/api/categories');
    // event.result does not auto-populate relations in Strapi v5 — fetch explicitly.
    // Note: on delete the blog may already be gone from DB, so null slugs are expected.
    const { categorySlug, subCategorySlug } = await fetchBlogRelationSlugs(id);
    await revalidateNextJs('entry.delete', slug, locale, categorySlug, subCategorySlug);
  },

};
