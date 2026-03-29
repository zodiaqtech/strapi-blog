/**
 * Strapi v5 Document Service Middleware
 *
 * Problem: In Strapi v5, relations between localized content types are stored at
 * the document level. When you update locale A's relation, Strapi syncs it to ALL
 * other locales automatically — even with pluginOptions.i18n.localized = true.
 *
 * Fix: Before the save, snapshot relation row IDs for every OTHER locale using
 * strapi.db.query (bypasses this middleware). After Strapi's save restores them
 * using the same DB-level query. A processingDocs Set prevents infinite loops.
 *
 * Fields protected per-locale: author, category, sub_category, tags, relatedArticles
 */

const RELATION_FIELDS = ['author', 'category', 'sub_category', 'tags', 'relatedArticles'];

// Guards against re-entrant middleware calls triggered by our own restore writes
const processingDocs = new Set<string>();

export default {
  register({ strapi }: { strapi: any }) {
    strapi.documents.middleware.use(async (ctx: any, next: any) => {
      const documentId: string | undefined = ctx.params?.documentId;
      const editedLocale: string | undefined = ctx.params?.locale;

      // Only intercept blog create/update that target a specific locale document
      if (
        ctx.uid !== 'api::blog.blog' ||
        !['create', 'update'].includes(ctx.action) ||
        !editedLocale ||
        !documentId ||
        processingDocs.has(documentId)   // skip our own restore calls
      ) {
        return next();
      }

      // ── Snapshot: read current relations for every OTHER locale row ──────────
      let snapshots: Array<{
        rowId: number;
        locale: string;
        author: any;
        category: any;
        sub_category: any;
        tags: any[];
        relatedArticles: any[];
      }> = [];

      try {
        const allRows = await strapi.db.query('api::blog.blog').findMany({
          where: { documentId },
          populate: {
            author: { select: ['id'] },
            category: { select: ['id'] },
            sub_category: { select: ['id'] },
            tags: { select: ['id'] },
            relatedArticles: { select: ['id'] },
          },
        });

        for (const row of allRows ?? []) {
          if (row.locale === editedLocale) continue;
          snapshots.push({
            rowId: row.id,
            locale: row.locale,
            author: row.author ?? null,
            category: row.category ?? null,
            sub_category: row.sub_category ?? null,
            tags: row.tags ?? [],
            relatedArticles: row.relatedArticles ?? [],
          });
        }
      } catch (err) {
        strapi.log.warn('[locale-relation-guard] snapshot failed:', err);
      }

      // ── Run Strapi's normal save (may sync relations to other locales) ────────
      processingDocs.add(documentId);
      let result: any;
      try {
        result = await next();
      } finally {
        processingDocs.delete(documentId);
      }

      // ── Restore: write back snapshotted relations for other locale rows ───────
      for (const snap of snapshots) {
        try {
          await strapi.db.query('api::blog.blog').update({
            where: { id: snap.rowId },
            data: {
              author: snap.author ? snap.author.id : null,
              category: snap.category ? snap.category.id : null,
              sub_category: snap.sub_category ? snap.sub_category.id : null,
              tags: snap.tags.map((t: any) => t.id),
              relatedArticles: snap.relatedArticles.map((r: any) => r.id),
            },
          });
        } catch (err) {
          strapi.log.warn(
            `[locale-relation-guard] restore failed for locale "${snap.locale}" (row ${snap.rowId}):`,
            err
          );
        }
      }

      return result;
    });
  },

  bootstrap(/*{ strapi }*/) {},
};
