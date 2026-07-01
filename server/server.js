import cors from "cors";
import { createHmac, createPublicKey, randomBytes, randomUUID, scryptSync, timingSafeEqual, verify as verifySignature } from "node:crypto";
import dotenv from "dotenv";
import express from "express";
import http from "node:http";
import pg from "pg";
import { Server as SocketIOServer } from "socket.io";
import { attachZombieMultiplayer } from "./src/socket/index.js";

dotenv.config();

const app = express();
const httpServer = http.createServer(app);
const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET || jwtSecret;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!jwtSecret) throw new Error("JWT_SECRET is required");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10_000),
  query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 15_000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15_000),
});
const port = Number(process.env.PORT || 8787);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
const appVersion = process.env.APP_VERSION || "1.0.0";
const serverCommit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.COMMIT_SHA || "local";
const serverBuildId = process.env.RENDER_SERVICE_ID || process.env.BUILD_ID || "local";
const multiplayerProtocol = "br-trace-v2";
const appStartedAt = Date.now();
const corsOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 120);
const schemaRetryMs = Number(process.env.SCHEMA_RETRY_MS || 30_000);
const rateLimitBuckets = new Map();
const loginSessions = new Map();
const oauthStates = new Map();
const admobSsvKeyUrl = "https://gstatic.com/admob/reward/verifier-keys.json";
let admobSsvKeysCache = { expiresAt: 0, keys: new Map() };
let schemaReady = false;
let schemaInitializing = false;
let schemaLastError = "";
let schemaLastAttemptAt = 0;
let schemaReadyAt = 0;
const devRewardVerificationEnabled =
  process.env.ENABLE_DEV_AD_REWARD_VERIFY === "1" ||
  process.env.NODE_ENV === "development" ||
  process.env.NODE_ENV === "test";

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (corsOrigins.length === 0) return callback(null, true);
    if (!origin || corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("cors_origin_denied"));
  },
}));
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  const now = Date.now();
  const key = `${req.ip}:${req.path}`;
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + rateLimitWindowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + rateLimitWindowMs;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (bucket.count > rateLimitMax) {
    return res.status(429).json({ error: "rate_limited", retry_after_ms: bucket.resetAt - now });
  }
  next();
});

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: corsOrigins.length === 0 ? true : corsOrigins,
    methods: ["GET", "POST"],
  },
});
const onlineUserIds = new Set();
const realtimeRooms = new Map();

// ─── Static Definitions ───────────────────────────────────────────────────────

const ACHIEVEMENTS = [
  // 생존 - 최고기록
  { id: "survive_10",   name: "첫 생존",      reward: 10,  check: s => s.best_survival_time >= 10 },
  { id: "survive_30",   name: "30초의 벽",     reward: 20,  check: s => s.best_survival_time >= 30 },
  { id: "survive_60",   name: "1분 클럽",      reward: 50,  check: s => s.best_survival_time >= 60 },
  { id: "survive_120",  name: "2분의 벽",      reward: 80,  check: s => s.best_survival_time >= 120 },
  { id: "survive_180",  name: "3분의 전설",    reward: 150, check: s => s.best_survival_time >= 180 },
  { id: "survive_300",  name: "5분의 신화",    reward: 250, check: s => s.best_survival_time >= 300 },
  { id: "survive_600",  name: "불멸자",        reward: 500, check: s => s.best_survival_time >= 600 },
  // 생존 - 누적
  { id: "total_survive_300",   name: "총 생존 5분",    reward: 30,  check: s => s.total_survival_time >= 300 },
  { id: "total_survive_3600",  name: "총 생존 1시간",  reward: 80,  check: s => s.total_survival_time >= 3600 },
  { id: "total_survive_36000", name: "총 생존 10시간", reward: 200, check: s => s.total_survival_time >= 36000 },
  { id: "total_survive_360000",name: "총 생존 100시간",reward: 600, check: s => s.total_survival_time >= 360000 },
  // 플레이 횟수
  { id: "play_1",    name: "첫 도전",  reward: 10,  check: s => s.total_plays >= 1 },
  { id: "play_10",   name: "입문자",   reward: 20,  check: s => s.total_plays >= 10 },
  { id: "play_50",   name: "단골",     reward: 40,  check: s => s.total_plays >= 50 },
  { id: "play_100",  name: "중독자",   reward: 80,  check: s => s.total_plays >= 100 },
  { id: "play_300",  name: "전사",     reward: 150, check: s => s.total_plays >= 300 },
  { id: "play_1000", name: "광전사",   reward: 300, check: s => s.total_plays >= 1000 },
  { id: "play_5000", name: "전설의 전사", reward: 800, check: s => s.total_plays >= 5000 },
  // P포인트
  { id: "p_first",        name: "첫 P포인트",     reward: 10,  check: s => s.total_p_points >= 1 },
  { id: "p_total_100",    name: "누적 P 100개",   reward: 20,  check: s => s.total_p_points >= 100 },
  { id: "p_total_500",    name: "누적 P 500개",   reward: 50,  check: s => s.total_p_points >= 500 },
  { id: "p_total_2000",   name: "누적 P 2,000개", reward: 120, check: s => s.total_p_points >= 2000 },
  { id: "p_total_10000",  name: "누적 P 10,000개",reward: 400, check: s => s.total_p_points >= 10000 },
  // 방어막
  { id: "s_first",          name: "첫 S포인트",       reward: 10,  check: s => s.total_s_points >= 1 },
  { id: "shield_first",     name: "방어막 첫 발동",   reward: 10,  check: s => s.total_shield_activations >= 1 },
  { id: "shield_block_1",   name: "방어막 첫 무효화", reward: 15,  check: s => s.total_shield_blocks >= 1 },
  { id: "shield_block_10",  name: "철벽",             reward: 40,  check: s => s.total_shield_blocks >= 10 },
  { id: "shield_block_100", name: "난공불락",          reward: 120, check: s => s.total_shield_blocks >= 100 },
  { id: "shield_block_500", name: "영원한 방패",       reward: 350, check: s => s.total_shield_blocks >= 500 },
  // 콤보
  { id: "combo_x2", name: "콤보 입문", reward: 10,  check: s => s.best_combo >= 2 },
  { id: "combo_x3", name: "콤보 중급", reward: 20,  check: s => s.best_combo >= 3 },
  { id: "combo_x4", name: "콤보 고수", reward: 60,  check: s => s.best_combo >= 4 },
  { id: "combo_x5", name: "콤보 마스터", reward: 150, check: s => s.best_combo >= 5 },
  // 출석
  { id: "attendance_1",   name: "첫 출석",     reward: 10,  check: s => s.attendance_total >= 1 },
  { id: "attendance_3",   name: "3일 연속",    reward: 30,  check: s => s.attendance_streak >= 3 },
  { id: "attendance_7",   name: "7일 연속",    reward: 80,  check: s => s.attendance_streak >= 7 },
  { id: "attendance_14",  name: "2주 연속",    reward: 120, check: s => s.attendance_streak >= 14 },
  { id: "attendance_30",  name: "한 달 개근",  reward: 250, check: s => s.attendance_streak >= 30 },
  { id: "attendance_100", name: "100일의 전사",reward: 600, check: s => s.attendance_streak >= 100 },
  // 특수
  { id: "rank_submit",     name: "랭킹 진입",       reward: 20,  check: s => s.total_plays >= 1 },
  { id: "best_break_10",   name: "신기록 사냥꾼",   reward: 120, check: s => s.best_breaks >= 10 },
  { id: "best_break_50",   name: "신기록 장인",     reward: 300, check: s => s.best_breaks >= 50 },
  // 히든
  { id: "fast_death", name: "1초 사망", reward: 20, check: s => s.last_survival_time > 0 && s.last_survival_time <= 1 },
];

const DAILY_QUESTS = [
  { id: "daily_play_1",      name: "오늘 첫 판",     desc: "오늘 1판 플레이",       reward: 10, stat: "today_plays",         target: 1 },
  { id: "daily_play_10",     name: "열전사",          desc: "하루 10판 플레이",      reward: 30, stat: "today_plays",         target: 10 },
  { id: "daily_survive_30",  name: "오늘의 생존",     desc: "오늘 30초 이상 생존",   reward: 20, stat: "today_best_survival",  target: 30 },
  { id: "daily_p_20",        name: "P포인트 수집가",  desc: "오늘 P포인트 20개 획득",reward: 20, stat: "today_p_points",       target: 20 },
  { id: "daily_deaths_20",   name: "칠전팔기",        desc: "하루에 20번 사망",      reward: 30, stat: "today_deaths",         target: 20 },
];

const SHOP_ITEMS = {
  "skin_default":    { category: "skin",       name: "스카우트 유닛", desc: "처음부터 지급",          icon: "", price: 0 },
  "skin_ice":        { category: "skin",       name: "프로스트 셔틀", desc: "차가운 결정형 바디",     icon: "", price: 1500 },
  "skin_fire":       { category: "skin",       name: "블레이즈 팟",   desc: "추진 바디",              icon: "", price: 1500, badge: "HOT" },
  "skin_cyber":      { category: "skin",       name: "네온 링",       desc: "네온 링 유닛",           icon: "", price: 4000, badge: "NEW" },
  "skin_star":       { category: "skin",       name: "스타 윙",       desc: "별빛 윙 바디",           icon: "", price: 15000, badge: "SEASON" },
  "skin_drone":      { category: "skin",       name: "네온 드론",     desc: "작은 전투 드론 실루엣",   icon: "▰", price: 5200, badge: "NEW" },
  "skin_capsule":    { category: "skin",       name: "마그넷 캡슐",   desc: "떠 있는 캡슐 바디",       icon: "▮", price: 5200 },
  "skin_raptor":     { category: "skin",       name: "랩터 코어",     desc: "날개 달린 공격형 코어",   icon: "◆", price: 6200, badge: "RARE" },
  "skin_satellite":  { category: "skin",       name: "위성 유닛",     desc: "위성이 도는 탐사용 유닛", icon: "◌", price: 6200 },
  "trail_none":      { category: "trail",      name: "없음",          desc: "기본",                   icon: "-", price: 0 },
  "trail_wind":      { category: "trail",      name: "바람 흔적",     desc: "반투명 연기 잔상",       icon: "~", price: 800 },
  "trail_lightning": { category: "trail",      name: "번개 궤적",     desc: "전기 스파크",            icon: "⚡", price: 2500, badge: "HOT" },
  "trail_rainbow":   { category: "trail",      name: "레인보우",      desc: "무지개 흔적",            icon: "◇", price: 2500 },
  "death_default":   { category: "death",      name: "기본 폭발",     desc: "기본 제공",              icon: "✹", price: 0 },
  "death_blackhole": { category: "death",      name: "블랙홀 소멸",   desc: "빨려드는 흡수 연출",     icon: "●", price: 2500, badge: "HOT" },
  "death_crystal":   { category: "death",      name: "결정화",        desc: "얼음 결정으로 산산조각", icon: "❄", price: 2500 },
  "death_pixel":     { category: "death",      name: "픽셀 분해",     desc: "레트로 픽셀 분해",       icon: "■", price: 4000, badge: "NEW" },
  "shield_default":  { category: "shield",     name: "기본 링",       desc: "파란 원형 링",           icon: "○", price: 0 },
  "shield_hex":      { category: "shield",     name: "육각 방어막",   desc: "육각형 보호막",          icon: "⬡", price: 1500, badge: "NEW" },
  "shield_fire":     { category: "shield",     name: "불꽃 방어막",   desc: "불꽃 보호막",            icon: "△", price: 2500 },
  "shield_sakura":   { category: "shield",     name: "벚꽃 방어막",   desc: "꽃잎 회전 보호막",       icon: "✿", price: 4000 },
  "bg_void":         { category: "background", name: "다크 보이드",   desc: "기본 제공",              icon: "◆", price: 0 },
  "bg_ocean":        { category: "background", name: "딥 오션",       desc: "수중 물결 배경",         icon: "≈", price: 2000 },
  "bg_forest":       { category: "background", name: "다크 포레스트", desc: "녹색 입자 배경",         icon: "▲", price: 2000 },
  "bg_galaxy":       { category: "background", name: "갤럭시",        desc: "성운 배경 테마",         icon: "✦", price: 2000, badge: "SALE" },
};

