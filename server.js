const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const STORE_FILE = path.join(ROOT, "pools.json");
const ADMIN_PASSWORD = process.env.WORLDCUP_ADMIN_PASSWORD || "worldcup2026";
const TOKEN_SECRET = process.env.WORLDCUP_TOKEN_SECRET || crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex");
const WORLDCUP_API_KEY = process.env.WORLDCUP_API_KEY || "";
const WORLDCUP_API_BASE = process.env.WORLDCUP_API_BASE || "https://api.worldcupapi.com";
let liveCache = { fetchedAt: 0, payload: null };

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { pools: {} };
    throw error;
  }
}

async function writeStore(store) {
  const tempFile = `${STORE_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tempFile, STORE_FILE);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeSlug(slug) {
  return String(slug || "main").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "main";
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  return payload.exp > Date.now();
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/worldcup/live") {
    return sendJson(res, 200, await getWorldCupLiveData());
  }

  if (req.method === "POST" && url.pathname === "/api/admin/unlock") {
    const body = await readBody(req);
    if (body.password !== ADMIN_PASSWORD) return sendJson(res, 401, { error: "Incorrect password" });
    return sendJson(res, 200, { token: signToken({ role: "admin", exp: Date.now() + 1000 * 60 * 60 * 8 }) });
  }

  const match = url.pathname.match(/^\/api\/pools\/([^/]+)$/);
  if (!match) return sendJson(res, 404, { error: "Not found" });

  const slug = normalizeSlug(match[1]);
  const store = await readStore();

  if (req.method === "GET") {
    return sendJson(res, 200, {
      slug,
      state: store.pools[slug]?.state || null,
      updatedAt: store.pools[slug]?.updatedAt || null
    });
  }

  if (req.method === "PUT") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!verifyToken(token)) return sendJson(res, 401, { error: "Admin unlock required" });
    const body = await readBody(req);
    store.pools[slug] = {
      state: body.state,
      updatedAt: new Date().toISOString()
    };
    await writeStore(store);
    return sendJson(res, 200, { ok: true, slug, updatedAt: store.pools[slug].updatedAt });
  }

  return sendJson(res, 405, { error: "Method not allowed" });
}

async function getWorldCupLiveData() {
  if (!WORLDCUP_API_KEY) {
    return {
      configured: false,
      fetchedAt: null,
      fixtures: [],
      liveScores: [],
      message: "Set WORLDCUP_API_KEY on the server to enable automatic fixtures and live scores."
    };
  }

  if (liveCache.payload && Date.now() - liveCache.fetchedAt < 30000) return liveCache.payload;

  const [fixtures, liveScores] = await Promise.all([
    fetchWorldCupEndpoint("/fixtures"),
    fetchWorldCupEndpoint("/livescores")
  ]);

  liveCache = {
    fetchedAt: Date.now(),
    payload: {
      configured: true,
      fetchedAt: new Date().toISOString(),
      fixtures,
      liveScores
    }
  };
  return liveCache.payload;
}

async function fetchWorldCupEndpoint(endpoint) {
  const url = new URL(endpoint, WORLDCUP_API_BASE);
  url.searchParams.set("key", WORLDCUP_API_KEY);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`World Cup API failed: ${response.status}`);
  return response.json();
}

async function serveStatic(req, res, url) {
  const filePath = url.pathname === "/" ? path.join(ROOT, "index.html") : path.join(ROOT, url.pathname);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ROOT)) return sendText(res, 403, "Forbidden");

  try {
    const data = await fs.readFile(resolved);
    const contentType = resolved.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
    sendText(res, 200, data, contentType);
  } catch {
    sendText(res, 404, "Not found");
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Server error" });
  }
}).listen(PORT, HOST, () => {
  console.log(`World Cup pool app running at http://${HOST}:${PORT}/?pool=main`);
});
