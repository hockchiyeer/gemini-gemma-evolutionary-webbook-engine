import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const PERSISTED_BOOKS_DIR = path.resolve(process.cwd(), "saved_webbooks");

/**
 * Sanitizes a topic title and timestamp into a safe file name across Windows and Linux.
 * Strips forbidden characters (/ \ : * ? " < > |), trims spaces, and limits length.
 */
export function sanitizeFileName(topic: string, timestamp?: number): string {
  const ts = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
  const dateStr = new Date(ts).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const cleanTopic = String(topic || "webbook")
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60)
    .replace(/^_+|_+$/g, "") || "webbook";
  return `${dateStr}_${cleanTopic}.txt`;
}

/**
 * Persists formatted WebBook text content to a .txt file inside targetDir (defaulting to saved_webbooks/).
 */
export function saveWebBookText(params: {
  topic: string;
  text: string;
  timestamp?: number;
  fileName?: string;
  dir?: string;
}): { fileName: string; filePath: string; bytesWritten: number } {
  const targetDir = params.dir || PERSISTED_BOOKS_DIR;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const rawFileName = params.fileName || sanitizeFileName(params.topic, params.timestamp);
  // Prevent directory traversal attacks
  const safeBaseName = path.basename(rawFileName);
  const filePath = path.join(targetDir, safeBaseName);

  fs.writeFileSync(filePath, params.text, "utf8");
  const bytesWritten = Buffer.byteLength(params.text, "utf8");

  return { fileName: safeBaseName, filePath, bytesWritten };
}

/**
 * Lists all persisted .txt WebBooks in targetDir.
 */
export function listPersistedWebBooks(dir: string = PERSISTED_BOOKS_DIR): Array<{
  fileName: string;
  size: number;
  modifiedAt: number;
}> {
  if (!fs.existsSync(dir)) return [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".txt"))
      .map((e) => {
        const fullPath = path.join(dir, e.name);
        const stats = fs.statSync(fullPath);
        return {
          fileName: e.name,
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
}

async function readJsonBody(req: IncomingMessage & { body?: any }): Promise<any> {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/**
 * Middleware handling /api/webbooks/persist and /api/webbooks/list.
 */
export function createWebBookStoreMiddleware(dir: string = PERSISTED_BOOKS_DIR) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/api/webbooks/persist" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const topic = String(body.topic || body.webBook?.topic || "webbook");
        const text = String(body.text || body.textContent || "");
        if (!text.trim()) {
          sendJson(res, 400, { ok: false, error: "Missing text content to persist" });
          return;
        }

        const result = saveWebBookText({
          topic,
          text,
          timestamp: body.timestamp || body.webBook?.timestamp,
          fileName: body.fileName,
          dir,
        });

        sendJson(res, 200, { ok: true, ...result });
        return;
      } catch (err: any) {
        console.error("Failed to persist webbook:", err);
        sendJson(res, 500, { ok: false, error: err?.message || "Failed to persist webbook" });
        return;
      }
    }

    if (url.pathname === "/api/webbooks/list" && req.method === "GET") {
      try {
        const files = listPersistedWebBooks(dir);
        sendJson(res, 200, { ok: true, files });
        return;
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || "Failed to list persisted webbooks" });
        return;
      }
    }

    if (url.pathname === "/api/webbooks/file" && req.method === "GET") {
      try {
        const fileName = url.searchParams.get("name") || "";
        if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
          sendJson(res, 400, { ok: false, error: "Invalid file name" });
          return;
        }
        const filePath = path.join(dir, path.basename(fileName));
        if (!fs.existsSync(filePath)) {
          sendJson(res, 404, { ok: false, error: "File not found" });
          return;
        }
        const text = fs.readFileSync(filePath, "utf8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(text);
        return;
      } catch (err: any) {
        sendJson(res, 500, { ok: false, error: err?.message || "Failed to read persisted webbook" });
        return;
      }
    }

    next();
  };
}

/**
 * Vite plugin mounting the webBookStore middleware in dev and preview.
 */
export function webBookStorePlugin(): Plugin {
  const middleware = createWebBookStoreMiddleware();
  return {
    name: "webbook-store",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