const SHOP_BUNDLES = {
  "bundle_starter": {
    name: "스타터 팩", desc: "프로스트 셔틀 + 바람 흔적 + 육각 방어막",
    price: 3000, was: 3800, item_ids: ["skin_ice", "trail_wind", "shield_hex"], tag: "21% 할인",
  },
  "bundle_fire": {
    name: "파이어 패키지", desc: "블레이즈 팟 + 번개 궤적 + 불꽃 방어막",
    price: 5000, was: 6500, item_ids: ["skin_fire", "trail_lightning", "shield_fire"], tag: "23% 할인",
  },
  "bundle_master": {
    name: "프리미엄 번들", desc: "사이버 링 + 레인보우 + 블랙홀 + 벚꽃 방어막 + 갤럭시",
    price: 10000, was: 15000, item_ids: ["skin_cyber", "trail_rainbow", "death_blackhole", "shield_sakura", "bg_galaxy"], tag: "PREMIUM",
  },
};

const DEFAULT_OWNED = ["skin_default", "trail_none", "death_default", "shield_default", "bg_void"];
const DEFAULT_EQUIPPED = { skin: "skin_default", trail: "trail_none", death: "death_default", shield: "shield_default", background: "bg_void" };
const ATTENDANCE_BASE_COINS = 20;
const ATTENDANCE_WEEKLY_BONUS_COINS = 50;
const ADMIN_USERNAMES = String(process.env.ADMIN_USERNAMES || "admin").split(",").map((item) => item.trim()).filter(Boolean);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanNickname(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 16);
}
function cleanUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}
function cleanModeId(value) {
  const mode = String(value || "classic").trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
  return mode || "classic";
}
function cleanRankingScope(value) {
  return String(value || "world").trim().toLowerCase() === "friends" ? "friends" : "world";
}
function cleanShortText(value, maxLength = 160) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}
function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function cleanInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
function cleanBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}
function cleanTextArray(value, maxItems = 24, maxLength = 40) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map(v => cleanShortText(v, maxLength)).filter(Boolean);
}
function normalizeModeData(mode, body = {}) {
  const raw = body.mode_data && typeof body.mode_data === "object" && !Array.isArray(body.mode_data)
    ? body.mode_data
    : {};
  const common = {
    death_reason: cleanShortText(raw.death_reason || body.death_reason, 120),
    mode_score_bonus: Math.max(0, cleanInt(body.mode_score_bonus, 0)),
    coins_earned: Math.max(0, cleanInt(raw.coins_earned ?? body.coins_earned, 0)),
  };
  if (mode === "air_raid") {
    return {
      ...common,
      survived_seconds: Math.max(0, cleanNumber(raw.survived_seconds ?? body.mode_metric_primary, 0)),
      shots_fired: Math.max(0, cleanInt(raw.shots_fired ?? body.mode_metric_secondary, 0)),
      p_count: Math.max(0, cleanInt(raw.p_count ?? body.p_count, 0)),
      survival_bonus: Math.max(0, cleanInt(raw.survival_bonus ?? body.mode_score_bonus, 0)),
    };
  }
  if (mode === "tag") {
    return {
      ...common,
      catches: Math.max(0, cleanInt(raw.catches ?? body.mode_metric_secondary, 0)),
      survived_as_runner: Math.max(0, cleanNumber(raw.survived_as_runner ?? body.mode_metric_primary, 0)),
    };
  }
  if (mode === "zombie") {
    return {
      ...common,
      infection_time: Math.max(0, cleanNumber(raw.infection_time ?? body.mode_metric_primary, 0)),
      infected_count: Math.max(0, cleanInt(raw.infected_count ?? body.mode_metric_secondary, 0)),
    };
  }
  return {
    ...common,
    p_count: Math.max(0, cleanInt(body.p_count, 0)),
    s_count: Math.max(0, cleanInt(body.s_count, 0)),
    shield_blocks: Math.max(0, cleanInt(body.shield_blocks, 0)),
    shield_activations: Math.max(0, cleanInt(body.shield_activations, 0)),
    max_combo: Math.max(0, cleanInt(body.max_combo, 0)),
    used_revival: cleanBool(body.used_revival),
    was_best: cleanBool(body.was_best),
  };
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function requireAuth(req, res) {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: "missing_token" }); return null; }
  const payload = verifyAuthToken(token);
  if (!payload) { res.status(401).json({ error: "invalid_token" }); return null; }
  return payload;
}

async function requireAdmin(req, res) {
  const configuredSecret = process.env.ADMIN_SECRET || "";
  const providedSecret = String(req.headers["x-admin-secret"] || "");
  const payload = bearerToken(req) ? verifyAuthToken(bearerToken(req)) : null;
  if (configuredSecret && timingSafeStringEqual(providedSecret, configuredSecret)) {
    return payload || { sub: null, username: "admin_secret" };
  }
  if (!payload) {
    res.status(401).json({ error: "missing_admin_auth" });
    return null;
  }
  const result = await pool.query("SELECT username FROM users WHERE id = $1", [payload.sub]);
  const username = String(result.rows[0]?.username || payload.username || "");
  if (!ADMIN_USERNAMES.includes(username)) {
    res.status(403).json({ error: "admin_required" });
    return null;
  }
  return payload;
}

async function addCoins(userId, amount, reason, refId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2",
      [amount, userId],
    );
    await client.query(
      "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, $3, $4)",
      [userId, amount, reason, refId],
    );
    const r = await client.query("SELECT coin_balance FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT");
    return r.rows[0].coin_balance;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
function makeRoomCode() {
  return randomBytes(4).toString("hex").toUpperCase().replace(/[^A-F0-9]/g, "").slice(0, 6);
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: "Laser Dodge API",
    ok: true,
    health: "/health",
    version: appVersion,
    server_version: appVersion,
    commit: serverCommit,
    started_at: new Date(appStartedAt).toISOString(),
    multiplayer_protocol: multiplayerProtocol,
    schema_ready: schemaReady,
  });
});

app.get("/version", (_req, res) => {
  res.json({
    ok: true,
    version: appVersion,
    server_version: appVersion,
    commit: serverCommit,
    gitCommit: serverCommit,
    build_id: serverBuildId,
    started_at: new Date(appStartedAt).toISOString(),
    serverStartedAt: new Date(appStartedAt).toISOString(),
    runtimeVersion: process.version,
    multiplayer_protocol: multiplayerProtocol,
    schema_ready: schemaReady,
    schema_last_error: schemaReady ? "" : schemaLastError,
  });
});

app.get("/health", async (_req, res) => {
  if (!schemaReady) {
    return res.status(503).json({
      ok: false,
      server: "ok",
      db: schemaLastError ? "error" : "initializing",
      schema_ready: false,
      schema_initializing: schemaInitializing,
      schema_last_error: schemaLastError,
      schema_last_attempt_at: schemaLastAttemptAt ? new Date(schemaLastAttemptAt).toISOString() : "",
      version: appVersion,
      server_version: appVersion,
      commit: serverCommit,
      build_id: serverBuildId,
      started_at: new Date(appStartedAt).toISOString(),
      multiplayer_protocol: multiplayerProtocol,
      uptime: Math.floor((Date.now() - appStartedAt) / 1000),
    });
  }
  await pool.query("SELECT 1");
  res.json({
    ok: true,
    server: "ok",
    db: "ok",
    schema_ready: true,
    version: appVersion,
    server_version: appVersion,
    commit: serverCommit,
    build_id: serverBuildId,
    started_at: new Date(appStartedAt).toISOString(),
    schema_ready_at: schemaReadyAt ? new Date(schemaReadyAt).toISOString() : "",
    multiplayer_protocol: multiplayerProtocol,
    uptime: Math.floor((Date.now() - appStartedAt) / 1000),
  });
});

app.get("/app/status", async (_req, res) => {
  const maintenance = await pool.query(
    "SELECT maintenance, message FROM maintenance_status ORDER BY updated_at DESC LIMIT 1",
  );
  const version = await pool.query(
    "SELECT min_supported_version, latest_version, force_update, notes FROM app_versions WHERE platform = 'android' ORDER BY created_at DESC LIMIT 1",
  );
  const maintenanceRow = maintenance.rows[0] || {};
  const versionRow = version.rows[0] || {};
  res.json({
    maintenance: Boolean(maintenanceRow.maintenance),
    message: maintenanceRow.message || "",
    min_supported_version: Number(versionRow.min_supported_version || 1),
    latest_version: Number(versionRow.latest_version || 1),
    force_update: Boolean(versionRow.force_update),
    notes: versionRow.notes || "",
  });
});

app.post("/client/error", async (req, res) => {
  const payload = bearerToken(req) ? verifyAuthToken(bearerToken(req)) : null;
  await recordErrorLog({
    userId: payload?.sub || null,
    level: cleanShortText(req.body.level || "error", 20),
    source: "client",
    message: cleanShortText(req.body.message || "client_error", 500),
    details: req.body.details && typeof req.body.details === "object" ? req.body.details : {},
    requestId: req.requestId,
  });
  res.json({ ok: true });
});

app.get("/account-deletion", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laser Dodge 계정 및 데이터 삭제</title>
<body style="font-family:system-ui,sans-serif;line-height:1.6;max-width:720px;margin:40px auto;padding:0 20px">
<h1>Laser Dodge 계정 및 데이터 삭제</h1>
<p>앱에서 로그인한 뒤 설정 화면의 회원탈퇴를 누르면 계정과 관련 데이터 삭제를 요청할 수 있습니다.</p>
<p>앱을 사용할 수 없는 경우 <a href="mailto:rkdduf44@naver.com">rkdduf44@naver.com</a>으로 닉네임, 로그인 방식, 삭제 요청 내용을 보내 주세요.</p>
<p>삭제 대상: 계정, 닉네임, 랭킹/점수, 코인, 상점/장착 정보, 친구 관계, 멀티플레이 결과. 법령상 보관이 필요한 항목은 필요한 기간 동안 보관될 수 있습니다.</p>
</body></html>`);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post("/users/guest", async (req, res) => {
  const nickname = cleanNickname(req.body.nickname);
  const providerId = String(req.body.provider_id || randomUUID());
  if (nickname.length < 2) return res.status(400).json({ error: "nickname_too_short" });
  try {
    const result = await pool.query(
      `INSERT INTO users (provider, provider_id, nickname)
       VALUES ('guest', $1, $2)
       ON CONFLICT (provider, provider_id)
       DO UPDATE SET nickname = EXCLUDED.nickname
       RETURNING id, provider, provider_id, nickname, coin_balance`,
      [providerId, nickname],
    );
    const user = result.rows[0];
    await ensureUserGameStats(user.id);
    await ensureUserEquipped(user.id);
    res.json(await issueAuthResponse(user, req));
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "nickname_taken" });
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
  if (username.length < 4) return res.status(400).json({ error: "username_too_short" });
  if (password.length < 6) return res.status(400).json({ error: "password_too_short" });
  if (nickname.length < 2) return res.status(400).json({ error: "nickname_too_short" });
  if (!cleanBool(req.body.terms_accepted) || !cleanBool(req.body.privacy_accepted)) {
    return res.status(400).json({ error: "required_terms_missing" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (provider, provider_id, username, password_hash, nickname)
       VALUES ('password', $1, $1, $2, $3)
       RETURNING id, username, nickname, coin_balance`,
      [username, hashPassword(password), nickname],
    );
    const user = result.rows[0];
    await ensureUserGameStats(user.id);
    await ensureUserEquipped(user.id);
    await pool.query(
      `INSERT INTO user_profiles (user_id, display_name, marketing_opt_in)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, marketing_opt_in = EXCLUDED.marketing_opt_in, updated_at = now()`,
      [user.id, nickname, cleanBool(req.body.marketing_opt_in)],
    );
    res.json(await issueAuthResponse(user, req));
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
    "SELECT id, username, nickname, password_hash, coin_balance FROM users WHERE username = $1 AND provider = 'password'",
    [username],
  );
  if (result.rowCount === 0 || !verifyPassword(password, result.rows[0].password_hash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const user = result.rows[0];
  const publicUser = { id: user.id, username: user.username, nickname: user.nickname, coin_balance: user.coin_balance };
  res.json(await issueAuthResponse(publicUser, req));
});

