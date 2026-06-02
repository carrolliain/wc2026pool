const FREE_API_BASE = process.env.WORLDCUP_FREE_API_BASE || "https://worldcup26.ir";

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
        status: game.status || game.phase || (score ? "UPDATED" : "SCHEDULED"),
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

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [gamesPayload, teamsPayload] = await Promise.all([
      fetchFreeEndpoint("/get/games"),
      fetchFreeEndpoint("/get/teams")
    ]);
    const normalized = normalizeFreeData(gamesPayload, teamsPayload);

    return res.status(200).json({
      configured: true,
      provider: "worldcup26.ir",
      fetchedAt: new Date().toISOString(),
      fixtures: normalized.fixtures,
      liveScores: normalized.liveScores
    });
  } catch (error) {
    return res.status(502).json({
      configured: false,
      provider: "worldcup26.ir",
      fetchedAt: null,
      fixtures: [],
      liveScores: [],
      message: "Free World Cup score feed is currently unavailable."
    });
  }
};
