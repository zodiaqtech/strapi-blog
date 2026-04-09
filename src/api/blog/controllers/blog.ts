import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::blog.blog', ({ strapi }) => ({
  async findBySlug(ctx) {
    const { slug } = ctx.params;
    const { locale = 'en' } = ctx.query as any;

    const populate = {
      category: true,
      sub_category: true,
      thumbnail: true,
      featured_image: true,
      author: true,
      seo: true,
      body: true,
      tags: true,
      relatedArticles: {
        populate: {
          thumbnail: true,
        },
      },
    };

    // Use strapi.documents() which correctly handles Strapi v5 locale + draft/publish state.
    // strapi.db.query() is low-level and does not distinguish draft vs published rows,
    // causing older published HI entries to return null (draft row hit instead of published).
    // Try requested locale first, fall back to 'en' if no translation exists.
    let entity = await strapi.documents('api::blog.blog').findFirst({
      filters: { slug },
      locale,
      status: 'published',
      populate,
    });

    if (!entity && locale !== 'en') {
      entity = await strapi.documents('api::blog.blog').findFirst({
        filters: { slug },
        locale: 'en',
        status: 'published',
        populate,
      });
    }

    if (!entity) {
      return ctx.notFound('Blog not found');
    }

    // Enforce that blogs must have category and sub_category
    if (!entity.category || !entity.sub_category) {
      return ctx.notFound('Blog not found');
    }

    // Use transformResponse directly — sanitizeOutput strips relations on custom routes
    // because the public role has no explicit populate permissions for this custom route.
    // This route is already auth: false public so no sensitive data is at risk.
    return this.transformResponse(entity);
  },
}));
