const WORLDCUP_API_KEY = process.env.WORLDCUP_API_KEY || "";
const WORLDCUP_API_BASE = process.env.WORLDCUP_API_BASE || "https://api.worldcupapi.com";

async function fetchWorldCupEndpoint(endpoint) {
  const url = new URL(endpoint, WORLDCUP_API_BASE);
  url.searchParams.set("key", WORLDCUP_API_KEY);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`World Cup API failed: ${response.status}`);
  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!WORLDCUP_API_KEY) {
    return res.status(200).json({
      configured: false,
      fetchedAt: null,
      fixtures: [],
      liveScores: [],
      message: "Set WORLDCUP_API_KEY on the server to enable automatic fixtures and live scores."
    });
  }

  const [fixtures, liveScores] = await Promise.all([
    fetchWorldCupEndpoint("/fixtures"),
    fetchWorldCupEndpoint("/livescores")
  ]);

  return res.status(200).json({
    configured: true,
    fetchedAt: new Date().toISOString(),
    fixtures,
    liveScores
  });
};
