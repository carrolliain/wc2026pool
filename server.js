const http = require("http");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const STORE_FILE = path.join(ROOT, "pools.json");
const ADMIN_PASSWORD = process.env.WORLDCUP_ADMIN_PASSWORD || "worldcup2026";
const TOKEN_SECRET = process.env.WORLDCUP_TOKEN_SECRET || crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex");
const FOOTBALL_DATA_API_BASE = process.env.FOOTBALL_DATA_API_BASE || "https://api.football-data.org/v4";
const FOOTBALL_DATA_API_TOKEN = process.env.FOOTBALL_DATA_API_TOKEN || "";
const FOOTBALL_DATA_COMPETITION = process.env.FOOTBALL_DATA_COMPETITION || "WC";
const FOOTBALL_DATA_SEASON = process.env.FOOTBALL_DATA_SEASON || "2026";
let liveCache = { fetchedAt: 0, payload: null };

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) return;

  const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) return;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

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
  if (liveCache.payload && Date.now() - liveCache.fetchedAt < 30000) return liveCache.payload;

  if (!FOOTBALL_DATA_API_TOKEN) {
    return {
      configured: false,
      provider: "football-data.org",
      fetchedAt: null,
      fixtures: [],
      liveScores: [],
      message: "Football-data.org live feed is not configured. Set FOOTBALL_DATA_API_TOKEN to enable live scores."
    };
  }

  const matchesPayload = await fetchFootballDataEndpoint(`/competitions/${encodeURIComponent(FOOTBALL_DATA_COMPETITION)}/matches?season=${encodeURIComponent(FOOTBALL_DATA_SEASON)}`);
  const normalized = normalizeFootballData(matchesPayload);

  liveCache = {
    fetchedAt: Date.now(),
    payload: {
      configured: true,
      provider: "football-data.org",
      fetchedAt: new Date().toISOString(),
      fixtures: normalized.fixtures,
      liveScores: normalized.liveScores
    }
  };
  return liveCache.payload;
}

async function fetchFootballDataEndpoint(endpoint) {
  const base = FOOTBALL_DATA_API_BASE.endsWith("/") ? FOOTBALL_DATA_API_BASE : `${FOOTBALL_DATA_API_BASE}/`;
  const response = await fetch(new URL(endpoint.replace(/^\/+/, ""), base), {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_TOKEN }
  });
  if (!response.ok) throw new Error(`Football-data.org feed failed: ${response.status}`);
  return response.json();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeFootballData(payload) {
  const fixtures = Array.isArray(payload?.matches) ? payload.matches : [];
  const liveScores = fixtures
    .map(match => {
      const score = bestFootballDataScore(match.score);
      const scoreText = score.homeScore === null || score.awayScore === null ? "" : `${score.homeScore} - ${score.awayScore}`;

      return {
        id: match.id,
        fixture_id: match.id,
        status: normalizeFootballDataStatus(match.status),
        scheduled: match.utcDate,
        location: match.venue || "",
        home: { name: normalizeFootballDataTeamName(match.homeTeam?.name || match.homeTeam?.shortName || "") },
        away: { name: normalizeFootballDataTeamName(match.awayTeam?.name || match.awayTeam?.shortName || "") },
        scores: { score: scoreText, ft_score: scoreText }
      };
    })
    .filter(match => match.home.name && match.away.name && match.scores.score);

  return { fixtures, liveScores };
}

function bestFootballDataScore(score = {}) {
  const fullTimeHome = toNumber(score.fullTime?.home);
  const fullTimeAway = toNumber(score.fullTime?.away);
  if (fullTimeHome !== null && fullTimeAway !== null) return { homeScore: fullTimeHome, awayScore: fullTimeAway };

  const regularHome = toNumber(score.regularTime?.home);
  const regularAway = toNumber(score.regularTime?.away);
  if (regularHome !== null && regularAway !== null) return { homeScore: regularHome, awayScore: regularAway };

  const halfTimeHome = toNumber(score.halfTime?.home);
  const halfTimeAway = toNumber(score.halfTime?.away);
  return { homeScore: halfTimeHome, awayScore: halfTimeAway };
}

function normalizeFootballDataStatus(status) {
  const value = String(status || "").toUpperCase();
  if (["IN_PLAY", "PAUSED"].includes(value)) return "live";
  if (value === "FINISHED") return "finished";
  if (["TIMED", "SCHEDULED", "POSTPONED", "SUSPENDED", "CANCELLED"].includes(value)) return "scheduled";
  return value.toLowerCase();
}

function normalizeFootballDataTeamName(name) {
  const aliases = {
    "USA": "United States",
    "United States of America": "United States",
    "South Korea": "Korea Republic",
    "Korea Republic": "Korea Republic",
    "Turkey": "Türkiye",
    "Cote d'Ivoire": "Côte d’Ivoire",
    "Ivory Coast": "Côte d’Ivoire",
    "Cape Verde": "Cabo Verde",
    "DR Congo": "Congo DR",
    "Democratic Republic of the Congo": "Congo DR",
    "Curacao": "Curaçao"
  };
  return aliases[name] || name;
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


