import { WebSocketServer } from "ws";

const ZOMBIE_MATCH_SIZE = 4;
const TAG_MATCH_SIZE = 6;
const BATTLE_ROYALE_MATCH_SIZE = 6;
const MIN_MATCH_SIZE = 2;
const QUICK_MATCH_TIMEOUT_MS = 30_000;
const POSITION_SYNC_MS = 15;
const TOUCH_RADIUS = 30;
const ZOMBIE_ROUND_MS = 90_000;
const ZOMBIE_ROLE_REVEAL_MS = 3_000;
const ZOMBIE_MISSILE_ORB_SPAWN_MS = 2000;
const ZOMBIE_MISSILE_ORB_LIFETIME_MS = 9000;
const ZOMBIE_MISSILE_ORB_RADIUS = 170;
const ZOMBIE_MISSILE_PICKUP_RADIUS = 34;
const ZOMBIE_MISSILE_CHARGE_REQUIRED = 2;
const ZOMBIE_MISSILE_SLOW_MS = 2500;
const ZOMBIE_MISSILE_EFFECT_MS = 720;
const ZOMBIE_COIN_HARD_CAP = 40;
const TAG_ROUND_MS = 180_000;
const TAG_IMMUNITY_MS = 1_200;
const TAG_TOUCH_COOLDOWN_MS = 300;
const TAG_STALE_POSITION_MS = 1_500;
const TAG_TAGGER_COUNT = 2;
const TAG_RUNNER_WIN_SURVIVORS = 1;
const TAG_PRISON = { x: 0, y: 0 };
const TAG_PRISON_RADIUS = 96;
const TAG_RESCUE_RADIUS = 118;
const TAG_RESCUE_MS = 5_000;
const TAG_BOOST_MS = 3_500;
const TAG_BOOST_COOLDOWN_MS = 12_000;
const TAG_DASH_MS = 420;
const TAG_DASH_COOLDOWN_MS = 9_000;
const TAG_ITEM_SELECT_MS = 10_000;
const TAG_HUNTER_ITEMS = new Set(["hunter_missile", "hunter_radar", "prison_sentinel"]);
const TAG_RUNNER_ITEMS = new Set(["runner_clone", "runner_speed_points", "runner_smoke"]);
const TAG_ITEM_DEFAULTS = { tagger: "hunter_radar", runner: "runner_clone" };
const TAG_ITEM_COOLDOWNS = {
  hunter_missile: 14_000,
  prison_sentinel: 20_000,
  runner_clone: 18_000,
  runner_speed_points: 12_000,
  runner_smoke: 16_000,
};
const TAG_MISSILE_SLOW_MS = 3_500;
const TAG_SENTINEL_MS = 10_000;
const TAG_CLONE_MS = 5_000;
const TAG_SPEED_ITEM_MS = 6_000;
const TAG_SMOKE_MS = 4_000;
const TAG_CLONE_SPEED = 260;
const TAG_SENTINEL_SPEED = 330;
const TAG_SENTINEL_FIRE_RADIUS = 260;
const TAG_SENTINEL_FIRE_COOLDOWN_MS = 1200;
const TAG_SENTINEL_MISSILE_SLOW_MS = 1800;
const TAG_SPEED_ORB_MS = 7000;
const TAG_SPEED_ORB_SPAWN_MS = 1500;
const TAG_SPEED_ORB_RADIUS = 42;
const TAG_SPEED_PICKUP_MS = 6000;
const TAG_SPEED_MAX_STACKS = 3;
const TAG_COIN_HARD_CAP = 45;
const POSITION_MIN_INTERVAL_MS = 12;
const POSITION_MAX_ABS = 200_000;
const POSITION_MAX_SPEED = 1_600;
const POSITION_GRACE_DISTANCE = 90;
const PLAYER_LEFT_REWARD_MIN_MS = 30_000;
const BR_INITIAL_HP = 4;
const BR_RECONNECT_GRACE_MS = 10_000;
const BR_QUICK_START_WAIT_MS = 25_000;
const BR_START_TEXT_MS = 1_000;
const BR_START_COUNTDOWN_MS = 3_000 + BR_START_TEXT_MS;
const BR_INITIAL_ZONE_RADIUS = 1800;
const BR_FINAL_ZONE_RADIUS = 260;
const BR_ZONE_SHRINK_MS = 120_000;
const BR_ZONE_DAMAGE_INTERVAL_MS = 1000;
const BR_SPAWN_RADIUS = 900;
const BR_ORB_SPAWN_MS = 1000;
const BR_ORB_LIFETIME_MS = 14000;
const BR_SHIELD_CHARGE_REQUIRED = 3;
const BR_MISSILE_CHARGE_REQUIRED = 2;
const BR_ORB_PICKUP_RADIUS = 34;
const BR_HOMING_SPEED = 520;
const BR_HOMING_LIFETIME_MS = 3000;
const BR_HOMING_MAX_DISTANCE = 1200;
const BR_HOMING_ACQUIRE_RADIUS = 640;
const BR_HOMING_HIT_RADIUS = 40;
const BR_HOMING_TURN_RATE = Math.PI * 1.55;
const BR_LASER_HIT_RADIUS = 42;
const BR_PROJECTILE_HIT_RADIUS = 52;
const BR_COIN_HARD_CAP = 50;
const MULTI_HAZARD_LIFETIME_MS = 6200;
const MULTI_LASER_WARNING_MS = 800;
const MULTI_HAZARD_MAX = 8;
const BR_HAZARD_BALANCE = {
  introGraceMs: 5000,
  laser: {
    warningMs: 900,
    damageVisualLeadMs: 250,
    minCooldownMs: 650,
  },
  arrow: {
    visualLeadMs: 650,
    minSpawnAfterActiveMs: 5000,
    speedMultiplier: 0.95,
    minCooldownMs: 750,
  },
  syncedHoming: {
    visualLeadMs: 850,
    minSpawnAfterActiveMs: 20000,
    cooldownMs: 9000,
    maxActive: 1,
  },
  greenMeteor: {
    enabled: true,
    allowedAfterMatchMs: 8000,
    stopSafeZoneRatio: 0.55,
    spawnSafeZoneRatioMin: 0.58,
    cooldownMs: 12000,
    maxActive: 1,
    warningMs: 800,
    parentVisualLeadMs: 700,
    parentTravelMsMin: 1100,
    parentTravelMsMax: 1400,
    shardVisualLeadMs: 600,
    shardLifetimeMs: 1600,
    shardCount: 8,
    shardSpeedMultiplierOfArrow: 0.7,
    shardRadiusMultiplierOfArrow: 0.85,
    blockNearSafeZoneShrinkMs: 700,
    blockNearSyncedHomingMs: 2000,
  },
};
const BR_PROJECTILE_DAMAGE_GRACE_MS = BR_HAZARD_BALANCE.arrow.visualLeadMs;
const BR_ARROW_SPEED = 360 * BR_HAZARD_BALANCE.arrow.speedMultiplier;
const BR_SYNCED_HOMING_SPEED = 430;
const BR_GREEN_METEOR_PARENT_RADIUS = 42;
const BR_GREEN_METEOR_SHARD_RADIUS = Math.round(BR_PROJECTILE_HIT_RADIUS * BR_HAZARD_BALANCE.greenMeteor.shardRadiusMultiplierOfArrow);

