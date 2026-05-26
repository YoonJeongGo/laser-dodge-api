import cors from "cors";
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import pg from "pg";

dotenv.config();

const app = express();
const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
if (!jwtSecret) {
  throw new Error("JWT_SECRET is required");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});
const port = Number(process.env.PORT || 8787);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
const loginSessions = new Map();
const oauthStates = new Map();

app.use(cors());
app.use(express.json({ limit: "64kb" }));

function cleanNickname(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 16);
}

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
}

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

app.post("/users/guest", async (req, res) => {
  const nickname = cleanNickname(req.body.nickname);
  const providerId = String(req.body.provider_id || randomUUID());

  if (nickname.length < 2) {
    return res.status(400).json({ error: "nickname_too_short" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO users (provider, provider_id, nickname)
      VALUES ('guest', $1, $2)
      ON CONFLICT (provider, provider_id)
      DO UPDATE SET nickname = EXCLUDED.nickname
      RETURNING id, provider, provider_id, nickname
      `,
      [providerId, nickname],
    );
    res.json({ user: result.rows[0], token: signAuthToken(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "nickname_taken" });
    }
    throw error;
  }
});

app.get("/auth/check", async (req, res) => {
  const username = cleanUsername(req.query.username);
  const nickname = cleanNickname(req.query.nickname);
  const result = { username_available: null, nickname_available: null };

  if (username) {
    const found = await pool.query("SELECT 1 FROM users WHERE username = $1", [username]);
    result.username_available = found.rowCount === 0;
  }
  if (nickname) {
    const found = await pool.query("SELECT 1 FROM users WHERE nickname = $1", [nickname]);
    result.nickname_available = found.rowCount === 0;
  }

  res.json(result);
});

app.post("/auth/register", async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");
  const nickname = cleanNickname(req.body.nickname);

  if (username.length < 4) {
    return res.status(400).json({ error: "username_too_short" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "password_too_short" });
  }
  if (nickname.length < 2) {
    return res.status(400).json({ error: "nickname_too_short" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO users (provider, provider_id, username, password_hash, nickname)
      VALUES ('password', $1, $1, $2, $3)
      RETURNING id, username, nickname
      `,
      [username, hashPassword(password), nickname],
    );
    res.json({ user: result.rows[0], token: signAuthToken(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      const field = String(error.constraint || "").includes("nickname") ? "nickname_taken" : "username_taken";
      return res.status(409).json({ error: field });
    }
    throw error;
  }
});

app.post("/auth/login", async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");
  const result = await pool.query(
    "SELECT id, username, nickname, password_hash FROM users WHERE username = $1 AND provider = 'password'",
    [username],
  );

  if (result.rowCount === 0 || !verifyPassword(password, result.rows[0].password_hash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const user = result.rows[0];
  const publicUser = { id: user.id, username: user.username, nickname: user.nickname };
  res.json({ user: publicUser, token: signAuthToken(publicUser) });
});

app.get("/auth/me", async (req, res) => {
  const token = bearerToken(req);
  const payload = token ? verifyAuthToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: "invalid_token" });
  }

  const result = await pool.query(
    "SELECT id, username, nickname FROM users WHERE id = $1",
    [payload.sub],
  );
  if (result.rowCount === 0) {
    return res.status(401).json({ error: "invalid_token" });
  }

  res.json({ user: result.rows[0] });
});

app.post("/auth/session", (_req, res) => {
  const sessionId = randomUUID();
  const state = randomUUID();
  loginSessions.set(sessionId, {
    state,
    user: null,
    error: null,
    createdAt: Date.now(),
  });
  oauthStates.set(state, sessionId);

  res.json({
    session_id: sessionId,
    urls: {
      google: buildGoogleAuthUrl(sessionId, state),
      naver: buildNaverAuthUrl(sessionId, state),
      facebook: buildFacebookAuthUrl(sessionId, state),
    },
  });
});

app.get("/auth/session/:sessionId", (req, res) => {
  const session = loginSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "session_not_found" });
  }
  res.json({
    done: Boolean(session.user),
    error: session.error,
    user: session.user,
  });
});

app.get("/auth/:provider/callback", async (req, res) => {
  const provider = req.params.provider;
  const sessionId = oauthStates.get(String(req.query.state || "")) || "";
  const session = loginSessions.get(sessionId);

  if (!session || session.state !== req.query.state) {
    return res.status(400).send(renderAuthResult("로그인 실패", "인증 세션이 올바르지 않습니다."));
  }

  try {
    const code = String(req.query.code || "");
    if (!code) {
      throw new Error("missing_authorization_code");
    }

    const profile = await fetchProviderProfile(provider, code, sessionId);
    const user = await upsertOAuthUser(profile);
    session.user = user;
    res.send(renderAuthResult("로그인 완료", "게임으로 돌아가세요."));
  } catch (error) {
    console.error(error);
    session.error = "oauth_failed";
    res.status(500).send(renderAuthResult("로그인 실패", "다시 시도해 주세요."));
  }
});

