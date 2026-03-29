/**
 * Strapi v5 Document Service Middleware
 *
 * Problem: In Strapi v5, ALL fields without pluginOptions.i18n.localized=true
 * are synced across locales on every save — including fields that ARE marked
 * localized in the schema (Strapi v5 ignores the flag for certain field types
 * at runtime). When you save locale A, Strapi writes those field values to
 * every other locale row too.
 *
 * Fix: Before the save, snapshot the fields we want to keep locale-independent
 * for every OTHER locale row (using strapi.db.query to bypass this middleware).
 * After the save, restore those snapshots.
 *
 * Protected content types and their locale-specific fields:
 *   api::blog.blog          → author, category, sub_category, tags, relatedArticles
 *   api::category.category  → name, slug
 *   api::sub-category.sub-category → name, slug, category (relation)
 */

// Guards against re-entrant middleware calls triggered by our own restore writes
const processingDocs = new Set<string>();

type FieldConfig = {
  scalar: string[];        // plain string/number fields to snapshot & restore
  relations: string[];     // relation fields (manyToOne / manyToMany)
};

const PROTECTED: Record<string, FieldConfig> = {
  'api::blog.blog': {
    scalar: [],
    relations: ['author', 'category', 'sub_category', 'tags', 'relatedArticles'],
  },
  'api::category.category': {
    scalar: ['name', 'slug'],
    relations: [],
  },
  'api::sub-category.sub-category': {
    scalar: ['name', 'slug'],
    relations: ['category'],
  },
};

export default {
  register({ strapi }: { strapi: any }) {
    strapi.documents.middleware.use(async (ctx: any, next: any) => {
      const uid: string = ctx.uid;
      const documentId: string | undefined = ctx.params?.documentId;
      const editedLocale: string | undefined = ctx.params?.locale;
      const config = PROTECTED[uid];

      // Only intercept content types we care about
      if (
        !config ||
        !['create', 'update'].includes(ctx.action) ||
        !editedLocale ||
        !documentId ||
        processingDocs.has(documentId)
      ) {
        return next();
      }

      // Build populate spec for snapshot
      const populateSpec: Record<string, any> = {};
      for (const f of config.scalar) {
        populateSpec[f] = true; // scalars don't need populate but won't hurt
      }
      for (const f of config.relations) {
        populateSpec[f] = { select: ['id'] };
      }

      // ── Snapshot ──────────────────────────────────────────────────────────────
      type SnapRow = { rowId: number; locale: string; data: Record<string, any> };
      const snapshots: SnapRow[] = [];

      try {
        const allRows = await strapi.db.query(uid).findMany({
          where: { documentId },
          populate: config.relations.reduce((acc: any, f) => {
            acc[f] = { select: ['id'] };
            return acc;
          }, {}),
        });

        for (const row of allRows ?? []) {
          if (row.locale === editedLocale) continue;

          const data: Record<string, any> = {};

          // Scalar fields
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

      // ── Run Strapi's normal save ──────────────────────────────────────────────
      processingDocs.add(documentId);
      let result: any;
      try {
        result = await next();
      } finally {
        processingDocs.delete(documentId);
      }

      // ── Restore: write back snapshotted values for every other locale row ─────
      for (const snap of snapshots) {
        try {
          const restoreData: Record<string, any> = {};

          for (const f of config.scalar) {
            restoreData[f] = snap.data[f];
          }

          for (const f of config.relations) {
            restoreData[f] = snap.data[f]; // id or array of ids or null
          }

          await strapi.db.query(uid).update({
            where: { id: snap.rowId },
            data: restoreData,
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
