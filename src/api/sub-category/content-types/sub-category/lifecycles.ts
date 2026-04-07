/**
 * Sub-category lifecycle hooks — automatic cache invalidation
 *
 * On every sub-category create / update / delete:
 *   Calls the Next.js /api/revalidate endpoint using the webhook format so
 *   that the category listing pages are immediately refreshed.
 *
 * Required env vars:
 *   REVALIDATION_SECRET   — shared secret with Next.js
 *   NEXTJS_SITE_URL       — e.g. https://www.myzodiaq.in
 */

async function revalidateNextJs(event: string, slug?: string): Promise<void> {
  const nextjsUrl = process.env.NEXTJS_SITE_URL;
  const secret    = process.env.REVALIDATION_SECRET;

  if (!nextjsUrl || !secret) {
    strapi.log.warn('[lifecycle:sub-category] NEXTJS_SITE_URL or REVALIDATION_SECRET not set — skipping');
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
        model: 'sub-category',
        entry: { slug: slug ?? null },
      }),
    });

    if (res.ok) {
      strapi.log.info(`[lifecycle:sub-category] Next.js revalidated: event="${event}" slug="${slug ?? 'unknown'}"`);
    } else {
      const text = await res.text().catch(() => '');
      strapi.log.warn(`[lifecycle:sub-category] Next.js revalidation failed: HTTP ${res.status} — ${text}`);
    }
  } catch (err: any) {
    strapi.log.warn(`[lifecycle:sub-category] Next.js revalidation error: ${err.message}`);
  }
}

export default {
  async afterCreate(event: any) {
    const { slug } = event.result ?? {};
    await revalidateNextJs('entry.create', slug);
  },

  async afterUpdate(event: any) {
    const { slug } = event.result ?? {};
    await revalidateNextJs('entry.update', slug);
  },

  async afterDelete(event: any) {
    const { slug } = event.result ?? {};
    await revalidateNextJs('entry.delete', slug);
  },
};