app.post("/scores", async (req, res) => {
  const token = bearerToken(req);
  const payload = token ? verifyAuthToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: "invalid_token" });
  }

  const userResult = await pool.query(
    "SELECT id, nickname FROM users WHERE id = $1",
    [payload.sub],
  );
  if (userResult.rowCount === 0) {
    return res.status(401).json({ error: "invalid_token" });
  }

  const user = userResult.rows[0];
  const totalScore = Math.max(0, Number.parseInt(req.body.total_score, 10) || 0);
  const survivalTime = Math.max(0, Number(req.body.survival_time) || 0);
  const pScore = Math.max(0, Number.parseInt(req.body.p_score, 10) || 0);

  if (!isPlausibleScore(totalScore, survivalTime, pScore)) {
    return res.status(400).json({ error: "implausible_score" });
  }

  const inserted = await pool.query(
    `
    INSERT INTO scores (user_id, nickname, total_score, survival_time, p_score)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, total_score, survival_time, p_score, created_at
    `,
    [user.id, user.nickname, totalScore, survivalTime, pScore],
  );

  const rank = await getRank(totalScore, survivalTime);
  res.json({ score: inserted.rows[0], rank });
});

app.get("/leaderboard", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const result = await pool.query(
    `
    WITH best_scores AS (
      SELECT DISTINCT ON (user_id)
             user_id, nickname, total_score, survival_time, p_score, created_at
      FROM scores
      ORDER BY user_id, total_score DESC, survival_time DESC, created_at ASC
    )
    SELECT nickname, total_score, survival_time, p_score, created_at,
           RANK() OVER (ORDER BY total_score DESC, survival_time DESC) AS rank
    FROM best_scores
    ORDER BY total_score DESC, survival_time DESC, created_at ASC
    LIMIT $1
    `,
    [limit],
  );
  res.json({ records: result.rows });
});

app.get("/users/:userId/rank", async (req, res) => {
  const best = await pool.query(
    `
    SELECT total_score, survival_time
    FROM scores
    WHERE user_id = $1
    ORDER BY total_score DESC, survival_time DESC, created_at ASC
    LIMIT 1
    `,
    [req.params.userId],
  );

  if (best.rowCount === 0) {
    return res.json({ rank: null });
  }

  const row = best.rows[0];
  res.json({ rank: await getRank(row.total_score, row.survival_time) });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "server_error" });
});

async function getRank(totalScore, survivalTime) {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int + 1 AS rank
    FROM (
      SELECT DISTINCT ON (user_id) user_id, total_score, survival_time
      FROM scores
      ORDER BY user_id, total_score DESC, survival_time DESC, created_at ASC
    ) best_scores
    WHERE total_score > $1
       OR (total_score = $1 AND survival_time > $2)
    `,
    [totalScore, survivalTime],
  );
  return result.rows[0].rank;
}

function requireOAuthConfig(provider, keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`${provider}_oauth_not_configured:${missing.join(",")}`);
  }
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function signAuthToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(user.id),
    username: String(user.username || ""),
    nickname: String(user.nickname || ""),
    iat: now,
    exp: now + 60 * 60 * 24 * 30,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signJwtParts(encodedHeader, encodedPayload);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyAuthToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = signJwtParts(encodedHeader, encodedPayload);
  if (!timingSafeStringEqual(signature, expected)) return null;

  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    if (header.alg !== "HS256") return null;
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload.sub || Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function signJwtParts(encodedHeader, encodedPayload) {
  return createHmac("sha256", jwtSecret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function callbackUrl(provider) {
  return `${publicBaseUrl}/auth/${provider}/callback`;
}

function buildGoogleAuthUrl(sessionId, state) {
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl("google"),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function buildNaverAuthUrl(sessionId, state) {
  if (!process.env.NAVER_CLIENT_ID) return null;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.NAVER_CLIENT_ID,
    redirect_uri: callbackUrl("naver"),
    state,
  });
  return `https://nid.naver.com/oauth2.0/authorize?${params}`;
}

function buildFacebookAuthUrl(sessionId, state) {
  if (!process.env.FACEBOOK_CLIENT_ID) return null;
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_CLIENT_ID,
    redirect_uri: callbackUrl("facebook"),
    response_type: "code",
    scope: "public_profile,email",
    state,
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}

