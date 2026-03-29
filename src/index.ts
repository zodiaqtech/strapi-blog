/**
 * Strapi v5 Document Service Middleware
 *
 * Problem: In Strapi v5, relations between two localized content types are stored
 * at the document level. When you update locale A's relation, Strapi automatically
 * syncs the same relation (by document_id) to ALL other locales.
 *
 * Fix: Before saving a blog update, snapshot the relation link IDs for every OTHER
 * locale row. After Strapi's save (which overwrites them), restore those snapshots.
 *
 * Fields protected per-locale: author, category, sub_category, tags, relatedArticles
 */

const LOCALE_RELATION_FIELDS = [
  'author',
  'category',
  'sub_category',
  'tags',
  'relatedArticles',
];

export default {
  register({ strapi }: { strapi: any }) {
    strapi.documents.middleware.use(async (ctx: any, next: any) => {
      // Only intercept blog create / update that carry a locale
      if (
        ctx.uid !== 'api::blog.blog' ||
        !['create', 'update'].includes(ctx.action) ||
        !ctx.params?.locale
      ) {
        return next();
      }

      const editedLocale: string = ctx.params.locale;
      const documentId: string | undefined = ctx.params?.documentId;

      // ── Snapshot: record relation IDs for every locale OTHER than the one being edited ──
      let snapshots: Record<string, Record<string, any>> = {};

      if (documentId) {
        try {
          // Fetch all locale versions of this document
          const allLocales = await strapi.documents('api::blog.blog').findMany({
            filters: { documentId },
            populate: LOCALE_RELATION_FIELDS.reduce((acc: any, f) => {
              acc[f] = { fields: ['id', 'documentId', 'locale'] };
              return acc;
            }, {}),
            locale: 'all' as any,
          });

          for (const localeDoc of allLocales || []) {
            if (localeDoc.locale === editedLocale) continue; // skip the one being edited

            snapshots[localeDoc.locale] = {};
            for (const field of LOCALE_RELATION_FIELDS) {
              const val = localeDoc[field];
              if (!val) {
                snapshots[localeDoc.locale][field] = null;
              } else if (Array.isArray(val)) {
                // manyToMany → store array of documentIds
                snapshots[localeDoc.locale][field] = val.map((v: any) => ({
                  documentId: v.documentId,
                }));
              } else {
                // manyToOne → store single documentId
                snapshots[localeDoc.locale][field] = { documentId: val.documentId };
              }
            }
          }
        } catch (err) {
          strapi.log.warn('[locale-relation-guard] snapshot failed:', err);
        }
      }

      // ── Run Strapi's normal save ──
      const result = await next();

      // ── Restore: write back the snapshotted relations for every other locale ──
      if (documentId && Object.keys(snapshots).length > 0) {
        for (const [locale, relations] of Object.entries(snapshots)) {
          try {
            const updateData: Record<string, any> = {};
            for (const field of LOCALE_RELATION_FIELDS) {
              const snap = relations[field];
              if (snap === null) {
                updateData[field] = null;
              } else if (Array.isArray(snap)) {
                updateData[field] = snap; // restore array of documentIds
              } else {
                updateData[field] = snap.documentId ?? null;
              }
            }

            await strapi.documents('api::blog.blog').update({
              documentId,
              locale,
              data: updateData,
            });
          } catch (err) {
            strapi.log.warn(
              `[locale-relation-guard] restore failed for locale ${locale}:`,
              err
            );
          }
        }
      }

      return result;
    });
  },

  bootstrap(/*{ strapi }*/) {},
};