app.post("/auth/refresh", async (req, res) => {
  const refreshToken = String(req.body.refresh_token || "").trim();
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return res.status(401).json({ error: "invalid_refresh_token" });
  const tokenHash = hashRefreshToken(refreshToken);
  const session = await pool.query(
    `SELECT rt.user_id, u.username, u.nickname, u.coin_balance
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
    [tokenHash],
  );
  if (session.rowCount === 0) return res.status(401).json({ error: "invalid_refresh_token" });
  const user = session.rows[0];
  const publicUser = { id: user.user_id, username: user.username, nickname: user.nickname, coin_balance: user.coin_balance };
  res.json({ user: publicUser, token: signAuthToken(publicUser), refresh_token: refreshToken });
});

app.post("/auth/logout", async (req, res) => {
  const refreshToken = String(req.body.refresh_token || "").trim();
  if (refreshToken) {
    await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [hashRefreshToken(refreshToken)]);
  }
  res.json({ logged_out: true });
});

app.get("/auth/me", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const result = await pool.query(
    "SELECT id, username, nickname, coin_balance FROM users WHERE id = $1",
    [payload.sub],
  );
  if (result.rowCount === 0) return res.status(401).json({ error: "invalid_token" });
  res.json({ user: result.rows[0] });
});

app.delete("/auth/me", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM users WHERE id = $1", [payload.sub]);
    await client.query("COMMIT");
    res.json({ deleted: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/auth/session", (_req, res) => {
  const sessionId = randomUUID();
  const state = randomUUID();
  loginSessions.set(sessionId, { state, user: null, error: null, createdAt: Date.now() });
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
  if (!session) return res.status(404).json({ error: "session_not_found" });
  res.json({ done: Boolean(session.user), error: session.error, user: session.user });
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
    if (!code) throw new Error("missing_authorization_code");
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

// ─── Scores (existing + extended) ────────────────────────────────────────────

app.post("/scores", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const userResult = await pool.query(
    "SELECT id, nickname FROM users WHERE id = $1",
    [payload.sub],
  );
  if (userResult.rowCount === 0) return res.status(401).json({ error: "invalid_token" });
  const user = userResult.rows[0];

  const totalScore = Math.max(0, Number.parseInt(req.body.total_score, 10) || 0);
  const survivalTime = Math.max(0, Number(req.body.survival_time) || 0);
  const pScore = Math.max(0, Number.parseInt(req.body.p_score, 10) || 0);
  const mode = cleanModeId(req.body.mode);
  const modeScoreBonus = Math.max(0, Number.parseInt(req.body.mode_score_bonus, 10) || 0);

  if (!isPlausibleScore(totalScore, survivalTime, pScore, modeScoreBonus)) {
    return res.status(400).json({ error: "implausible_score" });
  }

  // Extended session stats (optional, default 0)
  const pCount = Math.max(0, Number.parseInt(req.body.p_count, 10) || Math.floor(pScore / 100));
  const sCount = Math.max(0, Number.parseInt(req.body.s_count, 10) || 0);
  const shieldBlocks = Math.max(0, Number.parseInt(req.body.shield_blocks, 10) || 0);
  const shieldActivations = Math.max(0, Number.parseInt(req.body.shield_activations, 10) || 0);
  const maxCombo = Math.max(0, Number.parseInt(req.body.max_combo, 10) || 0);
  const usedRevival = Boolean(req.body.used_revival);
  const wasBest = Boolean(req.body.was_best);
  const metricPrimary = Math.max(0, Number(req.body.mode_metric_primary) || 0);
  const metricSecondary = Math.max(0, Number.parseInt(req.body.mode_metric_secondary, 10) || 0);
  const modeData = normalizeModeData(mode, req.body);
  const sessionCoinsEarned = Math.min(2000, Math.max(0, cleanInt(modeData.coins_earned, 0)));
  modeData.coins_earned = sessionCoinsEarned;

  const inserted = await pool.query(
    `INSERT INTO scores (user_id, nickname, total_score, survival_time, p_score, mode, mode_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, total_score, survival_time, p_score, mode, mode_data, created_at`,
    [user.id, user.nickname, totalScore, survivalTime, pScore, mode, modeData],
  );
  const modeScore = await pool.query(
    `INSERT INTO mode_scores (mode, user_id, nickname, total_score, survival_time, p_score, metric_primary, metric_secondary, mode_data, source_score_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source_score_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       nickname = EXCLUDED.nickname,
       total_score = EXCLUDED.total_score,
       survival_time = EXCLUDED.survival_time,
       p_score = EXCLUDED.p_score,
       metric_primary = EXCLUDED.metric_primary,
       metric_secondary = EXCLUDED.metric_secondary,
       mode_data = EXCLUDED.mode_data
     RETURNING id, mode, total_score, survival_time, p_score, metric_primary, metric_secondary, mode_data, created_at`,
    [mode, user.id, user.nickname, totalScore, survivalTime, pScore, metricPrimary, metricSecondary, modeData, inserted.rows[0].id],
  );
  const rank = await getRank(totalScore, survivalTime, mode);

  // Update game stats and check achievements
  const { newlyUnlocked, updatedDailyQuests } = await updateGameStats(user.id, {
    survivalTime, pCount, sCount, shieldBlocks, shieldActivations,
    maxCombo, usedRevival, wasBest, wasRevived: usedRevival,
  });
  const coinBalance = sessionCoinsEarned > 0
    ? await addCoins(user.id, sessionCoinsEarned, "game_pickup", String(inserted.rows[0].id))
    : (await pool.query("SELECT coin_balance FROM users WHERE id = $1", [user.id])).rows[0].coin_balance;

  res.json({
    score: inserted.rows[0],
    mode_score: modeScore.rows[0],
    rank,
    coins_awarded: sessionCoinsEarned,
    coin_balance: coinBalance,
    achievements_unlocked: newlyUnlocked,
    daily_quests_updated: updatedDailyQuests,
  });
});

app.get("/leaderboard", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const mode = cleanModeId(req.query.mode);
  const scope = cleanRankingScope(req.query.scope);
  const payload = scope === "friends" ? requireAuth(req, res) : null;
  if (scope === "friends" && !payload) return;
  const friendJoin = scope === "friends"
    ? `WHERE best_scores.user_id = $2
       OR EXISTS (
         SELECT 1 FROM friendships f
         WHERE f.status = 'accepted'
           AND ((f.user_id = $2 AND f.friend_id = best_scores.user_id)
             OR (f.friend_id = $2 AND f.user_id = best_scores.user_id))
       )`
    : "";
  const params = scope === "friends" ? [limit, payload.sub, mode] : [limit, mode];
  const modeParamIndex = scope === "friends" ? 3 : 2;
  const result = await pool.query(
    `WITH best_scores AS (
       SELECT DISTINCT ON (user_id)
              user_id, nickname, total_score, survival_time, p_score, metric_primary, metric_secondary, mode_data, created_at
       FROM mode_scores
       WHERE mode = $${modeParamIndex}
       ORDER BY user_id, total_score DESC, survival_time DESC, created_at ASC
     )
     SELECT nickname, total_score, survival_time, p_score, metric_primary, metric_secondary, mode_data, created_at,
            RANK() OVER (ORDER BY total_score DESC, survival_time DESC) AS rank
     FROM best_scores
     ${friendJoin}
     ORDER BY total_score DESC, survival_time DESC, created_at ASC
     LIMIT $1`,
    params,
  );
  res.json({ records: result.rows, mode, scope });
});

app.get("/scores/me/best", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const mode = cleanModeId(req.query.mode);
  const best = await getUserBestScore(payload.sub, mode);
  if (!best) return res.json({ record: null, rank: null });
  res.json({ record: best, rank: await getRank(best.total_score, best.survival_time, mode) });
});

app.get("/users/:userId/rank", async (req, res) => {
  const mode = cleanModeId(req.query.mode);
  const best = await getUserBestScore(req.params.userId, mode);
  if (!best) return res.json({ rank: null });
  res.json({ rank: await getRank(best.total_score, best.survival_time, mode), record: best });
});

// ─── Friends ──────────────────────────────────────────────────────────────────

app.post("/friends/request/:username", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const username = cleanUsername(req.params.username);
  const friend = await pool.query(
    "SELECT id, username, nickname FROM users WHERE username = $1 OR nickname = $2",
    [username, cleanNickname(req.params.username)],
  );
  if (friend.rowCount === 0) return res.status(404).json({ error: "user_not_found" });
  if (friend.rows[0].id === payload.sub) return res.status(400).json({ error: "cannot_add_self" });
  const reverse = await pool.query(
    "SELECT status FROM friendships WHERE user_id = $1 AND friend_id = $2",
    [friend.rows[0].id, payload.sub],
  );
  if (reverse.rowCount > 0 && reverse.rows[0].status === "pending") {
    await pool.query(
      "UPDATE friendships SET status = 'accepted', updated_at = now() WHERE user_id = $1 AND friend_id = $2",
      [friend.rows[0].id, payload.sub],
    );
    await pool.query(
      `INSERT INTO friendships (user_id, friend_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted', updated_at = now()`,
      [payload.sub, friend.rows[0].id],
    );
    return res.json({ requested: false, accepted: true, friend: friend.rows[0] });
  }
  await pool.query(
    `INSERT INTO friendships (user_id, friend_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (user_id, friend_id) DO UPDATE SET status = friendships.status, updated_at = now()`,
    [payload.sub, friend.rows[0].id],
  );
  res.json({ requested: true, friend: friend.rows[0] });
});

app.post("/friends/accept/:userId", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const requesterId = String(req.params.userId || "");
  const result = await pool.query(
    `UPDATE friendships SET status = 'accepted'
     WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'
     RETURNING user_id, friend_id, status`,
    [requesterId, payload.sub],
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "request_not_found" });
  await pool.query(
    `INSERT INTO friendships (user_id, friend_id, status)
     VALUES ($1, $2, 'accepted')
     ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'`,
    [payload.sub, requesterId],
  );
  res.json({ accepted: true });
});

app.delete("/friends/:userId", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  await pool.query(
    "DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)",
    [payload.sub, String(req.params.userId || "")],
  );
  res.json({ deleted: true });
});

app.get("/friends", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const friends = await pool.query(
    `SELECT u.id, u.username, u.nickname, f.status, f.created_at
     FROM friendships f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = $1 AND f.status = 'accepted'
     ORDER BY u.nickname ASC, f.created_at DESC`,
    [payload.sub],
  );
  const sent = await pool.query(
    `SELECT u.id, u.username, u.nickname, f.status, f.created_at
     FROM friendships f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [payload.sub],
  );
  const received = await pool.query(
    `SELECT u.id, u.username, u.nickname, f.status, f.created_at
     FROM friendships f
     JOIN users u ON u.id = f.user_id
     WHERE f.friend_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [payload.sub],
  );
  res.json({
    friends: friends.rows.map((friend) => ({ ...friend, online: onlineUserIds.has(String(friend.id)) })),
    sent: sent.rows,
    received: received.rows,
  });
});

app.get("/friends/ranking", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const mode = cleanModeId(req.query.mode);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const result = await pool.query(
    `WITH best_scores AS (
       SELECT DISTINCT ON (s.user_id)
              s.user_id, s.nickname, s.total_score, s.survival_time, s.p_score, s.metric_primary, s.metric_secondary, s.mode_data, s.created_at
       FROM mode_scores s
       WHERE s.mode = $2
         AND (
           s.user_id = $1
           OR EXISTS (
             SELECT 1 FROM friendships f
             WHERE f.status = 'accepted'
               AND ((f.user_id = $1 AND f.friend_id = s.user_id)
                 OR (f.friend_id = $1 AND f.user_id = s.user_id))
           )
         )
       ORDER BY s.user_id, s.total_score DESC, s.survival_time DESC, s.created_at ASC
     )
     SELECT nickname, total_score, survival_time, p_score, metric_primary, metric_secondary, mode_data, created_at,
            RANK() OVER (ORDER BY total_score DESC, survival_time DESC) AS rank
     FROM best_scores
     ORDER BY total_score DESC, survival_time DESC, created_at ASC
     LIMIT $3`,
    [payload.sub, mode, limit],
  );
  res.json({ records: result.rows, scope: "friends", mode });
});

// ─── Moderation and Admin ─────────────────────────────────────────────────────

