/**
 * Locale-isolation guard for Strapi v5
 *
 * Problem: Strapi v5 syncs ALL fields (including those marked localized:true in
 * schema) across all locale rows whenever any save/publish action is triggered.
 *
 * Strategy:
 *
 * 1. DB Lifecycle hooks (beforeUpdate) for SCALAR fields — fires at DB level for
 *    every operation (update, publish, etc.). If the row being written is NOT the
 *    locale the user is editing, strip the protected fields so Strapi leaves the
 *    existing value untouched.
 *
 * 2. Document Service middleware for RELATION fields on blogs — snapshots relation
 *    IDs before the save, then restores them for other locale rows after.
 *
 * Protected scalar fields:
 *   api::category.category        → name, slug
 *   api::sub-category.sub-category → name, slug
 *
 * Protected relation fields:
 *   api::blog.blog → author, category, sub_category, tags, relatedArticles
 */

// ── helpers ──────────────────────────────────────────────────────────────────

/** Read the locale being edited from the current HTTP request context. */
const getEditedLocale = (strapi: any): string | null => {
  try {
    const ctx = strapi.requestContext.get();
    // locale is usually a query param: PUT /content-manager/…?locale=hi
    return ctx?.query?.locale || ctx?.request?.body?.locale || null;
  } catch {
    return null;
  }
};

// ── 1. DB lifecycle guard for scalar fields ───────────────────────────────────

const SCALAR_GUARD: Record<string, string[]> = {
  'api::category.category': ['name', 'slug'],
  'api::sub-category.sub-category': ['name', 'slug'],
};

// ── 2. Document Service middleware for blog relation fields ───────────────────

const BLOG_RELATION_FIELDS = [
  'author',
  'category',
  'sub_category',
  'tags',
  'relatedArticles',
];

const processingDocs = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────

export default {
  register({ strapi }: { strapi: any }) {

    // ── Scalar field guard via DB lifecycles ────────────────────────────────
    strapi.db.lifecycles.subscribe({
      models: Object.keys(SCALAR_GUARD),

      async beforeUpdate(event: any) {
        const uid: string = event.model?.uid;
        const protectedFields = SCALAR_GUARD[uid];
        if (!protectedFields?.length) return;

        const editedLocale = getEditedLocale(strapi);
        if (!editedLocale) return;

        // Find the row that Strapi is about to update
        const row = await strapi.db.query(uid).findOne({
          where: event.params.where,
          select: ['id', 'locale'],
        });

        if (!row || row.locale === editedLocale) return;

        // This row belongs to a different locale — strip the protected fields
        // so Strapi's sync write leaves the existing values untouched.
        for (const field of protectedFields) {
          if (field in event.params.data) {
            delete event.params.data[field];
          }
        }
      },
    });

    // ── Blog relation guard via Document Service middleware ──────────────────
    strapi.documents.middleware.use(async (ctx: any, next: any) => {
      const documentId: string | undefined = ctx.params?.documentId;
      const editedLocale: string | undefined = ctx.params?.locale;

      if (
        ctx.uid !== 'api::blog.blog' ||
        !['create', 'update', 'publish'].includes(ctx.action) ||
        !editedLocale ||
        !documentId ||
        processingDocs.has(documentId)
      ) {
        return next();
      }

      // Snapshot relation IDs for every OTHER locale row
      type SnapRow = { rowId: number; locale: string; data: Record<string, any> };
      const snapshots: SnapRow[] = [];

      try {
        const allRows = await strapi.db.query('api::blog.blog').findMany({
          where: { documentId },
          populate: BLOG_RELATION_FIELDS.reduce((acc: any, f) => {
            acc[f] = { select: ['id'] };
            return acc;
          }, {}),
        });

        for (const row of allRows ?? []) {
          if (row.locale === editedLocale) continue;

          const data: Record<string, any> = {};
          for (const f of BLOG_RELATION_FIELDS) {
            const val = row[f];
            if (!val) data[f] = null;
            else if (Array.isArray(val)) data[f] = val.map((v: any) => v.id);
            else data[f] = val.id ?? null;
          }
          snapshots.push({ rowId: row.id, locale: row.locale, data });
        }
      } catch (err) {
        strapi.log.warn('[locale-guard][blog] snapshot failed:', err);
      }

      processingDocs.add(documentId);
      let result: any;
      try {
        result = await next();
      } finally {
        processingDocs.delete(documentId);
      }

      // Restore snapshotted relations for other locale rows
      for (const snap of snapshots) {
        try {
          await strapi.db.query('api::blog.blog').update({
            where: { id: snap.rowId },
            data: snap.data,
          });
        } catch (err) {
          strapi.log.warn(
            `[locale-guard][blog] restore failed for locale "${snap.locale}" (row ${snap.rowId}):`,
            err
          );
        }
      }

      return result;
    });
  },

  bootstrap(/*{ strapi }*/) {},
};
