/**
 * Locale-isolation guard — Strapi v5
 *
 * Problem: Strapi v5 syncs ALL non-explicitly-localized fields (and even some that
 * ARE marked localized) across locale rows on every save/publish.
 *
 * Fix: Document Service middleware intercepts create/update/publish/unpublish.
 * ctx.params.locale is always reliable here (set by Strapi itself, not parsed from
 * the HTTP request). Before the save we snapshot every OTHER locale row's protected
 * fields. After the save we restore them via strapi.db.query (bypasses middleware).
 *
 * Protected content types:
 *   api::category.category         scalar: [name, slug]   relations: []
 *   api::sub-category.sub-category scalar: [name, slug]   relations: []
 *   api::blog.blog                 scalar: []             relations: [author, category,
 *                                                          sub_category, tags, relatedArticles]
 */

type FieldConfig = {
  scalar: string[];
  relations: string[];
};

const PROTECTED: Record<string, FieldConfig> = {
  'api::category.category': {
    scalar: ['name', 'slug'],
    relations: [],
  },
  'api::sub-category.sub-category': {
    scalar: ['name', 'slug'],
    relations: [],
  },
  'api::blog.blog': {
    scalar: [],
    relations: ['author', 'category', 'sub_category', 'tags', 'relatedArticles'],
  },
};

const GUARDED_ACTIONS = ['create', 'update', 'publish', 'unpublish'];

// Prevents our own restore db.query calls from re-triggering the middleware
const processingDocs = new Set<string>();

export default {
  register({ strapi }: { strapi: any }) {
    strapi.documents.middleware.use(async (ctx: any, next: any) => {
      const uid: string = ctx.uid;
      const config = PROTECTED[uid];
      const editedLocale: string | undefined = ctx.params?.locale;
      const documentId: string | undefined = ctx.params?.documentId;

      // Only act on content types + actions we care about
      if (
        !config ||
        !GUARDED_ACTIONS.includes(ctx.action) ||
        !editedLocale ||
        !documentId ||
        processingDocs.has(documentId)
      ) {
        return next();
      }

      // Build populate spec for relations
      const populateSpec = config.relations.reduce((acc: any, f) => {
        acc[f] = { select: ['id'] };
        return acc;
      }, {} as Record<string, any>);

      // ── Snapshot all OTHER locale rows ────────────────────────────────────
      type SnapRow = { rowId: number; locale: string; data: Record<string, any> };
      const snapshots: SnapRow[] = [];

      try {
        const allRows = await strapi.db.query(uid).findMany({
          where: { documentId },
          ...(config.relations.length > 0 ? { populate: populateSpec } : {}),
        });

        for (const row of allRows ?? []) {
          if (row.locale === editedLocale) continue; // skip the locale being edited

          const data: Record<string, any> = {};

          // Scalar fields — read directly from the row
          for (const f of config.scalar) {
            data[f] = row[f] ?? null;
          }

          // Relation fields
          for (const f of config.relations) {
            const val = row[f];
            if (!val) {
              data[f] = null;
            } else if (Array.isArray(val)) {
              data[f] = val.map((v: any) => v.id);
            } else {
              data[f] = val.id ?? null;
            }
          }

          snapshots.push({ rowId: row.id, locale: row.locale, data });
        }
      } catch (err) {
        strapi.log.warn(`[locale-guard][${uid}] snapshot failed:`, err);
      }

      // ── Run Strapi's normal save (may overwrite other locale rows) ────────
      processingDocs.add(documentId);
      let result: any;
      try {
        result = await next();
      } finally {
        processingDocs.delete(documentId);
      }

      // ── Restore snapshotted values for every other locale row ─────────────
      for (const snap of snapshots) {
        try {
          await strapi.db.query(uid).update({
            where: { id: snap.rowId },
            data: snap.data,
          });
        } catch (err) {
          strapi.log.warn(
            `[locale-guard][${uid}] restore failed for locale "${snap.locale}" (row ${snap.rowId}):`,
            err
          );
        }
      }

      return result;
    });
  },

  bootstrap(/*{ strapi }*/) {},
};