app.post("/v1/reports", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const reportedUserId = String(req.body.reported_user_id || req.body.user_id || "").trim();
  const reason = cleanShortText(req.body.reason || "unspecified", 80);
  const details = cleanShortText(req.body.details || "", 1000);
  if (!reportedUserId) return res.status(400).json({ error: "reported_user_required" });
  const result = await pool.query(
    `INSERT INTO reports (reporter_id, reported_user_id, reason, details)
     VALUES ($1, $2, $3, $4)
     RETURNING id, status, created_at`,
    [payload.sub, reportedUserId, reason, details],
  );
  await recordAuditLog({ userId: payload.sub, action: "report_user", targetType: "user", targetId: reportedUserId, details: { reason }, requestId: req.requestId });
  res.json({ report: result.rows[0] });
});

app.post("/v1/blocks", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const blockedUserId = String(req.body.blocked_user_id || req.body.user_id || "").trim();
  if (!blockedUserId || blockedUserId === payload.sub) return res.status(400).json({ error: "blocked_user_required" });
  await pool.query(
    `INSERT INTO blocks (blocker_id, blocked_user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [payload.sub, blockedUserId],
  );
  await pool.query(
    "DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)",
    [payload.sub, blockedUserId],
  );
  await recordAuditLog({ userId: payload.sub, action: "block_user", targetType: "user", targetId: blockedUserId, requestId: req.requestId });
  res.json({ blocked: true });
});

app.delete("/v1/blocks/:userId", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  await pool.query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_user_id = $2", [payload.sub, req.params.userId]);
  res.json({ blocked: false });
});

app.get("/admin/users", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const q = cleanShortText(req.query.q || "", 80);
  const result = await pool.query(
    `SELECT id, username, nickname, provider, coin_balance, created_at
     FROM users
     WHERE $1 = '' OR username ILIKE '%' || $1 || '%' OR nickname ILIKE '%' || $1 || '%'
     ORDER BY created_at DESC
     LIMIT 100`,
    [q],
  );
  res.json({ users: result.rows });
});

app.get("/admin/reports", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const result = await pool.query("SELECT * FROM reports ORDER BY created_at DESC LIMIT 100");
  res.json({ reports: result.rows });
});

app.post("/admin/wallet/adjust", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const userId = String(req.body.user_id || "").trim();
  const amount = cleanInt(req.body.amount, 0);
  const reason = cleanShortText(req.body.reason || "admin_adjust", 120);
  if (!userId || amount === 0) return res.status(400).json({ error: "user_and_amount_required" });
  const idempotencyKey = `admin:${admin.sub}:${userId}:${req.requestId}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const update = await client.query(
      "UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2 AND coin_balance + $1 >= 0 RETURNING coin_balance",
      [amount, userId],
    );
    if (update.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "invalid_wallet_adjustment" });
    }
    await client.query(
      "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, $3, $4)",
      [userId, amount, "admin_adjust", idempotencyKey],
    );
    await client.query(
      "INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)",
      [admin.sub, "wallet_adjust", "user", userId, JSON.stringify({ amount, reason })],
    );
    await client.query("COMMIT");
    res.json({ balance: update.rows[0].coin_balance });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/admin/app/status", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const maintenance = cleanBool(req.body.maintenance);
  const message = cleanShortText(req.body.message || "", 300);
  await pool.query("INSERT INTO maintenance_status (maintenance, message) VALUES ($1, $2)", [maintenance, message]);
  await pool.query(
    "INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details) VALUES ($1, 'set_maintenance', 'app', 'status', $2)",
    [admin.sub, JSON.stringify({ maintenance, message })],
  );
  res.json({ maintenance, message });
});

// ─── Multiplayer Rooms (REST fallback for Socket.io migration) ────────────────

app.post("/v1/multiplayer/rooms", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const mode = cleanModeId(req.body.mode);
  if (!["tag", "zombie", "battle_royale"].includes(mode)) return res.status(400).json({ error: "unsupported_mode" });
  const maxPlayers = Math.min(6, Math.max(2, Number.parseInt(req.body.max_players, 10) || 6));
  let room = null;
  for (let i = 0; i < 5; i++) {
    const code = makeRoomCode();
    try {
      const result = await pool.query(
        `INSERT INTO game_rooms (room_code, host_id, mode, max_players)
         VALUES ($1, $2, $3, $4)
         RETURNING id, room_code, host_id, mode, status, max_players, created_at`,
        [code, payload.sub, mode, maxPlayers],
      );
      room = result.rows[0];
      break;
    } catch (error) {
      if (error.code !== "23505") throw error;
    }
  }
  if (!room) return res.status(500).json({ error: "room_code_failed" });
  await pool.query(
    `INSERT INTO room_players (room_id, user_id, is_host, is_ready)
     VALUES ($1, $2, true, true)
     ON CONFLICT (room_id, user_id) DO UPDATE SET is_host = true, is_ready = true`,
    [room.id, payload.sub],
  );
  res.json({ room });
});

app.post("/v1/multiplayer/rooms/:roomCode/join", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const room = await pool.query(
    "SELECT * FROM game_rooms WHERE room_code = $1 AND status = 'waiting'",
    [String(req.params.roomCode || "").toUpperCase()],
  );
  if (room.rowCount === 0) return res.status(404).json({ error: "room_not_found" });
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM room_players WHERE room_id = $1", [room.rows[0].id]);
  if (count.rows[0].count >= room.rows[0].max_players) return res.status(409).json({ error: "room_full" });
  await pool.query(
    `INSERT INTO room_players (room_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [room.rows[0].id, payload.sub],
  );
  res.json({ joined: true, room: room.rows[0] });
});

app.get("/v1/multiplayer/rooms/:roomCode", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const room = await pool.query("SELECT * FROM game_rooms WHERE room_code = $1", [String(req.params.roomCode || "").toUpperCase()]);
  if (room.rowCount === 0) return res.status(404).json({ error: "room_not_found" });
  const players = await pool.query(
    `SELECT u.id, u.nickname, rp.is_host, rp.is_ready, rp.joined_at
     FROM room_players rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id = $1
     ORDER BY rp.is_host DESC, rp.joined_at ASC`,
    [room.rows[0].id],
  );
  res.json({ room: room.rows[0], players: players.rows });
});

app.post("/v1/multiplayer/rooms/:roomCode/ready", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const ready = Boolean(req.body.ready);
  const result = await pool.query(
    `UPDATE room_players rp
     SET is_ready = $1
     FROM game_rooms gr
     WHERE gr.id = rp.room_id AND gr.room_code = $2 AND rp.user_id = $3
     RETURNING rp.room_id, rp.user_id, rp.is_ready`,
    [ready, String(req.params.roomCode || "").toUpperCase(), payload.sub],
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "room_player_not_found" });
  res.json({ ready });
});

app.post("/v1/multiplayer/rooms/:roomCode/start", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const roomCode = String(req.params.roomCode || "").toUpperCase();
  const room = await pool.query("SELECT * FROM game_rooms WHERE room_code = $1", [roomCode]);
  if (room.rowCount === 0) return res.status(404).json({ error: "room_not_found" });
  if (room.rows[0].host_id !== payload.sub) return res.status(403).json({ error: "host_only" });
  const players = await pool.query("SELECT is_ready FROM room_players WHERE room_id = $1", [room.rows[0].id]);
  if (players.rowCount < 2) return res.status(409).json({ error: "not_enough_players" });
  if (players.rows.some(p => !p.is_ready)) return res.status(409).json({ error: "not_all_ready" });
  await pool.query("UPDATE game_rooms SET status = 'playing' WHERE id = $1", [room.rows[0].id]);
  res.json({ started: true, room_code: roomCode, mode: room.rows[0].mode });
});

// ─── V1: Wallet ───────────────────────────────────────────────────────────────

app.get("/v1/wallet", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const r = await pool.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);
  if (r.rowCount === 0) return res.status(401).json({ error: "user_not_found" });
  res.json({ coins: r.rows[0].coin_balance, balance: r.rows[0].coin_balance });
});

// ─── V1: Attendance ───────────────────────────────────────────────────────────

app.post("/v1/attendance/checkin", async (req, res) => {
	const payload = requireAuth(req, res);
	if (!payload) return;
	const today = todayUtc();

	const stats = await getUserStats(payload.sub);
	if (stats.last_attendance_date === today) {
		const r = await pool.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);
		const balance = r.rowCount > 0 ? r.rows[0].coin_balance : 0;
		return res.json({ already_checked_in: true, streak: stats.attendance_streak, total: stats.attendance_total, coins_awarded: 0, coins: balance, balance });
	}

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

	const newStreak = stats.last_attendance_date === yesterdayStr ? stats.attendance_streak + 1 : 1;
	const newTotal = stats.attendance_total + 1;
	const coinsAwarded = ATTENDANCE_BASE_COINS + (newStreak % 7 === 0 ? ATTENDANCE_WEEKLY_BONUS_COINS : 0);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`UPDATE user_game_stats SET attendance_streak = $1, attendance_total = $2, last_attendance_date = $3, updated_at = now()
			 WHERE user_id = $4`,
			[newStreak, newTotal, today, payload.sub],
		);
		await client.query("UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2", [coinsAwarded, payload.sub]);
		await client.query(
			"INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, $3, $4)",
			[payload.sub, coinsAwarded, "attendance_reward", today],
		);
		await client.query("COMMIT");
	} catch (e) {
		await client.query("ROLLBACK");
		throw e;
	} finally {
		client.release();
	}

	// Check attendance achievements
	const updatedStats = { ...stats, attendance_streak: newStreak, attendance_total: newTotal, last_attendance_date: today };
	const newlyUnlocked = await checkAndUnlockAchievements(payload.sub, updatedStats);
	const r = await pool.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);
	const balance = r.rowCount > 0 ? r.rows[0].coin_balance : 0;

	res.json({ checked_in: true, streak: newStreak, total: newTotal, coins_awarded: coinsAwarded, coins: balance, balance, achievements_unlocked: newlyUnlocked });
});

// ─── V1: Achievements ─────────────────────────────────────────────────────────

app.get("/v1/achievements", async (req, res) => {
  res.json({ achievements: ACHIEVEMENTS.map(a => ({ id: a.id, name: a.name, reward: a.reward })) });
});

app.get("/v1/achievements/me", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const stats = await getUserStats(payload.sub);
  const claimedRows = await pool.query(
    "SELECT achievement_id, claimed_at FROM user_achievements WHERE user_id = $1",
    [payload.sub],
  );
  const claimed = {};
  for (const row of claimedRows.rows) {
    claimed[row.achievement_id] = row.claimed_at;
  }

  const result = ACHIEVEMENTS.map(a => {
    const unlocked = a.check(stats);
    const claimedAt = claimed[a.id] || null;
    return {
      id: a.id, name: a.name, reward: a.reward,
      unlocked, claimed: Boolean(claimedAt),
      can_claim: unlocked && !claimedAt,
    };
  });

  res.json({ achievements: result, stats });
});

app.post("/v1/achievements/claim", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const achievementId = String(req.body.achievement_id || "");
  const ach = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!ach) return res.status(400).json({ error: "achievement_not_found" });

  // Check if already claimed
  const existing = await pool.query(
    "SELECT claimed_at FROM user_achievements WHERE user_id = $1 AND achievement_id = $2",
    [payload.sub, achievementId],
  );
  if (existing.rowCount > 0 && existing.rows[0].claimed_at) {
    return res.status(409).json({ error: "already_claimed" });
  }

  // Verify achievement is actually unlocked
  const stats = await getUserStats(payload.sub);
  if (!ach.check(stats)) {
    return res.status(403).json({ error: "not_unlocked" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_achievements (user_id, achievement_id, claimed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id, achievement_id) DO UPDATE SET claimed_at = now()`,
      [payload.sub, achievementId],
    );
    await client.query(
      "UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2",
      [ach.reward, payload.sub],
    );
    await client.query(
      "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, $3, $4)",
      [payload.sub, ach.reward, "achievement_reward", achievementId],
    );
    const r = await client.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);
    await client.query("COMMIT");
    res.json({ coins_added: ach.reward, new_balance: r.rows[0].coin_balance });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// ─── V1: Daily Quests ─────────────────────────────────────────────────────────

