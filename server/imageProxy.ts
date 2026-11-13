import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * Same-origin image proxy for exports.
 *
 * The export code has to turn chapter pictures into data URLs (canvas, jsPDF, Word). A browser may only read pixels of a
 * cross-origin picture when the picture's server allows it (CORS), and hosted previews such as Google AI Studio block
 * those requests, so every picture used to fall back to a grey placeholder. Fetching the picture here and serving it from
 * the app's own origin has none of those limits.
 *
 * This is not an open proxy: it takes ONE parameter, `u`, and only ever fetches a picsum.photos picture. See isAllowedImageUrl.
 */
export const IMAGE_PROXY_ROUTE = "/api/image-proxy";
export const MAX_PROXIED_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]); // no SVG: it can carry script
const MAX_REDIRECTS = 4;
const UPSTREAM_TIMEOUT_MS = 12_000;
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;

function isPicsumHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "picsum.photos" || host.endsWith(".picsum.photos");
}

/** The picture the app asks for, e.g. https://picsum.photos/seed/<seed>/1200/800 (or /id/<n>/<w>/<h>). Nothing else is fetched. */
export function isAllowedImageUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.hostname.toLowerCase() !== "picsum.photos") return null;
  if (!/^\/(?:seed\/[^/]{1,300}|id\/\d{1,6})\/\d{1,4}\/\d{1,4}(?:\.(?:jpg|webp))?$/.test(url.pathname)) return null;
  return url;
}

/** A redirect target only has to stay on picsum over https (the CDN host differs from the entry host). */
function isAllowedRedirectTarget(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && isPicsumHost(url.hostname);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ImageProxyOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

class ProxyError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

interface CachedImage {
  body: Buffer;
  contentType: string;
}

function sendText(res: ServerResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(message);
}

export function createImageProxyMiddleware(options: ImageProxyOptions = {}) {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PROXIED_IMAGE_BYTES;

  // Small LRU: a book shows each picture on screen and again in every export.
  const cache = new Map<string, CachedImage>();
  let cachedBytes = 0;
  const remember = (key: string, image: CachedImage) => {
    if (image.body.length > CACHE_MAX_BYTES) return;
    cache.set(key, image);
    cachedBytes += image.body.length;
    while (cache.size > CACHE_MAX_ENTRIES || cachedBytes > CACHE_MAX_BYTES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cachedBytes -= cache.get(oldest)!.body.length;
      cache.delete(oldest);
    }
  };

  async function download(start: URL): Promise<CachedImage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let current = start;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetchImpl(current.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "image/*" },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new ProxyError(502, "Image host sent a redirect without a location");
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw new ProxyError(502, "Image host sent an invalid redirect");
          }
          if (!isAllowedRedirectTarget(next)) throw new ProxyError(502, "Image host redirected outside the allowed host");
          current = next;
          continue;
        }

        if (!response.ok) throw new ProxyError(502, `Image host answered ${response.status}`);

        const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new ProxyError(502, "Image host did not return a supported image type");

        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) throw new ProxyError(502, "Image is too large");

        const body = Buffer.from(await response.arrayBuffer());
        if (body.length === 0) throw new ProxyError(502, "Image host returned an empty body");
        if (body.length > maxBytes) throw new ProxyError(502, "Image is too large");
        return { body, contentType };
      }
      throw new ProxyError(502, "Too many redirects");
    } catch (err) {
      if (err instanceof ProxyError) throw err;
      if ((err as Error)?.name === "AbortError") throw new ProxyError(504, "Image host timed out");
      throw new ProxyError(502, "Could not reach the image host");
    } finally {
      clearTimeout(timer);
    }
  }

  return async (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname !== IMAGE_PROXY_ROUTE) {
      next();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendText(res, 405, "Method not allowed");
      return;
    }

    const target = isAllowedImageUrl(requestUrl.searchParams.get("u") || "");
    if (!target) {
      sendText(res, 400, "Only picsum.photos pictures can be proxied");
      return;
    }

    try {
      const key = target.toString();
      let image = cache.get(key);
      if (image) {
        cache.delete(key); // refresh its place in the LRU order
        cache.set(key, image);
      } else {
        image = await download(target);
        remember(key, image);
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", image.contentType);
      res.setHeader("Content-Length", String(image.body.length));
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? undefined : image.body);
    } catch (err) {
      const status = err instanceof ProxyError ? err.statusCode : 502;
      sendText(res, status, err instanceof ProxyError ? err.message : "Image proxy failed");
    }
  };
}

export function imageProxyPlugin(): Plugin {
  const middleware = createImageProxyMiddleware();
  return {
    name: "image-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
