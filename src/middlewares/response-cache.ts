'use strict';

/**
 * In-memory response cache middleware for Strapi v5
 *
 * - Caches GET /api/* responses in memory with a configurable TTL
 * - Cache key = full request URL (path + query string)
 * - Automatically invalidates cache on POST/PUT/PATCH/DELETE
 * - Never caches admin routes, upload endpoints, or authenticated requests
 * - Reports hit/miss stats via X-Cache header
 */

interface CacheEntry {
  body: string;
  status: number;
  headers: Record<string, string>;
  expiresAt: number;
}

// Simple TTL map — no extra dependencies needed
const cache = new Map<string, CacheEntry>();

// Config
const TTL_BLOG_MS    = 30 * 24 * 60 * 60 * 1000;  // 30 days  — individual blog pages (slug URLs)
const TTL_DEFAULT_MS =       5 * 60 * 1000;        // 5 minutes — listings, categories, authors
const MAX_SIZE = 20_000;                            // max number of cached responses (~340MB worst case for 10k blogs × 2 locales)

function getTTL(url: string): number {
  // Individual blog detail page — content never changes after publish
  if (/\/api\/blogs\/slug\//.test(url)) return TTL_BLOG_MS;
  return TTL_DEFAULT_MS;
}

// Routes that should NEVER be cached
const SKIP_PATTERNS = [
  /^\/admin/,
  /^\/upload/,
  /^\/auth/,
  /^\/api\/users/,
  /^\/api\/connect/,
];

// Routes that benefit most from caching
const CACHE_PATTERNS = [
  /^\/api\/blogs/,
  /^\/api\/categories/,
  /^\/api\/sub-categories/,
  /^\/api\/authors/,
];

function shouldCache(path: string): boolean {
  if (SKIP_PATTERNS.some(p => p.test(path))) return false;
  return CACHE_PATTERNS.some(p => p.test(path));
}

/**
 * Exported utility — clears all Strapi in-memory cache entries for a given slug.
 * Called by the /api/cache/revalidate endpoint when a blog is updated.
 * Returns the number of entries removed.
 */
export function clearCacheBySlug(slug: string, locale?: string): number {
  let count = 0;
  const pattern = locale
    ? `/api/blogs/slug/${slug}?locale=${locale}`   // specific locale
    : `/api/blogs/slug/${slug}`;                   // all locales for this slug
  for (const key of cache.keys()) {
    if (key.includes(pattern)) {
      cache.delete(key);
      count++;
    }
  }
  return count;
}

/**
 * Exported utility — clears all Strapi in-memory cache entries whose key
 * starts with the given path prefix (e.g. '/api/categories').
 * Use when a related content type changes and listing endpoints become stale.
 * Returns the number of entries removed.
 */
export function clearCacheByPath(pathPrefix: string): number {
  let count = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(pathPrefix)) {
      cache.delete(key);
      count++;
    }
  }
  return count;
}

/**
 * Exported utility — clears ALL Strapi in-memory cache entries.
 * Nuclear option — use when doing bulk updates.
 */
export function clearAllCache(): number {
  const count = cache.size;
  cache.clear();
  return count;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

function evictOldest(): void {
  // Delete first (oldest) entry
  const firstKey = cache.keys().next().value;
  if (firstKey) cache.delete(firstKey);
}

let reqCount = 0;
let hitCount  = 0;

export default (config, { strapi }) => {
  return async (ctx, next) => {
    const method = ctx.method;
    const path   = ctx.path;

    // ── Invalidate on write operations ──────────────────────────────────────
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      // Clear cache entries related to this path prefix
      const prefix = path.split('/').slice(0, 4).join('/');
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
      return next();
    }

    // ── Only cache GET requests on whitelisted routes ───────────────────────
    if (method !== 'GET' || !shouldCache(path)) {
      return next();
    }

    // Never cache authenticated requests
    const authHeader = ctx.get('Authorization');
    if (authHeader) return next();

    // Bypass cache when client explicitly requests fresh data
    const cacheControl = ctx.get('Cache-Control');
    if (cacheControl && (cacheControl.includes('no-cache') || cacheControl.includes('no-store'))) {
      return next();
    }

    const cacheKey = ctx.url; // includes query string
    const now      = Date.now();

    // ── Cache HIT ────────────────────────────────────────────────────────────
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      hitCount++;
      ctx.status = cached.status;
      ctx.body   = cached.body;
      for (const [k, v] of Object.entries(cached.headers)) {
        ctx.set(k, v);
      }
      ctx.set('X-Cache', 'HIT');
      ctx.set('X-Cache-TTL', String(Math.round((cached.expiresAt - now) / 1000)) + 's');
      return;
    }

    // ── Cache MISS — run handler ─────────────────────────────────────────────
    reqCount++;
    await next();

    // Only cache successful JSON responses
    if (ctx.status >= 200 && ctx.status < 300 && ctx.body) {
      // Evict expired entries periodically
      if (reqCount % 50 === 0) evictExpired();

      // Evict oldest if at capacity
      if (cache.size >= MAX_SIZE) evictOldest();

      const bodyStr = typeof ctx.body === 'string'
        ? ctx.body
        : JSON.stringify(ctx.body);

      // Only cache responses under 500KB to avoid memory bloat
      if (bodyStr.length < 500_000) {
        const headersToCache: Record<string, string> = {};
        const contentType = ctx.get('Content-Type');
        if (contentType) headersToCache['Content-Type'] = contentType;

        cache.set(cacheKey, {
          body: bodyStr,
          status: ctx.status,
          headers: headersToCache,
          expiresAt: now + getTTL(cacheKey),
        });
      }
    }

    ctx.set('X-Cache', 'MISS');

    // Log cache stats every 100 requests
    if (reqCount % 100 === 0) {
      const hitRate = reqCount > 0 ? ((hitCount / (hitCount + reqCount)) * 100).toFixed(1) : '0';
      strapi.log.info(`[cache] size=${cache.size} hits=${hitCount} misses=${reqCount} hit-rate=${hitRate}%`);
    }
  };
};