app.get("/v1/daily-quests", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const today = todayUtc();
  const stats = await getUserStats(payload.sub);

  const claimed = {};
  const rows = await pool.query(
    "SELECT quest_id, claimed_at FROM user_daily_quests WHERE user_id = $1 AND quest_date = $2",
    [payload.sub, today],
  );
  for (const row of rows.rows) {
    if (row.claimed_at) claimed[row.quest_id] = true;
  }

  const isToday = stats.today_date === today;
  const result = DAILY_QUESTS.map(q => {
    const progress = isToday ? (stats[q.stat] || 0) : 0;
    const completed = progress >= q.target;
    return {
      id: q.id, name: q.name, desc: q.desc, reward: q.reward,
      progress: Math.min(progress, q.target), target: q.target,
      completed, claimed: Boolean(claimed[q.id]),
      can_claim: completed && !claimed[q.id],
    };
  });
  res.json({ quests: result, today });
});

app.post("/v1/daily-quests/claim", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;
  const today = todayUtc();
  const questId = String(req.body.quest_id || "");
  const quest = DAILY_QUESTS.find(q => q.id === questId);
  if (!quest) return res.status(400).json({ error: "quest_not_found" });

  const existing = await pool.query(
    "SELECT claimed_at FROM user_daily_quests WHERE user_id = $1 AND quest_id = $2 AND quest_date = $3",
    [payload.sub, questId, today],
  );
  if (existing.rowCount > 0 && existing.rows[0].claimed_at) {
    return res.status(409).json({ error: "already_claimed" });
  }

  const stats = await getUserStats(payload.sub);
  if (stats.today_date !== today) {
    return res.status(403).json({ error: "not_completed" });
  }
  const progress = stats[quest.stat] || 0;
  if (progress < quest.target) {
    return res.status(403).json({ error: "not_completed" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_daily_quests (user_id, quest_id, quest_date, progress, completed_at, claimed_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (user_id, quest_id, quest_date) DO UPDATE SET claimed_at = now()`,
      [payload.sub, questId, today, progress],
    );
    await client.query(
      "UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2",
      [quest.reward, payload.sub],
    );
    await client.query(
      "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, $3, $4)",
      [payload.sub, quest.reward, "daily_quest_reward", `${today}:${questId}`],
    );
    const r = await client.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);
    await client.query("COMMIT");
    res.json({ coins_added: quest.reward, new_balance: r.rows[0].coin_balance });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// ─── V1: Shop ─────────────────────────────────────────────────────────────────

app.get("/v1/shop/items", async (req, res) => {
  const payload = bearerToken(req) ? verifyAuthToken(bearerToken(req)) : null;
  let owned = new Set(DEFAULT_OWNED);

  if (payload) {
    const invRows = await pool.query(
      "SELECT item_id FROM user_inventory WHERE user_id = $1",
      [payload.sub],
    );
    for (const r of invRows.rows) owned.add(r.item_id);
  }

  const items = Object.entries(SHOP_ITEMS).map(([id, item]) => ({
    id, ...item, owned: owned.has(id),
  }));
  const bundles = Object.entries(SHOP_BUNDLES).map(([id, b]) => ({ id, ...b }));
  res.json({ items, bundles });
});

app.post("/v1/shop/buy", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const itemId = String(req.body.item_id || "");
  const bundleId = String(req.body.bundle_id || "");

  if (itemId) {
    const item = SHOP_ITEMS[itemId];
    if (!item) return res.status(400).json({ error: "item_not_found" });
    if (item.price === 0) return res.status(400).json({ error: "item_is_free" });

    const alreadyOwned = await pool.query(
      "SELECT 1 FROM user_inventory WHERE user_id = $1 AND item_id = $2",
      [payload.sub, itemId],
    );
    if (alreadyOwned.rowCount > 0) return res.status(409).json({ error: "already_owned" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const debit = await client.query(
        "UPDATE users SET coin_balance = coin_balance - $1 WHERE id = $2 AND coin_balance >= $1 RETURNING coin_balance",
        [item.price, payload.sub],
      );
      if (debit.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(402).json({ error: "insufficient_coins" });
      }
      await client.query(
        "INSERT INTO user_inventory (user_id, item_id) VALUES ($1, $2)",
        [payload.sub, itemId],
      );
      await client.query(
        "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, $3, $4)",
        [payload.sub, -item.price, "shop_purchase", itemId],
      );
      await client.query("COMMIT");
      res.json({ success: true, item_id: itemId, new_balance: debit.rows[0].coin_balance });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

  } else if (bundleId) {
    const bundle = SHOP_BUNDLES[bundleId];
    if (!bundle) return res.status(400).json({ error: "bundle_not_found" });

    const ownedRows = await pool.query(
      "SELECT item_id FROM user_inventory WHERE user_id = $1 AND item_id = ANY($2::text[])",
      [payload.sub, bundle.item_ids],
    );
    if (ownedRows.rowCount >= bundle.item_ids.length) {
      return res.status(409).json({ error: "already_owned" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const debit = await client.query(
        "UPDATE users SET coin_balance = coin_balance - $1 WHERE id = $2 AND coin_balance >= $1 RETURNING coin_balance",
        [bundle.price, payload.sub],
      );
      if (debit.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(402).json({ error: "insufficient_coins" });
      }
      for (const id of bundle.item_ids) {
        await client.query(
          "INSERT INTO user_inventory (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [payload.sub, id],
        );
      }
      await client.query(
        "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, $3, $4)",
        [payload.sub, -bundle.price, "bundle_purchase", bundleId],
      );
      await client.query("COMMIT");
      res.json({ success: true, bundle_id: bundleId, item_ids: bundle.item_ids, new_balance: debit.rows[0].coin_balance });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } else {
    res.status(400).json({ error: "item_id_or_bundle_id_required" });
  }
});

app.get("/v1/shop/inventory", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const invRows = await pool.query(
    "SELECT item_id FROM user_inventory WHERE user_id = $1",
    [payload.sub],
  );
  const owned = [...DEFAULT_OWNED, ...invRows.rows.map(r => r.item_id)];

  const equippedRow = await pool.query(
    "SELECT skin, trail, death, shield, background FROM user_equipped WHERE user_id = $1",
    [payload.sub],
  );
  const equipped = equippedRow.rowCount > 0 ? equippedRow.rows[0] : { ...DEFAULT_EQUIPPED };

  const coinRow = await pool.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);

  res.json({ owned, equipped, coins: coinRow.rows[0].coin_balance });
});

app.post("/v1/shop/equip", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const itemId = String(req.body.item_id || "");
  const item = SHOP_ITEMS[itemId];
  if (!item) return res.status(400).json({ error: "item_not_found" });

  const ownedByDefault = DEFAULT_OWNED.includes(itemId);
  if (!ownedByDefault) {
    const owned = await pool.query(
      "SELECT 1 FROM user_inventory WHERE user_id = $1 AND item_id = $2",
      [payload.sub, itemId],
    );
    if (owned.rowCount === 0) return res.status(403).json({ error: "not_owned" });
  }

  const category = item.category;
  await pool.query(
    `INSERT INTO user_equipped (user_id, ${category}) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET ${category} = $2`,
    [payload.sub, itemId],
  );

  res.json({ success: true, item_id: itemId, category });
});

// ─── V1: Ad Reward ────────────────────────────────────────────────────────────

app.post("/v1/wallet/ad-reward", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const sessionToken = String(req.body.session_token || "").trim();
  if (!sessionToken) return res.status(400).json({ error: "reward_session_required" });
  const session = await pool.query(
    `SELECT session_token, verified_at, claimed_at, expires_at
     FROM ad_reward_sessions
     WHERE user_id = $1 AND session_token = $2`,
    [payload.sub, sessionToken],
  );
  if (session.rowCount === 0) return res.status(404).json({ error: "reward_session_not_found" });
  const row = session.rows[0];
  if (!row.verified_at) return res.status(202).json({ status: "pending_verification" });
  if (!row.claimed_at) {
    await pool.query("UPDATE ad_reward_sessions SET claimed_at = now() WHERE user_id = $1 AND session_token = $2", [payload.sub, sessionToken]);
  }
  const balanceRow = await pool.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);
  res.json({ coins_added: row.claimed_at ? 0 : 15, new_balance: balanceRow.rows[0].coin_balance, status: "verified" });
});

app.post("/v1/wallet/ad-reward/session", async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const today = todayUtc();
  const countRow = await pool.query(
    `SELECT COUNT(*) AS cnt FROM coin_transactions
     WHERE user_id = $1 AND reason = 'ad_reward' AND created_at::date = $2::date`,
    [payload.sub, today],
  );
  const usedToday = Number(countRow.rows[0].cnt);
  if (usedToday >= 5) return res.status(429).json({ error: "daily_limit_reached", limit: 5, used: usedToday });

  const sessionToken = randomBytes(18).toString("base64url");
  await pool.query(
    `INSERT INTO ad_reward_sessions (user_id, session_token, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')`,
    [payload.sub, sessionToken],
  );
  res.json({ session_token: sessionToken, custom_data: sessionToken, used_today: usedToday, limit: 5 });
});

app.get("/v1/wallet/ad-reward/ssv", async (req, res) => {
  try {
    await verifyAdMobSsvRequest(req);
    const sessionToken = cleanShortText(req.query.custom_data, 120);
    const transactionId = cleanShortText(req.query.transaction_id, 120);
    const rewardAmount = Math.max(0, cleanInt(req.query.reward_amount, 0));
    const adUnit = cleanShortText(req.query.ad_unit, 120);
    if (!sessionToken || !transactionId) return res.send("OK");
    await verifyAdRewardSession(sessionToken, transactionId, rewardAmount, adUnit);
    res.send("OK");
  } catch (error) {
    console.warn("[admob-ssv] rejected callback", { error: error?.message || String(error) });
    res.status(400).send("invalid_callback");
  }
});

app.post("/dev/ad-reward/verify", async (req, res) => {
  if (!devRewardVerificationEnabled) return res.status(404).json({ error: "not_found" });
  const payload = requireAuth(req, res);
  if (!payload) return;
  const sessionToken = cleanShortText(req.body.session_token, 120);
  if (!sessionToken) return res.status(400).json({ error: "reward_session_required" });
  const transactionId = cleanShortText(req.body.transaction_id || `dev-${randomUUID()}`, 120);
  try {
    await verifyAdRewardSession(sessionToken, transactionId, 15, "dev");
    const balanceRow = await pool.query("SELECT coin_balance FROM users WHERE id = $1", [payload.sub]);
    res.json({ ok: true, session_token: sessionToken, transaction_id: transactionId, new_balance: balanceRow.rows[0].coin_balance });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    if (statusCode >= 400 && statusCode < 500) return res.status(statusCode).json({ error: error.message });
    throw error;
  }
});

// ─── Socket.io Realtime Multiplayer ──────────────────────────────────────────

io.use((socket, next) => {
  const token = String(socket.handshake.auth?.token || socket.handshake.query?.token || "");
  const payload = verifyAuthToken(token);
  if (!payload) return next(new Error("invalid_token"));
  socket.data.userId = payload.sub;
  socket.data.nickname = payload.nickname || payload.username || "Player";
  next();
});

io.on("connection", (socket) => {
  socket.on("room:create", async (data, ack) => {
    try {
      const mode = cleanModeId(data?.mode);
      if (!["tag", "zombie", "battle_royale"].includes(mode)) return safeAck(ack, { ok: false, error: "unsupported_mode" });
      const maxPlayers = Math.min(6, Math.max(2, Number.parseInt(data?.max_players, 10) || 6));
      const roomCode = makeRoomCode();
      const room = {
        code: roomCode,
        mode,
        host_id: socket.data.userId,
        max_players: maxPlayers,
        status: "waiting",
        private: Boolean(data?.private),
        players: new Map(),
        created_at: Date.now(),
      };
      realtimeRooms.set(roomCode, room);
      addRealtimePlayer(room, socket);
      socket.join(roomCode);
      safeAck(ack, { ok: true, room: serializeRealtimeRoom(room) });
      io.to(roomCode).emit("room:state", serializeRealtimeRoom(room));
    } catch (error) {
      safeAck(ack, { ok: false, error: "room_create_failed" });
    }
  });

  socket.on("room:join", (data, ack) => {
    const roomCode = String(data?.room_code || "").trim().toUpperCase();
    const room = realtimeRooms.get(roomCode);
    if (!room || room.status !== "waiting") return safeAck(ack, { ok: false, error: "room_not_found" });
    if (room.players.size >= room.max_players) return safeAck(ack, { ok: false, error: "room_full" });
    addRealtimePlayer(room, socket);
    socket.join(roomCode);
    safeAck(ack, { ok: true, room: serializeRealtimeRoom(room) });
    io.to(roomCode).emit("room:state", serializeRealtimeRoom(room));
  });

  socket.on("player:ready", (data) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.ready = Boolean(data?.ready);
    io.to(room.code).emit("room:state", serializeRealtimeRoom(room));
  });

  socket.on("room:set_private", (data, ack) => {
    const room = getSocketRoom(socket);
    if (!room) return safeAck(ack, { ok: false, error: "room_not_found" });
    if (room.host_id !== socket.data.userId) return safeAck(ack, { ok: false, error: "not_host" });
    if (room.status !== "waiting") return safeAck(ack, { ok: false, error: "room_not_waiting" });
    room.private = Boolean(data?.private);
    safeAck(ack, { ok: true, room: serializeRealtimeRoom(room) });
    io.to(room.code).emit("room:state", serializeRealtimeRoom(room));
  });

  socket.on("match:start", () => {
    const room = getSocketRoom(socket);
    if (!room || room.host_id !== socket.data.userId || room.players.size < 2) return;
    room.status = "playing";
    if (room.mode === "tag") assignInitialTagger(room);
    if (room.mode === "zombie") assignInitialZombie(room);
    io.to(room.code).emit("match:start", serializeRealtimeRoom(room));
  });

  socket.on("player:state", (state) => {
    const room = getSocketRoom(socket);
    if (!room || room.status !== "playing") return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.x = Number(state?.x) || 0;
    player.y = Number(state?.y) || 0;
    player.vx = Number(state?.vx) || 0;
    player.vy = Number(state?.vy) || 0;
    player.stunned_until = Math.max(player.stunned_until || 0, Number(state?.stunned_until) || 0);
    socket.to(room.code).emit("player:state", {
      user_id: player.user_id,
      nickname: player.nickname,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      role: player.role,
      stunned_until: player.stunned_until || 0,
    });
  });

  socket.on("tag:touch", (data) => {
    const room = getSocketRoom(socket);
    if (!room || room.mode !== "tag" || room.status !== "playing") return;
    const tagger = room.players.get(socket.id);
    if (!tagger || tagger.role !== "tagger") return;
    const target = findRealtimePlayerByUserId(room, String(data?.target_user_id || ""));
    if (!target || target.role === "tagger") return;
    if (Date.now() < Number(target.stunned_until || 0)) return;
    target.role = "tagger";
    io.to(room.code).emit("tag:infected", { user_id: target.user_id });
    checkTagWin(room);
  });

  socket.on("zombie:infect", (data) => {
    const room = getSocketRoom(socket);
    if (!room || room.mode !== "zombie" || room.status !== "playing") return;
    const zombie = room.players.get(socket.id);
    if (!zombie || zombie.role !== "zombie") return;
    const target = findRealtimePlayerByUserId(room, String(data?.target_user_id || ""));
    if (!target || target.role === "zombie") return;
    if (realtimeDistance(zombie, target) > 30) return;
    target.role = "zombie";
    io.to(room.code).emit("zombie:infected", { user_id: target.user_id });
    checkZombieWin(room);
  });

  socket.on("laser:stun", () => {
    const room = getSocketRoom(socket);
    if (!room || room.status !== "playing") return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.stunned_until = Date.now() + 3000;
    io.to(room.code).emit("player:stunned", { user_id: player.user_id, stunned_until: player.stunned_until });
  });

  socket.on("match:finish", async (data, ack) => {
    const room = getSocketRoom(socket);
    if (!room) return safeAck(ack, { ok: false, error: "room_not_found" });
    try {
      await saveMultiplayerResult(room, socket.data.userId, data);
      safeAck(ack, { ok: true });
    } catch (error) {
      safeAck(ack, { ok: false, error: "result_save_failed" });
    }
  });

  socket.on("disconnect", () => {
    const room = getSocketRoom(socket);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(room.code);
    if (room.players.size === 0) realtimeRooms.delete(room.code);
    else io.to(room.code).emit("room:state", serializeRealtimeRoom(room));
  });
});

// ─── Error Handler ────────────────────────────────────────────────────────────

wrapExpress4AsyncRoutes(app);

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  res.status(500).json({ error: "server_error" });
});

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function wrapExpress4AsyncRoutes(expressApp) {
  const stack = expressApp?._router?.stack || [];
  for (const layer of stack) {
    if (!layer.route?.stack) continue;
    for (const routeLayer of layer.route.stack) {
      const original = routeLayer.handle;
      if (typeof original !== "function" || original.length > 3 || original._asyncWrapped) continue;
      const wrapped = function wrappedAsyncRoute(req, res, next) {
        Promise.resolve(original(req, res, next)).catch(next);
      };
      wrapped._asyncWrapped = true;
      routeLayer.handle = wrapped;
    }
  }
}

