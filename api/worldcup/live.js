const FOOTBALL_DATA_API_BASE = process.env.FOOTBALL_DATA_API_BASE || "https://api.football-data.org/v4";
const FOOTBALL_DATA_API_TOKEN = process.env.FOOTBALL_DATA_API_TOKEN || "";
const FOOTBALL_DATA_COMPETITION = process.env.FOOTBALL_DATA_COMPETITION || "WC";
const FOOTBALL_DATA_SEASON = process.env.FOOTBALL_DATA_SEASON || "2026";

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

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!FOOTBALL_DATA_API_TOKEN) {
    return res.status(200).json({
      configured: false,
      provider: "football-data.org",
      fetchedAt: null,
      fixtures: [],
      liveScores: [],
      message: "Football-data.org live feed is not configured. Set FOOTBALL_DATA_API_TOKEN to enable live scores."
    });
  }

  try {
    const matchesPayload = await fetchFootballDataEndpoint(`/competitions/${encodeURIComponent(FOOTBALL_DATA_COMPETITION)}/matches?season=${encodeURIComponent(FOOTBALL_DATA_SEASON)}`);
    const normalized = normalizeFootballData(matchesPayload);

    return res.status(200).json({
      configured: true,
      provider: "football-data.org",
      fetchedAt: new Date().toISOString(),
      fixtures: normalized.fixtures,
      liveScores: normalized.liveScores
    });
  } catch (error) {
    return res.status(502).json({
      configured: false,
      provider: "football-data.org",
      fetchedAt: null,
      fixtures: [],
      liveScores: [],
      message: "Football-data.org score feed is currently unavailable."
    });
  }
};