async function fetchProviderProfile(provider, code, sessionId) {
  if (provider === "google") return fetchGoogleProfile(code, sessionId);
  if (provider === "naver") return fetchNaverProfile(code, sessionId);
  if (provider === "facebook") return fetchFacebookProfile(code, sessionId);
  throw new Error("unsupported_provider");
}

async function fetchGoogleProfile(code, sessionId) {
  requireOAuthConfig("google", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  const token = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: callbackUrl("google"),
    grant_type: "authorization_code",
  });
  const profile = await getJson("https://openidconnect.googleapis.com/v1/userinfo", token.access_token);
  return {
    provider: "google",
    providerId: profile.sub,
    nickname: profile.name || profile.email || "GooglePlayer",
  };
}

async function fetchNaverProfile(code, sessionId) {
  requireOAuthConfig("naver", ["NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"]);
  const token = await postForm("https://nid.naver.com/oauth2.0/token", {
    grant_type: "authorization_code",
    client_id: process.env.NAVER_CLIENT_ID,
    client_secret: process.env.NAVER_CLIENT_SECRET,
    code,
    state: loginSessions.get(sessionId)?.state || "",
  });
  const data = await getJson("https://openapi.naver.com/v1/nid/me", token.access_token);
  const profile = data.response || {};
  return {
    provider: "naver",
    providerId: profile.id,
    nickname: profile.nickname || profile.name || "NaverPlayer",
  };
}

async function fetchFacebookProfile(code, sessionId) {
  requireOAuthConfig("facebook", ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"]);
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_CLIENT_ID,
    client_secret: process.env.FACEBOOK_CLIENT_SECRET,
    redirect_uri: callbackUrl("facebook"),
    code,
  });
  const token = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${params}`).then((res) => res.json());
  const profile = await getJson("https://graph.facebook.com/me?fields=id,name,email", token.access_token);
  return {
    provider: "facebook",
    providerId: profile.id,
    nickname: profile.name || profile.email || "FacebookPlayer",
  };
}

async function postForm(url, values) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function upsertOAuthUser(profile) {
  const nickname = await reserveNickname(cleanNickname(profile.nickname || "Player"), profile.provider, profile.providerId);
  const result = await pool.query(
    `
    INSERT INTO users (provider, provider_id, nickname)
    VALUES ($1, $2, $3)
    ON CONFLICT (provider, provider_id)
    DO UPDATE SET nickname = users.nickname
    RETURNING id, provider, provider_id, nickname
    `,
    [profile.provider, profile.providerId, nickname],
  );
  return result.rows[0];
}

async function reserveNickname(baseNickname, provider, providerId) {
  const base = cleanNickname(baseNickname).slice(0, 12) || "Player";
  const existing = await pool.query(
    "SELECT nickname FROM users WHERE provider = $1 AND provider_id = $2",
    [provider, providerId],
  );
  if (existing.rowCount > 0) return existing.rows[0].nickname;

  for (let i = 0; i < 20; i += 1) {
    const nickname = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    const taken = await pool.query("SELECT 1 FROM users WHERE nickname = $1", [nickname]);
    if (taken.rowCount === 0) return nickname;
  }
  return `${base}${Date.now().toString().slice(-5)}`;
}

function renderAuthResult(title, message) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;background:#071018;color:white;display:grid;place-items:center;min-height:100vh"><main style="text-align:center"><h1>${title}</h1><p>${message}</p></main></body>`;
}

function isPlausibleScore(totalScore, survivalTime, pScore) {
  const expectedTotal = Math.floor(survivalTime * 10) + pScore;
  const maxPScore = Math.ceil(survivalTime / 1.0) * 100 + 300;
  return (
    survivalTime >= 0 &&
    survivalTime < 60 * 60 &&
    pScore >= 0 &&
    pScore % 100 === 0 &&
    pScore <= maxPScore &&
    Math.abs(totalScore - expectedTotal) <= 5
  );
}

async function ensureSchema() {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL DEFAULT 'guest',
      provider_id TEXT NOT NULL,
      username TEXT UNIQUE,
      password_hash TEXT,
      nickname TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      total_score INTEGER NOT NULL,
      survival_time REAL NOT NULL,
      p_score INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS scores_rank_idx
    ON scores (total_score DESC, survival_time DESC, created_at ASC)
  `);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT");
}

await ensureSchema();

app.listen(port, "0.0.0.0", () => {
  console.log(`Laser Dodge API listening on http://0.0.0.0:${port}`);
});