function safeAck(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function addRealtimePlayer(room, socket) {
  socket.data.roomCode = room.code;
  room.players.set(socket.id, {
    socket_id: socket.id,
    user_id: socket.data.userId,
    nickname: socket.data.nickname,
    ready: room.host_id === socket.data.userId,
    role: "survivor",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    stunned_until: 0,
  });
}

function getSocketRoom(socket) {
  const roomCode = String(socket.data.roomCode || "");
  if (!roomCode) return null;
  return realtimeRooms.get(roomCode) || null;
}

function serializeRealtimeRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    host_id: room.host_id,
    max_players: room.max_players,
    status: room.status,
    private: Boolean(room.private),
    players: [...room.players.values()].map(p => ({
      user_id: p.user_id,
      nickname: p.nickname,
      ready: p.ready,
      role: p.role,
      x: p.x,
      y: p.y,
      stunned_until: p.stunned_until || 0,
    })),
  };
}

function findRealtimePlayerByUserId(room, userId) {
  for (const player of room.players.values()) {
    if (player.user_id === userId) return player;
  }
  return null;
}

function assignInitialTagger(room) {
  const players = [...room.players.values()];
  for (const p of players) p.role = "runner";
  if (players.length > 0) players[Math.floor(Math.random() * players.length)].role = "tagger";
}

function assignInitialZombie(room) {
  const players = [...room.players.values()];
  for (const p of players) p.role = "survivor";
  if (players.length > 0) players[Math.floor(Math.random() * players.length)].role = "zombie";
}

function checkTagWin(room) {
  const runners = [...room.players.values()].filter(p => p.role !== "tagger");
  if (runners.length <= 1) {
    room.status = "finished";
    io.to(room.code).emit("match:finished", { mode: room.mode, winner_user_ids: runners.map(p => p.user_id), reason: "last_runner" });
  }
}

function checkZombieWin(room) {
  const survivors = [...room.players.values()].filter(p => p.role !== "zombie");
  if (survivors.length <= 1) {
    room.status = "finished";
    io.to(room.code).emit("match:finished", { mode: room.mode, winner_user_ids: survivors.map(p => p.user_id), reason: survivors.length === 0 ? "zombie_win" : "survivor_win" });
  }
}

