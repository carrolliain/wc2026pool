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
const FREE_API_BASE = process.env.WORLDCUP_FREE_API_BASE || "https://worldcup26.ir";
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
  if (liveCache.payload && Date.now() - liveCache.fetchedAt < 30000) return liveCache.payload;

  const [gamesPayload, teamsPayload] = await Promise.all([
    fetchFreeEndpoint("/get/games"),
    fetchFreeEndpoint("/get/teams")
  ]);
  const normalized = normalizeFreeData(gamesPayload, teamsPayload);

  liveCache = {
    fetchedAt: Date.now(),
    payload: {
      configured: true,
      provider: "worldcup26.ir",
      fetchedAt: new Date().toISOString(),
      fixtures: normalized.fixtures,
      liveScores: normalized.liveScores
    }
  };
  return liveCache.payload;
}

async function fetchFreeEndpoint(endpoint) {
  const response = await fetch(new URL(endpoint, FREE_API_BASE));
  if (!response.ok) throw new Error(`Free World Cup feed failed: ${response.status}`);
  return response.json();
}

function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.games)) return payload.games;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.teams)) return payload.teams;
  return [];
}

function teamName(team) {
  return team?.name_en || team?.name || team?.team_name || team?.country || "";
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeGameStatus(game, score) {
  const rawStatus = String(game.status || game.phase || game.state || "").toLowerCase();
  const elapsed = String(game.time_elapsed || game.elapsed || game.match_time || "").toLowerCase();
  const finished = String(game.finished ?? game.is_finished ?? game.completed ?? "").toLowerCase();

  if (["true", "1", "yes"].includes(finished) || ["finished", "ft", "fulltime", "full-time"].some(value => rawStatus.includes(value) || elapsed.includes(value))) {
    return "finished";
  }

  if (["notstarted", "not_started", "not started", "scheduled", "pending", "fixture"].some(value => rawStatus.includes(value) || elapsed.includes(value))) {
    return "scheduled";
  }

  if (!score) return "scheduled";
  if (rawStatus || elapsed) return "live";
  return "updated";
}
function normalizeFreeData(gamesPayload, teamsPayload) {
  const teams = unwrapList(teamsPayload);
  const teamById = Object.fromEntries(teams.map(team => [String(team.id || team.team_id), team]));

  const fixtures = unwrapList(gamesPayload);
  const liveScores = fixtures
    .map(game => {
      const homeTeam = teamById[String(game.home_team_id)] || game.home_team || game.home || {};
      const awayTeam = teamById[String(game.away_team_id)] || game.away_team || game.away || {};
      const homeScore = toNumber(game.home_score ?? game.homeScore ?? game.score_home);
      const awayScore = toNumber(game.away_score ?? game.awayScore ?? game.score_away);
      const score = homeScore === null || awayScore === null ? "" : `${homeScore} - ${awayScore}`;

      return {
        id: game.id || game.match_id,
        fixture_id: game.id || game.match_id,
        status: normalizeGameStatus(game, score),
        scheduled: game.local_date || game.date || game.kickoff,
        location: game.stadium?.name_en || game.stadium_name || game.venue || "",
        home: { name: teamName(homeTeam) || game.home_name || game.home_team_name || "" },
        away: { name: teamName(awayTeam) || game.away_name || game.away_team_name || "" },
        scores: { score, ft_score: score }
      };
    })
    .filter(match => match.home.name && match.away.name && match.scores.score);

  return { fixtures, liveScores };
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


