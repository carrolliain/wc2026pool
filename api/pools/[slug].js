const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const STORE_FILE = path.join(process.cwd(), "pools.json");
const ADMIN_PASSWORD = process.env.WORLDCUP_ADMIN_PASSWORD || "worldcup2026";
const TOKEN_SECRET = process.env.WORLDCUP_TOKEN_SECRET || crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex");

function normalizeSlug(slug) {
  return String(slug || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { pools: {} };
    throw error;
  }
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  return payload.exp > Date.now();
}

module.exports = async function handler(req, res) {
  const slug = normalizeSlug(req.query.slug);
  if (!slug) return res.status(400).json({ error: "Pool name required" });

  const store = await readStore();

  if (req.method === "GET") {
    return res.status(200).json({
      slug,
      state: store.pools[slug]?.state || null,
      updatedAt: store.pools[slug]?.updatedAt || null
    });
  }

  if (req.method === "PUT") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!verifyToken(token)) return res.status(401).json({ error: "Admin unlock required" });

    return res.status(501).json({
      error: "Persistent saving is not available on Vercel file storage.",
      message: "Vercel serverless functions cannot reliably save to pools.json. Use a durable store such as Vercel Blob/KV, Upstash, Firebase, Supabase, or deploy this as a persistent Node server."
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