function realtimeDistance(a, b) {
  const dx = (Number(a?.x) || 0) - (Number(b?.x) || 0);
  const dy = (Number(a?.y) || 0) - (Number(b?.y) || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

async function saveMultiplayerResult(room, userId, data) {
  const rank = Math.max(1, Number.parseInt(data?.rank, 10) || 1);
  const score = Math.max(0, Number.parseInt(data?.score, 10) || 0);
  const survivedSeconds = Math.max(0, Number(data?.survived_seconds) || 0);
  await pool.query(
    `INSERT INTO multiplayer_results (room_id, user_id, mode, rank, score, survived_seconds)
     VALUES (NULL, $1, $2, $3, $4, $5)`,
    [userId, room.mode, rank, score, survivedSeconds],
  );
}

async function getUserStats(userId) {
  await ensureUserGameStats(userId);
  const r = await pool.query("SELECT * FROM user_game_stats WHERE user_id = $1", [userId]);
  return r.rows[0];
}

async function ensureUserGameStats(userId) {
  await pool.query(
    "INSERT INTO user_game_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
}

async function ensureUserEquipped(userId) {
  await pool.query(
    `INSERT INTO user_equipped (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId],
  );
}

async function updateGameStats(userId, session) {
  const today = todayUtc();
  const stats = await getUserStats(userId);

  const isNewDay = stats.today_date !== today;
  const newTodayPlays = (isNewDay ? 0 : stats.today_plays) + 1;
  const newTodayDeaths = (isNewDay ? 0 : stats.today_deaths) + 1;
  const newTodayP = (isNewDay ? 0 : stats.today_p_points) + session.pCount;
  const newTodayBest = isNewDay
    ? session.survivalTime
    : Math.max(stats.today_best_survival, session.survivalTime);

  const newTotalSurvival = stats.total_survival_time + session.survivalTime;
  const newBestSurvival = Math.max(stats.best_survival_time, session.survivalTime);
  const newTotalPlays = stats.total_plays + 1;
  const newTotalP = stats.total_p_points + session.pCount;
  const newTotalS = stats.total_s_points + session.sCount;
  const newTotalBlocks = stats.total_shield_blocks + session.shieldBlocks;
  const newTotalActivations = stats.total_shield_activations + session.shieldActivations;
  const newBestCombo = Math.max(stats.best_combo, session.maxCombo);
  const newBestBreaks = stats.best_breaks + (session.wasBest ? 1 : 0);

  await pool.query(
    `UPDATE user_game_stats SET
       today_date = $1,
       today_plays = $2,
       today_deaths = $3,
       today_p_points = $4,
       today_best_survival = $5,
       total_survival_time = $6,
       best_survival_time = $7,
       total_plays = $8,
       total_p_points = $9,
       total_s_points = $10,
       total_shield_blocks = $11,
       total_shield_activations = $12,
       best_combo = $13,
       best_breaks = $14,
       last_survival_time = $15,
       updated_at = now()
     WHERE user_id = $16`,
    [
      today, newTodayPlays, newTodayDeaths, newTodayP, newTodayBest,
      newTotalSurvival, newBestSurvival, newTotalPlays, newTotalP, newTotalS,
      newTotalBlocks, newTotalActivations, newBestCombo, newBestBreaks,
      session.survivalTime, userId,
    ],
  );

  const updatedStats = {
    ...stats,
    today_date: today, today_plays: newTodayPlays, today_deaths: newTodayDeaths,
    today_p_points: newTodayP, today_best_survival: newTodayBest,
    total_survival_time: newTotalSurvival, best_survival_time: newBestSurvival,
    total_plays: newTotalPlays, total_p_points: newTotalP, total_s_points: newTotalS,
    total_shield_blocks: newTotalBlocks, total_shield_activations: newTotalActivations,
    best_combo: newBestCombo, best_breaks: newBestBreaks, last_survival_time: session.survivalTime,
  };

  const newlyUnlocked = await checkAndUnlockAchievements(userId, updatedStats);
  const updatedDailyQuests = await getDailyQuestProgress(userId, updatedStats, today);

  return { newlyUnlocked, updatedDailyQuests };
}

async function checkAndUnlockAchievements(userId, stats) {
  const existing = await pool.query(
    "SELECT achievement_id FROM user_achievements WHERE user_id = $1",
    [userId],
  );
  const alreadyRecorded = new Set(existing.rows.map(r => r.achievement_id));

  const newlyUnlocked = [];
  for (const ach of ACHIEVEMENTS) {
    if (alreadyRecorded.has(ach.id)) continue;
    if (ach.check(stats)) {
      await pool.query(
        `INSERT INTO user_achievements (user_id, achievement_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, ach.id],
      );
      newlyUnlocked.push({ id: ach.id, name: ach.name, reward: ach.reward });
    }
  }
  return newlyUnlocked;
}

async function getDailyQuestProgress(userId, stats, today) {
  const claimedRows = await pool.query(
    "SELECT quest_id FROM user_daily_quests WHERE user_id = $1 AND quest_date = $2 AND claimed_at IS NOT NULL",
    [userId, today],
  );
  const claimed = new Set(claimedRows.rows.map(r => r.quest_id));

  return DAILY_QUESTS.map(q => {
    const progress = stats.today_date === today ? (stats[q.stat] || 0) : 0;
    const completed = progress >= q.target;
    return {
      id: q.id, name: q.name, reward: q.reward,
      progress: Math.min(progress, q.target), target: q.target,
      completed, claimed: claimed.has(q.id),
      can_claim: completed && !claimed.has(q.id),
    };
  });
}

async function getRank(totalScore, survivalTime, mode = "classic") {
  const result = await pool.query(
    `SELECT COUNT(*)::int + 1 AS rank
     FROM (
       SELECT DISTINCT ON (user_id) user_id, total_score, survival_time
       FROM mode_scores
       WHERE mode = $3
       ORDER BY user_id, total_score DESC, survival_time DESC, created_at ASC
     ) best_scores
     WHERE total_score > $1
        OR (total_score = $1 AND survival_time > $2)`,
    [totalScore, survivalTime, cleanModeId(mode)],
  );
  return result.rows[0].rank;
}

async function getUserBestScore(userId, mode = "classic") {
  const result = await pool.query(
    `SELECT nickname, total_score, survival_time, p_score, mode, metric_primary, metric_secondary, mode_data, created_at
     FROM mode_scores WHERE user_id = $1 AND mode = $2
     ORDER BY total_score DESC, survival_time DESC, created_at ASC LIMIT 1`,
    [userId, cleanModeId(mode)],
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

function isPlausibleScore(totalScore, survivalTime, pScore, modeScoreBonus = 0) {
  const expectedTotal = Math.floor(survivalTime * 10) + pScore + modeScoreBonus;
  const maxPScore = Math.ceil(survivalTime / 1.0) * 500 + 5000;
  const maxBonus = Math.ceil(survivalTime / 1.0) * 2500 + 20000;
  return (
    survivalTime >= 0 && survivalTime < 60 * 60 &&
    pScore >= 0 && pScore <= maxPScore &&
    modeScoreBonus >= 0 && modeScoreBonus <= maxBonus &&
    Math.abs(totalScore - expectedTotal) <= 10
  );
}

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

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
  const payload = { sub: String(user.id), username: String(user.username || ""), nickname: String(user.nickname || ""), iat: now, exp: now + 60 * 15 };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signJwtParts(encodedHeader, encodedPayload);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
function signRefreshToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: String(user.id), typ: "refresh", jti: randomUUID(), iat: now, exp: now + 60 * 60 * 24 * 30 };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", refreshTokenSecret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
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
    if (!payload.sub || Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function verifyRefreshToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = createHmac("sha256", refreshTokenSecret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
  if (!timingSafeStringEqual(signature, expected)) return null;
  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (header.alg !== "HS256" || payload.typ !== "refresh") return null;
    if (!payload.sub || Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function signJwtParts(encodedHeader, encodedPayload) {
  return createHmac("sha256", jwtSecret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
}
function base64UrlEncode(value) { return Buffer.from(value).toString("base64url"); }
function base64UrlDecode(value) { return Buffer.from(value, "base64url").toString("utf8"); }
function hashRefreshToken(token) {
  return createHmac("sha256", refreshTokenSecret).update(String(token || "")).digest("hex");
}
function timingSafeStringEqual(left, right) {
  const l = Buffer.from(String(left));
  const r = Buffer.from(String(right));
  return l.length === r.length && timingSafeEqual(l, r);
}
async function issueAuthResponse(user, req) {
  const publicUser = {
    id: user.id,
    username: user.username || "",
    nickname: user.nickname || "",
    coin_balance: user.coin_balance || 0,
  };
  const token = signAuthToken(publicUser);
  const refreshToken = signRefreshToken(publicUser);
  const refreshPayload = verifyRefreshToken(refreshToken);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5))`,
    [
      publicUser.id,
      hashRefreshToken(refreshToken),
      cleanShortText(req.headers["user-agent"] || "", 250),
      cleanShortText(req.ip || "", 80),
      refreshPayload.exp,
    ],
  );
  return { user: publicUser, token, access_token: token, refresh_token: refreshToken };
}
async function recordAuditLog({ userId = null, action, targetType = "", targetId = "", details = {}, requestId = "" }) {
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, request_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, cleanShortText(action, 80), cleanShortText(targetType, 80), cleanShortText(targetId, 120), JSON.stringify(details || {}), requestId],
  );
}
async function recordErrorLog({ userId = null, level = "error", source = "server", message = "", details = {}, requestId = "" }) {
  await pool.query(
    `INSERT INTO error_logs (user_id, level, source, message, details, request_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, cleanShortText(level, 20), cleanShortText(source, 40), cleanShortText(message, 500), JSON.stringify(details || {}), requestId],
  );
}
async function verifyAdMobSsvRequest(req) {
  const originalUrl = req.originalUrl || "";
  const queryString = originalUrl.includes("?") ? originalUrl.slice(originalUrl.indexOf("?") + 1) : "";
  const signatureMarker = "signature=";
  const signatureIndex = queryString.indexOf(signatureMarker);
  if (signatureIndex <= 0) throw new Error("missing_signature");
  const signedContent = queryString.slice(0, signatureIndex - 1);
  const signature = String(req.query.signature || "");
  const keyId = String(req.query.key_id || "");
  if (!signature || !keyId) throw new Error("missing_signature_or_key");
  const keys = await getAdMobSsvKeys();
  const publicKey = keys.get(keyId);
  if (!publicKey) throw new Error("unknown_key_id");
  const ok = verifySignature(
    "sha256",
    Buffer.from(signedContent, "utf8"),
    { key: publicKey, dsaEncoding: "der" },
    Buffer.from(signature, "base64url"),
  );
  if (!ok) throw new Error("bad_signature");
}
async function verifyAdRewardSession(sessionToken, transactionId, rewardAmount = 15, adUnit = "") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ad_reward:${transactionId}`]);
    const session = await client.query(
      `SELECT user_id, verified_at, expires_at
       FROM ad_reward_sessions
       WHERE session_token = $1
       FOR UPDATE`,
      [sessionToken],
    );
    if (session.rowCount === 0) {
      const error = new Error("session_not_found");
      error.statusCode = 404;
      throw error;
    }
    const rewardSession = session.rows[0];
    if (new Date(rewardSession.expires_at).getTime() < Date.now()) {
      const error = new Error("session_expired");
      error.statusCode = 410;
      throw error;
    }
    if (!rewardSession.verified_at) {
      await client.query(
        `UPDATE ad_reward_sessions
         SET verified_at = now(), transaction_id = $2, reward_amount = $3, ad_unit = $4
         WHERE session_token = $1`,
        [sessionToken, transactionId, rewardAmount, adUnit],
      );
      await client.query("UPDATE users SET coin_balance = coin_balance + 15 WHERE id = $1", [rewardSession.user_id]);
      await client.query(
        "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, 15, 'ad_reward', $2)",
        [rewardSession.user_id, transactionId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function getAdMobSsvKeys() {
  if (Date.now() < admobSsvKeysCache.expiresAt && admobSsvKeysCache.keys.size > 0) {
    return admobSsvKeysCache.keys;
  }
  const response = await fetch(admobSsvKeyUrl);
  if (!response.ok) throw new Error(`admob_keys_http_${response.status}`);
  const data = await response.json();
  const keys = new Map();
  for (const item of data.keys || []) {
    const id = String(item.keyId ?? item.key_id ?? "");
    if (!id) continue;
    if (item.pem) {
      keys.set(id, createPublicKey(item.pem));
    } else if (item.base64) {
      keys.set(id, createPublicKey({ key: Buffer.from(String(item.base64), "base64"), format: "der", type: "spki" }));
    }
  }
  if (keys.size === 0) throw new Error("admob_keys_empty");
  admobSsvKeysCache = { expiresAt: Date.now() + 12 * 60 * 60 * 1000, keys };
  return keys;
}
function callbackUrl(provider) { return `${publicBaseUrl}/auth/${provider}/callback`; }
function buildGoogleAuthUrl(sessionId, state) {
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl("google"), response_type: "code", scope: "openid email profile", state, access_type: "online", prompt: "select_account" });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
function buildNaverAuthUrl(sessionId, state) {
  if (!process.env.NAVER_CLIENT_ID) return null;
  const params = new URLSearchParams({ response_type: "code", client_id: process.env.NAVER_CLIENT_ID, redirect_uri: callbackUrl("naver"), state });
  return `https://nid.naver.com/oauth2.0/authorize?${params}`;
}
function buildFacebookAuthUrl(sessionId, state) {
  if (!process.env.FACEBOOK_CLIENT_ID) return null;
  const params = new URLSearchParams({ client_id: process.env.FACEBOOK_CLIENT_ID, redirect_uri: callbackUrl("facebook"), response_type: "code", scope: "public_profile,email", state });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}
async function fetchProviderProfile(provider, code, sessionId) {
  if (provider === "google") return fetchGoogleProfile(code, sessionId);
  if (provider === "naver") return fetchNaverProfile(code, sessionId);
  if (provider === "facebook") return fetchFacebookProfile(code, sessionId);
  throw new Error("unsupported_provider");
}
async function fetchGoogleProfile(code, sessionId) {
  const token = await postForm("https://oauth2.googleapis.com/token", { code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: callbackUrl("google"), grant_type: "authorization_code" });
  const profile = await getJson("https://openidconnect.googleapis.com/v1/userinfo", token.access_token);
  return { provider: "google", providerId: profile.sub, nickname: profile.name || profile.email || "GooglePlayer" };
}
async function fetchNaverProfile(code, sessionId) {
  const token = await postForm("https://nid.naver.com/oauth2.0/token", { grant_type: "authorization_code", client_id: process.env.NAVER_CLIENT_ID, client_secret: process.env.NAVER_CLIENT_SECRET, code, state: loginSessions.get(sessionId)?.state || "" });
  const data = await getJson("https://openapi.naver.com/v1/nid/me", token.access_token);
  const profile = data.response || {};
  return { provider: "naver", providerId: profile.id, nickname: profile.nickname || profile.name || "NaverPlayer" };
}
async function fetchFacebookProfile(code, sessionId) {
  const params = new URLSearchParams({ client_id: process.env.FACEBOOK_CLIENT_ID, client_secret: process.env.FACEBOOK_CLIENT_SECRET, redirect_uri: callbackUrl("facebook"), code });
  const token = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${params}`).then(r => r.json());
  const profile = await getJson("https://graph.facebook.com/me?fields=id,name,email", token.access_token);
  return { provider: "facebook", providerId: profile.id, nickname: profile.name || profile.email || "FacebookPlayer" };
}
async function postForm(url, values) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function getJson(url, accessToken) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function upsertOAuthUser(profile) {
  const nickname = await reserveNickname(cleanNickname(profile.nickname || "Player"), profile.provider, profile.providerId);
  const result = await pool.query(
    `INSERT INTO users (provider, provider_id, nickname) VALUES ($1, $2, $3)
     ON CONFLICT (provider, provider_id) DO UPDATE SET nickname = users.nickname
     RETURNING id, provider, provider_id, nickname, coin_balance`,
    [profile.provider, profile.providerId, nickname],
  );
  const user = result.rows[0];
  await ensureUserGameStats(user.id);
  await ensureUserEquipped(user.id);
  return user;
}
async function reserveNickname(baseNickname, provider, providerId) {
  const base = cleanNickname(baseNickname).slice(0, 12) || "Player";
  const existing = await pool.query("SELECT nickname FROM users WHERE provider = $1 AND provider_id = $2", [provider, providerId]);
  if (existing.rowCount > 0) return existing.rows[0].nickname;
  for (let i = 0; i < 20; i++) {
    const nickname = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    const taken = await pool.query("SELECT 1 FROM users WHERE nickname = $1", [nickname]);
    if (taken.rowCount === 0) return nickname;
  }
  return `${base}${Date.now().toString().slice(-5)}`;
}
function renderAuthResult(title, message) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;background:#071018;color:white;display:grid;place-items:center;min-height:100vh"><main style="text-align:center"><h1>${title}</h1><p>${message}</p></main></body>`;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

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
      coin_balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_id)
    )`);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS coin_balance INTEGER NOT NULL DEFAULT 0");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      total_score INTEGER NOT NULL,
      survival_time REAL NOT NULL,
      p_score INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'classic',
      mode_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'classic'");
  await pool.query("ALTER TABLE scores ADD COLUMN IF NOT EXISTS mode_data JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("CREATE INDEX IF NOT EXISTS scores_rank_idx ON scores (total_score DESC, survival_time DESC, created_at ASC)");
  await pool.query("CREATE INDEX IF NOT EXISTS scores_mode_rank_idx ON scores (mode, total_score DESC, survival_time DESC, created_at ASC)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mode_scores (
      id BIGSERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      total_score INTEGER NOT NULL,
      survival_time REAL NOT NULL,
      p_score INTEGER NOT NULL DEFAULT 0,
      metric_primary REAL NOT NULL DEFAULT 0,
      metric_secondary INTEGER NOT NULL DEFAULT 0,
      mode_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_score_id BIGINT UNIQUE REFERENCES scores(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("ALTER TABLE mode_scores ADD COLUMN IF NOT EXISTS mode_data JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("CREATE INDEX IF NOT EXISTS mode_scores_rank_idx ON mode_scores (mode, total_score DESC, survival_time DESC, created_at ASC)");
  await pool.query("CREATE INDEX IF NOT EXISTS mode_scores_user_idx ON mode_scores (user_id, mode, total_score DESC)");
  await pool.query(`
    INSERT INTO mode_scores (mode, user_id, nickname, total_score, survival_time, p_score, mode_data, source_score_id, created_at)
    SELECT mode, user_id, nickname, total_score, survival_time, p_score, mode_data, id, created_at
    FROM scores
    ON CONFLICT (source_score_id) DO NOTHING`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_game_stats (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      total_survival_time REAL NOT NULL DEFAULT 0,
      best_survival_time REAL NOT NULL DEFAULT 0,
      last_survival_time REAL NOT NULL DEFAULT 0,
      total_plays INTEGER NOT NULL DEFAULT 0,
      total_p_points INTEGER NOT NULL DEFAULT 0,
      total_s_points INTEGER NOT NULL DEFAULT 0,
      total_shield_blocks INTEGER NOT NULL DEFAULT 0,
      total_shield_activations INTEGER NOT NULL DEFAULT 0,
      best_combo INTEGER NOT NULL DEFAULT 0,
      best_breaks INTEGER NOT NULL DEFAULT 0,
      attendance_total INTEGER NOT NULL DEFAULT 0,
      attendance_streak INTEGER NOT NULL DEFAULT 0,
      last_attendance_date TEXT NOT NULL DEFAULT '',
      today_plays INTEGER NOT NULL DEFAULT 0,
      today_deaths INTEGER NOT NULL DEFAULT 0,
      today_p_points INTEGER NOT NULL DEFAULT 0,
      today_best_survival REAL NOT NULL DEFAULT 0,
      today_date TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_achievements (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_id TEXT NOT NULL,
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, achievement_id)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_daily_quests (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      quest_id TEXT NOT NULL,
      quest_date TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, quest_id, quest_date)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_inventory (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, item_id)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_equipped (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      skin TEXT NOT NULL DEFAULT 'skin_default',
      trail TEXT NOT NULL DEFAULT 'trail_none',
      death TEXT NOT NULL DEFAULT 'death_default',
      shield TEXT NOT NULL DEFAULT 'shield_default',
      background TEXT NOT NULL DEFAULT 'bg_void'
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coin_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS coin_tx_user_idx ON coin_transactions (user_id, created_at DESC)");
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS coin_tx_unique_user_reason_ref_idx ON coin_transactions (user_id, reason, ref_id) WHERE ref_id IS NOT NULL",
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      marketing_opt_in BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_agent TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id, revoked_at, expires_at)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
      reason TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx ON wallet_transactions (user_id, created_at DESC)");
  await pool.query(`
    CREATE OR REPLACE FUNCTION mirror_coin_transaction_to_wallet()
    RETURNS TRIGGER AS $$
    DECLARE current_balance INTEGER;
    BEGIN
      SELECT coin_balance INTO current_balance FROM users WHERE id = NEW.user_id;
      INSERT INTO user_wallets (user_id, balance)
      VALUES (NEW.user_id, COALESCE(current_balance, 0))
      ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now();
      INSERT INTO wallet_transactions (user_id, amount, balance_after, reason, source_type, source_id, idempotency_key, created_at)
      VALUES (
        NEW.user_id,
        NEW.amount,
        COALESCE(current_balance, 0),
        NEW.reason,
        NEW.reason,
        COALESCE(NEW.ref_id, NEW.id::text),
        NEW.user_id::text || ':' || NEW.reason || ':' || COALESCE(NEW.ref_id, NEW.id::text),
        NEW.created_at
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  await pool.query("DROP TRIGGER IF EXISTS coin_transactions_wallet_mirror ON coin_transactions");
  await pool.query(`
    CREATE TRIGGER coin_transactions_wallet_mirror
    AFTER INSERT ON coin_transactions
    FOR EACH ROW EXECUTE FUNCTION mirror_coin_transaction_to_wallet()`);
  await pool.query(`
    INSERT INTO user_wallets (user_id, balance)
    SELECT id, coin_balance FROM users
    ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reward_claims (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reward_type TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'granted',
      reward_amount INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS reward_claims_user_idx ON reward_claims (user_id, created_at DESC)");
  await pool.query(`
    CREATE OR REPLACE FUNCTION mirror_coin_transaction_to_reward_claim()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.amount > 0 AND NEW.reason IN ('ad_reward', 'attendance_reward', 'achievement_reward', 'daily_quest_reward', 'game_reward', 'zombie_result', 'tag_result', 'battle_royale_result') THEN
        INSERT INTO reward_claims (user_id, reward_type, source_id, idempotency_key, status, reward_amount, created_at)
        VALUES (
          NEW.user_id,
          NEW.reason,
          COALESCE(NEW.ref_id, NEW.id::text),
          NEW.user_id::text || ':' || NEW.reason || ':' || COALESCE(NEW.ref_id, NEW.id::text),
          'granted',
          NEW.amount,
          NEW.created_at
        )
        ON CONFLICT (idempotency_key) DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  await pool.query("DROP TRIGGER IF EXISTS coin_transactions_reward_claim_mirror ON coin_transactions");
  await pool.query(`
    CREATE TRIGGER coin_transactions_reward_claim_mirror
    AFTER INSERT ON coin_transactions
    FOR EACH ROW EXECUTE FUNCTION mirror_coin_transaction_to_reward_claim()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_items (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      equipped BOOLEAN NOT NULL DEFAULT false,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, item_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_products (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      bundle_id TEXT,
      price INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_rewards (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ad_session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      reward_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS ad_rewards_user_session_idx ON ad_rewards (user_id, ad_session_id)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'classic',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_results (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_session_id UUID NOT NULL,
      mode TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      survival_time REAL NOT NULL DEFAULT 0,
      suspicious BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, game_session_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboards (
      id BIGSERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS achievements (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      reward INTEGER NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attendance_date DATE NOT NULL,
      reward_amount INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, attendance_date)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id BIGSERIAL PRIMARY KEY,
      from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (from_user_id, to_user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, friend_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (blocker_id, blocked_user_id),
      CHECK (blocker_id <> blocked_user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderation_actions (
      id BIGSERIAL PRIMARY KEY,
      admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS error_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      level TEXT NOT NULL DEFAULT 'error',
      source TEXT NOT NULL DEFAULT 'server',
      message TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_actions (
      id BIGSERIAL PRIMARY KEY,
      admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_versions (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'android',
      min_supported_version INTEGER NOT NULL DEFAULT 1,
      latest_version INTEGER NOT NULL DEFAULT 1,
      force_update BOOLEAN NOT NULL DEFAULT false,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_status (
      id BIGSERIAL PRIMARY KEY,
      maintenance BOOLEAN NOT NULL DEFAULT false,
      message TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("INSERT INTO app_versions (platform) SELECT 'android' WHERE NOT EXISTS (SELECT 1 FROM app_versions WHERE platform = 'android')");
  await pool.query("INSERT INTO maintenance_status (maintenance, message) SELECT false, '' WHERE NOT EXISTS (SELECT 1 FROM maintenance_status)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_reward_sessions (
      session_token TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_id TEXT UNIQUE,
      reward_amount INTEGER NOT NULL DEFAULT 0,
      ad_unit TEXT NOT NULL DEFAULT '',
      verified_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS ad_reward_sessions_user_idx ON ad_reward_sessions (user_id, created_at DESC)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, friend_id),
      CHECK (user_id <> friend_id)
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS friendships_friend_idx ON friendships (friend_id, status)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_rooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_code VARCHAR(6) NOT NULL UNIQUE,
      host_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      max_players INTEGER NOT NULL DEFAULT 6,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS game_rooms_code_idx ON game_rooms (room_code)");
  await pool.query("CREATE INDEX IF NOT EXISTS game_rooms_mode_status_idx ON game_rooms (mode, status)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_players (
      room_id UUID NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_host BOOLEAN NOT NULL DEFAULT false,
      is_ready BOOLEAN NOT NULL DEFAULT false,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, user_id)
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS room_players_user_idx ON room_players (user_id)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS multiplayer_results (
      id BIGSERIAL PRIMARY KEY,
      room_id UUID REFERENCES game_rooms(id) ON DELETE SET NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      rank INTEGER NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      survived_seconds REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS multiplayer_results_user_idx ON multiplayer_results (user_id, created_at DESC)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zombie_rooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_code VARCHAR(6) UNIQUE NOT NULL,
      host_id UUID REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'waiting',
      max_players INT DEFAULT 4,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS zombie_rooms_code_idx ON zombie_rooms (room_code)");
  await pool.query("CREATE INDEX IF NOT EXISTS zombie_rooms_status_idx ON zombie_rooms (status, created_at DESC)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zombie_players (
      id BIGSERIAL PRIMARY KEY,
      room_id UUID REFERENCES zombie_rooms(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      is_host BOOLEAN DEFAULT false,
      is_ready BOOLEAN DEFAULT false,
      status VARCHAR(20) DEFAULT 'alive',
      joined_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (room_id, user_id)
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS zombie_players_room_idx ON zombie_players (room_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS zombie_players_user_idx ON zombie_players (user_id)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zombie_results (
      id BIGSERIAL PRIMARY KEY,
      room_id UUID REFERENCES zombie_rooms(id) ON DELETE SET NULL,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      rank INT NOT NULL,
      survived_ms INT DEFAULT 0,
      infected_count INT DEFAULT 0,
      is_winner BOOLEAN DEFAULT false,
      played_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS zombie_results_user_idx ON zombie_results (user_id, played_at DESC)");
}

function scheduleSchemaInitialization(delayMs = 0) {
  setTimeout(async () => {
    if (schemaReady || schemaInitializing) return;
    schemaInitializing = true;
    schemaLastAttemptAt = Date.now();
    try {
      await ensureSchema();
      schemaReady = true;
      schemaReadyAt = Date.now();
      schemaLastError = "";
      console.log("Database schema ready");
    } catch (error) {
      schemaLastError = error?.message || String(error);
      console.error("Database schema initialization failed; retrying", {
        retryMs: schemaRetryMs,
        error: schemaLastError,
      });
      scheduleSchemaInitialization(schemaRetryMs);
    } finally {
      schemaInitializing = false;
    }
  }, Math.max(0, delayMs));
}

app.use(async (error, req, res, _next) => {
  console.error(error);
  try {
    const payload = bearerToken(req) ? verifyAuthToken(bearerToken(req)) : null;
    await recordErrorLog({
      userId: payload?.sub || null,
      level: "error",
      source: "server",
      message: error?.message || "server_error",
      details: { path: req.path, method: req.method },
      requestId: req.requestId || "",
    });
  } catch {
    // Avoid masking the original server error.
  }
  res.status(error.statusCode || 500).json({ error: "server_error", request_id: req.requestId || "" });
});

attachZombieMultiplayer({
  httpServer,
  io,
  pool,
  verifyAuthToken,
  makeRoomCode,
  onlineUserIds,
  serverInfo: {
    server_version: appVersion,
    commit: serverCommit,
    build_id: serverBuildId,
    started_at: new Date(appStartedAt).toISOString(),
    multiplayer_protocol: multiplayerProtocol,
  },
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Laser Dodge API v2 listening on http://0.0.0.0:${port}`);
  scheduleSchemaInitialization(0);
});