export function attachZombieMultiplayer({ httpServer, io, pool, verifyAuthToken, makeRoomCode, onlineUserIds = new Set(), serverInfo = {} }) {
  const rooms = new Map();
  const quickQueue = [];
  const clientsByUserId = new Map();
  const pendingInvites = new Map();

  const wsServer = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/zombie-ws") return;
    const payload = verifyAuthToken(url.searchParams.get("token") || "");
    if (!payload) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request, payload);
    });
  });

  wsServer.on("connection", (ws, _request, payload) => {
    const client = makeWsClient(ws, payload);
    registerClient(client);
  });

  io.on("connection", (socket) => {
    const client = makeSocketIoClient(socket);
    registerClient(client);
  });

  function registerClient(client) {
    const existing = clientsByUserId.get(client.userId);
    if (existing && existing !== client) {
      existing.send("request_failed", { ok: false, action: "session", error: "signed_in_elsewhere" });
      leaveQuickMatch(existing, false);
      removeFromCurrentRoom(existing);
    }
    clientsByUserId.set(client.userId, client);
    onlineUserIds.add(client.userId);
    client.send("server_hello", {
      ok: true,
      ...serverInfo,
      connected_at: new Date().toISOString(),
    });
    restoreBattleRoyaleClient(client);
    client.on("quick_match", (data) => joinQuickMatch(client, data));
    client.on("cancel_quick_match", () => leaveQuickMatch(client, true));
    client.on("create_room", (data, ack) => createRoom(client, data, ack));
    client.on("join_room", (data, ack) => joinRoom(client, data, ack));
    client.on("leave_room", () => removeFromCurrentRoom(client));
    client.on("kick_player", (data, ack) => kickPlayer(client, data, ack));
    client.on("set_room_private", (data, ack) => setRoomPrivate(client, data, ack));
    client.on("invite_friend", (data, ack) => inviteFriend(client, data, ack));
    client.on("accept_invite", (data, ack) => acceptInvite(client, data, ack));
    client.on("player_ready", (data) => setReady(client, data));
    client.on("return_to_lobby", () => markReturnedToLobby(client));
    client.on("start_game", () => startGameByHost(client));
    client.on("position_update", (data) => updatePosition(client, data));
    client.on("player_infected", (data) => requestInfection(client, data));
    client.on("zombie_orb_collect", (data) => requestZombieMissileOrbCollect(client, data));
    client.on("tag_touch", (data) => requestTagTouch(client, data));
    client.on("tag_ability", () => requestTagAbility(client));
    client.on("tag_item_select", (data) => requestTagItemSelect(client, data));
    client.on("tag_item_use", () => requestTagItemUse(client));
    client.on("br_damage", (data) => requestBattleRoyaleDamage(client, data));
    client.on("br_orb_collect", (data) => requestBattleRoyaleOrbCollect(client, data));
    client.on("game_over", (data, ack) => finishGame(client, data, ack));
    client.onClose(() => disconnectClient(client));
  }

  async function createRoom(client, data = {}, ack = null) {
    const mode = normalizeMultiplayerMode(data.mode);
    const defaultMax = maxPlayersForMode(mode);
    const maxPlayers = clampInt(data.max_players, 2, defaultMax, defaultMax);
    const tagVariant = mode === "tag" ? normalizeTagVariant(data.tag_variant || data.settings?.tag_variant) : "basic";
    console.info(`[CREATE_ROOM_REQUEST] userId=${client.userId} mode=${mode} maxPlayers=${maxPlayers} private=${Boolean(data.private)} tagVariant=${tagVariant}`);
    try {
      const room = makeRoom(mode, client, maxPlayers, false, tagVariant);
      room.private = Boolean(data.private);
      room.settings = cleanRoomSettings(data.settings);
      room.settings.tag_variant = tagVariant;
      await persistRoom(room, client.userId);
      addPlayerToRoom(room, client, true);
      await persistRoomPlayer(room, client.userId, true);
      client.roomCode = room.code;
      sendAck(ack, { ok: true, room: serializeRoom(room) });
      client.send("room_created", { room: serializeRoom(room), room_code: room.code });
      broadcastRoom(room, "room_updated", serializeRoom(room));
      updateFullRoomAutoStart(room);
      console.info(`[CREATE_ROOM_CREATED] userId=${client.userId} roomCode=${room.code} mode=${mode} maxPlayers=${maxPlayers}`);
    } catch (error) {
      console.error(`[CREATE_ROOM_FAILED] userId=${client.userId} mode=${mode} error=${error?.message || String(error)}`);
      sendRequestFailed(client, ack, "create_room", "room_create_failed");
    }
  }

  async function joinRoom(client, data = {}, ack = null) {
    const code = String(data.room_code || data.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendRequestFailed(client, ack, "join_room", "room_not_found");
    if (room.status === "playing") return sendRequestFailed(client, ack, "join_room", "room_already_started");
    if (room.status === "finished") return sendRequestFailed(client, ack, "join_room", "room_finished");
    if (room.status !== "waiting") return sendRequestFailed(client, ack, "join_room", "room_not_available");
    if (room.players.size >= room.maxPlayers) return sendRequestFailed(client, ack, "join_room", "room_full");
    addPlayerToRoom(room, client, false);
    await persistRoomPlayer(room, client.userId, false);
    const payload = { ok: true, room: serializeRoom(room) };
    sendAck(ack, payload);
    client.send("room_joined", payload);
    broadcastRoom(room, "room_updated", serializeRoom(room));
    updateFullRoomAutoStart(room);
  }

  async function joinQuickMatch(client, data = {}) {
    leaveQuickMatch(client, false);
    const mode = normalizeMultiplayerMode(data.mode);
    const tagVariant = mode === "tag" ? normalizeTagVariant(data.tag_variant) : "basic";
    console.info(`[QUICK_MATCH_REQUEST] userId=${client.userId} mode=${mode} tagVariant=${tagVariant}`);
    const openRoom = findOpenQuickRoom(mode, tagVariant);
    if (openRoom) {
      addPlayerToRoom(openRoom, client, false);
      const quickPlayer = openRoom.players.get(client.userId);
      if (quickPlayer) {
        quickPlayer.returnedToLobby = true;
        quickPlayer.ready = true;
      }
      await persistRoomPlayer(openRoom, client.userId, false);
      const payload = { ok: true, room: serializeRoom(openRoom), quick_match: true };
      client.send("room_joined", payload);
      broadcastRoom(openRoom, "room_updated", serializeRoom(openRoom));
      updateFullRoomAutoStart(openRoom);
      updateQuickRoomStart(openRoom);
      emitQuickQueue();
      console.info(`[QUICK_MATCH_ROOM_JOINED] userId=${client.userId} roomCode=${openRoom.code} mode=${mode} players=${openRoom.players.size}/${openRoom.maxPlayers}`);
      return;
    }

    try {
      const room = makeRoom(mode, client, quickMatchSizeForMode(mode), false, tagVariant);
      room.settings.tag_variant = tagVariant;
      room.quickMatchRoom = true;
      await persistRoom(room, client.userId);
      addPlayerToRoom(room, client, true);
      await persistRoomPlayer(room, client.userId, true);
      client.roomCode = room.code;
      const payload = { ok: true, room: serializeRoom(room), room_code: room.code, quick_match: true };
      client.send("room_created", payload);
      broadcastRoom(room, "room_updated", serializeRoom(room));
      updateFullRoomAutoStart(room);
      updateQuickRoomStart(room);
      emitQuickQueue();
      console.info(`[QUICK_MATCH_ROOM_CREATED] userId=${client.userId} roomCode=${room.code} mode=${mode} maxPlayers=${room.maxPlayers}`);
    } catch (error) {
      console.error(`[QUICK_MATCH_FAILED] userId=${client.userId} mode=${mode} error=${error?.message || String(error)}`);
      sendRequestFailed(client, null, "quick_match", "room_create_failed");
    }
  }

  function findOpenQuickRoom(mode, tagVariant = "basic") {
    let fallbackRoom = null;
    for (const room of rooms.values()) {
      if (room.private) continue;
      if (room.status !== "waiting") continue;
      if (room.mode !== mode) continue;
      if (room.players.size >= room.maxPlayers) continue;
      if ((room.tagVariant || "basic") === tagVariant) return room;
      if (!fallbackRoom) fallbackRoom = room;
    }
    return fallbackRoom;
  }

  function leaveQuickMatch(client, notify) {
    const idx = quickQueue.findIndex((entry) => entry.client === client);
    if (idx >= 0) {
      const [entry] = quickQueue.splice(idx, 1);
      clearTimeout(entry.timer);
      if (notify) client.send("room_updated", { queue_count: 0, max_players: quickMatchSizeForMode(entry.mode), mode: entry.mode, tag_variant: entry.tagVariant || "basic", cancelled: true });
      emitQuickQueue();
    }
  }

  function startQuickMatchFromEntry(entry) {
    if (!quickQueue.includes(entry)) return;
    const matchSize = quickMatchSizeForMode(entry.mode);
    const key = quickMatchKey(entry.mode, entry.tagVariant);
    const count = Math.min(matchSize, quickQueue.filter((queued) => quickMatchKey(queued.mode, queued.tagVariant) === key).length);
    if (count < MIN_MATCH_SIZE) {
      entry.timer = setTimeout(() => startQuickMatchFromEntry(entry), QUICK_MATCH_TIMEOUT_MS);
      entry.client.send("room_updated", {
        queue_count: count,
        max_players: matchSize,
        mode: entry.mode,
        tag_variant: entry.tagVariant || "basic",
        waiting_for_players: true,
      });
      return;
    }
    const group = takeQuickMatchEntries(entry.mode, count, entry.tagVariant);
    startQuickMatch(group);
  }

  async function startQuickMatch(entries) {
    if (entries.length < MIN_MATCH_SIZE) return;
    for (const entry of entries) clearTimeout(entry.timer);
    const host = entries[0].client;
    const mode = entries[0].mode || "zombie";
    const tagVariant = mode === "tag" ? normalizeTagVariant(entries[0].tagVariant) : "basic";
    const room = makeRoom(mode, host, quickMatchSizeForMode(mode), true, tagVariant);
    room.settings.tag_variant = tagVariant;
    await persistRoom(room, host.userId);
    for (const entry of entries) {
      addPlayerToRoom(room, entry.client, entry.client === host);
      await persistRoomPlayer(room, entry.client.userId, entry.client === host);
    }
    broadcastRoom(room, "match_found", serializeRoom(room));
    broadcastRoom(room, "room_updated", serializeRoom(room));
    startRoom(room);
    emitQuickQueue();
  }

  function emitQuickQueue() {
    for (const entry of quickQueue) {
      const key = quickMatchKey(entry.mode, entry.tagVariant);
      const queueCount = quickQueue.filter((queued) => quickMatchKey(queued.mode, queued.tagVariant) === key).length;
      entry.client.send("room_updated", { queue_count: queueCount, max_players: quickMatchSizeForMode(entry.mode), mode: entry.mode, tag_variant: entry.tagVariant || "basic" });
    }
  }

  function takeQuickMatchEntries(mode, count, tagVariant = "basic") {
    const entries = [];
    const key = quickMatchKey(mode, tagVariant);
    for (let i = 0; i < quickQueue.length && entries.length < count;) {
      if (quickMatchKey(quickQueue[i].mode, quickQueue[i].tagVariant) !== key) {
        i += 1;
        continue;
      }
      entries.push(quickQueue.splice(i, 1)[0]);
    }
    return entries;
  }

  function inviteFriend(client, data = {}, ack = null) {
    const friendId = String(data.friend_id || data.user_id || "").trim();
    const target = clientsByUserId.get(friendId);
    if (!target) return sendRequestFailed(client, ack, "invite_friend", "friend_offline");
    let room = getClientRoom(client);
    if (!room) {
      const mode = normalizeMultiplayerMode(data.mode);
      const tagVariant = mode === "tag" ? normalizeTagVariant(data.tag_variant) : "basic";
      room = makeRoom(mode, client, quickMatchSizeForMode(mode), false, tagVariant);
      room.private = true;
      room.settings.tag_variant = tagVariant;
      addPlayerToRoom(room, client, true);
      persistRoom(room, client.userId).then(() => persistRoomPlayer(room, client.userId, true)).catch((error) => {
        console.error("[invite] persist room failed", {
          room: room.code,
          mode: room.mode,
          userId: client.userId,
          error: error?.message || String(error),
        });
      });
    }
    const inviteId = `${room.code}:${client.userId}:${friendId}:${Date.now()}`;
    pendingInvites.set(inviteId, { roomCode: room.code, fromUserId: client.userId, toUserId: friendId, expiresAt: Date.now() + 30_000 });
    setTimeout(() => pendingInvites.delete(inviteId), 30_000);
    target.send("invite_received", { invite_id: inviteId, room_code: room.code, from_user_id: client.userId, from_nickname: client.nickname });
    sendAck(ack, { ok: true, invite_id: inviteId, room: serializeRoom(room) });
    client.send("room_created", { room: serializeRoom(room), room_code: room.code });
  }

  async function acceptInvite(client, data = {}, ack = null) {
    const inviteId = String(data.invite_id || "").trim();
    const invite = pendingInvites.get(inviteId);
    if (!invite || invite.toUserId !== client.userId || invite.expiresAt < Date.now()) {
      return sendRequestFailed(client, ack, "accept_invite", "invite_expired");
    }
    pendingInvites.delete(inviteId);
    await joinRoom(client, { room_code: invite.roomCode }, ack);
  }

  function setReady(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "waiting") return;
    const player = room.players.get(client.userId);
    if (!player) return;
    player.returnedToLobby = true;
    player.ready = Boolean(data.ready);
    broadcastRoom(room, "room_updated", serializeRoom(room));
    updateFullRoomAutoStart(room);
  }

  function markReturnedToLobby(client) {
    const room = getClientRoom(client);
    if (!room || room.status !== "waiting") return;
    const player = room.players.get(client.userId);
    if (!player) return;
    player.returnedToLobby = true;
    player.ready = true;
    broadcastRoom(room, "room_updated", serializeRoom(room));
    updateFullRoomAutoStart(room);
  }

  function startGameByHost(client) {
    const room = getClientRoom(client);
    if (!room) return sendRequestFailed(client, null, "start_game", "room_not_found");
    if (room.status !== "waiting") return sendRequestFailed(client, null, "start_game", "room_not_waiting");
    if (room.hostId !== client.userId) return sendRequestFailed(client, null, "start_game", "not_host");
    if (room.mode === "tag" && room.players.size < TAG_MATCH_SIZE) {
      return sendRequestFailed(client, null, "start_game", "tag_needs_six_players");
    }
    if (room.players.size < 2) return sendRequestFailed(client, null, "start_game", "not_enough_players");
    if (room.players.size >= room.maxPlayers) {
      for (const player of room.players.values()) {
        player.returnedToLobby = true;
        player.ready = true;
      }
    }
    if (!allPlayersReturnedToLobby(room)) {
      return sendRequestFailed(client, null, "start_game", "players_not_in_lobby");
    }
    if ([...room.players.values()].some((player) => !player.ready)) {
      return sendRequestFailed(client, null, "start_game", "players_not_ready");
    }
    startRoom(room);
  }

  function startRoom(room) {
    if (room.status === "playing") return;
    if (room.mode === "tag" && room.players.size < TAG_MATCH_SIZE) {
      clearFullRoomAutoStart(room);
      broadcastRoom(room, "room_updated", serializeRoom(room));
      return;
    }
    clearFullRoomAutoStart(room);
    clearQuickStartTimer(room);
    room.status = "playing";
    room.awaitingLobbyReturn = false;
    room.startedAt = Date.now();
    room.activeAt = room.mode === "zombie"
      ? room.startedAt + ZOMBIE_ROLE_REVEAL_MS
      : (room.mode === "battle_royale" ? room.startedAt + BR_START_COUNTDOWN_MS : room.startedAt);
    room.roundEndsAt = room.mode === "zombie" ? room.activeAt + ZOMBIE_ROUND_MS : 0;
    room.roundId = (room.roundId || 0) + 1;
    room.matchId = makeMatchId(room);
    room.eliminationSequence = 0;
    room.firstZombieDone = false;
    room.resultFinalized = false;
    if (room.mode === "battle_royale") {
      room.brIntroBlockedLogged = false;
      room.hazardSeq = 0;
      room.lastGreenMeteorAt = 0;
      room.lastSyncedHomingAt = 0;
      room.lastSafeZoneDamageAt = 0;
      console.info(`[BR_START_SCHEDULED] event=game_starting match=${room.matchId || ""} room=${room.code} startedAt=${room.startedAt} activeAt=${room.activeAt} countdownMs=${BR_START_COUNTDOWN_MS} startTextMs=${BR_START_TEXT_MS}`);
    }
    for (const player of room.players.values()) {
      player.status = "alive";
      player.role = "survivor";
      player.tagTeam = "";
      player.infectedCount = 0;
      player.zombieMissileCharge = 0;
      player.zombieMissileHits = 0;
      player.zombieSlowUntil = 0;
      player.tagCount = 0;
      player.sentinelContributionCount = 0;
      player.tagImmuneUntil = 0;
      player.survivedMs = 0;
      player.rank = 0;
      player.eliminatedAt = 0;
      player.eliminationSequence = 0;
      player.disconnected = false;
      player.disconnectedAt = 0;
      player.disconnectExpiresAt = 0;
      if (player.disconnectTimeoutTimer) {
        clearTimeout(player.disconnectTimeoutTimer);
        player.disconnectTimeoutTimer = null;
      }
      player.wasRescued = false;
      player.rescuedAndStayedFree = false;
      player.isTagMvp = false;
      player.rewardReason = "";
      player.rewardElapsedMs = 0;
    }
    if (room.mode === "zombie") setupZombieRoom(room);
    if (room.mode === "tag") setupTagRoom(room);
    if (room.mode === "battle_royale") setupBattleRoyale(room);
    setupMultiplayerHazards(room);
    broadcastRoom(room, "game_starting", { countdown: 3, room: serializeRoom(room) });
    if (room.mode === "zombie") {
      room.finishTimer = setTimeout(() => finishRoom(room, currentZombieSurvivors(room)), Math.max(1, room.roundEndsAt - Date.now()));
    }
    if (room.mode === "tag") {
      const activeAt = room.tagActiveAt || room.startedAt;
      room.finishTimer = setTimeout(() => finishTagRoom(room, "time_up"), Math.max(1, activeAt + TAG_ROUND_MS - Date.now()));
    }
    room.syncTimer = setInterval(() => syncPositions(room), POSITION_SYNC_MS);
  }

  function updateFullRoomAutoStart(room) {
    if (!room || room.status !== "waiting") return;
    if (room.awaitingLobbyReturn) {
      clearFullRoomAutoStart(room);
      broadcastRoom(room, "room_updated", serializeRoom(room));
      return;
    }
    if (room.mode === "tag" && room.players.size < TAG_MATCH_SIZE) {
      clearFullRoomAutoStart(room);
      broadcastRoom(room, "room_updated", serializeRoom(room));
      return;
    }
    const full = room.players.size >= room.maxPlayers;
    if (!full) {
      clearFullRoomAutoStart(room);
      broadcastRoom(room, "room_updated", serializeRoom(room));
      return;
    }
    for (const player of room.players.values()) {
      player.returnedToLobby = true;
      player.ready = true;
    }
    if (!allPlayersReturnedToLobby(room) || [...room.players.values()].some((player) => !player.ready)) {
      clearFullRoomAutoStart(room);
      broadcastRoom(room, "room_updated", serializeRoom(room));
      return;
    }
    if (room.autoStartTimer) return;
    room.autoStartAt = Date.now() + 5_000;
    broadcastRoom(room, "room_updated", serializeRoom(room));
    room.autoStartTimer = setTimeout(() => {
      room.autoStartTimer = null;
      if (!rooms.has(room.code)) return;
      if (room.status !== "waiting") return;
      if (room.mode === "tag" && room.players.size < TAG_MATCH_SIZE) {
        room.autoStartAt = 0;
        broadcastRoom(room, "room_updated", serializeRoom(room));
        return;
      }
      if (room.players.size < room.maxPlayers) {
        room.autoStartAt = 0;
        broadcastRoom(room, "room_updated", serializeRoom(room));
        return;
      }
      for (const player of room.players.values()) {
        player.returnedToLobby = true;
        player.ready = true;
      }
      if (!allPlayersReturnedToLobby(room) || [...room.players.values()].some((player) => !player.ready)) {
        room.autoStartAt = 0;
        broadcastRoom(room, "room_updated", serializeRoom(room));
        return;
      }
      startRoom(room);
    }, 5_000);
  }

  function allPlayersReturnedToLobby(room) {
    return [...room.players.values()].every((player) => player.returnedToLobby !== false);
  }

  function clearFullRoomAutoStart(room) {
    if (!room) return;
    if (room.autoStartTimer) {
      clearTimeout(room.autoStartTimer);
      room.autoStartTimer = null;
    }
    room.autoStartAt = 0;
  }

  function updateQuickRoomStart(room) {
    if (!room || room.status !== "waiting" || !room.quickMatchRoom || room.mode !== "battle_royale") return;
    if (room.players.size >= room.maxPlayers) return;
    if (room.quickStartTimer) return;
    room.quickStartAt = Date.now() + BR_QUICK_START_WAIT_MS;
    broadcastRoom(room, "room_updated", serializeRoom(room));
    room.quickStartTimer = setTimeout(() => {
      room.quickStartTimer = null;
      if (!rooms.has(room.code) || room.status !== "waiting" || room.mode !== "battle_royale") return;
      if (room.players.size >= MIN_MATCH_SIZE) {
        for (const player of room.players.values()) {
          player.returnedToLobby = true;
          player.ready = true;
        }
        startRoom(room);
      } else {
        room.quickStartAt = 0;
        const failedPayload = {
          ...serializeRoom(room),
          quick_match_failed: true,
          reason: "not_enough_players",
        };
        broadcastRoom(room, "room_updated", failedPayload);
        for (const player of room.players.values()) {
          const playerClient = clientsByUserId.get(player.userId);
          if (playerClient) playerClient.roomCode = "";
        }
        rooms.delete(room.code);
      }
    }, BR_QUICK_START_WAIT_MS);
  }

  function clearQuickStartTimer(room) {
    if (!room) return;
    if (room.quickStartTimer) {
      clearTimeout(room.quickStartTimer);
      room.quickStartTimer = null;
    }
    room.quickStartAt = 0;
  }

  function setRoomPrivate(client, data = {}, ack = null) {
    const room = getClientRoom(client);
    if (!room) return sendRequestFailed(client, ack, "set_room_private", "room_not_found");
    if (room.hostId !== client.userId) return sendRequestFailed(client, ack, "set_room_private", "not_host");
    if (room.status !== "waiting") return sendRequestFailed(client, ack, "set_room_private", "room_not_waiting");
    room.private = Boolean(data.private);
    const payload = { ok: true, room: serializeRoom(room) };
    sendAck(ack, payload);
    broadcastRoom(room, "room_updated", serializeRoom(room));
    emitQuickQueue();
  }

  function kickPlayer(client, data = {}, ack = null) {
    const room = getClientRoom(client);
    if (!room) return sendRequestFailed(client, ack, "kick_player", "room_not_found");
    if (room.hostId !== client.userId) return sendRequestFailed(client, ack, "kick_player", "not_host");
    const targetId = String(data.user_id || data.target_user_id || "").trim();
    if (!targetId || !room.players.has(targetId)) return sendRequestFailed(client, ack, "kick_player", "target_not_found");
    if (targetId === client.userId) return sendRequestFailed(client, ack, "kick_player", "cannot_kick_self");
    const targetClient = clientsByUserId.get(targetId);
    if (targetClient) {
      targetClient.send("kicked", { room_code: room.code, reason: "host_kick" });
      removeFromCurrentRoom(targetClient);
    } else {
      room.players.delete(targetId);
      broadcastRoom(room, "room_updated", serializeRoom(room));
      updateFullRoomAutoStart(room);
    }
    sendAck(ack, { ok: true });
  }

  function updatePosition(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing") return;
    const player = room.players.get(client.userId);
    if (!player) return;
    const now = Date.now();
    const sanitized = sanitizePositionUpdate(player, data, now);
    if (!sanitized) return;
    player.x = sanitized.x;
    player.y = sanitized.y;
    player.vx = Number(data.vx) || 0;
    player.vy = Number(data.vy) || 0;
    if (room.mode !== "battle_royale") {
      player.shield = Boolean(data.shield);
    }
    player.skinId = cleanCosmeticId(data.skin_id || data.skinId || player.skinId || "skin_default");
    const facingAngle = finiteNumber(data.facing_angle ?? data.facingAngle);
    if (facingAngle !== null) player.facingAngle = facingAngle;
    player.updatedAt = now;
    player.positionInitialized = true;
    if (room.mode === "tag" && player.status === "jailed") clampPlayerToTagPrison(player);
    serverCheckInfections(room);
    serverCheckTags(room);
    serverCheckBattleRoyale(room);
  }

  function requestInfection(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "zombie") return;
    const now = Date.now();
    if (!isZombieRoundActive(room, now)) return;
    const player = room.players.get(client.userId);
    if (!player || player.status !== "zombie") return;
    const targetId = String(data.target_user_id || client.userId);
    const rawReason = String(data.reason || "contact").trim().toLowerCase();
    if (rawReason !== "contact") return;
    const target = room.players.get(targetId);
    if (!target || target.status === "zombie") return;
    if (!hasFreshPosition(player, now) || !hasFreshPosition(target, now)) return;
    if (distance(player, target) > TOUCH_RADIUS * 1.25) return;
    infectPlayer(room, target, "contact", player.userId);
  }

  function requestZombieMissileOrbCollect(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "zombie") return;
    const now = Date.now();
    if (!isZombieRoundActive(room, now)) return;
    const player = room.players.get(client.userId);
    if (!player || player.status === "zombie") return;
    const orbId = String(data.orb_id || data.id || "");
    if (!orbId) return;
    const orbs = Array.isArray(room.zombieMissileOrbs) ? room.zombieMissileOrbs : [];
    const index = orbs.findIndex((orb) => orb.id === orbId && (orb.until || 0) > now);
    if (index < 0) return;
    const orb = orbs[index];
    const kind = String(orb.kind || orb.type || "");
    if (kind !== "M") {
      orbs.splice(index, 1);
      room.zombieMissileOrbs = orbs;
      return;
    }
    const clientPoint = finiteNumber(data.x) !== null && finiteNumber(data.y) !== null
      ? { x: clampNumber(Number(data.x), -POSITION_MAX_ABS, POSITION_MAX_ABS), y: clampNumber(Number(data.y), -POSITION_MAX_ABS, POSITION_MAX_ABS) }
      : null;
    const serverDistance = distancePoint(player, orb);
    const clientDistance = clientPoint ? distancePoint(clientPoint, orb) : Infinity;
    const touchRadius = ZOMBIE_MISSILE_PICKUP_RADIUS;
    if (Math.min(serverDistance, clientDistance) > touchRadius) return;
    orbs.splice(index, 1);
    room.zombieMissileOrbs = orbs;
    player.zombieMissileCharge = Math.min(ZOMBIE_MISSILE_CHARGE_REQUIRED, (player.zombieMissileCharge || 0) + 1);
    broadcastRoom(room, "zombie_event", {
      type: "missile_orb_collected",
      event: "zombie_orb_collected",
      orb_id: orb.id,
      user_id: player.userId,
      charge: player.zombieMissileCharge,
      required: ZOMBIE_MISSILE_CHARGE_REQUIRED,
      room: serializeRoom(room),
    });
    if (player.zombieMissileCharge >= ZOMBIE_MISSILE_CHARGE_REQUIRED) {
      player.zombieMissileCharge = 0;
      fireZombieMissile(room, player, now);
    }
  }

  function requestTagTouch(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "tag") return;
    const now = Date.now();
    if (now < (room.tagActiveAt || room.startedAt)) return;
    if (now > (room.tagActiveAt || room.startedAt) + TAG_ROUND_MS) return;
    const tagger = room.players.get(client.userId);
    if (!tagger || tagger.role !== "tagger" || tagger.status !== "tagger") return;
    if ((tagger.nextTagAllowedUntil || 0) > now) return;
    if (!hasFreshPosition(tagger, now)) return;
    const targetId = String(data.target_user_id || data.user_id || "");
    if (!targetId) return;
    const target = room.players.get(targetId);
    if (!target || target.role !== "runner" || target.status !== "runner") return;
    if (!hasFreshPosition(target, now)) return;
    if (distance(tagger, target) > TOUCH_RADIUS * 1.45) return;
    tagPlayer(room, tagger, target, "client_touch");
  }

  function requestTagAbility(client) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "tag") return;
    const player = room.players.get(client.userId);
    if (!player) return;
    const now = Date.now();
    if (now < (room.tagActiveAt || room.startedAt)) return;
    if (player.role === "tagger" && player.status === "tagger") {
      if ((player.tagBoostReadyAt || 0) > now) return;
      player.tagBoostUntil = now + TAG_BOOST_MS;
      player.tagBoostReadyAt = now + TAG_BOOST_COOLDOWN_MS;
      broadcastRoom(room, "tag_event", { type: "boost", user_id: player.userId, nickname: player.nickname, room: serializeRoom(room) });
    } else if (player.role === "runner" && player.status === "runner") {
      if ((player.runnerDashReadyAt || 0) > now) return;
      player.runnerDashUntil = now + TAG_DASH_MS;
      player.runnerDashReadyAt = now + TAG_DASH_COOLDOWN_MS;
      broadcastRoom(room, "tag_event", { type: "dash", user_id: player.userId, nickname: player.nickname, room: serializeRoom(room) });
    }
  }

  function requestTagItemSelect(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "tag" || room.tagVariant !== "item") return;
    const player = room.players.get(client.userId);
    if (!player || player.tagItem) return;
    const now = Date.now();
    if (now > (room.tagItemSelectUntil || 0)) return;
    const itemId = String(data.item_id || data.item || "").trim();
    if (!isValidTagItemForRole(player.role, itemId)) return;
    player.tagItem = itemId;
    broadcastRoom(room, "tag_event", { type: "item_selected", user_id: player.userId, item_id: itemId, room: serializeRoom(room) });
  }

  function requestTagItemUse(client) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "tag" || room.tagVariant !== "item") return;
    ensureTagItemRoundActive(room, Date.now());
    const player = room.players.get(client.userId);
    if (!player || player.status === "jailed") return;
    const now = Date.now();
    if (now < (room.tagActiveAt || room.startedAt)) return;
    const itemId = String(player.tagItem || "");
    if (!itemId || itemId === "hunter_radar") return;
    if ((player.tagItemReadyAt || 0) > now) return;
    if (!isValidTagItemForRole(player.role, itemId)) return;
    if (itemId === "hunter_missile") {
      const target = nearestActiveRunner(room, player, now);
      if (!target) return;
      player.tagItemReadyAt = now + (TAG_ITEM_COOLDOWNS[itemId] || 12_000);
      target.tagSlowUntil = now + TAG_MISSILE_SLOW_MS;
      broadcastRoom(room, "tag_event", {
        type: "item_effect",
        item_id: itemId,
        user_id: player.userId,
        target_user_id: target.userId,
        until: target.tagSlowUntil,
        effect: "slow",
        slow_ms: TAG_MISSILE_SLOW_MS,
        start: { x: Number(player.x) || 0, y: Number(player.y) || 0 },
        target: { x: Number(target.x) || 0, y: Number(target.y) || 0 },
        room: serializeRoom(room),
      });
    } else if (itemId === "prison_sentinel") {
      if (!room.tagRescue || !room.tagRescue.startedAt) return;
      player.tagItemReadyAt = now + (TAG_ITEM_COOLDOWNS[itemId] || 12_000);
      room.pendingPrisonSentinel = { ownerId: player.userId, spawnAt: now + 3_000 };
      broadcastRoom(room, "tag_event", { type: "sentinel_warning", item_id: itemId, user_id: player.userId, room: serializeRoom(room) });
    } else if (itemId === "runner_clone") {
      player.tagItemReadyAt = now + (TAG_ITEM_COOLDOWNS[itemId] || 12_000);
      player.cloneUntil = now + TAG_CLONE_MS;
      spawnTagClones(room, player, now);
      broadcastRoom(room, "tag_event", { type: "item_effect", item_id: itemId, user_id: player.userId, until: player.cloneUntil, room: serializeRoom(room) });
    } else if (itemId === "runner_speed_points") {
      player.tagItemReadyAt = now + (TAG_ITEM_COOLDOWNS[itemId] || 12_000);
      player.speedPointModeUntil = now + TAG_SPEED_ITEM_MS;
      player.nextSpeedOrbAt = now;
      broadcastRoom(room, "tag_event", { type: "item_effect", item_id: itemId, user_id: player.userId, until: player.speedPointModeUntil, room: serializeRoom(room) });
    } else if (itemId === "runner_smoke") {
      player.tagItemReadyAt = now + (TAG_ITEM_COOLDOWNS[itemId] || 12_000);
      player.smokeUntil = now + TAG_SMOKE_MS;
      broadcastRoom(room, "tag_event", { type: "item_effect", item_id: itemId, user_id: player.userId, until: player.smokeUntil, room: serializeRoom(room) });
    }
  }

  function requestBattleRoyaleDamage(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return;
    console.info(`[BR_DAMAGE_BLOCKED] matchId=${room.matchId || ""} roomCode=${room.code} playerId=${client.userId} hazardId=${String(data.hazardId || "")} hazardType=${String(data.hazardType || "")} reason=client_damage_legacy_blocked serverTime=${Date.now()} activeAt=${room.activeAt || 0} damageEnabledAt=0`);
  }

  function serverCheckInfections(room) {
    if (room.mode !== "zombie") return;
    const now = Date.now();
    revealInitialZombieIfNeeded(room, now);
    if (!isZombieRoundActive(room, now)) return;
    const zombies = [...room.players.values()].filter((player) => player.status === "zombie");
    const survivors = [...room.players.values()].filter((player) => player.status !== "zombie");
    for (const zombie of zombies) {
      for (const survivor of survivors) {
        if (distance(zombie, survivor) <= TOUCH_RADIUS) {
          if (survivor.shield) {
            survivor.shield = false;
            continue;
          }
          infectPlayer(room, survivor, "contact", zombie.userId);
        }
      }
    }
  }

  function serverCheckTags(room) {
    if (room.mode !== "tag") return;
    const now = Date.now();
    if (now < (room.tagActiveAt || room.startedAt)) return;
    if (now > (room.tagActiveAt || room.startedAt) + TAG_ROUND_MS) return;
    const taggers = [...room.players.values()].filter((player) => player.role === "tagger" && player.status === "tagger");
    for (const tagger of taggers) {
      if ((tagger.nextTagAllowedUntil || 0) > now || !hasFreshPosition(tagger, now)) continue;
      const runners = [...room.players.values()].filter((player) => player.role === "runner" && player.status === "runner");
      for (const runner of runners) {
        if (!hasFreshPosition(runner, now)) continue;
        if ((runner.tagImmuneUntil || 0) > now) continue;
        if (distance(tagger, runner) <= TOUCH_RADIUS) {
          tagPlayer(room, tagger, runner, "contact");
          return;
        }
      }
    }
    updateTagRescue(room, now);
    checkTagWin(room, "contact");
  }

  function setupTagRoom(room) {
    const players = [...room.players.values()];
    if (players.length === 0) return;
    const now = Date.now();
    const taggerCount = Math.min(TAG_TAGGER_COUNT, Math.max(1, players.length - 1));
    const runnerSpawns = [
      { x: TAG_PRISON.x + 430, y: TAG_PRISON.y - 310 },
      { x: TAG_PRISON.x + 500, y: TAG_PRISON.y + 0 },
      { x: TAG_PRISON.x + 430, y: TAG_PRISON.y + 310 },
      { x: TAG_PRISON.x - 120, y: TAG_PRISON.y + 430 },
      { x: TAG_PRISON.x + 120, y: TAG_PRISON.y - 430 },
      { x: TAG_PRISON.x + 620, y: TAG_PRISON.y + 210 },
    ];
    const taggerSpawns = [
      { x: TAG_PRISON.x - 520, y: TAG_PRISON.y - 260 },
      { x: TAG_PRISON.x - 520, y: TAG_PRISON.y + 260 },
    ];
    for (const player of players) {
      const spawn = runnerSpawns[players.indexOf(player) % runnerSpawns.length];
      player.status = "runner";
      player.role = "runner";
      player.tagTeam = "runner";
      player.tagImmuneUntil = now + TAG_IMMUNITY_MS;
      player.nextTagAllowedUntil = 0;
      player.tagBoostUntil = 0;
      player.tagBoostReadyAt = now + 1_500;
      player.runnerDashUntil = 0;
      player.runnerDashReadyAt = now + 2_000;
      player.tagItem = "";
      player.tagItemReadyAt = 0;
      player.tagSlowUntil = 0;
      player.cloneUntil = 0;
      player.runnerSpeedUntil = 0;
      player.runnerSpeedStacks = 0;
      player.smokeUntil = 0;
      player.jailedAt = 0;
      player.rescuedCount = 0;
      player.sentinelContributionCount = 0;
      player.wasRescued = false;
      player.rescuedAndStayedFree = false;
      player.isTagMvp = false;
      player.x = spawn.x;
      player.y = spawn.y;
      player.positionInitialized = true;
    }
    const shuffled = players.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < taggerCount; i += 1) {
      const tagger = shuffled[i];
      tagger.status = "tagger";
      tagger.role = "tagger";
      tagger.tagTeam = "tagger";
      tagger.tagImmuneUntil = 0;
      tagger.nextTagAllowedUntil = now + TAG_IMMUNITY_MS;
      const spawn = taggerSpawns[i % taggerSpawns.length];
      tagger.x = spawn.x;
      tagger.y = spawn.y;
    }
    if (room.tagVariant === "item") {
      room.tagItemSelectUntil = now + TAG_ITEM_SELECT_MS;
      room.tagActiveAt = room.tagItemSelectUntil;
      room.tagItemRoundStarted = false;
    } else {
      room.tagItemSelectUntil = 0;
      room.tagActiveAt = now;
      room.tagItemRoundStarted = true;
    }
    room.tagRescue = null;
    console.info(`[tag] start room=${room.code} taggers=${taggerCount}`);
    broadcastRoom(room, "tag_event", {
      type: "start",
      by_user_id: "server",
      reason: room.tagVariant === "item" ? "item_select" : "initial",
      room: serializeRoom(room),
    });
  }

  function setupZombieRoom(room) {
    const spawns = [
      { x: -360, y: -260 },
      { x: 360, y: -260 },
      { x: -360, y: 260 },
      { x: 360, y: 260 },
      { x: 0, y: -420 },
      { x: 0, y: 420 },
    ];
    let index = 0;
    for (const player of room.players.values()) {
      const spawn = spawns[index % spawns.length];
      player.x = spawn.x;
      player.y = spawn.y;
      player.vx = 0;
      player.vy = 0;
      player.facingAngle = 0;
      player.status = "alive";
      player.role = "survivor";
      player.infectedCount = 0;
      player.zombieMissileCharge = 0;
      player.zombieMissileHits = 0;
      player.zombieSlowUntil = 0;
      player.survivedMs = 0;
      player.rank = 0;
      player.positionInitialized = true;
      index += 1;
    }
    room.zombieMissileOrbs = [];
    room.activeAt = (room.startedAt || Date.now()) + ZOMBIE_ROLE_REVEAL_MS;
    room.roundEndsAt = room.activeAt + ZOMBIE_ROUND_MS;
    room.nextZombieMissileOrbAt = room.activeAt + 250;
    room.lastSurvivorId = "";
    const players = [...room.players.values()];
    room.pendingInitialZombieId = players.length > 0 ? players[Math.floor(Math.random() * players.length)].userId : "";
    room.zombieRevealAt = room.activeAt;
    room.firstZombieDone = false;
  }

  function revealInitialZombieIfNeeded(room, now) {
    if (!room || room.mode !== "zombie" || room.firstZombieDone) return;
    if (now < (room.zombieRevealAt || ((room.startedAt || now) + ZOMBIE_ROLE_REVEAL_MS))) return;
    let target = room.players.get(room.pendingInitialZombieId || "");
    if (!target) {
      const candidates = [...room.players.values()].filter((player) => player.status !== "zombie");
      target = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    }
    room.pendingInitialZombieId = "";
    if (target) infectPlayer(room, target, "initial", "server");
  }

  function currentZombieSurvivors(room) {
    return [...room.players.values()].filter((player) => player.status !== "zombie");
  }

  function updateZombieMissileOrbs(room, now) {
    if (!room || room.status !== "playing" || room.mode !== "zombie") return;
    revealInitialZombieIfNeeded(room, now);
    if (!isZombieRoundActive(room, now)) return;
    room.zombieMissileOrbs = (room.zombieMissileOrbs || []).filter((orb) => (orb.until || 0) > now);
    if ((room.nextZombieMissileOrbAt || 0) > now) return;
    const liveSurvivors = currentZombieSurvivors(room);
    if (liveSurvivors.length === 0) return;
    if ((room.zombieMissileOrbs || []).length >= Math.max(5, liveSurvivors.length + 2)) {
      room.nextZombieMissileOrbAt = now + 300;
      return;
    }
    const freshSurvivors = liveSurvivors.filter((player) => hasFreshPosition(player, now));
    const sources = freshSurvivors.length > 0 ? freshSurvivors : liveSurvivors;
    const source = sources[Math.floor(Math.random() * sources.length)];
    const angle = Math.random() * Math.PI * 2;
    const dist = 130 + Math.random() * 180;
    room.zombieMissileOrbs.push({
      id: `zm_${room.roundId || 0}_${now}_${Math.floor(Math.random() * 10000)}`,
      kind: "M",
      type: "missile_charge",
      x: (Number(source.x) || 0) + Math.cos(angle) * dist,
      y: (Number(source.y) || 0) + Math.sin(angle) * dist,
      spawned_at: now,
      expires_at: now + ZOMBIE_MISSILE_ORB_LIFETIME_MS,
      until: now + ZOMBIE_MISSILE_ORB_LIFETIME_MS,
      collected_by: "",
    });
    room.nextZombieMissileOrbAt = now + ZOMBIE_MISSILE_ORB_SPAWN_MS;
  }

  function nearestZombieTarget(room, source) {
    let best = null;
    let bestDistance = Infinity;
    for (const player of room.players.values()) {
      if (player.status !== "zombie") continue;
      const dist = distancePoint(source, player);
      if (dist < bestDistance) {
        bestDistance = dist;
        best = player;
      }
    }
    return best;
  }

  function fireZombieMissile(room, player, now) {
    const target = nearestZombieTarget(room, player);
    if (!target) return;
    const missileId = `zms_${room.roundId || 0}_${now}_${player.userId}`;
    broadcastRoom(room, "zombie_event", {
      type: "missile_fired",
      event: "zombie_missile_fired",
      missile_id: missileId,
      user_id: player.userId,
      shooter_user_id: player.userId,
      target_user_id: target ? target.userId : "",
      start: { x: Number(player.x) || 0, y: Number(player.y) || 0 },
      target: { x: Number(target.x) || 0, y: Number(target.y) || 0 },
      from_x: Number(player.x) || 0,
      from_y: Number(player.y) || 0,
      to_x: Number(target.x) || 0,
      to_y: Number(target.y) || 0,
      projectile_type: "ai_homing",
      fired_at: now,
      hit_at: now + ZOMBIE_MISSILE_EFFECT_MS,
      effect_duration_ms: ZOMBIE_MISSILE_EFFECT_MS,
      room: serializeRoom(room),
    });
    target.zombieSlowUntil = now + ZOMBIE_MISSILE_SLOW_MS;
    player.zombieMissileHits = (Number(player.zombieMissileHits) || 0) + 1;
    broadcastRoom(room, "zombie_event", {
      type: "missile_hit",
      event: "zombie_missile_hit",
      missile_id: missileId,
      user_id: player.userId,
      shooter_user_id: player.userId,
      target_user_id: target.userId,
      projectile_type: "ai_homing",
      until: target.zombieSlowUntil,
      slowed_until: target.zombieSlowUntil,
      room: serializeRoom(room),
    });
  }

  function ensureTagItemRoundActive(room, now) {
    if (!room || room.mode !== "tag" || room.tagVariant !== "item") return;
    if (room.tagItemRoundStarted || now < (room.tagActiveAt || 0)) return;
    for (const player of room.players.values()) {
      if (!player.tagItem) {
        player.tagItem = player.role === "tagger" ? TAG_ITEM_DEFAULTS.tagger : TAG_ITEM_DEFAULTS.runner;
      }
    }
    room.tagItemRoundStarted = true;
    broadcastRoom(room, "tag_event", { type: "round_started", room: serializeRoom(room) });
  }

  function tagPlayer(room, tagger, target, reason) {
    const now = Date.now();
    if (!tagger || !target || tagger.role !== "tagger" || target.role !== "runner") return;
    if ((target.tagImmuneUntil || 0) > now) return;
    target.status = "jailed";
    target.role = "jailed";
    target.x = TAG_PRISON.x;
    target.y = TAG_PRISON.y;
    target.vx = 0;
    target.vy = 0;
    target.jailedAt = now;
    target.survivedMs = Math.max(target.survivedMs || 0, now - (room.tagActiveAt || room.startedAt));
    target.rescuedAndStayedFree = false;
    tagger.nextTagAllowedUntil = now + TAG_TOUCH_COOLDOWN_MS;
    const scoringTagger = room.players.get(tagger.userId) || tagger;
    if (reason === "sentinel") {
      scoringTagger.sentinelContributionCount = (scoringTagger.sentinelContributionCount || 0) + 1;
    } else {
      scoringTagger.tagCount = (scoringTagger.tagCount || 0) + 1;
    }
    broadcastRoom(room, "tag_event", {
      type: "jailed",
      user_id: target.userId,
      by_user_id: tagger.userId,
      reason,
      nickname: target.nickname,
      room: serializeRoom(room),
    });
    checkTagWin(room, "caught");
  }

  function updateTagRescue(room, now) {
    if (!room || room.mode !== "tag" || room.status !== "playing") return;
    if (now < (room.tagActiveAt || room.startedAt)) {
      cancelTagRescue(room, "round_not_active");
      return;
    }
    const jailed = [...room.players.values()].filter((player) => player.status === "jailed");
    if (jailed.length === 0) {
      cancelTagRescue(room, "no_jailed_target");
      return;
    }
    const rescuers = [...room.players.values()].filter((player) =>
      player.status === "runner" &&
      distancePoint(player, TAG_PRISON) <= TAG_RESCUE_RADIUS &&
      hasFreshPosition(player, now)
    );
    if (rescuers.length === 0) {
      cancelTagRescue(room, "no_rescuer");
      return;
    }
    const rescuer = rescuers[0];
    if (room.prisonSentinel && (room.prisonSentinel.until || 0) > now) {
      cancelTagRescue(room, "sentinel_block");
      rescuer.tagSlowUntil = Math.max(rescuer.tagSlowUntil || 0, now + 700);
      const owner = room.players.get(room.prisonSentinel.ownerId);
      if (owner && (room.prisonSentinel.lastContributionAt || 0) + 1_000 <= now) {
        owner.sentinelContributionCount = (owner.sentinelContributionCount || 0) + 1;
        room.prisonSentinel.lastContributionAt = now;
      }
      return;
    }
    const target = jailed.sort((a, b) => (a.jailedAt || 0) - (b.jailedAt || 0))[0];
    if (!room.tagRescue || room.tagRescue.rescuerId !== rescuer.userId || room.tagRescue.targetId !== target.userId) {
      room.tagRescue = { rescuerId: rescuer.userId, targetId: target.userId, startedAt: now, updatedAt: now };
      broadcastRoom(room, "tag_event", {
        type: "rescue_started",
        user_id: target.userId,
        by_user_id: rescuer.userId,
        nickname: target.nickname,
        by_nickname: rescuer.nickname,
        room: serializeRoom(room),
      });
    }
    room.tagRescue.updatedAt = now;
    if (now - room.tagRescue.startedAt < TAG_RESCUE_MS) return;
    target.status = "runner";
    target.role = "runner";
    target.tagImmuneUntil = now + 2_000;
    target.x = TAG_PRISON.x + 150;
    target.y = TAG_PRISON.y;
    target.positionInitialized = true;
    target.wasRescued = true;
    target.rescuedAndStayedFree = true;
    rescuer.rescuedCount = (rescuer.rescuedCount || 0) + 1;
    room.tagRescue = null;
    broadcastRoom(room, "tag_event", {
      type: "rescue_completed",
      user_id: target.userId,
      by_user_id: rescuer.userId,
      nickname: target.nickname,
      room: serializeRoom(room),
    });
    broadcastRoom(room, "tag_event", {
      type: "rescued",
      user_id: target.userId,
      by_user_id: rescuer.userId,
      nickname: target.nickname,
      room: serializeRoom(room),
    });
  }

  function cancelTagRescue(room, reason = "cancelled") {
    if (!room) return;
    const hadRescue = Boolean(room.tagRescue && room.tagRescue.startedAt);
    room.tagRescue = null;
    if (hadRescue) {
      broadcastRoom(room, "tag_event", { type: "rescue_cancelled", reason, room: serializeRoom(room) });
    }
  }

  function activeTagRescuePayload(room) {
    const rescue = room?.tagRescue || null;
    if (!rescue || !(Number(rescue.startedAt) > 0) || !rescue.rescuerId || !rescue.targetId) return null;
    const now = Date.now();
    const elapsed = Math.max(0, now - Number(rescue.startedAt));
    return {
      rescuer_user_id: rescue.rescuerId,
      jailed_user_id: rescue.targetId,
      progress: Math.max(0, Math.min(1, elapsed / TAG_RESCUE_MS)),
      started_at: Number(rescue.startedAt) || 0,
      updated_at: Number(rescue.updatedAt) || now,
    };
  }

  function checkTagWin(room, reason) {
    if (!room || room.status !== "playing" || room.mode !== "tag") return;
    const aliveRunners = [...room.players.values()].filter((player) => player.status === "runner").length;
    if (aliveRunners <= 0) finishTagRoom(room, reason || "taggers_win");
  }

  function spawnTagClones(room, owner, now) {
    room.tagClones = Array.isArray(room.tagClones) ? room.tagClones : [];
    for (let i = 0; i < 2; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      room.tagClones.push({
        id: `${owner.userId}:clone:${now}:${i}`,
        ownerId: owner.userId,
        nickname: owner.nickname,
        skinId: owner.skinId || "skin_default",
        x: (Number(owner.x) || 0) + Math.cos(angle) * 38,
        y: (Number(owner.y) || 0) + Math.sin(angle) * 38,
        vx: Math.cos(angle) * TAG_CLONE_SPEED,
        vy: Math.sin(angle) * TAG_CLONE_SPEED,
        until: now + TAG_CLONE_MS,
      });
    }
  }

  function spawnTagSentinel(room, owner, now) {
    room.tagSentinels = Array.isArray(room.tagSentinels) ? room.tagSentinels : [];
    const sentinel = {
      id: `${owner.userId}:sentinel:${now}`,
      ownerId: owner.userId,
      nickname: "경찰 AI",
      skinId: "skin_default",
      x: TAG_PRISON.x,
      y: TAG_PRISON.y,
      vx: 0,
      vy: 0,
      nextFireAt: now + 550,
      until: now + TAG_SENTINEL_MS,
    };
    room.tagSentinels.push(sentinel);
    return sentinel;
  }

  function updateTagItemEntities(room, now) {
    if (room.pendingPrisonSentinel && (room.pendingPrisonSentinel.spawnAt || 0) <= now) {
      const owner = room.players.get(room.pendingPrisonSentinel.ownerId);
      if (owner && owner.status === "tagger") {
        const sentinel = spawnTagSentinel(room, owner, now);
        room.prisonSentinel = { ownerId: owner.userId, until: now + TAG_SENTINEL_MS };
        broadcastRoom(room, "tag_event", { type: "item_effect", item_id: "prison_sentinel", user_id: owner.userId, sentinel_id: sentinel.id, until: room.prisonSentinel.until, room: serializeRoom(room) });
      }
      room.pendingPrisonSentinel = null;
    }
    room.tagClones = (room.tagClones || []).filter((clone) => (clone.until || 0) > now).map((clone) => ({
      ...clone,
      x: (Number(clone.x) || 0) + (Number(clone.vx) || 0) * POSITION_SYNC_MS / 1000,
      y: (Number(clone.y) || 0) + (Number(clone.vy) || 0) * POSITION_SYNC_MS / 1000,
    }));
    updateTagSpeedOrbs(room, now);
    updateTagSentinels(room, now);
  }

  function updateTagSpeedOrbs(room, now) {
    room.tagSpeedOrbs = (room.tagSpeedOrbs || []).filter((orb) => (orb.until || 0) > now);
    for (const player of room.players.values()) {
      if (player.status !== "runner" || (player.speedPointModeUntil || 0) <= now) continue;
      if ((player.nextSpeedOrbAt || 0) <= now) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 75 + Math.random() * 70;
        room.tagSpeedOrbs.push({
          id: `${player.userId}:speed:${now}`,
          ownerId: player.userId,
          x: (Number(player.x) || 0) + Math.cos(angle) * dist,
          y: (Number(player.y) || 0) + Math.sin(angle) * dist,
          until: now + TAG_SPEED_ORB_MS,
        });
        player.nextSpeedOrbAt = now + TAG_SPEED_ORB_SPAWN_MS;
      }
      for (const orb of room.tagSpeedOrbs) {
        if (orb.ownerId !== player.userId) continue;
        if (distancePoint(player, orb) <= TAG_SPEED_ORB_RADIUS) {
          orb.until = 0;
          player.runnerSpeedUntil = now + TAG_SPEED_PICKUP_MS;
          player.runnerSpeedStacks = Math.min(TAG_SPEED_MAX_STACKS, (Number(player.runnerSpeedStacks) || 0) + 1);
          broadcastRoom(room, "tag_event", { type: "speed_orb_collected", user_id: player.userId, until: player.runnerSpeedUntil, room: serializeRoom(room) });
        }
      }
    }
    room.tagSpeedOrbs = room.tagSpeedOrbs.filter((orb) => (orb.until || 0) > now);
  }

  function updateTagSentinels(room, now) {
    const sentinels = [];
    for (const sentinel of room.tagSentinels || []) {
      if ((sentinel.until || 0) <= now) continue;
      const target = nearestActiveRunner(room, sentinel, now);
      if (target) {
        const dx = (Number(target.x) || 0) - (Number(sentinel.x) || 0);
        const dy = (Number(target.y) || 0) - (Number(sentinel.y) || 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= TAG_SENTINEL_FIRE_RADIUS && (sentinel.nextFireAt || 0) <= now) {
          sentinel.nextFireAt = now + TAG_SENTINEL_FIRE_COOLDOWN_MS;
          target.tagSlowUntil = Math.max(target.tagSlowUntil || 0, now + TAG_SENTINEL_MISSILE_SLOW_MS);
          const owner = room.players.get(String(sentinel.ownerId || ""));
          if (owner) owner.sentinelContributionCount = (owner.sentinelContributionCount || 0) + 1;
          broadcastRoom(room, "tag_event", {
            type: "item_effect",
            item_id: "prison_sentinel_missile",
            user_id: sentinel.ownerId,
            sentinel_id: sentinel.id,
            target_user_id: target.userId,
            until: target.tagSlowUntil,
            effect: "slow",
            slow_ms: TAG_SENTINEL_MISSILE_SLOW_MS,
            start: { x: Number(sentinel.x) || 0, y: Number(sentinel.y) || 0 },
            target: { x: Number(target.x) || 0, y: Number(target.y) || 0 },
            room: serializeRoom(room),
          });
        }
        if (dist > 0.001) {
          sentinel.vx = dx / dist * TAG_SENTINEL_SPEED;
          sentinel.vy = dy / dist * TAG_SENTINEL_SPEED;
          sentinel.x = (Number(sentinel.x) || 0) + sentinel.vx * POSITION_SYNC_MS / 1000;
          sentinel.y = (Number(sentinel.y) || 0) + sentinel.vy * POSITION_SYNC_MS / 1000;
        }
      }
      sentinels.push(sentinel);
    }
    room.tagSentinels = sentinels;
  }

  function visibleSpeedOrbs(room) {
    return (room.tagSpeedOrbs || []).filter((orb) => {
      const owner = room.players.get(orb.ownerId);
      return owner && (owner.speedPointModeUntil || 0) > Date.now();
    });
  }

  function setupMultiplayerHazards(room) {
    room.hazards = [];
    const now = Date.now();
    if (room.mode === "battle_royale") {
      room.nextHazardAt = Math.max(now, Number(room.activeAt) || now) + 350;
    } else {
      room.nextHazardAt = 0;
    }
  }

  function updateMultiplayerHazards(room, now) {
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return;
    const activeAt = Number(room.activeAt) || Number(room.startedAt) || now;
    if (now < activeAt) {
      room.hazards = [];
      room.nextHazardAt = activeAt + 350;
      if (!room.brIntroBlockedLogged) {
        room.brIntroBlockedLogged = true;
        console.info(`[BR_HAZARD_BLOCKED] event=positions_sync match=${room.matchId || ""} room=${room.code} serverTime=${now} activeAt=${activeAt} reason=intro_countdown`);
      }
      return;
    }
    if (room.brIntroBlockedLogged) {
      room.brIntroBlockedLogged = false;
      console.info(`[BR_HAZARD_RELEASED] event=positions_sync match=${room.matchId || ""} room=${room.code} serverTime=${now} activeAt=${activeAt} reason=intro_finished`);
    }
    room.hazards = (room.hazards || []).filter((hazard) => (hazard.despawnAt || 0) > now);
    if ((room.nextHazardAt || 0) > now) return;
    const hazardLimit = battleRoyaleHazardLimit(room, now);
    if (room.hazards.length >= hazardLimit) return;
    const roomLeft = Math.max(0, hazardLimit - room.hazards.length);
    const spawnCount = Math.min(roomLeft, Math.random() < 0.55 ? 2 : 1);
    for (let index = 0; index < spawnCount; index += 1) {
      const created = createMultiplayerHazard(room, now + index);
      const hazards = Array.isArray(created) ? created : (created ? [created] : []);
      for (const hazard of hazards) {
        if (!hazard) continue;
        room.hazards.push(hazard);
        console.info(`[BR_HAZARD_SPAWNED] matchId=${room.matchId || ""} roomCode=${room.code} hazardId=${hazard.id || ""} hazardType=${hazard.type || hazard.kind || ""} seq=${hazard.seq || 0} x=${Number(hazard.x || 0).toFixed(1)} y=${Number(hazard.y || 0).toFixed(1)} vx=${Number(hazard.vx || 0).toFixed(1)} vy=${Number(hazard.vy || 0).toFixed(1)} spawnedAt=${hazard.spawned_at || 0} damageEnabledAt=${hazard.damage_enabled_at || hazard.damage_started_at || 0} expiresAt=${hazard.expires_at || 0}`);
      }
    }
    room.nextHazardAt = now + 520 + Math.floor(Math.random() * 260);
  }

  function battleRoyaleHazardLimit(room, now) {
    const elapsed = Math.max(0, now - (room.activeAt || room.startedAt || now));
    if (elapsed < 30_000) return 4;
    if (elapsed < 60_000) return 5;
    if (elapsed < 90_000) return 6;
    return MULTI_HAZARD_MAX;
  }

  function battleRoyaleHazardWarningMs(room, now) {
    const elapsed = Math.max(0, now - (room.activeAt || room.startedAt || now));
    if (elapsed < 30_000) return BR_HAZARD_BALANCE.laser.warningMs;
    if (elapsed < 60_000) return 720;
    if (elapsed < 90_000) return 660;
    return 580;
  }

  function createMultiplayerHazard(room, now) {
    const zone = battleRoyaleZone(room, now);
    const center = battleRoyaleHazardSpawnCenter(room, zone);
    const selectedType = selectBattleRoyaleHazardType(room, now, zone);
    if (!selectedType) return null;
    if (selectedType === "green_meteor") return createGreenMeteorHazards(room, now, zone, center);
    if (selectedType === "laser") return createBattleRoyaleLaserHazard(room, now, zone, center);
    return createBattleRoyaleProjectileHazard(room, now, zone, center, selectedType);
  }

  function selectBattleRoyaleHazardType(room, now, zone) {
    const activeAt = Number(room.activeAt) || Number(room.startedAt) || now;
    const elapsed = Math.max(0, now - activeAt);
    const safeZoneRatio = battleRoyaleSafeZoneRatio(zone);
    const phase = battleRoyaleHazardPhase(elapsed, safeZoneRatio);
    const weights = battleRoyaleHazardWeights(phase);
    const allowed = { ...weights };
    if (elapsed < BR_HAZARD_BALANCE.arrow.minSpawnAfterActiveMs) allowed.arrow = 0;
    if (elapsed < BR_HAZARD_BALANCE.syncedHoming.minSpawnAfterActiveMs) allowed.synced_homing = 0;
    if (countActiveHazards(room, "synced_homing", now) >= BR_HAZARD_BALANCE.syncedHoming.maxActive) allowed.synced_homing = 0;
    if (now - (Number(room.lastSyncedHomingAt) || 0) < BR_HAZARD_BALANCE.syncedHoming.cooldownMs) allowed.synced_homing = 0;
    const meteorBlock = greenMeteorBlockReason(room, now, zone);
    if (meteorBlock) allowed.green_meteor = 0;
    const selectedType = weightedHazardType(allowed);
    console.info(`[BR_HAZARD_ROLL] matchId=${room.matchId || ""} roomCode=${room.code} serverTime=${now} elapsedMs=${elapsed} safeZoneRatio=${safeZoneRatio.toFixed(3)} phase=${phase} selectedType=${selectedType || "none"} weights=${JSON.stringify(allowed)}`);
    if (weights.green_meteor > 0) {
      console.info(`[BR_GREEN_METEOR_ROLL] matchId=${room.matchId || ""} roomCode=${room.code} serverTime=${now} elapsedMs=${elapsed} safeZoneRatio=${safeZoneRatio.toFixed(3)} selected=${selectedType === "green_meteor"} reason=${meteorBlock || "allowed"}`);
    }
    return selectedType;
  }

  function battleRoyaleHazardPhase(elapsed, safeZoneRatio) {
    if (elapsed < BR_HAZARD_BALANCE.introGraceMs) return "phase0";
    if (safeZoneRatio <= 0.55 || elapsed >= 45_000) return "phase3";
    if (elapsed < 20_000) return "phase1";
    return "phase2";
  }

  function battleRoyaleHazardWeights(phase) {
    if (phase === "phase0") return { laser: 100, arrow: 0, synced_homing: 0, green_meteor: 0 };
    if (phase === "phase1") return { laser: 58, arrow: 37, synced_homing: 0, green_meteor: 5 };
    if (phase === "phase2") return { laser: 50, arrow: 40, synced_homing: 3, green_meteor: 7 };
    return { laser: 45, arrow: 43, synced_homing: 12, green_meteor: 0 };
  }

  function weightedHazardType(weights) {
    const entries = Object.entries(weights).filter(([, value]) => Number(value) > 0);
    const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const [type, value] of entries) {
      roll -= Number(value);
      if (roll <= 0) return type;
    }
    return entries[entries.length - 1]?.[0] || null;
  }

  function nextBattleRoyaleHazardSeq(room) {
    room.hazardSeq = (Number(room.hazardSeq) || 0) + 1;
    return room.hazardSeq;
  }

  function createBattleRoyaleLaserHazard(room, now, zone, center) {
    const roll = Math.random();
    const warningMs = battleRoyaleHazardWarningMs(room, now);
    const type = roll < 0.38 ? "LZ_H" : (roll < 0.76 ? "LZ_V" : (roll < 0.88 ? "LZ_D1" : "LZ_D2"));
    const offsetLimit = Math.max(120, Math.min(760, zone.radius * 0.72));
    const offset = (Math.random() - 0.5) * offsetLimit * 2;
    let data;
    if (type === "LZ_H") {
      data = { type, from: { x: -99999, y: center.y + offset }, to: { x: 99999, y: center.y + offset } };
    } else if (type === "LZ_V") {
      data = { type, from: { x: center.x + offset, y: -99999 }, to: { x: center.x + offset, y: 99999 } };
    } else {
      const diagonal = type === "LZ_D1" ? 1 : -1;
      data = {
        type,
        from: { x: center.x - 1600, y: center.y + offset - diagonal * 1600 },
        to: { x: center.x + 1600, y: center.y + offset + diagonal * 1600 },
      };
    }
    const seq = nextBattleRoyaleHazardSeq(room);
    const hazard = {
      id: `hz_${room.roundId || 0}_${seq}_${now}`,
      seq,
      kind: "laser",
      type,
      hazard_type: type,
      warning_ms: warningMs,
      spawned_at: now,
      warning_started_at: now,
      damage_enabled_at: now + warningMs,
      damage_started_at: now + warningMs,
      expires_at: now + warningMs + 700,
      despawnAt: now + warningMs + 700,
      radius: BR_LASER_HIT_RADIUS,
      active_at: Number(room.activeAt) || 0,
      data,
      laser_line: { start: data.from, end: data.to, width: BR_LASER_HIT_RADIUS * 2 },
      warning_line: { start: data.from, end: data.to, width: BR_LASER_HIT_RADIUS * 2 },
      damage_line: { start: data.from, end: data.to, width: BR_LASER_HIT_RADIUS * 2 },
      line_start_x: data.from.x,
      line_start_y: data.from.y,
      line_end_x: data.to.x,
      line_end_y: data.to.y,
      width: BR_LASER_HIT_RADIUS * 2,
    };
    console.info(`[BR_LASER_WARNING_SENT] matchId=${room.matchId || ""} hazardId=${hazard.id} hazardType=${type} warningStartedAt=${hazard.warning_started_at} damageEnabledAt=${hazard.damage_enabled_at} lineStart=${JSON.stringify(data.from)} lineEnd=${JSON.stringify(data.to)}`);
    return hazard;
  }

  function createBattleRoyaleProjectileHazard(room, now, zone, center, projectileKind) {
    const side = Math.floor(Math.random() * 4);
    const spread = Math.max(260, Math.min(680, zone.radius * 0.9));
    let start = { x: center.x, y: center.y };
    if (side === 0) start = { x: center.x - spread, y: center.y + (Math.random() - 0.5) * spread };
    else if (side === 1) start = { x: center.x + spread, y: center.y + (Math.random() - 0.5) * spread };
    else if (side === 2) start = { x: center.x + (Math.random() - 0.5) * spread, y: center.y - spread };
    else start = { x: center.x + (Math.random() - 0.5) * spread, y: center.y + spread };
    start = clampPointToBattleRoyaleZone(start, zone, Math.max(80, Math.min(180, zone.radius * 0.22)));
    const target = randomAlivePlayer(room) || center;
    const aim = clampPointToBattleRoyaleZone({
      x: (Number(target.x) || center.x) + (Math.random() - 0.5) * 90,
      y: (Number(target.y) || center.y) + (Math.random() - 0.5) * 90,
    }, zone, 45);
    const dx = aim.x - start.x;
    const dy = aim.y - start.y;
    const dist = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    const speed = projectileKind === "synced_homing" ? BR_SYNCED_HOMING_SPEED : BR_ARROW_SPEED;
    const visualLeadMs = projectileKind === "synced_homing" ? BR_HAZARD_BALANCE.syncedHoming.visualLeadMs : BR_HAZARD_BALANCE.arrow.visualLeadMs;
    const seq = nextBattleRoyaleHazardSeq(room);
    if (projectileKind === "synced_homing") room.lastSyncedHomingAt = now;
    return {
      id: `hz_${room.roundId || 0}_${seq}_${now}`,
      seq,
      kind: "projectile",
      type: projectileKind,
      hazard_type: projectileKind,
      projectile_kind: projectileKind,
      start,
      x: start.x,
      y: start.y,
      dir: { x: dx / dist, y: dy / dist },
      vx: (dx / dist) * speed,
      vy: (dy / dist) * speed,
      speed,
      radius: BR_PROJECTILE_HIT_RADIUS,
      target_id: target?.userId || "",
      turn_rate: projectileKind === "synced_homing" ? 0 : 0,
      warning_ms: visualLeadMs,
      spawned_at: now,
      warning_started_at: now,
      damage_enabled_at: now + visualLeadMs,
      damage_started_at: now + visualLeadMs,
      expires_at: now + MULTI_HAZARD_LIFETIME_MS,
      despawnAt: now + MULTI_HAZARD_LIFETIME_MS,
      active_at: Number(room.activeAt) || 0,
    };
  }

  function greenMeteorBlockReason(room, now, zone) {
    const config = BR_HAZARD_BALANCE.greenMeteor;
    if (!config.enabled) return "disabled";
    const activeAt = Number(room.activeAt) || Number(room.startedAt) || now;
    const elapsed = Math.max(0, now - activeAt);
    const safeZoneRatio = battleRoyaleSafeZoneRatio(zone);
    if (elapsed < config.allowedAfterMatchMs) return "intro_not_finished";
    if (safeZoneRatio <= config.stopSafeZoneRatio || safeZoneRatio < config.spawnSafeZoneRatioMin) return "safe_zone_too_small";
    const maxMeteorLife = config.parentTravelMsMax + config.shardLifetimeMs;
    const predictedRatio = battleRoyaleSafeZoneRatio(battleRoyaleZone(room, now + maxMeteorLife + config.blockNearSafeZoneShrinkMs));
    if (predictedRatio <= config.stopSafeZoneRatio) return "safe_zone_will_be_too_small";
    if (countActiveHazards(room, "green_meteor", now) >= config.maxActive) return "max_active_green_meteor";
    if (now - (Number(room.lastGreenMeteorAt) || 0) < config.cooldownMs) return "cooldown";
    if (now - (Number(room.lastSyncedHomingAt) || 0) < config.blockNearSyncedHomingMs) return "near_synced_homing";
    if (now - (Number(room.lastSafeZoneDamageAt) || 0) < config.blockNearSafeZoneShrinkMs) return "near_safe_zone_damage";
    return "";
  }

  function createGreenMeteorHazards(room, now, zone, center) {
    const blockReason = greenMeteorBlockReason(room, now, zone);
    const safeZoneRatio = battleRoyaleSafeZoneRatio(zone);
    if (blockReason) {
      console.info(`[BR_GREEN_METEOR_SPAWN_BLOCKED] matchId=${room.matchId || ""} roomCode=${room.code} reason=${blockReason} safeZoneRatio=${safeZoneRatio.toFixed(3)} safeZoneRadius=${Number(zone.radius || 0).toFixed(1)} initialSafeZoneRadius=${BR_INITIAL_ZONE_RADIUS} safeZonePhase=${battleRoyaleHazardPhase(Math.max(0, now - (Number(room.activeAt) || now)), safeZoneRatio)} serverTime=${now}`);
      return null;
    }
    const config = BR_HAZARD_BALANCE.greenMeteor;
    const angle = Math.random() * Math.PI * 2;
    const spawnDist = Math.max(520, Math.min(920, zone.radius * 0.82));
    const spawn = clampPointToBattleRoyaleZone({
      x: center.x + Math.cos(angle) * spawnDist,
      y: center.y + Math.sin(angle) * spawnDist,
    }, zone, 50);
    const burst = clampPointToBattleRoyaleZone({
      x: center.x + (Math.random() - 0.5) * Math.min(420, zone.radius * 0.45),
      y: center.y + (Math.random() - 0.5) * Math.min(420, zone.radius * 0.45),
    }, zone, 120);
    const travelMs = config.parentTravelMsMin + Math.floor(Math.random() * (config.parentTravelMsMax - config.parentTravelMsMin + 1));
    const dx = burst.x - spawn.x;
    const dy = burst.y - spawn.y;
    const parentSpawnedAt = now + config.warningMs;
    const burstAt = parentSpawnedAt + travelMs;
    const vx = dx / (travelMs / 1000);
    const vy = dy / (travelMs / 1000);
    const parentSeq = nextBattleRoyaleHazardSeq(room);
    const parentId = `gm_${room.roundId || 0}_${parentSeq}_${now}`;
    const childIds = [];
    const shards = [];
    const shardSpeed = BR_ARROW_SPEED * config.shardSpeedMultiplierOfArrow;
    for (let index = 0; index < config.shardCount; index += 1) {
      const shardSeq = nextBattleRoyaleHazardSeq(room);
      const angleDeg = index * 45;
      const rad = angleDeg * Math.PI / 180;
      const shardId = `gms_${room.roundId || 0}_${shardSeq}_${now}`;
      childIds.push(shardId);
      shards.push({
        id: shardId,
        seq: shardSeq,
        parent_id: parentId,
        parentHazardId: parentId,
        kind: "projectile",
        type: "green_meteor_shard",
        hazard_type: "green_meteor_shard",
        projectile_kind: "green_meteor_shard",
        x: burst.x,
        y: burst.y,
        start: { x: burst.x, y: burst.y },
        dir: { x: Math.cos(rad), y: Math.sin(rad) },
        vx: Math.cos(rad) * shardSpeed,
        vy: Math.sin(rad) * shardSpeed,
        speed: shardSpeed,
        radius: BR_GREEN_METEOR_SHARD_RADIUS,
        angle_deg: angleDeg,
        spawned_at: burstAt,
        warning_started_at: now,
        damage_enabled_at: burstAt + config.shardVisualLeadMs,
        damage_started_at: burstAt + config.shardVisualLeadMs,
        expires_at: burstAt + config.shardLifetimeMs,
        despawnAt: burstAt + config.shardLifetimeMs,
        active_at: Number(room.activeAt) || 0,
        server_time: now,
      });
    }
    const parent = {
      id: parentId,
      seq: parentSeq,
      matchId: room.matchId || "",
      kind: "projectile",
      type: "green_meteor",
      hazard_type: "green_meteor",
      projectile_kind: "green_meteor",
      state: "incoming",
      spawn_x: spawn.x,
      spawn_y: spawn.y,
      x: spawn.x,
      y: spawn.y,
      start: spawn,
      dir: { x: dx / Math.max(1, Math.sqrt(dx * dx + dy * dy)), y: dy / Math.max(1, Math.sqrt(dx * dx + dy * dy)) },
      vx,
      vy,
      speed: Math.sqrt(vx * vx + vy * vy),
      radius: BR_GREEN_METEOR_PARENT_RADIUS,
      burst_x: burst.x,
      burst_y: burst.y,
      warning_started_at: now,
      spawned_at: parentSpawnedAt,
      damage_enabled_at: parentSpawnedAt + config.parentVisualLeadMs,
      damage_started_at: parentSpawnedAt + config.parentVisualLeadMs,
      burst_at: burstAt,
      expires_at: burstAt,
      despawnAt: burstAt,
      child_ids: childIds,
      active_at: Number(room.activeAt) || 0,
      server_time: now,
    };
    room.lastGreenMeteorAt = now;
    console.info(`[BR_GREEN_METEOR_SPAWNED] matchId=${room.matchId || ""} roomCode=${room.code} hazardId=${parent.id} spawnX=${spawn.x.toFixed(1)} spawnY=${spawn.y.toFixed(1)} burstX=${burst.x.toFixed(1)} burstY=${burst.y.toFixed(1)} vx=${vx.toFixed(1)} vy=${vy.toFixed(1)} warningStartedAt=${parent.warning_started_at} spawnedAt=${parent.spawned_at} damageEnabledAt=${parent.damage_enabled_at} burstAt=${parent.burst_at} expiresAt=${parent.expires_at} childIds=${childIds.join(",")}`);
    console.info(`[BR_GREEN_METEOR_SHARDS_SPAWNED] matchId=${room.matchId || ""} parentId=${parent.id} shardIds=${childIds.join(",")} shardAngles=0,45,90,135,180,225,270,315 shardSpeed=${shardSpeed.toFixed(1)} spawnedAt=${burstAt} damageEnabledAt=${burstAt + config.shardVisualLeadMs} expiresAt=${burstAt + config.shardLifetimeMs}`);
    return [parent, ...shards];
  }

  function countActiveHazards(room, type, now) {
    return (Array.isArray(room.hazards) ? room.hazards : []).filter((hazard) => {
      if (!hazard || (Number(hazard.expires_at ?? hazard.despawnAt) || 0) <= now) return false;
      return battleRoyaleHazardType(hazard) === type;
    }).length;
  }

  function multiplayerHazardCenter(room) {
    const alive = [...room.players.values()].filter((player) => player.status === "alive" || player.status === "survivor");
    if (alive.length === 0) return { x: 0, y: 0 };
    const sum = alive.reduce((acc, player) => {
      acc.x += Number(player.x) || 0;
      acc.y += Number(player.y) || 0;
      return acc;
    }, { x: 0, y: 0 });
    return { x: sum.x / alive.length, y: sum.y / alive.length };
  }

  function battleRoyaleHazardSpawnCenter(room, zone) {
    return clampPointToBattleRoyaleZone(multiplayerHazardCenter(room), zone, Math.max(80, Math.min(260, zone.radius * 0.35)));
  }

  function clampPointToBattleRoyaleZone(point, zone, margin = 0) {
    const center = zone?.center || { x: 0, y: 0 };
    const px = Number(point?.x) || 0;
    const py = Number(point?.y) || 0;
    const cx = Number(center.x) || 0;
    const cy = Number(center.y) || 0;
    const dx = px - cx;
    const dy = py - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxRadius = Math.max(40, (Number(zone?.radius) || BR_FINAL_ZONE_RADIUS) - Math.max(0, Number(margin) || 0));
    if (dist <= maxRadius) return { x: px, y: py };
    if (dist <= 0.0001) return { x: cx, y: cy };
    const scale = maxRadius / dist;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  function randomAlivePlayer(room) {
    const alive = [...room.players.values()].filter((player) => player.status === "alive" || player.status === "survivor");
    if (alive.length === 0) return null;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  function setupBattleRoyale(room) {
    let index = 0;
    const total = Math.max(1, room.players.size);
    const now = Date.now();
    for (const player of room.players.values()) {
      const angle = (Math.PI * 2 * index) / total;
      const radius = BR_SPAWN_RADIUS + (index % 2) * 180;
      player.x = Math.cos(angle) * radius;
      player.y = Math.sin(angle) * radius;
      player.vx = 0;
      player.vy = 0;
      player.facingAngle = angle;
      player.hp = BR_INITIAL_HP;
      player.status = "alive";
      player.role = "alive";
      player.shield = false;
      player.brShieldCharge = 0;
      player.brMissileCharge = 0;
      player.brEliminations = 0;
      player.brHomingHits = 0;
      player.eliminatedAt = 0;
      player.lastZoneDamageAt = now;
      player.survivedMs = 0;
      player.rank = 0;
      player.positionInitialized = true;
      index += 1;
    }
    room.brOrbs = [];
    room.brMissiles = [];
    room.nextBrOrbAt = Math.max(now, Number(room.activeAt) || now) + 650;
  }

  function serverCheckBattleRoyale(room) {
    if (room.mode !== "battle_royale" || room.status !== "playing") return;
    const now = Date.now();
    const activeAt = Number(room.activeAt) || Number(room.startedAt) || now;
    if (now < activeAt) {
      room.brOrbs = [];
      room.brMissiles = [];
      room.hazards = [];
      room.nextBrOrbAt = activeAt + 650;
      room.nextHazardAt = activeAt + 350;
      return;
    }
    updateBattleRoyaleOrbs(room, now);
    collectBattleRoyaleOrbsOnServerTick(room, now);
    updateBattleRoyaleMissiles(room, now);
    applyBattleRoyaleHazardDamage(room, now);
    const zone = battleRoyaleZone(room, now);
    if (zone.damage <= 0) return;
    for (const player of room.players.values()) {
      if (player.status !== "alive") continue;
      if (distancePoint(player, zone.center) <= zone.radius) continue;
      if (now - (player.lastZoneDamageAt || 0) < BR_ZONE_DAMAGE_INTERVAL_MS) continue;
      player.lastZoneDamageAt = now;
      room.lastSafeZoneDamageAt = now;
      applyBattleRoyaleDamage(room, player, zone.damage, "safe_zone", null, {
        serverTime: now,
        safeZoneRatio: battleRoyaleSafeZoneRatio(zone),
        playerDistanceFromCenter: distancePoint(player, zone.center),
      });
    }
  }

  function updateBattleRoyaleOrbs(room, now) {
    room.brOrbs = (room.brOrbs || []).filter((orb) => (orb.until || 0) > now && (orb.kind === "S" || orb.kind === "M"));
    if ((room.nextBrOrbAt || 0) > now) return;
    const kindRoll = Math.random();
    const kind = kindRoll < 0.42 ? "S" : "M";
    const angle = Math.random() * Math.PI * 2;
    const zone = battleRoyaleZone(room, now);
    const radius = Math.max(160, Math.min(zone.radius - 80, 980)) * Math.sqrt(Math.random());
    const orb = {
      id: `br_${room.roundId || 0}_${now}_${Math.floor(Math.random() * 10000)}`,
      type: kind,
      kind,
      x: zone.center.x + Math.cos(angle) * radius,
      y: zone.center.y + Math.sin(angle) * radius,
      spawned_at: now,
      expires_at: now + BR_ORB_LIFETIME_MS,
      until: now + BR_ORB_LIFETIME_MS,
    };
    room.brOrbs.push(orb);
    console.info(`[BR_ORB_SPAWNED] match=${room.matchId || ""} room=${room.code} orb=${orb.id} type=${kind} x=${orb.x.toFixed(1)} y=${orb.y.toFixed(1)} count=${room.brOrbs.length}`);
    room.nextBrOrbAt = now + BR_ORB_SPAWN_MS + Math.floor(Math.random() * 350);
  }

  function collectBattleRoyaleOrbsOnServerTick(room, now) {
    const orbs = Array.isArray(room.brOrbs) ? [...room.brOrbs] : [];
    if (orbs.length === 0) return;
    for (const player of room.players.values()) {
      if (player.status !== "alive") continue;
      for (const orb of orbs) {
        if (!orb || !room.brOrbs.some((item) => item && item.id === orb.id)) continue;
        const kind = String(orb.kind || orb.type || "");
        if (kind !== "S" && kind !== "M") continue;
        const dist = distancePoint(player, orb);
        if (dist <= BR_ORB_PICKUP_RADIUS) {
          logBattleRoyalePickupCheck(room, player, orb, dist, BR_ORB_PICKUP_RADIUS, "server_tick", "collected");
          collectBattleRoyaleOrb(room, player, orb, now, "server_tick");
        }
      }
    }
  }

  function nearestBattleRoyaleTarget(room, source) {
    let best = null;
    let bestDistance = Infinity;
    for (const player of room.players.values()) {
      if (player.userId === source.userId || player.status !== "alive") continue;
      const dist = distancePoint(source, player);
      if (dist < bestDistance) {
        bestDistance = dist;
        best = player;
      }
    }
    return best;
  }

  function applyBattleRoyaleDamage(room, player, amount, reason, sourcePlayer = null, context = {}) {
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return;
    if (!player || player.status !== "alive") return;
    const beforeHp = Number(player.hp) || BR_INITIAL_HP;
    const beforeShield = Boolean(player.shield);
    const hazard = context.hazard || null;
    const hazardId = String(context.hazardId || hazard?.id || "");
    const hazardType = String(context.hazardType || (hazard ? battleRoyaleHazardType(hazard) : ""));
    const serverTime = Number(context.serverTime) || Date.now();
    if ((reason === "homing" || reason === "br_missile") && sourcePlayer && sourcePlayer.userId !== player.userId) {
      sourcePlayer.brHomingHits = (Number(sourcePlayer.brHomingHits) || 0) + 1;
    }
    if (reason !== "safe_zone" && player.shield) {
      player.shield = false;
      player.brShieldCharge = 0;
      console.info(`[BR_DAMAGE_BLOCKED] matchId=${room.matchId || ""} roomCode=${room.code} playerId=${player.userId} hazardId=${hazardId} hazardType=${hazardType} reason=shield serverTime=${serverTime} activeAt=${room.activeAt || 0} damageEnabledAt=${hazard ? (hazard.damage_enabled_at || hazard.damage_started_at || 0) : 0}`);
      broadcastRoom(room, "br_event", {
        type: "shield_block",
        event: "br_damage",
        match_id: room.matchId || "",
        matchId: room.matchId || "",
        roomCode: room.code,
        server_time: serverTime,
        user_id: player.userId,
        playerId: player.userId,
        hp: player.hp,
        beforeHp,
        afterHp: player.hp,
        beforeShield,
        afterShield: false,
        shield_charge: 0,
        shield_active: false,
        reason,
        damageReason: reason,
        hazardId,
        hazardType,
        parentHazardId: String(context.parentHazardId || hazard?.parent_id || ""),
        hazard: hazard ? battleRoyaleDamageHazardPayload(hazard, serverTime) : null,
        room: serializeRoom(room),
      });
      return;
    }
    player.hp = Math.max(0, (Number(player.hp) || BR_INITIAL_HP) - Math.max(1, amount));
    console.info(`[BR_DAMAGE_APPLIED] matchId=${room.matchId || ""} roomCode=${room.code} playerId=${player.userId} hazardId=${hazardId} hazardType=${hazardType} damageReason=${reason} beforeHp=${beforeHp} afterHp=${player.hp} beforeShield=${beforeShield} afterShield=${Boolean(player.shield)} serverTime=${serverTime}`);
    broadcastRoom(room, "br_event", {
      type: "damage",
      event: "br_damage",
      match_id: room.matchId || "",
      matchId: room.matchId || "",
      roomCode: room.code,
      server_time: serverTime,
      user_id: player.userId,
      playerId: player.userId,
      hp: player.hp,
      beforeHp,
      afterHp: player.hp,
      beforeShield,
      afterShield: Boolean(player.shield),
      reason,
      damageReason: reason,
      hazardId,
      hazardType,
      parentHazardId: String(context.parentHazardId || hazard?.parent_id || ""),
      safeZoneRatio: context.safeZoneRatio,
      playerDistanceFromCenter: context.playerDistanceFromCenter,
      hazard: hazard ? battleRoyaleDamageHazardPayload(hazard, serverTime) : null,
      room: serializeRoom(room),
    });
    if (player.hp <= 0) eliminateBattleRoyalePlayer(room, player, reason, sourcePlayer);
  }

  function applyBattleRoyaleHazardDamage(room, now) {
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return;
    const hazards = Array.isArray(room.hazards) ? room.hazards : [];
    if (hazards.length === 0) return;
    for (const hazard of hazards) {
      const hazardId = String(hazard.id || "");
      if (!hazardId) continue;
      const gate = battleRoyaleHazardDamageGate(room, hazard, now);
      if (!gate.canDamage) {
        console.info(`[BR_PROJECTILE_DAMAGE_GATE] matchId=${room.matchId || ""} hazardId=${hazardId} hazardType=${battleRoyaleHazardType(hazard)} serverTime=${now} spawnedAt=${hazard.spawned_at || 0} damageEnabledAt=${hazard.damage_enabled_at || hazard.damage_started_at || 0} canDamage=false reason=${gate.reason}`);
        continue;
      }
      for (const player of room.players.values()) {
        if (player.status !== "alive") continue;
        player.brHazardHits = player.brHazardHits || {};
        if (player.brHazardHits[hazardId]) continue;
        const hit = battleRoyaleHazardHitDetails(hazard, player, now);
        console.info(`[BR_DAMAGE_ATTEMPT] matchId=${room.matchId || ""} roomCode=${room.code} playerId=${player.userId} hazardId=${hazardId} hazardType=${battleRoyaleHazardType(hazard)} damageReason=${battleRoyaleDamageReasonForHazard(hazard)} serverTime=${now} damageEnabledAt=${hazard.damage_enabled_at || hazard.damage_started_at || 0} playerX=${Number(player.x || 0).toFixed(1)} playerY=${Number(player.y || 0).toFixed(1)} hazardX=${hit.hazardX.toFixed(1)} hazardY=${hit.hazardY.toFixed(1)} distance=${hit.distance.toFixed(1)} radius=${hit.radius.toFixed(1)}`);
        if (!hit.hit) continue;
        player.brHazardHits[hazardId] = true;
        applyBattleRoyaleDamage(room, player, 1, battleRoyaleDamageReasonForHazard(hazard), null, {
          hazard,
          hazardId,
          hazardType: battleRoyaleHazardType(hazard),
          parentHazardId: hazard.parent_id || "",
          serverTime: now,
        });
      }
    }
  }

  function isPlayerTouchingBattleRoyaleHazard(room, player, now) {
    if (!room || room.mode !== "battle_royale" || !player || player.status !== "alive") return false;
    for (const hazard of room.hazards || []) {
      if (!isBattleRoyaleHazardDamageActive(hazard, now)) continue;
      if (battleRoyaleHazardHitsPlayer(hazard, player, now)) return true;
    }
    return false;
  }

  function isBattleRoyaleHazardDamageActive(hazard, now) {
    const damageAt = Number(hazard.damage_enabled_at ?? hazard.damage_started_at ?? hazard.damageStartedAt ?? hazard.spawned_at ?? 0);
    const expiresAt = Number(hazard.expires_at ?? hazard.despawnAt ?? 0);
    return damageAt > 0 && expiresAt > 0 && now >= damageAt && now <= expiresAt;
  }

  function battleRoyaleHazardDamageGate(room, hazard, now) {
    const activeAt = Number(room.activeAt) || Number(room.startedAt) || now;
    const damageAt = Number(hazard.damage_enabled_at ?? hazard.damage_started_at ?? hazard.spawned_at ?? 0);
    const expiresAt = Number(hazard.expires_at ?? hazard.despawnAt ?? 0);
    const type = battleRoyaleHazardType(hazard);
    if (now < activeAt) return { canDamage: false, reason: "round_not_active" };
    if (!String(hazard.id || "")) return { canDamage: false, reason: "missing_hazard_id" };
    if (type === "green_meteor" && Number(hazard.burst_at || 0) > 0 && now >= Number(hazard.burst_at)) return { canDamage: false, reason: "green_meteor_burst_finished" };
    if (damageAt <= 0 || now < damageAt) return { canDamage: false, reason: `${type || "hazard"}_warning_not_finished` };
    if (expiresAt <= 0 || now > expiresAt) return { canDamage: false, reason: "expired" };
    return { canDamage: true, reason: "ok" };
  }

  function battleRoyaleHazardHitsPlayer(hazard, player, now) {
    return battleRoyaleHazardHitDetails(hazard, player, now).hit;
  }

  function battleRoyaleHazardHitDetails(hazard, player, now) {
    const kind = String(hazard.kind || hazard.type || "");
    const type = battleRoyaleHazardType(hazard);
    if (kind === "laser") {
      const data = hazard.data || {};
      const from = data.from || null;
      const to = data.to || null;
      if (!from || !to) return { hit: false, hazardX: 0, hazardY: 0, distance: Infinity, radius: BR_LASER_HIT_RADIUS };
      const distance = distancePointToSegment(player, from, to);
      return { hit: distance <= BR_LASER_HIT_RADIUS, hazardX: Number(player.x) || 0, hazardY: Number(player.y) || 0, distance, radius: BR_LASER_HIT_RADIUS };
    }
    if (kind === "projectile" || type === "arrow" || type === "synced_homing" || type === "green_meteor" || type === "green_meteor_shard") {
      const pos = projectilePositionAt(hazard, now);
      const radius = Number(hazard.radius) || (type === "green_meteor" ? BR_GREEN_METEOR_PARENT_RADIUS : (type === "green_meteor_shard" ? BR_GREEN_METEOR_SHARD_RADIUS : BR_PROJECTILE_HIT_RADIUS));
      const distance = distancePoint(player, pos);
      return { hit: distance <= radius, hazardX: pos.x, hazardY: pos.y, distance, radius };
    }
    return { hit: false, hazardX: 0, hazardY: 0, distance: Infinity, radius: 0 };
  }

  function projectilePositionAt(hazard, now) {
    const start = hazard.start || { x: Number(hazard.x) || 0, y: Number(hazard.y) || 0 };
    const spawnedAt = Number(hazard.spawned_at ?? hazard.spawnedAt ?? now);
    const ageSec = Math.max(0, now - spawnedAt) / 1000;
    const vx = finiteNumber(hazard.vx);
    const vy = finiteNumber(hazard.vy);
    if (vx !== null && vy !== null) {
      return {
        x: (Number(start.x) || 0) + vx * ageSec,
        y: (Number(start.y) || 0) + vy * ageSec,
      };
    }
    const dir = hazard.dir || { x: 1, y: 0 };
    const speed = Number(hazard.speed) || 0;
    return {
      x: (Number(start.x) || 0) + (Number(dir.x) || 0) * speed * ageSec,
      y: (Number(start.y) || 0) + (Number(dir.y) || 0) * speed * ageSec,
    };
  }

  function battleRoyaleHazardType(hazard) {
    const type = String(hazard?.hazard_type || hazard?.type || hazard?.projectile_kind || hazard?.kind || "");
    if (type === "projectile") return String(hazard?.projectile_kind || "arrow");
    if (type === "laser") return String(hazard?.data?.type || "laser");
    return type;
  }

  function battleRoyaleDamageReasonForHazard(hazard) {
    const type = battleRoyaleHazardType(hazard);
    if (type === "green_meteor") return "green_meteor";
    if (type === "green_meteor_shard") return "green_meteor_shard";
    if (type === "synced_homing") return "synced_homing";
    if (type === "arrow") return "arrow";
    return "laser";
  }

  function battleRoyaleDamageHazardPayload(hazard, now) {
    const pos = projectilePositionAt(hazard, now);
    return {
      id: hazard.id || "",
      type: battleRoyaleHazardType(hazard),
      x: pos.x,
      y: pos.y,
      vx: Number(hazard.vx) || 0,
      vy: Number(hazard.vy) || 0,
      radius: Number(hazard.radius) || 0,
      spawned_at: Number(hazard.spawned_at) || 0,
      damage_enabled_at: Number(hazard.damage_enabled_at ?? hazard.damage_started_at) || 0,
      expires_at: Number(hazard.expires_at) || 0,
    };
  }

  function battleRoyaleHazardPayloads(room, now) {
    return (Array.isArray(room.hazards) ? room.hazards : []).map((hazard) => battleRoyaleHazardPayload(room, hazard, now)).filter(Boolean);
  }

  function battleRoyaleHazardPayload(room, hazard, now) {
    if (!hazard || !hazard.id) return null;
    const type = battleRoyaleHazardType(hazard);
    const pos = type === "LZ_H" || type === "LZ_V" || type === "LZ_D1" || type === "LZ_D2"
      ? { x: Number(hazard.line_start_x ?? hazard.data?.from?.x) || 0, y: Number(hazard.line_start_y ?? hazard.data?.from?.y) || 0 }
      : projectilePositionAt(hazard, now);
    const start = hazard.start || { x: Number(hazard.x) || 0, y: Number(hazard.y) || 0 };
    const payload = {
      id: String(hazard.id || ""),
      seq: Number(hazard.seq) || 0,
      type,
      hazardType: type,
      kind: String(hazard.kind || ""),
      projectile_kind: String(hazard.projectile_kind || ""),
      matchId: room.matchId || "",
      match_id: room.matchId || "",
      roomCode: room.code,
      spawn_x: Number(hazard.spawn_x ?? start.x ?? pos.x) || 0,
      spawn_y: Number(hazard.spawn_y ?? start.y ?? pos.y) || 0,
      x: pos.x,
      y: pos.y,
      vx: Number(hazard.vx) || 0,
      vy: Number(hazard.vy) || 0,
      radius: Number(hazard.radius) || (type === "green_meteor" ? BR_GREEN_METEOR_PARENT_RADIUS : (type === "green_meteor_shard" ? BR_GREEN_METEOR_SHARD_RADIUS : BR_PROJECTILE_HIT_RADIUS)),
      warning_started_at: Number(hazard.warning_started_at) || 0,
      spawned_at: Number(hazard.spawned_at) || 0,
      damage_enabled_at: Number(hazard.damage_enabled_at ?? hazard.damage_started_at) || 0,
      damage_started_at: Number(hazard.damage_enabled_at ?? hazard.damage_started_at) || 0,
      expires_at: Number(hazard.expires_at) || 0,
      active_at: Number(room.activeAt) || 0,
      server_time: now,
      target_id: String(hazard.target_id || ""),
      turn_rate: Number(hazard.turn_rate) || 0,
      speed: Number(hazard.speed) || 0,
      parent_id: String(hazard.parent_id || ""),
      parentHazardId: String(hazard.parentHazardId || hazard.parent_id || ""),
      child_ids: Array.isArray(hazard.child_ids) ? hazard.child_ids : [],
      burst_x: Number(hazard.burst_x) || 0,
      burst_y: Number(hazard.burst_y) || 0,
      burst_at: Number(hazard.burst_at) || 0,
      angle_deg: Number(hazard.angle_deg) || 0,
    };
    if (hazard.data?.from && hazard.data?.to) {
      payload.laser_line = hazard.laser_line || { start: hazard.data.from, end: hazard.data.to, width: hazard.width || BR_LASER_HIT_RADIUS * 2 };
      payload.warning_line = hazard.warning_line || payload.laser_line;
      payload.damage_line = hazard.damage_line || payload.laser_line;
      payload.line_start_x = Number(hazard.line_start_x ?? hazard.data.from.x) || 0;
      payload.line_start_y = Number(hazard.line_start_y ?? hazard.data.from.y) || 0;
      payload.line_end_x = Number(hazard.line_end_x ?? hazard.data.to.x) || 0;
      payload.line_end_y = Number(hazard.line_end_y ?? hazard.data.to.y) || 0;
      payload.width = Number(hazard.width) || BR_LASER_HIT_RADIUS * 2;
      payload.data = hazard.data;
    }
    return payload;
  }

  function requestBattleRoyaleOrbCollect(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return;
    const player = room.players.get(client.userId);
    if (!player || player.status !== "alive") {
      console.info(`[BR_PICKUP_CHECK] room=${room.code} user=${client.userId} result=not_alive source=client_request`);
      return;
    }
    const orbId = String(data.orb_id || data.id || "");
    if (!orbId) return;
    const now = Date.now();
    const orbs = Array.isArray(room.brOrbs) ? room.brOrbs : [];
    const index = orbs.findIndex((orb) => orb.id === orbId && (orb.until || 0) > now);
    if (index < 0) {
      console.info(`[BR_PICKUP_CHECK] match=${room.matchId || ""} room=${room.code} user=${player.userId} orb=${orbId} source=client_request result=expired_or_already_collected`);
      return;
    }
    const orb = orbs[index];
    const clientPoint = finiteNumber(data.x) !== null && finiteNumber(data.y) !== null
      ? { x: clampNumber(Number(data.x), -POSITION_MAX_ABS, POSITION_MAX_ABS), y: clampNumber(Number(data.y), -POSITION_MAX_ABS, POSITION_MAX_ABS) }
      : null;
    const serverDistance = distancePoint(player, orb);
    const clientDistance = clientPoint ? distancePoint(clientPoint, orb) : Infinity;
    const touchRadius = BR_ORB_PICKUP_RADIUS;
    const bestDistance = Math.min(serverDistance, clientDistance);
    if (bestDistance > touchRadius) {
      logBattleRoyalePickupCheck(room, player, orb, bestDistance, touchRadius, "client_request", "too_far");
      return;
    }
    logBattleRoyalePickupCheck(room, player, orb, bestDistance, touchRadius, "client_request", "collected");
    collectBattleRoyaleOrb(room, player, orb, now, "client_request");
  }

  function collectBattleRoyaleOrb(room, player, orb, now, source) {
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return false;
    if (!player || player.status !== "alive") {
      console.info(`[BR_PICKUP_CHECK] match=${room?.matchId || ""} room=${room?.code || ""} user=${player?.userId || ""} orb=${orb?.id || ""} source=${source} result=not_alive`);
      return false;
    }
    if (!orb || (orb.until || 0) <= now) {
      console.info(`[BR_PICKUP_CHECK] match=${room.matchId || ""} room=${room.code} user=${player.userId} orb=${orb?.id || ""} source=${source} result=expired`);
      return false;
    }
    const orbs = Array.isArray(room.brOrbs) ? room.brOrbs : [];
    const index = orbs.findIndex((item) => item && item.id === orb.id && (item.until || 0) > now);
    if (index < 0) {
      console.info(`[BR_PICKUP_CHECK] match=${room.matchId || ""} room=${room.code} user=${player.userId} orb=${orb.id} source=${source} result=already_collected`);
      return false;
    }
    const collected = orbs[index];
    const kind = String(collected.kind || collected.type || "");
    if (kind !== "S" && kind !== "M") {
      orbs.splice(index, 1);
      room.brOrbs = orbs;
      return false;
    }
    collected.collected_by = player.userId;
    orbs.splice(index, 1);
    room.brOrbs = orbs;
    const shieldBefore = Number(player.brShieldCharge) || 0;
    const missileBefore = Number(player.brMissileCharge) || 0;
    if (kind === "M") {
      player.brMissileCharge = Math.min(BR_MISSILE_CHARGE_REQUIRED, missileBefore + 1);
      const ready = player.brMissileCharge >= BR_MISSILE_CHARGE_REQUIRED;
      const missile = ready ? createBattleRoyaleMissile(room, player, now) : null;
      if (ready) player.brMissileCharge = 0;
      console.info(`[BR_ORB_COLLECTED] match=${room.matchId || ""} room=${room.code} user=${player.userId} orb=${collected.id} type=${kind} missile_before=${missileBefore} missile_after=${player.brMissileCharge || 0} missile_required=${BR_MISSILE_CHARGE_REQUIRED} missile_spawned=${Boolean(missile)}`);
      broadcastRoom(room, "br_event", {
        type: "orb_collected",
        orb_id: collected.id,
        kind,
        user_id: player.userId,
        nickname: player.nickname,
        missile_charge: player.brMissileCharge || 0,
        missile_count: player.brMissileCharge || 0,
        missile_required: BR_MISSILE_CHARGE_REQUIRED,
        missile_max: BR_MISSILE_CHARGE_REQUIRED,
        missile,
        target_user_id: missile ? missile.current_target_user_id : "",
        room: serializeRoom(room),
      });
      return true;
    }
    player.brShieldCharge = Math.min(BR_SHIELD_CHARGE_REQUIRED, (Number(player.brShieldCharge) || 0) + 1);
    if (player.brShieldCharge >= BR_SHIELD_CHARGE_REQUIRED) {
      player.shield = true;
    }
    console.info(`[BR_ORB_COLLECTED] match=${room.matchId || ""} room=${room.code} user=${player.userId} orb=${collected.id} type=${kind} shield_before=${shieldBefore} shield_after=${player.brShieldCharge} missile_spawned=false`);
    broadcastRoom(room, "br_event", {
      type: "orb_collected",
      orb_id: collected.id,
      kind,
      user_id: player.userId,
      nickname: player.nickname,
      shield_charge: player.brShieldCharge,
      shield_count: player.brShieldCharge,
      shield_required: BR_SHIELD_CHARGE_REQUIRED,
      shield_max: BR_SHIELD_CHARGE_REQUIRED,
      shield_active: Boolean(player.shield),
      room: serializeRoom(room),
    });
    return true;
  }

  function logBattleRoyalePickupCheck(room, player, orb, dist, radius, source, result) {
    const kind = String(orb?.kind || orb?.type || "");
    console.info(`[BR_PICKUP_CHECK] match=${room.matchId || ""} room=${room.code} user=${player.userId} orb=${orb?.id || ""} type=${kind} player_x=${Number(player.x || 0).toFixed(1)} player_y=${Number(player.y || 0).toFixed(1)} orb_x=${Number(orb?.x || 0).toFixed(1)} orb_y=${Number(orb?.y || 0).toFixed(1)} dist=${Number(dist || 0).toFixed(1)} radius=${Number(radius || 0).toFixed(1)} source=${source} result=${result}`);
  }

  function createBattleRoyaleMissile(room, source, now) {
    const target = nearestBattleRoyaleTarget(room, source);
    const aliveTargets = [...room.players.values()].filter((player) => player.userId !== source.userId && player.status === "alive").length;
    console.info(`[BR_MISSILE_SPAWN_ATTEMPT] match=${room.matchId || ""} room=${room.code} owner=${source.userId} alive_targets=${aliveTargets} result=${aliveTargets > 0 ? "spawned" : "no_target_fallback"}`);
    const fallbackAngle = Number(source.facingAngle) || 0;
    const dx = target
      ? (Number(target.x) || 0) - (Number(source.x) || 0)
      : Math.cos(fallbackAngle);
    const dy = target
      ? (Number(target.y) || 0) - (Number(source.y) || 0)
      : Math.sin(fallbackAngle);
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const missile = {
      id: `brm_${room.roundId || 0}_${now}_${Math.floor(Math.random() * 10000)}`,
      owner_user_id: source.userId,
      x: Number(source.x) || 0,
      y: Number(source.y) || 0,
      vx: (dx / len) * BR_HOMING_SPEED,
      vy: (dy / len) * BR_HOMING_SPEED,
      projectile_type: "ai_homing",
      initial_target_user_id: target ? target.userId : "",
      current_target_user_id: target ? target.userId : "",
      spawned_at: now,
      updated_at: now,
      expires_at: now + BR_HOMING_LIFETIME_MS,
      max_lifetime_ms: BR_HOMING_LIFETIME_MS,
      max_distance: BR_HOMING_MAX_DISTANCE,
      distance_traveled: 0,
      speed: BR_HOMING_SPEED,
      turn_rate: BR_HOMING_TURN_RATE,
      acquire_radius: BR_HOMING_ACQUIRE_RADIUS,
      hit_radius: BR_HOMING_HIT_RADIUS,
      status: "active",
    };
    room.brMissiles = room.brMissiles || [];
    room.brMissiles.push(missile);
    console.info(`[BR_MISSILE_SPAWNED] match=${room.matchId || ""} room=${room.code} missile=${missile.id} owner=${source.userId} target=${missile.current_target_user_id || ""} x=${missile.x.toFixed(1)} y=${missile.y.toFixed(1)}`);
    broadcastRoom(room, "br_event", { type: "missile_spawned", missile, room: serializeRoom(room) });
    return missile;
  }

  function updateBattleRoyaleMissiles(room, now) {
    const missiles = Array.isArray(room.brMissiles) ? room.brMissiles : [];
    if (missiles.length === 0) return;
    const next = [];
    for (const missile of missiles) {
      if (!missile || missile.status !== "active") continue;
      if (now >= (Number(missile.expires_at) || 0) || (Number(missile.distance_traveled) || 0) >= BR_HOMING_MAX_DISTANCE) {
        missile.status = "expired";
        const reason = now >= (Number(missile.expires_at) || 0) ? "lifetime" : "distance";
        console.info(`[BR_MISSILE_EXPIRED] match=${room.matchId || ""} room=${room.code} missile=${missile.id} reason=${reason}`);
        broadcastRoom(room, "br_event", { type: "missile_expired", missile_id: missile.id, room: serializeRoom(room) });
        continue;
      }
      const dt = Math.max(0.001, Math.min(0.08, (now - (Number(missile.updated_at) || now)) / 1000));
      missile.updated_at = now;
      const target = nearestBattleRoyaleMissileTarget(room, missile);
      if (target) {
        missile.current_target_user_id = target.userId;
        steerBattleRoyaleMissile(missile, target, dt);
      }
      const prev = { x: Number(missile.x) || 0, y: Number(missile.y) || 0 };
      missile.x = prev.x + (Number(missile.vx) || 0) * dt;
      missile.y = prev.y + (Number(missile.vy) || 0) * dt;
      missile.distance_traveled = (Number(missile.distance_traveled) || 0) + distancePoint(prev, missile);
      const hit = battleRoyaleMissileHitTarget(room, missile, prev);
      if (hit) {
        missile.status = "hit";
        const source = room.players.get(String(missile.owner_user_id || ""));
        const shieldBlocked = Boolean(hit.shield);
        const hpBefore = Number(hit.hp) || BR_INITIAL_HP;
        applyBattleRoyaleDamage(room, hit, 1, "br_missile", source || null, {
          hazardId: missile.id,
          hazardType: "br_missile",
          serverTime: now,
        });
        console.info(`[BR_MISSILE_HIT] match=${room.matchId || ""} room=${room.code} missile=${missile.id} target=${hit.userId} shield_block=${shieldBlocked} hp_before=${hpBefore} hp_after=${hit.hp}`);
        broadcastRoom(room, "br_event", {
          type: "missile_hit",
          missile_id: missile.id,
          user_id: hit.userId,
          target_user_id: hit.userId,
          owner_user_id: missile.owner_user_id,
          room: serializeRoom(room),
        });
        continue;
      }
      next.push(missile);
    }
    room.brMissiles = next;
  }

  function nearestBattleRoyaleMissileTarget(room, missile) {
    let best = null;
    let bestDistance = Infinity;
    const ownerId = String(missile.owner_user_id || "");
    for (const player of room.players.values()) {
      if (player.userId === ownerId || player.status !== "alive") continue;
      const dist = distancePoint(missile, player);
      if (dist > BR_HOMING_ACQUIRE_RADIUS) continue;
      if (dist < bestDistance) {
        bestDistance = dist;
        best = player;
      }
    }
    return best;
  }

  function steerBattleRoyaleMissile(missile, target, dt) {
    const desired = Math.atan2((Number(target.y) || 0) - (Number(missile.y) || 0), (Number(target.x) || 0) - (Number(missile.x) || 0));
    const current = Math.atan2(Number(missile.vy) || 0, Number(missile.vx) || 0);
    const delta = clampAngle(desired - current);
    const turn = Math.max(-BR_HOMING_TURN_RATE * dt, Math.min(BR_HOMING_TURN_RATE * dt, delta));
    const nextAngle = current + turn;
    missile.vx = Math.cos(nextAngle) * BR_HOMING_SPEED;
    missile.vy = Math.sin(nextAngle) * BR_HOMING_SPEED;
  }

  function battleRoyaleMissileHitTarget(room, missile, previousPosition) {
    const ownerId = String(missile.owner_user_id || "");
    for (const player of room.players.values()) {
      if (player.userId === ownerId || player.status !== "alive") continue;
      if (distancePointToSegment(player, previousPosition, missile) <= BR_HOMING_HIT_RADIUS) return player;
    }
    return null;
  }

  function eliminateBattleRoyalePlayer(room, player, reason, sourcePlayer = null) {
    if (player.status !== "alive") return;
    const aliveBefore = [...room.players.values()].filter((item) => item.status === "alive").length;
    if (sourcePlayer && sourcePlayer.userId !== player.userId) {
      sourcePlayer.brEliminations = (Number(sourcePlayer.brEliminations) || 0) + 1;
    }
    player.status = "eliminated";
    player.role = "eliminated";
    player.eliminatedAt = Date.now();
    player.eliminationSequence = (room.eliminationSequence = (Number(room.eliminationSequence) || 0) + 1);
    player.survivedMs = Math.max(player.survivedMs || 0, player.eliminatedAt - room.startedAt);
    player.rank = Math.max(1, aliveBefore);
    broadcastRoom(room, "br_event", {
      type: "eliminated",
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      reason,
      eliminated_at: player.eliminatedAt,
      elimination_sequence: player.eliminationSequence,
      room: serializeRoom(room),
    });
    const survivors = [...room.players.values()].filter((item) => item.status === "alive");
    if (survivors.length <= 1) finishBattleRoyaleRoom(room, survivors, "last_survivor");
  }

  function infectPlayer(room, target, reason, byUserId) {
    if (target.status === "zombie") return;
    const cleanReason = cleanZombieInfectionReason(reason);
    target.status = "zombie";
    target.role = "zombie";
    target.infectedAt = Date.now();
    target.survivedMs = Math.max(target.survivedMs || 0, Date.now() - (room.activeAt || room.startedAt));
    room.firstZombieDone = true;
    if (byUserId && room.players.has(byUserId)) room.players.get(byUserId).infectedCount += 1;
    broadcastRoom(room, "infection_event", { user_id: target.userId, by_user_id: byUserId, reason: cleanReason, room: serializeRoom(room) });
    const survivors = currentZombieSurvivors(room);
    if (survivors.length === 1) {
      if (!room.lastSurvivorId) room.lastSurvivorId = survivors[0].userId;
      broadcastRoom(room, "last_survivor", { user_id: survivors[0].userId });
    }
    if (survivors.length <= 0) finishRoom(room, survivors);
  }

  async function finishGame(client, data = {}, ack = null) {
    const room = getClientRoom(client);
    if (!room) return sendAck(ack, { ok: false, error: "room_not_found" });
    sendRequestFailed(client, ack, "game_over", "client_result_disabled");
  }

  function finishRoom(room, survivors) {
    if (room.status === "finished") return;
    room.status = "finished";
    room.resultFinalized = true;
    clearTimeout(room.forceZombieTimer);
    clearTimeout(room.finishTimer);
    clearInterval(room.syncTimer);
    const now = Date.now();
    const elapsedMs = Math.max(0, now - (room.activeAt || room.startedAt || now));
    const winnerIds = survivors.map((player) => player.userId);
    const reason = winnerIds.length === 0 ? "zombie_win" : "survivor_win";
    const players = [...room.players.values()];
    for (const player of players) {
      if (winnerIds.includes(player.userId) || player.status !== "zombie") {
        player.survivedMs = Math.max(player.survivedMs || 0, elapsedMs);
      }
      player.isWinner = winnerIds.length === 0 ? player.status === "zombie" : winnerIds.includes(player.userId);
      player.isLastSurvivor = Boolean(room.lastSurvivorId && room.lastSurvivorId === player.userId);
      player.isZombieMvp = false;
      player.rewardReason = reason;
      player.rewardElapsedMs = elapsedMs;
    }
    const mvpId = zombieMvpUserId(players, reason);
    if (mvpId && room.players.has(mvpId)) room.players.get(mvpId).isZombieMvp = true;
    players.sort((a, b) => {
      if (a.isWinner && !b.isWinner) return -1;
      if (!a.isWinner && b.isWinner) return 1;
      return (b.survivedMs || 0) - (a.survivedMs || 0);
    });
    players.forEach((player, index) => {
      player.rank = index + 1;
      player.coins = zombieCoinsForPlayer(player, reason);
      saveZombieResult(room, player.userId, { ...player }).catch((error) => {
        console.error("[zombie] save result failed", {
          room: room.code,
          userId: player.userId,
          error: error?.message || String(error),
        });
      });
    });
    broadcastRoom(room, "game_result", {
      mode: "zombie",
      reason,
      match_id: room.matchId || "",
      winner_user_ids: winnerIds,
      mvp_user_id: mvpId || "",
      players: players.map(resultPayload),
    });
    returnRoomToLobby(room);
  }

  function finishTagRoom(room, reason) {
    if (!room || room.status === "finished" || room.mode !== "tag") return;
    cancelTagRescue(room, "round_finished");
    room.status = "finished";
    room.resultFinalized = true;
    clearTimeout(room.finishTimer);
    clearInterval(room.syncTimer);
    const now = Date.now();
    const players = [...room.players.values()];
    const aliveRunners = players.filter((player) => player.status === "runner").length;
    const runnerTeamWon = reason === "time_up" && aliveRunners >= TAG_RUNNER_WIN_SURVIVORS;
    const winnerTeam = runnerTeamWon ? "runner" : "tagger";
    const elapsedMs = Math.max(0, now - (room.tagActiveAt || room.startedAt || now));
    const normalResult = isNormalTagResult(reason);
    for (const player of players) {
      player.tagCount = Math.max(0, Number(player.tagCount) || 0);
      player.rescuedCount = Math.max(0, Number(player.rescuedCount) || 0);
      player.sentinelContributionCount = Math.max(0, Number(player.sentinelContributionCount) || 0);
      player.survivedMs = Math.max(player.survivedMs || 0, elapsedMs);
      const team = player.tagTeam || (player.role === "tagger" || player.status === "tagger" ? "tagger" : "runner");
      player.tagTeam = team;
      player.tagVariant = room.tagVariant || "basic";
      player.isWinner = team === winnerTeam;
      player.rewardReason = reason;
      player.rewardElapsedMs = elapsedMs;
      player.freeAtEnd = team === "runner" && player.status === "runner";
      player.rescuedAndStayedFree = Boolean(player.rescuedAndStayedFree && player.freeAtEnd);
      player.isTagMvp = false;
      player.score = tagMvpScore(player);
    }
    const mvpId = normalResult ? tagMvpUserId(players) : "";
    if (mvpId && room.players.has(mvpId)) room.players.get(mvpId).isTagMvp = true;
    players.sort((a, b) => {
      if (a.isWinner && !b.isWinner) return -1;
      if (!a.isWinner && b.isWinner) return 1;
      if ((a.tagTeam || "") === "tagger" && (b.tagTeam || "") !== "tagger") return winnerTeam === "tagger" ? -1 : 1;
      if ((a.tagTeam || "") !== "tagger" && (b.tagTeam || "") === "tagger") return winnerTeam === "tagger" ? 1 : -1;
      return (b.score || 0) - (a.score || 0);
    });
    players.forEach((player, index) => {
      player.rank = index + 1;
      player.coins = tagCoinsForPlayer(player, reason, elapsedMs);
      console.info("[tag] reward", {
        room: room.code,
        userId: player.userId,
        team: player.tagTeam,
        arrests: player.tagCount || 0,
        rescues: player.rescuedCount || 0,
        sentinelAssists: player.sentinelContributionCount || 0,
        freeAtEnd: Boolean(player.freeAtEnd),
        escapedAfterRescue: Boolean(player.rescuedAndStayedFree),
        mvp: Boolean(player.isTagMvp),
        coins: player.coins,
      });
      saveTagResult(room, { ...player }, reason).catch((error) => {
        console.error("[tag] save result failed", {
          room: room.code,
          userId: player.userId,
          reason,
          error: error?.message || String(error),
        });
      });
    });
    console.info(`[tag] result room=${room.code} reason=${reason} players=${players.length}`);
    broadcastRoom(room, "game_result", {
      mode: "tag",
      reason,
      match_id: room.matchId || "",
      winner_team: runnerTeamWon ? "runners" : "taggers",
      alive_runners: aliveRunners,
      winner_user_ids: players.filter((player) => player.isWinner).map((player) => player.userId),
      mvp_user_id: mvpId || "",
      players: players.map(tagResultPayload),
    });
    returnRoomToLobby(room);
  }

  function finishBattleRoyaleRoom(room, survivors, reason) {
    if (!room || room.status === "finished" || room.mode !== "battle_royale") return;
    const liveSurvivors = [...room.players.values()].filter((player) => player.status === "alive");
    console.info(`[BR_FINISH_ATTEMPT] match=${room.matchId || ""} room=${room.code} alive_count=${liveSurvivors.length} reason=${reason} allowed=${liveSurvivors.length <= 1}`);
    if (liveSurvivors.length > 1) {
      console.warn(`[br] blocked premature finish room=${room.code} reason=${reason} alive=${liveSurvivors.length}`);
      return;
    }
    survivors = liveSurvivors;
    room.status = "finished";
    room.resultFinalized = true;
    clearInterval(room.syncTimer);
    const now = Date.now();
    const startedAt = Number(room.startedAt) || now;
    const elapsedMs = Math.max(0, now - startedAt);
    const survivorIds = new Set(survivors.map((survivor) => survivor.userId));
    const players = [...room.players.values()];
    const eliminated = players
      .filter((player) => player.status !== "alive")
      .sort((a, b) => {
        const timeDelta = (Number(b.eliminatedAt) || now) - (Number(a.eliminatedAt) || now);
        if (timeDelta !== 0) return timeDelta;
        return (Number(b.eliminationSequence) || 0) - (Number(a.eliminationSequence) || 0);
      });
    for (const survivor of survivors) {
      survivor.status = "winner";
      survivor.role = "winner";
      survivor.rank = 1;
      survivor.survivedMs = elapsedMs;
    }
    eliminated.forEach((player, index) => {
      if (!player.rank || player.rank <= 1) player.rank = index + 2;
    });
    for (const player of players) {
      const isWinnerAtFinish = player.status === "winner" || survivorIds.has(player.userId);
      if (isWinnerAtFinish) {
        player.survivedMs = elapsedMs;
      } else {
        const eliminatedAt = Number(player.eliminatedAt) || startedAt;
        player.survivedMs = Math.max(0, eliminatedAt - startedAt);
      }
      if (!player.rank) player.rank = players.length;
      player.isWinner = player.rank === 1;
      player.rewardReason = reason;
      player.rewardElapsedMs = elapsedMs;
      player.coins = battleRoyaleCoinsForPlayer(player, reason, elapsedMs);
      console.info(`[BR_SURVIVAL_TIME] match=${room.matchId || ""} room=${room.code} user=${player.userId} rank=${player.rank} alive=${isWinnerAtFinish} eliminated_at=${player.eliminatedAt || 0} survived_ms=${player.survivedMs}`);
      saveBattleRoyaleResult(room, { ...player }).catch((error) => {
        console.error("[br] save result failed", {
          room: room.code,
          userId: player.userId,
          error: error?.message || String(error),
        });
      });
    }
    players.sort(compareBattleRoyaleResultPlayers);
    const uniqueSurvivalTimes = new Set(players.map((player) => Number(player.survivedMs) || 0));
    if (players.length > 1 && uniqueSurvivalTimes.size === 1) {
      console.warn(`[BR_SURVIVAL_TIME_WARNING] match=${room.matchId || ""} room=${room.code} all_survived_ms_equal=${players[0]?.survivedMs || 0}`);
    }
    console.info(`[br] result room=${room.code} reason=${reason} players=${players.length}`);
    console.info(`[BR_RESULT_SENT] match=${room.matchId || ""} room=${room.code} players=${players.length} winner=${survivors[0]?.userId || ""}`);
    broadcastRoom(room, "game_result", {
      mode: "battle_royale",
      reason,
      match_id: room.matchId || "",
      result_finalized: true,
      room_status: "finished",
      alive_count: survivors.length,
      winner_user_ids: survivors.map((player) => player.userId),
      players: players.map(battleRoyaleResultPayload),
    });
    returnRoomToLobby(room);
  }

  function returnRoomToLobby(room) {
    if (!room || !rooms.has(room.code)) return;
    clearTimeout(room.forceZombieTimer);
    clearTimeout(room.finishTimer);
    clearInterval(room.syncTimer);
    clearFullRoomAutoStart(room);
    clearQuickStartTimer(room);
    room.status = "waiting";
    room.awaitingLobbyReturn = true;
    room.quick = false;
    room.quickMatchRoom = false;
    room.startedAt = 0;
    room.activeAt = 0;
    room.roundEndsAt = 0;
    room.matchId = "";
    room.firstZombieDone = false;
    room.resultFinalized = false;
    room.tagItemSelectUntil = 0;
    room.tagActiveAt = 0;
    room.tagItemRoundStarted = false;
    room.prisonSentinel = {};
    room.pendingPrisonSentinel = null;
    room.tagRescue = null;
    room.tagClones = [];
    room.tagSentinels = [];
    room.tagSpeedOrbs = [];
    room.brOrbs = [];
    room.nextBrOrbAt = 0;
    room.zombieMissileOrbs = [];
    room.nextZombieMissileOrbAt = 0;
    room.pendingInitialZombieId = "";
    room.zombieRevealAt = 0;
    room.lastSurvivorId = "";
    room.hazards = [];
    room.nextHazardAt = 0;
    for (const player of room.players.values()) resetPlayerForLobby(room, player, true);
    broadcastRoom(room, "room_updated", serializeRoom(room));
    updateFullRoomAutoStart(room);
  }

  function resetPlayerForLobby(room, player, afterResult = false) {
    player.ready = false;
    player.returnedToLobby = !afterResult;
    player.isHost = player.userId === room.hostId;
    player.status = "alive";
    player.role = "survivor";
    player.tagTeam = "";
    player.x = 195;
    player.y = 422;
    player.vx = 0;
    player.vy = 0;
    player.facingAngle = 0;
    player.shield = false;
    player.brShieldCharge = 0;
    player.brMissileCharge = 0;
    player.brEliminations = 0;
    player.brHomingHits = 0;
    player.survivedMs = 0;
    player.infectedCount = 0;
    player.tagCount = 0;
    player.sentinelContributionCount = 0;
    player.tagImmuneUntil = 0;
    player.nextTagAllowedUntil = 0;
    player.rescuedCount = 0;
    player.tagBoostUntil = 0;
    player.tagBoostReadyAt = 0;
    player.runnerDashUntil = 0;
    player.runnerDashReadyAt = 0;
    player.tagItem = "";
    player.tagItemReadyAt = 0;
    player.tagSlowUntil = 0;
    player.zombieMissileCharge = 0;
    player.zombieMissileHits = 0;
    player.zombieSlowUntil = 0;
    player.cloneUntil = 0;
    player.runnerSpeedUntil = 0;
    player.runnerSpeedStacks = 0;
    player.smokeUntil = 0;
    player.speedPointModeUntil = 0;
    player.nextSpeedOrbAt = 0;
    player.jailedAt = 0;
    player.wasRescued = false;
    player.rescuedAndStayedFree = false;
    player.freeAtEnd = false;
    player.rank = 0;
    player.hp = BR_INITIAL_HP;
    player.eliminatedAt = 0;
    player.lastZoneDamageAt = 0;
    player.eliminationSequence = 0;
    player.disconnected = false;
    player.disconnectedAt = 0;
    player.disconnectExpiresAt = 0;
    if (player.disconnectTimeoutTimer) {
      clearTimeout(player.disconnectTimeoutTimer);
      player.disconnectTimeoutTimer = null;
    }
    player.updatedAt = Date.now();
    player.positionInitialized = false;
    player.isWinner = false;
    player.isLastSurvivor = false;
    player.isZombieMvp = false;
    player.isTagMvp = false;
    player.score = 0;
    player.coins = 0;
    player.rewardReason = "";
    player.rewardElapsedMs = 0;
  }

  async function saveZombieResult(room, userId, data = {}) {
    if (!room || room.mode !== "zombie") throw new Error("invalid_zombie_result_room");
    const rank = clampInt(data.rank, 1, 99, 1);
    const survivedMs = Math.max(0, Number.parseInt(data.survived_ms ?? data.survivedMs, 10) || 0);
    const infectedCount = Math.max(0, Number.parseInt(data.infected_count ?? data.infectedCount, 10) || 0);
    const isWinner = Boolean(data.is_winner ?? data.isWinner);
    const coins = Number.isFinite(data.coins) ? data.coins : zombieCoinsForPlayer(data);
    const refId = matchRewardRefId(room, "zombie", userId);
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      await dbClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`zombie_result:${refId}`]);
      const existing = await dbClient.query(
        "SELECT id FROM coin_transactions WHERE user_id = $1 AND reason = 'zombie_result' AND ref_id = $2 LIMIT 1",
        [userId, refId],
      );
      if (existing.rowCount > 0) {
        await dbClient.query("COMMIT");
        return;
      }
      await dbClient.query(
        `INSERT INTO zombie_results (room_id, user_id, rank, survived_ms, infected_count, is_winner)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [room.dbId, userId, rank, survivedMs, infectedCount, isWinner],
      );
      await dbClient.query("UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2", [coins, userId]);
      await dbClient.query(
        "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, 'zombie_result', $3)",
        [userId, coins, refId],
      );
      await dbClient.query("COMMIT");
    } catch (error) {
      await dbClient.query("ROLLBACK");
      throw error;
    } finally {
      dbClient.release();
    }
  }

  async function saveTagResult(room, player, reason = "time_up") {
    const elapsedMs = Math.max(0, Date.now() - (room.tagActiveAt || room.startedAt || Date.now()));
    const playerForReward = { ...player, tagVariant: room.tagVariant || "basic" };
    const coins = policeThiefCoinsForPlayer(playerForReward, reason, elapsedMs);
    const refId = matchRewardRefId(room, "police_thief", player.userId);
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      await dbClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`police_thief_result:${refId}`]);
      const existing = await dbClient.query(
        "SELECT id FROM coin_transactions WHERE user_id = $1 AND reason = 'police_thief_result' AND ref_id = $2 LIMIT 1",
        [player.userId, refId],
      );
      if (existing.rowCount > 0) {
        await dbClient.query("COMMIT");
        return;
      }
      await dbClient.query(
        `INSERT INTO multiplayer_results (room_id, user_id, mode, rank, score, survived_seconds)
         VALUES (NULL, $1, 'tag', $2, $3, $4)`,
        [player.userId, player.rank, Math.max(0, player.score || 0), Math.max(0, (player.survivedMs || 0) / 1000)],
      );
      if (coins > 0) {
        await dbClient.query("UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2", [coins, player.userId]);
        await dbClient.query(
          "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, 'police_thief_result', $3)",
          [player.userId, coins, refId],
        );
      } else {
        await dbClient.query(
          "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, 'police_thief_result', $3)",
          [player.userId, 0, refId],
        );
      }
      await dbClient.query("COMMIT");
    } catch (error) {
      await dbClient.query("ROLLBACK");
      throw error;
    } finally {
      dbClient.release();
    }
  }

  async function saveBattleRoyaleResult(room, player) {
    const coins = Number.isFinite(player.coins) ? player.coins : battleRoyaleCoinsForPlayer(player);
    const refId = matchRewardRefId(room, "battle_royale", player.userId);
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      await dbClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`br_result:${refId}`]);
      const existing = await dbClient.query(
        "SELECT id FROM coin_transactions WHERE user_id = $1 AND reason = 'battle_royale_result' AND ref_id = $2 LIMIT 1",
        [player.userId, refId],
      );
      if (existing.rowCount > 0) {
        await dbClient.query("COMMIT");
        return;
      }
      await dbClient.query(
        `INSERT INTO multiplayer_results (room_id, user_id, mode, rank, score, survived_seconds)
         VALUES (NULL, $1, 'battle_royale', $2, $3, $4)`,
        [player.userId, player.rank, Math.max(0, Math.floor((player.survivedMs || 0) / 1000)), Math.max(0, (player.survivedMs || 0) / 1000)],
      );
      await dbClient.query("UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2", [coins, player.userId]);
      await dbClient.query(
        "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, 'battle_royale_result', $3)",
        [player.userId, coins, refId],
      );
      await dbClient.query("COMMIT");
    } catch (error) {
      await dbClient.query("ROLLBACK");
      throw error;
    } finally {
      dbClient.release();
    }
  }

  function syncPositions(room) {
    if (room.status !== "playing") return;
    const now = Date.now();
    if (room.mode === "zombie") revealInitialZombieIfNeeded(room, now);
    if (room.mode === "tag") ensureTagItemRoundActive(room, now);
    if (room.mode === "tag") updateTagItemEntities(room, now);
    if (room.mode === "zombie") updateZombieMissileOrbs(room, now);
    updateMultiplayerHazards(room, now);
    if (room.mode === "battle_royale") serverCheckBattleRoyale(room);
    const activeAt = room.mode === "tag"
      ? (room.tagActiveAt || room.startedAt)
      : (room.mode === "zombie" || room.mode === "battle_royale" ? (room.activeAt || room.startedAt) : room.startedAt);
    const elapsed = now - activeAt;
    if (room.mode === "tag" && now >= activeAt + TAG_ROUND_MS) {
      finishTagRoom(room, "time_up");
      return;
    }
    if (room.mode === "zombie" && now >= activeAt + ZOMBIE_ROUND_MS) {
      finishRoom(room, currentZombieSurvivors(room));
      return;
    }
    const brHazards = room.mode === "battle_royale" ? battleRoyaleHazardPayloads(room, now) : [];
    const payload = {
      mode: room.mode,
      server_time: now,
      match_id: room.matchId || "",
      matchId: room.matchId || "",
      roomCode: room.code,
      intro_started_at: room.mode === "battle_royale" ? (room.startedAt || 0) : 0,
      round_started_at: room.mode === "zombie" || room.mode === "battle_royale" ? activeAt : 0,
      active_at: room.mode === "zombie" || room.mode === "battle_royale" ? activeAt : 0,
      hazard_seq: room.mode === "battle_royale" ? (Number(room.hazardSeq) || 0) : 0,
      elapsed_ms: elapsed,
      tag_variant: room.mode === "tag" ? (room.tagVariant || "basic") : "",
      tag_item_select_until: room.mode === "tag" ? (room.tagItemSelectUntil || 0) : 0,
      tag_active_at: room.mode === "tag" ? activeAt : 0,
      tag_prison_sentinel: room.mode === "tag" ? (room.prisonSentinel || {}) : {},
      tag_clones: room.mode === "tag" ? (room.tagClones || []) : [],
      tag_sentinels: room.mode === "tag" ? (room.tagSentinels || []) : [],
      tag_speed_orbs: room.mode === "tag" ? visibleSpeedOrbs(room) : [],
      round_ends_at: room.mode === "tag" ? activeAt + TAG_ROUND_MS : (room.mode === "zombie" ? activeAt + ZOMBIE_ROUND_MS : (room.mode === "battle_royale" ? activeAt + BR_ZONE_SHRINK_MS : 0)),
      zombie_reveal_at: room.mode === "zombie" ? (room.zombieRevealAt || activeAt + ZOMBIE_ROLE_REVEAL_MS) : 0,
      tag_prison: room.mode === "tag" ? TAG_PRISON : null,
      tag_prison_radius: room.mode === "tag" ? TAG_PRISON_RADIUS : 0,
      tag_rescue_radius: room.mode === "tag" ? TAG_RESCUE_RADIUS : 0,
      tag_rescue_required_ms: room.mode === "tag" ? TAG_RESCUE_MS : 0,
      active_rescue: room.mode === "tag" ? activeTagRescuePayload(room) : null,
      tag_rescue: room.mode === "tag" ? (activeTagRescuePayload(room) || {}) : {},
      hazards: brHazards,
      multiplayer_hazards: brHazards,
      safe_zone: room.mode === "battle_royale" ? battleRoyaleSafeZonePayload(room, now) : null,
      zone_radius: room.mode === "battle_royale" ? battleRoyaleZone(room, now).radius : 0,
      zone_damage_per_sec: room.mode === "battle_royale" ? battleRoyaleZone(room, now).damage : 0,
      br_orbs: room.mode === "battle_royale" ? (room.brOrbs || []) : [],
      br_missiles: room.mode === "battle_royale" ? (room.brMissiles || []) : [],
      zombie_missile_orbs: room.mode === "zombie" ? (room.zombieMissileOrbs || []) : [],
      zombie_missile_required: ZOMBIE_MISSILE_CHARGE_REQUIRED,
      zombie_speed_multiplier: zombieSpeedMultiplier(elapsed),
      players: [...room.players.values()].map((player) => ({
        user_id: player.userId,
        nickname: player.nickname,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        facing_angle: player.facingAngle || 0,
        status: player.status,
        role: player.role,
        tag_team: player.tagTeam || "",
        hp: room.mode === "battle_royale" ? (Number.isFinite(player.hp) ? player.hp : BR_INITIAL_HP) : (player.hp || 0),
        max_hp: room.mode === "battle_royale" ? BR_INITIAL_HP : 0,
        rank: player.rank || 0,
        join_order: player.joinOrder || 0,
        disconnected: Boolean(player.disconnected),
        disconnect_expires_at: player.disconnectExpiresAt || 0,
        shield: player.shield,
        br_shield_charge: player.brShieldCharge || 0,
        br_shield_required: BR_SHIELD_CHARGE_REQUIRED,
        br_missile_charge: player.brMissileCharge || 0,
        br_missile_required: BR_MISSILE_CHARGE_REQUIRED,
        shield_count: player.brShieldCharge || 0,
        shield_max: BR_SHIELD_CHARGE_REQUIRED,
        shield_active: Boolean(player.shield),
        alive: player.status === "alive" || player.status === "winner",
        eliminated_rank: player.status === "eliminated" ? (player.rank || 0) : 0,
        survived_ms: player.survivedMs || 0,
        zombie_missile_charge: player.zombieMissileCharge || 0,
        zombie_slow_until: player.zombieSlowUntil || 0,
        skin_id: player.skinId || "skin_default",
        tag_count: player.tagCount || 0,
        sentinel_contribution: player.sentinelContributionCount || 0,
        tag_immune_until: player.tagImmuneUntil || 0,
        rescued_count: player.rescuedCount || 0,
        tag_boost_until: player.tagBoostUntil || 0,
        tag_boost_ready_at: player.tagBoostReadyAt || 0,
        runner_dash_until: player.runnerDashUntil || 0,
        runner_dash_ready_at: player.runnerDashReadyAt || 0,
        tag_item: player.tagItem || "",
        tag_item_ready_at: player.tagItemReadyAt || 0,
        tag_slow_until: player.tagSlowUntil || 0,
        clone_until: player.cloneUntil || 0,
        runner_speed_until: player.runnerSpeedUntil || 0,
        runner_speed_stacks: player.runnerSpeedStacks || 0,
        smoke_until: player.smokeUntil || 0,
        speed_point_mode_until: player.speedPointModeUntil || 0,
        jailed_at: player.jailedAt || 0,
      })),
    };
    broadcastRoom(room, "positions_sync", payload);
    if (room.mode === "battle_royale") {
      console.info(`[BR_HAZARD_SYNC_SENT] matchId=${room.matchId || ""} roomCode=${room.code} eventName=positions_sync serverTime=${now} activeAt=${activeAt} hazardSeq=${Number(room.hazardSeq) || 0} hazardCount=${brHazards.length} hazardIds=${brHazards.map((hazard) => hazard.id).join(",")}`);
    }
    if (room.mode === "battle_royale") {
      broadcastRoom(room, "br_state_snapshot", battleRoyaleSnapshotPayload(room, payload, now, elapsed));
    }
    if (room.mode === "tag") updateTagRescue(room, now);
  }

  function makeRoom(mode, hostClient, maxPlayers, quick, tagVariant = "basic") {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();
    const room = {
      code,
      dbId: null,
      mode,
      tagVariant: normalizeTagVariant(tagVariant),
      hostId: hostClient.userId,
      hostNickname: hostClient.nickname,
      maxPlayers,
      quick,
      private: false,
      settings: {},
      status: "waiting",
      createdAt: Date.now(),
      startedAt: 0,
      activeAt: 0,
      roundEndsAt: 0,
      roundId: 0,
      matchId: "",
      nextJoinOrder: 0,
      eliminationSequence: 0,
      firstZombieDone: false,
      resultFinalized: false,
      players: new Map(),
      syncTimer: null,
      forceZombieTimer: null,
      finishTimer: null,
      autoStartTimer: null,
      autoStartAt: 0,
      quickStartTimer: null,
      quickStartAt: 0,
      tagItemSelectUntil: 0,
      tagActiveAt: 0,
      tagItemRoundStarted: false,
      prisonSentinel: {},
      pendingPrisonSentinel: null,
      tagClones: [],
      tagSentinels: [],
      tagSpeedOrbs: [],
      brOrbs: [],
      brMissiles: [],
      nextBrOrbAt: 0,
      zombieMissileOrbs: [],
      nextZombieMissileOrbAt: 0,
      pendingInitialZombieId: "",
      zombieRevealAt: 0,
      lastSurvivorId: "",
      hazards: [],
      nextHazardAt: 0,
    };
    rooms.set(code, room);
    return room;
  }

  async function persistRoom(room, hostId) {
    const result = await pool.query(
      `INSERT INTO zombie_rooms (room_code, host_id, status, max_players)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_code) DO UPDATE SET status = EXCLUDED.status
       RETURNING id`,
      [room.code, hostId, room.status, room.maxPlayers],
    );
    room.dbId = result.rows[0].id;
  }

  async function persistRoomPlayer(room, userId, isHost) {
    if (!room.dbId) return;
    await pool.query(
      `INSERT INTO zombie_players (room_id, user_id, is_host, is_ready, status)
       VALUES ($1, $2, $3, $4, 'alive')
       ON CONFLICT DO NOTHING`,
      [room.dbId, userId, isHost, isHost],
    );
  }

  function addPlayerToRoom(room, client, isHost) {
    leaveQuickMatch(client, false);
    removeFromCurrentRoom(client);
    client.roomCode = room.code;
    room.players.set(client.userId, {
      userId: client.userId,
      nickname: client.nickname,
      joinOrder: (room.nextJoinOrder = (room.nextJoinOrder || 0) + 1),
      ready: isHost,
      isHost,
      status: "alive",
      role: "survivor",
      tagTeam: "",
      x: 195,
      y: 422,
      vx: 0,
      vy: 0,
      facingAngle: 0,
      shield: false,
      skinId: "skin_default",
      survivedMs: 0,
      infectedCount: 0,
      tagCount: 0,
      sentinelContributionCount: 0,
      tagImmuneUntil: 0,
      nextTagAllowedUntil: 0,
      rescuedCount: 0,
      tagBoostUntil: 0,
      tagBoostReadyAt: 0,
      runnerDashUntil: 0,
      runnerDashReadyAt: 0,
      tagItem: "",
      tagItemReadyAt: 0,
      tagSlowUntil: 0,
      zombieMissileCharge: 0,
      zombieMissileHits: 0,
      zombieSlowUntil: 0,
      cloneUntil: 0,
      runnerSpeedUntil: 0,
      runnerSpeedStacks: 0,
      smokeUntil: 0,
      jailedAt: 0,
      wasRescued: false,
      rescuedAndStayedFree: false,
      freeAtEnd: false,
      rank: 0,
      hp: BR_INITIAL_HP,
      brEliminations: 0,
      brHomingHits: 0,
      eliminatedAt: 0,
      eliminationSequence: 0,
      lastZoneDamageAt: 0,
      disconnected: false,
      disconnectedAt: 0,
      disconnectExpiresAt: 0,
      disconnectTimeoutTimer: null,
      updatedAt: Date.now(),
      positionInitialized: false,
      isWinner: false,
      isLastSurvivor: false,
      isZombieMvp: false,
      isTagMvp: false,
      rewardReason: "",
      rewardElapsedMs: 0,
    });
  }

  function removeFromCurrentRoom(client) {
    const room = getClientRoom(client);
    if (!room) return;
    const wasHost = room.hostId === client.userId;
    const leavingPlayer = room.players.get(client.userId);
    if (leavingPlayer?.disconnectTimeoutTimer) {
      clearTimeout(leavingPlayer.disconnectTimeoutTimer);
      leavingPlayer.disconnectTimeoutTimer = null;
    }
    room.players.delete(client.userId);
    client.roomCode = "";
    if (room.players.size === 0) {
      clearFullRoomAutoStart(room);
      clearTimeout(room.forceZombieTimer);
      clearTimeout(room.finishTimer);
      clearInterval(room.syncTimer);
      clearQuickStartTimer(room);
      rooms.delete(room.code);
    } else {
      if (wasHost) {
        const nextHost = room.players.values().next().value;
        room.hostId = nextHost.userId;
        room.hostNickname = nextHost.nickname;
        for (const player of room.players.values()) {
          player.isHost = player.userId === nextHost.userId;
          if (player.isHost) player.ready = true;
        }
      }
      broadcastRoom(room, "room_updated", serializeRoom(room));
      updateFullRoomAutoStart(room);
      updateQuickRoomStart(room);
      if (room.status === "playing" && room.mode === "tag" && room.players.size < 2) finishTagRoom(room, "player_left");
      else if (room.status === "playing" && room.mode === "tag") checkTagWin(room, "player_left");
      else if (room.status === "playing" && room.mode === "battle_royale") {
        const survivors = [...room.players.values()].filter((item) => item.status === "alive");
        if (survivors.length <= 1) finishBattleRoyaleRoom(room, survivors, "player_left");
      } else if (room.status === "playing" && room.mode === "zombie") {
        const now = Date.now();
        const zombies = [...room.players.values()].filter((item) => item.status === "zombie");
        const survivors = currentZombieSurvivors(room);
        if (now >= (room.zombieRevealAt || 0) && zombies.length <= 0 && survivors.length > 0) finishRoom(room, survivors);
        else if (survivors.length <= 0) finishRoom(room, survivors);
      }
    }
  }

  function disconnectClient(client) {
    const current = clientsByUserId.get(client.userId);
    if (current && current !== client) return;
    if (current === client) {
      clientsByUserId.delete(client.userId);
      onlineUserIds.delete(client.userId);
    }
    leaveQuickMatch(client, false);
    if (scheduleBattleRoyaleDisconnect(client)) return;
    removeFromCurrentRoom(client);
  }

  function getClientRoom(client) {
    if (!client.roomCode) return null;
    return rooms.get(client.roomCode) || null;
  }

  function findRoomByUserId(userId) {
    for (const room of rooms.values()) {
      if (room.players.has(userId)) return room;
    }
    return null;
  }

  function scheduleBattleRoyaleDisconnect(client) {
    const room = getClientRoom(client);
    if (!room || room.mode !== "battle_royale" || room.status !== "playing") return false;
    const player = room.players.get(client.userId);
    if (!player || player.status !== "alive") return false;
    const now = Date.now();
    player.disconnected = true;
    player.disconnectedAt = now;
    player.disconnectExpiresAt = now + BR_RECONNECT_GRACE_MS;
    if (player.disconnectTimeoutTimer) clearTimeout(player.disconnectTimeoutTimer);
    player.disconnectTimeoutTimer = setTimeout(() => {
      const liveRoom = rooms.get(room.code);
      const livePlayer = liveRoom ? liveRoom.players.get(client.userId) : null;
      if (!liveRoom || liveRoom.status !== "playing" || liveRoom.mode !== "battle_royale") return;
      if (!livePlayer || livePlayer.status !== "alive" || !livePlayer.disconnected) return;
      eliminateBattleRoyalePlayer(liveRoom, livePlayer, "disconnect_timeout");
    }, BR_RECONNECT_GRACE_MS);
    client.roomCode = "";
    broadcastRoom(room, "br_event", {
      type: "disconnected",
      user_id: player.userId,
      nickname: player.nickname,
      disconnect_expires_at: player.disconnectExpiresAt,
      room: serializeRoom(room),
    });
    return true;
  }

  function restoreBattleRoyaleClient(client) {
    const room = findRoomByUserId(client.userId);
    if (!room || room.mode !== "battle_royale" || room.status !== "playing") return false;
    const player = room.players.get(client.userId);
    if (!player || !player.disconnected || (player.disconnectExpiresAt || 0) < Date.now()) return false;
    if (player.disconnectTimeoutTimer) {
      clearTimeout(player.disconnectTimeoutTimer);
      player.disconnectTimeoutTimer = null;
    }
    player.disconnected = false;
    player.disconnectedAt = 0;
    player.disconnectExpiresAt = 0;
    client.roomCode = room.code;
    client.send("room_joined", { ok: true, room: serializeRoom(room), reconnected: true });
    client.send("room_updated", serializeRoom(room));
    broadcastRoom(room, "br_event", {
      type: "reconnected",
      user_id: player.userId,
      nickname: player.nickname,
      room: serializeRoom(room),
    });
    return true;
  }

  function broadcastRoom(room, event, data) {
    for (const player of room.players.values()) {
      const client = clientsByUserId.get(player.userId);
      if (client) client.send(event, payloadForPlayer(event, data, room, player));
    }
  }

  function payloadForPlayer(event, data, room, player) {
    if (!data || typeof data !== "object" || Array.isArray(data) || room.mode !== "zombie") return data;
    const payload = { ...data };
    if (payload.room && typeof payload.room === "object") payload.room = serializeRoom(room, player);
    if (event === "positions_sync") {
      payload.zombie_missile_orbs = player.status === "zombie" ? [] : (room.zombieMissileOrbs || []);
      payload.zombie_survivor_hints = player.status === "zombie" ? zombieSurvivorHintsFor(room, player) : [];
    }
    return payload;
  }

  function battleRoyaleSnapshotPayload(room, syncPayload, now, elapsed) {
    const players = Array.isArray(syncPayload.players) ? syncPayload.players : [];
    const remaining = players.filter((player) => String(player.status || "") === "alive").length;
    const activeAt = Number(room.activeAt) || Number(room.startedAt) || 0;
    const hazards = Array.isArray(syncPayload.hazards) ? syncPayload.hazards : battleRoyaleHazardPayloads(room, now);
    console.info(`[BR_HAZARD_SYNC_SENT] matchId=${room.matchId || ""} roomCode=${room.code} eventName=br_state_snapshot serverTime=${now} activeAt=${activeAt} hazardSeq=${Number(room.hazardSeq) || 0} hazardCount=${hazards.length} hazardIds=${hazards.map((hazard) => hazard.id).join(",")}`);
    return {
      type: "snapshot",
      mode: "battle_royale",
      match_id: room.matchId || "",
      matchId: room.matchId || "",
      roomCode: room.code,
      server_time: now,
      round_elapsed_ms: elapsed,
      intro_started_at: room.startedAt || 0,
      round_started_at: activeAt,
      active_at: activeAt,
      hazard_seq: Number(room.hazardSeq) || 0,
      round_ends_at: activeAt + BR_ZONE_SHRINK_MS,
      safe_zone: syncPayload.safe_zone || battleRoyaleSafeZonePayload(room, now),
      players,
      orbs: room.brOrbs || [],
      br_orbs: room.brOrbs || [],
      hazards,
      multiplayer_hazards: hazards,
      missiles: room.brMissiles || [],
      br_missiles: room.brMissiles || [],
      remaining_players: remaining,
    };
  }

  function zombieSurvivorHintsFor(room, viewer) {
    return [...room.players.values()]
      .filter((item) => item.userId !== viewer.userId && item.status !== "zombie")
      .map((item) => ({
        user_id: item.userId,
        dx: (Number(item.x) || 0) - (Number(viewer.x) || 0),
        dy: (Number(item.y) || 0) - (Number(viewer.y) || 0),
      }));
  }

  function serializeRoom(room, viewer = null) {
    const showZombieOrbs = room.mode === "zombie" && (!viewer || viewer.status !== "zombie");
    const now = Date.now();
    const brHazards = room.mode === "battle_royale" ? battleRoyaleHazardPayloads(room, now) : [];
    return {
      code: room.code,
      room_code: room.code,
      mode: room.mode,
      tag_variant: room.tagVariant || "basic",
      host_id: room.hostId,
      status: room.status,
      server_time: now,
      match_id: room.matchId || "",
      matchId: room.matchId || "",
      roomCode: room.code,
      round_started_at: room.mode === "zombie" || room.mode === "battle_royale" ? (room.activeAt || 0) : 0,
      active_at: room.activeAt || 0,
      hazard_seq: room.mode === "battle_royale" ? (Number(room.hazardSeq) || 0) : 0,
      round_ends_at: room.roundEndsAt || 0,
      max_players: room.maxPlayers,
      private: Boolean(room.private),
      auto_start_at: room.autoStartAt || 0,
      quick_start_at: room.quickStartAt || 0,
      settings: room.settings || {},
      tag_item_select_until: room.tagItemSelectUntil || 0,
      tag_active_at: room.tagActiveAt || 0,
      tag_prison_sentinel: room.prisonSentinel || {},
      active_rescue: room.mode === "tag" ? activeTagRescuePayload(room) : null,
      tag_rescue: room.mode === "tag" ? (activeTagRescuePayload(room) || {}) : {},
      br_orbs: room.mode === "battle_royale" ? (room.brOrbs || []) : [],
      br_missiles: room.mode === "battle_royale" ? (room.brMissiles || []) : [],
      missiles: room.mode === "battle_royale" ? (room.brMissiles || []) : [],
      zombie_missile_orbs: showZombieOrbs ? (room.zombieMissileOrbs || []) : [],
      zombie_missile_required: ZOMBIE_MISSILE_CHARGE_REQUIRED,
      zombie_reveal_at: room.mode === "zombie" ? (room.zombieRevealAt || ((room.startedAt || 0) + ZOMBIE_ROLE_REVEAL_MS)) : 0,
      hazards: brHazards,
      multiplayer_hazards: brHazards,
      safe_zone: room.mode === "battle_royale" ? battleRoyaleSafeZonePayload(room, now) : null,
      players: [...room.players.values()].map((player) => ({
        user_id: player.userId,
        nickname: player.nickname,
        is_host: player.isHost,
        ready: player.ready,
        is_ready: player.ready,
        returned_to_lobby: player.returnedToLobby !== false,
        in_lobby: player.returnedToLobby !== false,
        status: player.status,
        role: player.role,
        tag_team: player.tagTeam || "",
        hp: room.mode === "battle_royale" ? (Number.isFinite(player.hp) ? player.hp : BR_INITIAL_HP) : (player.hp || 0),
        max_hp: room.mode === "battle_royale" ? BR_INITIAL_HP : 0,
        rank: player.rank || 0,
        join_order: player.joinOrder || 0,
        disconnected: Boolean(player.disconnected),
        disconnect_expires_at: player.disconnectExpiresAt || 0,
        shield: player.shield,
        br_shield_charge: player.brShieldCharge || 0,
        br_shield_required: BR_SHIELD_CHARGE_REQUIRED,
        br_missile_charge: player.brMissileCharge || 0,
        br_missile_required: BR_MISSILE_CHARGE_REQUIRED,
        shield_count: player.brShieldCharge || 0,
        shield_max: BR_SHIELD_CHARGE_REQUIRED,
        shield_active: Boolean(player.shield),
        alive: player.status === "alive" || player.status === "winner",
        eliminated_rank: player.status === "eliminated" ? (player.rank || 0) : 0,
        survived_ms: player.survivedMs || 0,
        zombie_missile_charge: player.zombieMissileCharge || 0,
        zombie_slow_until: player.zombieSlowUntil || 0,
        tag_count: player.tagCount || 0,
        sentinel_contribution: player.sentinelContributionCount || 0,
        tag_immune_until: player.tagImmuneUntil || 0,
        next_tag_allowed_until: player.nextTagAllowedUntil || 0,
        rescued_count: player.rescuedCount || 0,
        tag_boost_until: player.tagBoostUntil || 0,
        tag_boost_ready_at: player.tagBoostReadyAt || 0,
        runner_dash_until: player.runnerDashUntil || 0,
        runner_dash_ready_at: player.runnerDashReadyAt || 0,
        tag_item: player.tagItem || "",
        tag_item_ready_at: player.tagItemReadyAt || 0,
        tag_slow_until: player.tagSlowUntil || 0,
        clone_until: player.cloneUntil || 0,
        runner_speed_until: player.runnerSpeedUntil || 0,
        runner_speed_stacks: player.runnerSpeedStacks || 0,
        smoke_until: player.smokeUntil || 0,
        jailed_at: player.jailedAt || 0,
        x: player.x,
        y: player.y,
        facing_angle: player.facingAngle || 0,
        shield: player.shield,
        skin_id: player.skinId || "skin_default",
      })),
    };
  }

  function resultPayload(player) {
    const coins = Number.isFinite(player.coins) ? player.coins : zombieCoinsForPlayer(player);
    const rewardBreakdown = zombieRewardBreakdown(player, player.rewardReason || "", player.rewardElapsedMs);
    return {
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      survived_ms: player.survivedMs,
      infected_count: player.infectedCount,
      missile_hits: Math.max(0, Number(player.zombieMissileHits) || 0),
      is_last_survivor: Boolean(player.isLastSurvivor),
      is_mvp: Boolean(player.isZombieMvp),
      is_winner: Boolean(player.isWinner),
      reward_breakdown: rewardBreakdown,
      coins,
    };
  }

  function tagResultPayload(player) {
    const elapsedMs = Number.isFinite(player.rewardElapsedMs) ? player.rewardElapsedMs : TAG_ROUND_MS;
    const coins = Number.isFinite(player.coins) ? player.coins : policeThiefCoinsForPlayer(player, player.rewardReason || "time_up", elapsedMs);
    const rewardBreakdown = policeThiefRewardBreakdown(player, player.rewardReason || "time_up", elapsedMs);
    const team = tagTeamForPlayer(player);
    const role = team === "tagger" ? "police" : "thief";
    const resultText = Boolean(player.isWinner) ? "승" : "패";
    return {
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      score: Math.max(0, player.score || 0),
      survived_ms: player.survivedMs,
      tag_count: player.tagCount || 0,
      arrests: player.tagCount || 0,
      sentinel_contribution: player.tagVariant === "item" ? (player.sentinelContributionCount || 0) : 0,
      sentinel_assists: player.tagVariant === "item" ? (player.sentinelContributionCount || 0) : 0,
      rescued_count: player.rescuedCount || 0,
      rescues: player.rescuedCount || 0,
      role,
      team: role,
      status: player.status,
      tag_team: team,
      tag_variant: player.tagVariant || "basic",
      result_text: resultText,
      free_at_end: Boolean(player.freeAtEnd),
      survived_free: Boolean(player.freeAtEnd),
      rescued_and_stayed_free: Boolean(player.rescuedAndStayedFree),
      escaped_after_rescue: Boolean(player.rescuedAndStayedFree),
      is_mvp: Boolean(player.isTagMvp),
      is_winner: Boolean(player.isWinner),
      reward_breakdown: rewardBreakdown,
      coins,
    };
  }

  function battleRoyaleResultPayload(player) {
    const coins = Number.isFinite(player.coins) ? player.coins : battleRoyaleCoinsForPlayer(player);
    const elapsedMs = Number.isFinite(player.rewardElapsedMs) ? player.rewardElapsedMs : BR_ZONE_SHRINK_MS;
    const rewardBreakdown = battleRoyaleRewardBreakdown(player, player.rewardReason || "last_survivor", elapsedMs);
    return {
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      survived_ms: player.survivedMs,
      alive: player.status === "alive" || player.status === "winner",
      eliminated_rank: player.status === "eliminated" ? (player.rank || 0) : 0,
      is_winner: player.rank === 1,
      hp: Number.isFinite(player.hp) ? player.hp : BR_INITIAL_HP,
      max_hp: BR_INITIAL_HP,
      shield_count: player.brShieldCharge || 0,
      shield_max: BR_SHIELD_CHARGE_REQUIRED,
      shield_active: Boolean(player.shield),
      missile_count: player.brMissileCharge || 0,
      missile_max: BR_MISSILE_CHARGE_REQUIRED,
      eliminations: Math.max(0, Number(player.brEliminations) || 0),
      homing_hits: Math.max(0, Number(player.brHomingHits) || 0),
      eliminated_at: player.eliminatedAt || 0,
      elimination_sequence: player.eliminationSequence || 0,
      join_order: player.joinOrder || 0,
      reward_breakdown: rewardBreakdown,
      coins,
    };
  }
}

function makeWsClient(ws, payload) {
  const handlers = new Map();
  const closeHandlers = [];
  ws.on("message", (raw) => {
    let packet = {};
    try { packet = JSON.parse(String(raw)); } catch { return; }
    const event = String(packet.event || "");
    const handler = handlers.get(event);
    if (handler) handler(packet.data || {}, null);
  });
  ws.on("close", () => closeHandlers.forEach((handler) => handler()));
  return {
    userId: String(payload.sub),
    nickname: String(payload.nickname || payload.username || "Player"),
    roomCode: "",
    on: (event, handler) => handlers.set(event, handler),
    onClose: (handler) => closeHandlers.push(handler),
    send: (event, data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ event, data }));
    },
  };
}

function makeSocketIoClient(socket) {
  return {
    userId: String(socket.data.userId),
    nickname: String(socket.data.nickname || "Player"),
    roomCode: "",
    on: (event, handler) => socket.on(event, handler),
    onClose: (handler) => socket.on("disconnect", handler),
    send: (event, data) => socket.emit(event, data),
  };
}

function sendAck(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function sendRequestFailed(client, ack, action, error) {
  const payload = { ok: false, action, error };
  sendAck(ack, payload);
  client.send("request_failed", payload);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeMultiplayerMode(value) {
  const mode = String(value || "zombie").trim().toLowerCase();
  if (mode === "tag") return "tag";
  return mode === "battle_royale" ? "battle_royale" : "zombie";
}

function normalizeTagVariant(value) {
 return String(value || "basic").trim().toLowerCase() === "item" ? "item" : "basic";
}

function cleanCosmeticId(value) {
  const id = String(value || "skin_default").trim();
  return /^[a-z0-9_:-]{1,48}$/i.test(id) ? id : "skin_default";
}

function quickMatchKey(mode, tagVariant = "basic") {
  const normalized = normalizeMultiplayerMode(mode);
  return normalized === "tag" ? `${normalized}:${normalizeTagVariant(tagVariant)}` : normalized;
}

function quickMatchSizeForMode(mode) {
  return maxPlayersForMode(mode);
}

function maxPlayersForMode(mode) {
  const normalized = normalizeMultiplayerMode(mode);
  if (normalized === "battle_royale") return BATTLE_ROYALE_MATCH_SIZE;
  if (normalized === "tag") return TAG_MATCH_SIZE;
  return ZOMBIE_MATCH_SIZE;
}

function cleanRoomSettings(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    tag_variant: normalizeTagVariant(input.tag_variant),
  };
}

function isValidTagItemForRole(role, itemId) {
  if (role === "tagger") return TAG_HUNTER_ITEMS.has(itemId);
  if (role === "runner") return TAG_RUNNER_ITEMS.has(itemId);
  return false;
}

function nearestActiveRunner(room, source, now) {
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const player of room.players.values()) {
    if (player.role !== "runner" || player.status !== "runner") continue;
    if ((player.smokeUntil || 0) > now) continue;
    if (!hasFreshPosition(player, now)) continue;
    const d = distance(source, player);
    if (d < bestDist) {
      bestDist = d;
      best = player;
    }
  }
  return best;
}

function distance(a, b) {
  const dx = (Number(a.x) || 0) - (Number(b.x) || 0);
  const dy = (Number(a.y) || 0) - (Number(b.y) || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function distancePoint(player, point) {
  const dx = (Number(player.x) || 0) - (Number(point.x) || 0);
  const dy = (Number(player.y) || 0) - (Number(point.y) || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function distancePointToSegment(point, from, to) {
  const px = Number(point.x) || 0;
  const py = Number(point.y) || 0;
  const ax = Number(from.x) || 0;
  const ay = Number(from.y) || 0;
  const bx = Number(to.x) || 0;
  const by = Number(to.y) || 0;
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= 0.0001) {
    const dx = px - ax;
    const dy = py - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function clampAngle(angle) {
  let value = Number(angle) || 0;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function battleRoyaleZone(room, now = Date.now()) {
  const activeAt = Number(room.activeAt) || Number(room.startedAt) || now;
  const elapsed = Math.max(0, now - activeAt);
  const t = Math.min(1, elapsed / BR_ZONE_SHRINK_MS);
  const radius = BR_INITIAL_ZONE_RADIUS + (BR_FINAL_ZONE_RADIUS - BR_INITIAL_ZONE_RADIUS) * t;
  let damage = 0;
  if (elapsed >= 90_000) damage = 2;
  else if (elapsed >= 60_000) damage = 1;
  else if (elapsed >= 30_000) damage = 1;
  return { center: { x: 0, y: 0 }, radius, damage };
}

function battleRoyaleSafeZoneRatio(zone) {
  return Math.max(0, Math.min(1, (Number(zone?.radius) || 0) / BR_INITIAL_ZONE_RADIUS));
}

function battleRoyaleSafeZonePayload(room, now = Date.now()) {
  const zone = battleRoyaleZone(room, now);
  const startedAt = Number(room.activeAt) || Number(room.startedAt) || now;
  return {
    center_x: zone.center.x,
    center_y: zone.center.y,
    current_radius: zone.radius,
    target_radius: BR_FINAL_ZONE_RADIUS,
    initial_radius: BR_INITIAL_ZONE_RADIUS,
    safe_zone_ratio: battleRoyaleSafeZoneRatio(zone),
    shrink_started_at: startedAt,
    shrink_ends_at: startedAt + BR_ZONE_SHRINK_MS,
    damage_per_sec: zone.damage,
  };
}

function hasFreshPosition(player, now) {
  return now - (Number(player.updatedAt) || 0) <= TAG_STALE_POSITION_MS;
}

function sanitizePositionUpdate(player, data, now) {
  const nextX = finiteNumber(data.x);
  const nextY = finiteNumber(data.y);
  if (nextX === null || nextY === null) return null;
  const clampedNext = {
    x: clampNumber(nextX, -POSITION_MAX_ABS, POSITION_MAX_ABS),
    y: clampNumber(nextY, -POSITION_MAX_ABS, POSITION_MAX_ABS),
  };
  if (!player.positionInitialized) return clampedNext;
  const dtMs = Math.max(1, now - (Number(player.updatedAt) || now));
  if (dtMs < POSITION_MIN_INTERVAL_MS) return null;
  const from = { x: Number(player.x) || 0, y: Number(player.y) || 0 };
  const dx = clampedNext.x - from.x;
  const dy = clampedNext.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = POSITION_GRACE_DISTANCE + POSITION_MAX_SPEED * dtMs / 1000;
  if (dist <= maxDist) return clampedNext;
  if (dist <= 0.001) return from;
  const ratio = maxDist / dist;
  return {
    x: from.x + dx * ratio,
    y: from.y + dy * ratio,
  };
}

function clampPlayerToTagPrison(player) {
  const dx = (Number(player.x) || 0) - TAG_PRISON.x;
  const dy = (Number(player.y) || 0) - TAG_PRISON.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = Math.max(8, TAG_PRISON_RADIUS - 16);
  if (dist <= maxDist || dist <= 0.001) return;
  const ratio = maxDist / dist;
  player.x = TAG_PRISON.x + dx * ratio;
  player.y = TAG_PRISON.y + dy * ratio;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function zombieSpeedMultiplier(elapsedMs) {
  return 1.5;
}

function isZombieRoundActive(room, now = Date.now()) {
  if (!room || room.mode !== "zombie" || room.status !== "playing") return false;
  return now >= (room.activeAt || ((room.startedAt || now) + ZOMBIE_ROLE_REVEAL_MS))
    && now < (room.roundEndsAt || ((room.activeAt || room.startedAt || now) + ZOMBIE_ROUND_MS));
}

function cleanZombieInfectionReason(value) {
  const reason = String(value || "contact").trim().toLowerCase();
  if (reason === "initial" || reason === "server" || reason === "forced") return reason;
  return "contact";
}

function zombieMvpUserId(players, reason) {
  const candidates = reason === "zombie_win"
    ? players.filter((player) => player.status === "zombie")
    : players.filter((player) => player.isWinner || player.status !== "zombie");
  if (candidates.length === 0) return "";
  candidates.sort((a, b) => {
    if (reason === "zombie_win") {
      const infectedDelta = (Number(b.infectedCount) || 0) - (Number(a.infectedCount) || 0);
      if (infectedDelta !== 0) return infectedDelta;
      return compareJoinOrderAndUserId(a, b);
    }
    const survivedDelta = (Number(b.survivedMs) || 0) - (Number(a.survivedMs) || 0);
    if (survivedDelta !== 0) return survivedDelta;
    const missileDelta = (Number(b.zombieMissileHits) || 0) - (Number(a.zombieMissileHits) || 0);
    if (missileDelta !== 0) return missileDelta;
    return compareJoinOrderAndUserId(a, b);
  });
  return candidates[0]?.userId || "";
}

function zombieCoinsForPlayer(player, reason = "") {
  return cappedRewardTotal(zombieRewardBreakdown(player, reason), ZOMBIE_COIN_HARD_CAP);
}

function zombieRewardBreakdown(player, reason = "", _elapsedMs = ZOMBIE_ROUND_MS) {
  const isWinner = Boolean(player?.isWinner ?? player?.is_winner);
  const infectedCount = Math.max(0, Number(player?.infectedCount ?? player?.infected_count) || 0);
  const missileHits = Math.max(0, Number(player?.zombieMissileHits ?? player?.missile_hits) || 0);
  const rows = [
    rewardRow(isWinner ? "승리 보상" : "패배 보상", isWinner ? 20 : 5),
    rewardRow(`감염 ${Math.min(3, infectedCount)}회`, Math.min(12, infectedCount * 4)),
    rewardRow(`유도탄 명중 ${Math.min(3, missileHits)}회`, Math.min(6, missileHits * 2)),
    rewardRow("마지막 생존자", Boolean(player?.isLastSurvivor ?? player?.is_last_survivor) ? 5 : 0),
    rewardRow("90초 생존 성공", reason === "survivor_win" && isWinner && String(player?.status || "") !== "zombie" ? 5 : 0),
    rewardRow("MVP", Boolean(player?.isZombieMvp ?? player?.is_mvp) ? 6 : 0),
  ];
  return withHardCap(rows, ZOMBIE_COIN_HARD_CAP);
}

function isNormalTagResult(reason = "time_up") {
  return reason === "time_up" || reason === "caught" || reason === "taggers_win";
}

function tagTeamForPlayer(player) {
  if (Math.max(0, Number(player?.rescuedCount ?? player?.rescued_count ?? player?.rescues) || 0) > 0) return "runner";
  return player?.tagTeam || (player?.role === "tagger" || player?.status === "tagger" ? "tagger" : "runner");
}

function tagMvpScore(player) {
  const team = tagTeamForPlayer(player);
  const winBonus = Boolean(player?.isWinner ?? player?.is_winner) ? 80 : 0;
  if (team === "tagger") {
    return Math.max(0, Number(player?.tagCount ?? player?.tag_count) || 0) * 100
      + Math.max(0, Number(player?.sentinelContributionCount ?? player?.sentinel_contribution) || 0) * 40
      + winBonus;
  }
  const freeSurvivalSeconds = Math.max(0, Math.floor((Number(player?.survivedMs ?? player?.survived_ms) || 0) / 1000));
  const survivalScore = Boolean(player?.freeAtEnd ?? player?.free_at_end) ? 80 : 0;
  return Math.max(0, Number(player?.rescuedCount ?? player?.rescued_count ?? player?.rescues) || 0) * 120
    + freeSurvivalSeconds
    + survivalScore
    + winBonus;
}

function tagMvpUserId(players) {
  const candidates = players.filter((player) => player && player.userId);
  if (candidates.length === 0) return "";
  candidates.sort((a, b) => {
    const scoreDelta = tagMvpScore(b) - tagMvpScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    const winnerDelta = Number(Boolean(b.isWinner)) - Number(Boolean(a.isWinner));
    if (winnerDelta !== 0) return winnerDelta;
    const activeDelta = (Number(b.survivedMs) || 0) - (Number(a.survivedMs) || 0);
    if (activeDelta !== 0) return activeDelta;
    const statDelta = tagPrimaryStat(b) - tagPrimaryStat(a);
    if (statDelta !== 0) return statDelta;
    return compareJoinOrderAndUserId(a, b);
  });
  return candidates[0]?.userId || "";
}

function tagCoinsForPlayer(player, reason = "time_up", elapsedMs = TAG_ROUND_MS) {
  return policeThiefCoinsForPlayer(player, reason, elapsedMs);
}

function policeThiefCoinsForPlayer(player, reason = "time_up", elapsedMs = TAG_ROUND_MS) {
  return cappedRewardTotal(policeThiefRewardBreakdown(player, reason, elapsedMs), TAG_COIN_HARD_CAP);
}

function policeThiefRewardBreakdown(player, reason = "time_up", elapsedMs = TAG_ROUND_MS) {
  if (!isNormalTagResult(reason) && elapsedMs < PLAYER_LEFT_REWARD_MIN_MS) return [];
  const team = tagTeamForPlayer(player);
  const isWinner = Boolean(player?.isWinner ?? player?.is_winner);
  const isItemMode = String(player?.tagVariant ?? player?.tag_variant ?? "basic") === "item";
  const normalParticipation = elapsedMs >= 120_000 || isNormalTagResult(reason);
  const tagCount = Math.max(0, Number(player?.tagCount ?? player?.tag_count) || 0);
  const sentinelCount = isItemMode ? Math.max(0, Number(player?.sentinelContributionCount ?? player?.sentinel_contribution) || 0) : 0;
  const rescueCount = Math.max(0, Number(player?.rescuedCount ?? player?.rescued_count ?? player?.rescues) || 0);
  const rows = [
    rewardRow(isWinner ? "승리 보상" : "패배 보상", isWinner ? 18 : 8),
    rewardRow("정상 참여", normalParticipation ? 2 : 0),
    rewardRow(`체포 ${Math.min(4, tagCount)}회`, team === "tagger" ? Math.min(16, tagCount * 4) : 0),
    rewardRow(`감옥 감시자 기여 ${Math.min(3, sentinelCount)}회`, team === "tagger" ? Math.min(6, sentinelCount * 2) : 0),
    rewardRow(`구출 ${Math.min(3, rescueCount)}회`, team === "runner" ? Math.min(15, rescueCount * 5) : 0),
    rewardRow("자유 상태 생존", team === "runner" && Boolean(player?.freeAtEnd ?? player?.free_at_end) ? 6 : 0),
    rewardRow("구출 후 생존", team === "runner" && Boolean(player?.rescuedAndStayedFree ?? player?.rescued_and_stayed_free) ? 3 : 0),
    rewardRow("MVP", Boolean(player?.isTagMvp ?? player?.is_mvp) && isNormalTagResult(reason) ? 8 : 0),
  ];
  return withHardCap(rows, TAG_COIN_HARD_CAP);
}

function tagPrimaryStat(player) {
  return tagTeamForPlayer(player) === "tagger"
    ? (Number(player?.tagCount ?? player?.tag_count) || 0) + (Number(player?.sentinelContributionCount ?? player?.sentinel_contribution) || 0)
    : (Number(player?.rescuedCount ?? player?.rescued_count ?? player?.rescues) || 0);
}

function compareJoinOrderAndUserId(a, b) {
  const joinDelta = (Number(a?.joinOrder ?? a?.join_order) || 999999) - (Number(b?.joinOrder ?? b?.join_order) || 999999);
  if (joinDelta !== 0) return joinDelta;
  return String(a?.userId ?? a?.user_id ?? "").localeCompare(String(b?.userId ?? b?.user_id ?? ""));
}

function compareBattleRoyaleResultPlayers(a, b) {
  const rankDelta = (Number(a?.rank) || 99) - (Number(b?.rank) || 99);
  if (rankDelta !== 0) return rankDelta;
  const eliminatedDelta = (Number(a?.eliminatedAt ?? a?.eliminated_at) || 0) - (Number(b?.eliminatedAt ?? b?.eliminated_at) || 0);
  if (eliminatedDelta !== 0) return eliminatedDelta;
  const sequenceDelta = (Number(a?.eliminationSequence ?? a?.elimination_sequence) || 0) - (Number(b?.eliminationSequence ?? b?.elimination_sequence) || 0);
  if (sequenceDelta !== 0) return sequenceDelta;
  return compareJoinOrderAndUserId(a, b);
}

function rewardRow(label, amount) {
  return { label, amount: Math.floor(Number(amount) || 0) };
}

function cappedRewardTotal(rows, cap) {
  const list = Array.isArray(rows) ? rows : [];
  return Math.max(0, Math.min(cap, list.reduce((total, row) => total + (Number(row.amount) || 0), 0)));
}

function withHardCap(rows, cap) {
  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => Math.max(0, Number(row.amount) || 0) > 0);
  const total = filtered.reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0);
  if (total > cap) filtered.push(rewardRow("하드캡 조정", cap - total));
  return filtered;
}

function makeMatchId(room) {
  const mode = room?.mode === "tag" ? "police_thief" : String(room?.mode || "unknown");
  return `${mode}_${String(room?.code || "room").toLowerCase()}_${Number(room?.roundId) || 1}_${Date.now()}`;
}

function matchRewardRefId(room, mode, userId) {
  const matchId = room?.matchId || makeMatchId({ ...room, mode });
  return `match:${mode}:${matchId}:user:${userId}`;
}

function battleRoyaleCoinsForPlayer(player, reason = "last_survivor", elapsedMs = BR_ZONE_SHRINK_MS) {
  if (reason === "player_left" && elapsedMs < PLAYER_LEFT_REWARD_MIN_MS) return 0;
  return cappedRewardTotal(battleRoyaleRewardBreakdown(player, reason, elapsedMs), BR_COIN_HARD_CAP);
}

function battleRoyaleRewardBreakdown(player, reason = "last_survivor", elapsedMs = BR_ZONE_SHRINK_MS) {
  if (reason === "player_left" && elapsedMs < PLAYER_LEFT_REWARD_MIN_MS) return [];
  const rank = Math.max(1, Number(player?.rank) || 6);
  const survivedMs = Math.max(0, Number(player?.survivedMs ?? player?.survived_ms ?? elapsedMs) || 0);
  const eliminations = Math.max(0, Number(player?.brEliminations ?? player?.eliminations) || 0);
  const homingHits = Math.max(0, Number(player?.brHomingHits ?? player?.homing_hits) || 0);
  const rankCoins = ({ 1: 35, 2: 22, 3: 16, 4: 10, 5: 7, 6: 5 })[rank] || 5;
  const survivalTicks = Math.floor(survivedMs / 30_000);
  const rows = [
    rewardRow(`${rank}위 보상`, rankCoins),
    rewardRow(`탈락 유도/처치 ${Math.min(2, eliminations)}회`, Math.min(10, eliminations * 5)),
    rewardRow(`유도탄 명중 ${Math.min(3, homingHits)}회`, Math.min(6, homingHits * 2)),
    rewardRow(`생존 시간 ${Math.min(4, survivalTicks)}회`, Math.min(8, survivalTicks * 2)),
  ];
  return withHardCap(rows, BR_COIN_HARD_CAP);
}
