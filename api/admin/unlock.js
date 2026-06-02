const crypto = require("crypto");

const ADMIN_PASSWORD = process.env.WORLDCUP_ADMIN_PASSWORD || "worldcup2026";
const TOKEN_SECRET = process.env.WORLDCUP_TOKEN_SECRET || crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex");

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.body?.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  return res.status(200).json({
    token: signToken({ role: "admin", exp: Date.now() + 1000 * 60 * 60 * 8 })
  });
};
