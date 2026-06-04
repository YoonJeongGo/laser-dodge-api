import { WebSocketServer } from "ws";

const ZOMBIE_MATCH_SIZE = 4;
const TAG_MATCH_SIZE = 6;
const BATTLE_ROYALE_MATCH_SIZE = 6;
const MIN_MATCH_SIZE = 2;
const QUICK_MATCH_TIMEOUT_MS = 30_000;
const POSITION_SYNC_MS = 50;
const FIRST_ZOMBIE_DELAY_MS = 30_000;
const TOUCH_RADIUS = 30;
const TAG_ROUND_MS = 120_000;
const TAG_IMMUNITY_MS = 1_200;
const TAG_TOUCH_COOLDOWN_MS = 300;
const TAG_STALE_POSITION_MS = 1_500;
const POSITION_MIN_INTERVAL_MS = 25;
const POSITION_MAX_ABS = 200_000;
const POSITION_MAX_SPEED = 1_600;
const POSITION_GRACE_DISTANCE = 90;
const PLAYER_LEFT_REWARD_MIN_MS = 30_000;
const BR_INITIAL_HP = 3;
const BR_INITIAL_ZONE_RADIUS = 1800;
const BR_FINAL_ZONE_RADIUS = 260;
const BR_ZONE_SHRINK_MS = 120_000;
const BR_ZONE_DAMAGE_INTERVAL_MS = 1000;
const BR_SPAWN_RADIUS = 900;

export function attachZombieMultiplayer({ httpServer, io, pool, verifyAuthToken, makeRoomCode }) {
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
    client.on("quick_match", (data) => joinQuickMatch(client, data));
    client.on("cancel_quick_match", () => leaveQuickMatch(client, true));
    client.on("create_room", (data, ack) => createRoom(client, data, ack));
    client.on("join_room", (data, ack) => joinRoom(client, data, ack));
    client.on("leave_room", () => removeFromCurrentRoom(client));
    client.on("invite_friend", (data, ack) => inviteFriend(client, data, ack));
    client.on("accept_invite", (data, ack) => acceptInvite(client, data, ack));
    client.on("player_ready", (data) => setReady(client, data));
    client.on("start_game", () => startGameByHost(client));
    client.on("position_update", (data) => updatePosition(client, data));
    client.on("player_infected", (data) => requestInfection(client, data));
    client.on("tag_touch", (data) => requestTagTouch(client, data));
    client.on("br_damage", (data) => requestBattleRoyaleDamage(client, data));
    client.on("game_over", (data, ack) => finishGame(client, data, ack));
    client.onClose(() => disconnectClient(client));
  }

  async function createRoom(client, data = {}, ack = null) {
    const mode = normalizeMultiplayerMode(data.mode);
    const defaultMax = maxPlayersForMode(mode);
    const maxPlayers = clampInt(data.max_players, 2, defaultMax, defaultMax);
    const room = makeRoom(mode, client, maxPlayers, false);
    room.private = Boolean(data.private);
    room.settings = cleanRoomSettings(data.settings);
    await persistRoom(room, client.userId);
    addPlayerToRoom(room, client, true);
    await persistRoomPlayer(room, client.userId, true);
    client.roomCode = room.code;
    sendAck(ack, { ok: true, room: serializeRoom(room) });
    client.send("room_created", { room: serializeRoom(room), room_code: room.code });
    broadcastRoom(room, "room_updated", serializeRoom(room));
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
  }

  async function joinQuickMatch(client, data = {}) {
    leaveQuickMatch(client, false);
    const mode = normalizeMultiplayerMode(data.mode);
    const matchSize = quickMatchSizeForMode(mode);
    const entry = { client, mode, joinedAt: Date.now(), timer: null };
    quickQueue.push(entry);
    entry.timer = setTimeout(() => startQuickMatchFromEntry(entry), QUICK_MATCH_TIMEOUT_MS);
    emitQuickQueue();
    const matching = quickQueue.filter((queued) => queued.mode === mode);
    if (matching.length >= matchSize) startQuickMatch(takeQuickMatchEntries(mode, matchSize));
  }

  function leaveQuickMatch(client, notify) {
    const idx = quickQueue.findIndex((entry) => entry.client === client);
    if (idx >= 0) {
      const [entry] = quickQueue.splice(idx, 1);
      clearTimeout(entry.timer);
      if (notify) client.send("room_updated", { queue_count: 0, max_players: quickMatchSizeForMode(entry.mode), mode: entry.mode, cancelled: true });
      emitQuickQueue();
    }
  }

  function startQuickMatchFromEntry(entry) {
    if (!quickQueue.includes(entry)) return;
    const matchSize = quickMatchSizeForMode(entry.mode);
    const count = Math.min(matchSize, quickQueue.filter((queued) => queued.mode === entry.mode).length);
    if (count < MIN_MATCH_SIZE) {
      entry.timer = setTimeout(() => startQuickMatchFromEntry(entry), QUICK_MATCH_TIMEOUT_MS);
      entry.client.send("room_updated", {
        queue_count: count,
        max_players: matchSize,
        mode: entry.mode,
        waiting_for_players: true,
      });
      return;
    }
    const group = takeQuickMatchEntries(entry.mode, count);
    startQuickMatch(group);
  }

  async function startQuickMatch(entries) {
    if (entries.length < MIN_MATCH_SIZE) return;
    for (const entry of entries) clearTimeout(entry.timer);
    const host = entries[0].client;
    const mode = entries[0].mode || "zombie";
    const room = makeRoom(mode, host, quickMatchSizeForMode(mode), true);
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
      const queueCount = quickQueue.filter((queued) => queued.mode === entry.mode).length;
      entry.client.send("room_updated", { queue_count: queueCount, max_players: quickMatchSizeForMode(entry.mode), mode: entry.mode });
    }
  }

  function takeQuickMatchEntries(mode, count) {
    const entries = [];
    for (let i = 0; i < quickQueue.length && entries.length < count;) {
      if (quickQueue[i].mode !== mode) {
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
      room = makeRoom(mode, client, quickMatchSizeForMode(mode), false);
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
    player.ready = Boolean(data.ready);
    broadcastRoom(room, "room_updated", serializeRoom(room));
  }

  function startGameByHost(client) {
    const room = getClientRoom(client);
    if (!room) return sendRequestFailed(client, null, "start_game", "room_not_found");
    if (room.status !== "waiting") return sendRequestFailed(client, null, "start_game", "room_not_waiting");
    if (room.hostId !== client.userId) return sendRequestFailed(client, null, "start_game", "not_host");
    if (room.players.size < 2) return sendRequestFailed(client, null, "start_game", "not_enough_players");
    if ([...room.players.values()].some((player) => !player.ready)) {
      return sendRequestFailed(client, null, "start_game", "players_not_ready");
    }
    startRoom(room);
  }

  function startRoom(room) {
    if (room.status === "playing") return;
    room.status = "playing";
    room.startedAt = Date.now();
    room.firstZombieDone = false;
    for (const player of room.players.values()) {
      player.status = "alive";
      player.role = "survivor";
      player.infectedCount = 0;
      player.tagCount = 0;
      player.tagImmuneUntil = 0;
      player.survivedMs = 0;
      player.rank = 0;
    }
    if (room.mode === "tag") assignInitialTagger(room);
    if (room.mode === "battle_royale") setupBattleRoyale(room);
    broadcastRoom(room, "game_starting", { countdown: 3, room: serializeRoom(room) });
    if (room.mode === "zombie") room.forceZombieTimer = setTimeout(() => forceFirstZombie(room), FIRST_ZOMBIE_DELAY_MS);
    if (room.mode === "tag") room.finishTimer = setTimeout(() => finishTagRoom(room, "time_up"), TAG_ROUND_MS);
    room.syncTimer = setInterval(() => syncPositions(room), POSITION_SYNC_MS);
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
    player.shield = Boolean(data.shield);
    player.updatedAt = now;
    player.positionInitialized = true;
    serverCheckInfections(room);
    serverCheckTags(room);
    serverCheckBattleRoyale(room);
  }

  function requestInfection(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "zombie") return;
    const player = room.players.get(client.userId);
    if (!player) return;
    const targetId = String(data.target_user_id || client.userId);
    const reason = String(data.reason || "laser");
    const target = room.players.get(targetId);
    if (!target || target.status === "zombie") return;
    if (reason === "contact" && player.status !== "zombie") return;
    infectPlayer(room, target, reason, player.userId);
  }

  function requestTagTouch(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "tag") return;
    const now = Date.now();
    if (now > room.startedAt + TAG_ROUND_MS) return;
    const tagger = room.players.get(client.userId);
    if (!tagger || tagger.role !== "tagger") return;
    if ((tagger.nextTagAllowedUntil || 0) > now) return;
    if (!hasFreshPosition(tagger, now)) return;
    const targetId = String(data.target_user_id || data.user_id || "");
    if (!targetId) return;
    const target = room.players.get(targetId);
    if (!target || target.role === "tagger") return;
    if (!hasFreshPosition(target, now)) return;
    if (distance(tagger, target) > TOUCH_RADIUS * 1.45) return;
    tagPlayer(room, tagger, target, "client_touch");
  }

  function requestBattleRoyaleDamage(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return;
    const player = room.players.get(client.userId);
    if (!player || player.status !== "alive") return;
    const reason = String(data.reason || "laser");
    if (reason !== "laser") return;
    applyBattleRoyaleDamage(room, player, 1, "laser");
  }

  function serverCheckInfections(room) {
    if (room.mode !== "zombie") return;
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
    if (now > room.startedAt + TAG_ROUND_MS) return;
    const tagger = [...room.players.values()].find((player) => player.role === "tagger");
    if (!tagger) {
      assignInitialTagger(room);
      return;
    }
    if ((tagger.nextTagAllowedUntil || 0) > now || !hasFreshPosition(tagger, now)) return;
    const runners = [...room.players.values()].filter((player) => player.role !== "tagger");
    for (const runner of runners) {
      if (!hasFreshPosition(runner, now)) continue;
      if (distance(tagger, runner) <= TOUCH_RADIUS) {
        tagPlayer(room, tagger, runner, "contact");
        return;
      }
    }
  }

  function assignInitialTagger(room) {
    const players = [...room.players.values()];
    if (players.length === 0) return;
    const now = Date.now();
    for (const player of players) {
      player.status = "runner";
      player.role = "runner";
      player.tagImmuneUntil = now + TAG_IMMUNITY_MS;
      player.nextTagAllowedUntil = 0;
    }
    const tagger = players[Math.floor(Math.random() * players.length)];
    tagger.status = "tagger";
    tagger.role = "tagger";
    tagger.tagImmuneUntil = 0;
    tagger.nextTagAllowedUntil = now + TAG_IMMUNITY_MS;
    console.info(`[tag] start room=${room.code} tagger=${tagger.userId}`);
    broadcastRoom(room, "tag_event", {
      user_id: tagger.userId,
      by_user_id: "server",
      reason: "initial",
      nickname: tagger.nickname,
      room: serializeRoom(room),
    });
  }

  function tagPlayer(room, tagger, target, reason) {
    const now = Date.now();
    if (!tagger || !target || tagger.role !== "tagger" || target.role === "tagger") return;
    if ((target.tagImmuneUntil || 0) > now) return;
    tagger.role = "runner";
    tagger.status = "runner";
    tagger.tagImmuneUntil = now + TAG_IMMUNITY_MS;
    target.role = "tagger";
    target.status = "tagger";
    target.tagImmuneUntil = 0;
    target.nextTagAllowedUntil = now + TAG_IMMUNITY_MS;
    tagger.nextTagAllowedUntil = now + TAG_TOUCH_COOLDOWN_MS;
    tagger.tagCount = (tagger.tagCount || 0) + 1;
    target.survivedMs = Math.max(target.survivedMs || 0, now - room.startedAt);
    broadcastRoom(room, "tag_event", {
      user_id: target.userId,
      by_user_id: tagger.userId,
      reason,
      nickname: target.nickname,
      room: serializeRoom(room),
    });
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
      player.hp = BR_INITIAL_HP;
      player.status = "alive";
      player.role = "alive";
      player.eliminatedAt = 0;
      player.lastZoneDamageAt = now;
      player.survivedMs = 0;
      player.rank = 0;
      player.positionInitialized = true;
      index += 1;
    }
  }

  function serverCheckBattleRoyale(room) {
    if (room.mode !== "battle_royale" || room.status !== "playing") return;
    const now = Date.now();
    const zone = battleRoyaleZone(room, now);
    if (zone.damage <= 0) return;
    for (const player of room.players.values()) {
      if (player.status !== "alive") continue;
      if (distancePoint(player, zone.center) <= zone.radius) continue;
      if (now - (player.lastZoneDamageAt || 0) < BR_ZONE_DAMAGE_INTERVAL_MS) continue;
      player.lastZoneDamageAt = now;
      applyBattleRoyaleDamage(room, player, zone.damage, "zone");
    }
  }

  function applyBattleRoyaleDamage(room, player, amount, reason) {
    if (!room || room.status !== "playing" || room.mode !== "battle_royale") return;
    if (!player || player.status !== "alive") return;
    if (reason === "laser" && player.shield) {
      player.shield = false;
      return;
    }
    player.hp = Math.max(0, (Number(player.hp) || BR_INITIAL_HP) - Math.max(1, amount));
    broadcastRoom(room, "br_event", {
      type: "damage",
      user_id: player.userId,
      hp: player.hp,
      reason,
      room: serializeRoom(room),
    });
    if (player.hp <= 0) eliminateBattleRoyalePlayer(room, player, reason);
  }

  function eliminateBattleRoyalePlayer(room, player, reason) {
    if (player.status !== "alive") return;
    const aliveBefore = [...room.players.values()].filter((item) => item.status === "alive").length;
    player.status = "eliminated";
    player.role = "eliminated";
    player.eliminatedAt = Date.now();
    player.survivedMs = Math.max(player.survivedMs || 0, player.eliminatedAt - room.startedAt);
    player.rank = Math.max(1, aliveBefore);
    broadcastRoom(room, "br_event", {
      type: "eliminated",
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      reason,
      room: serializeRoom(room),
    });
    const survivors = [...room.players.values()].filter((item) => item.status === "alive");
    if (survivors.length <= 1) finishBattleRoyaleRoom(room, survivors, "last_survivor");
  }

  function forceFirstZombie(room) {
    if (!room || room.status !== "playing" || room.firstZombieDone) return;
    const survivors = [...room.players.values()].filter((player) => player.status !== "zombie");
    if (survivors.length === 0) return;
    const target = survivors[Math.floor(Math.random() * survivors.length)];
    infectPlayer(room, target, "forced", "server");
  }

  function infectPlayer(room, target, reason, byUserId) {
    if (target.status === "zombie") return;
    target.status = "zombie";
    target.role = "zombie";
    target.infectedAt = Date.now();
    target.survivedMs = Math.max(target.survivedMs || 0, Date.now() - room.startedAt);
    room.firstZombieDone = true;
    if (byUserId && room.players.has(byUserId)) room.players.get(byUserId).infectedCount += 1;
    broadcastRoom(room, "infection_event", { user_id: target.userId, by_user_id: byUserId, reason, room: serializeRoom(room) });
    const survivors = [...room.players.values()].filter((player) => player.status !== "zombie");
    if (survivors.length === 1) broadcastRoom(room, "last_survivor", { user_id: survivors[0].userId });
    if (survivors.length <= 1) finishRoom(room, survivors);
  }

  async function finishGame(client, data = {}, ack = null) {
    const room = getClientRoom(client);
    if (!room) return sendAck(ack, { ok: false, error: "room_not_found" });
    sendRequestFailed(client, ack, "game_over", "client_result_disabled");
  }

  function finishRoom(room, survivors) {
    if (room.status === "finished") return;
    room.status = "finished";
    clearTimeout(room.forceZombieTimer);
    clearTimeout(room.finishTimer);
    clearInterval(room.syncTimer);
    const winnerIds = survivors.map((player) => player.userId);
    const players = [...room.players.values()];
    players.sort((a, b) => {
      if (winnerIds.includes(a.userId) && !winnerIds.includes(b.userId)) return -1;
      if (!winnerIds.includes(a.userId) && winnerIds.includes(b.userId)) return 1;
      return (b.survivedMs || 0) - (a.survivedMs || 0);
    });
    players.forEach((player, index) => {
      player.rank = index + 1;
      player.survivedMs = Math.max(player.survivedMs || 0, Date.now() - room.startedAt);
      saveZombieResult(room, player.userId, player).catch((error) => {
        console.error("[zombie] save result failed", {
          room: room.code,
          userId: player.userId,
          error: error?.message || String(error),
        });
      });
    });
    broadcastRoom(room, "game_result", {
      reason: winnerIds.length === 0 ? "zombie_team" : "last_survivor",
      winner_user_ids: winnerIds,
      players: players.map(resultPayload),
    });
  }

  function finishTagRoom(room, reason) {
    if (!room || room.status === "finished" || room.mode !== "tag") return;
    room.status = "finished";
    room.resultFinalized = true;
    clearTimeout(room.finishTimer);
    clearInterval(room.syncTimer);
    const now = Date.now();
    const players = [...room.players.values()];
    for (const player of players) {
      player.survivedMs = Math.max(player.survivedMs || 0, now - room.startedAt);
      player.score = Math.floor((player.survivedMs || 0) / 1000) + (player.tagCount || 0) * 120 + (player.role === "tagger" ? -25 : 25);
    }
    players.sort((a, b) => (b.score || 0) - (a.score || 0));
    players.forEach((player, index) => {
      player.rank = index + 1;
      player.coins = tagCoinsForRank(player.rank, reason, Math.max(0, now - room.startedAt));
      saveTagResult(room, player, reason).catch((error) => {
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
      winner_user_ids: players.length > 0 ? [players[0].userId] : [],
      players: players.map(tagResultPayload),
    });
  }

  function finishBattleRoyaleRoom(room, survivors, reason) {
    if (!room || room.status === "finished" || room.mode !== "battle_royale") return;
    room.status = "finished";
    room.resultFinalized = true;
    clearInterval(room.syncTimer);
    const now = Date.now();
    const elapsedMs = Math.max(0, now - room.startedAt);
    for (const survivor of survivors) {
      survivor.status = "winner";
      survivor.role = "winner";
      survivor.rank = 1;
      survivor.survivedMs = Math.max(survivor.survivedMs || 0, elapsedMs);
    }
    const players = [...room.players.values()];
    for (const player of players) {
      player.survivedMs = Math.max(player.survivedMs || 0, elapsedMs);
      if (!player.rank) player.rank = players.length;
      player.coins = battleRoyaleCoinsForRank(player.rank, reason, elapsedMs);
      saveBattleRoyaleResult(room, player).catch((error) => {
        console.error("[br] save result failed", {
          room: room.code,
          userId: player.userId,
          error: error?.message || String(error),
        });
      });
    }
    players.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    console.info(`[br] result room=${room.code} reason=${reason} players=${players.length}`);
    broadcastRoom(room, "game_result", {
      mode: "battle_royale",
      reason,
      winner_user_ids: survivors.map((player) => player.userId),
      players: players.map(battleRoyaleResultPayload),
    });
  }

  async function saveZombieResult(room, userId, data = {}) {
    if (!room || room.mode !== "zombie") throw new Error("invalid_zombie_result_room");
    const rank = clampInt(data.rank, 1, 99, 1);
    const survivedMs = Math.max(0, Number.parseInt(data.survived_ms ?? data.survivedMs, 10) || 0);
    const infectedCount = Math.max(0, Number.parseInt(data.infected_count ?? data.infectedCount, 10) || 0);
    const isWinner = Boolean(data.is_winner || rank === 1);
    const coins = isWinner ? 20 : 5;
    const refId = `${room.code}:zombie:${userId}`;
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
    const elapsedMs = Math.max(0, Date.now() - room.startedAt);
    const coins = Number.isFinite(player.coins) ? player.coins : tagCoinsForRank(player.rank, reason, elapsedMs);
    const refId = `${room.code}:tag:${player.userId}`;
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      await dbClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tag_result:${refId}`]);
      const existing = await dbClient.query(
        "SELECT id FROM coin_transactions WHERE user_id = $1 AND reason = 'tag_result' AND ref_id = $2 LIMIT 1",
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
      await dbClient.query("UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2", [coins, player.userId]);
      await dbClient.query(
        "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, 'tag_result', $3)",
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

  async function saveBattleRoyaleResult(room, player) {
    const coins = Number.isFinite(player.coins) ? player.coins : battleRoyaleCoinsForRank(player.rank);
    const refId = `${room.code}:battle_royale:${player.userId}`;
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
    const elapsed = Date.now() - room.startedAt;
    broadcastRoom(room, "positions_sync", {
      mode: room.mode,
      elapsed_ms: elapsed,
      round_ends_at: room.mode === "tag" ? room.startedAt + TAG_ROUND_MS : 0,
      zone_radius: room.mode === "battle_royale" ? battleRoyaleZone(room, Date.now()).radius : 0,
      zone_damage_per_sec: room.mode === "battle_royale" ? battleRoyaleZone(room, Date.now()).damage : 0,
      zombie_speed_multiplier: zombieSpeedMultiplier(elapsed),
      players: [...room.players.values()].map((player) => ({
        user_id: player.userId,
        nickname: player.nickname,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        status: player.status,
        role: player.role,
        hp: player.hp || 0,
        rank: player.rank || 0,
        shield: player.shield,
        tag_count: player.tagCount || 0,
        tag_immune_until: player.tagImmuneUntil || 0,
      })),
    });
  }

  function makeRoom(mode, hostClient, maxPlayers, quick) {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();
    const room = {
      code,
      dbId: null,
      mode,
      hostId: hostClient.userId,
      hostNickname: hostClient.nickname,
      maxPlayers,
      quick,
      private: false,
      settings: {},
      status: "waiting",
      createdAt: Date.now(),
      startedAt: 0,
      firstZombieDone: false,
      resultFinalized: false,
      players: new Map(),
      syncTimer: null,
      forceZombieTimer: null,
      finishTimer: null,
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
      ready: isHost,
      isHost,
      status: "alive",
      role: "survivor",
      x: 195,
      y: 422,
      vx: 0,
      vy: 0,
      shield: false,
      survivedMs: 0,
      infectedCount: 0,
      tagCount: 0,
      tagImmuneUntil: 0,
      nextTagAllowedUntil: 0,
      rank: 0,
      hp: BR_INITIAL_HP,
      eliminatedAt: 0,
      lastZoneDamageAt: 0,
      updatedAt: Date.now(),
      positionInitialized: false,
    });
  }

  function removeFromCurrentRoom(client) {
    const room = getClientRoom(client);
    if (!room) return;
    const wasHost = room.hostId === client.userId;
    const leavingPlayer = room.players.get(client.userId);
    const wasTagger = room.mode === "tag" && leavingPlayer && leavingPlayer.role === "tagger";
    room.players.delete(client.userId);
    client.roomCode = "";
    if (room.players.size === 0) {
      clearTimeout(room.forceZombieTimer);
      clearTimeout(room.finishTimer);
      clearInterval(room.syncTimer);
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
      if (room.status === "playing" && room.mode === "tag" && room.players.size < 2) finishTagRoom(room, "player_left");
      else if (room.status === "playing" && room.mode === "tag" && wasTagger) assignInitialTagger(room);
      else if (room.status === "playing" && room.mode === "battle_royale") {
        const survivors = [...room.players.values()].filter((item) => item.status === "alive");
        if (survivors.length <= 1) finishBattleRoyaleRoom(room, survivors, "player_left");
      }
    }
  }

  function disconnectClient(client) {
    const current = clientsByUserId.get(client.userId);
    if (current === client) clientsByUserId.delete(client.userId);
    leaveQuickMatch(client, false);
    removeFromCurrentRoom(client);
  }

  function getClientRoom(client) {
    if (!client.roomCode) return null;
    return rooms.get(client.roomCode) || null;
  }

  function broadcastRoom(room, event, data) {
    for (const player of room.players.values()) {
      const client = clientsByUserId.get(player.userId);
      if (client) client.send(event, data);
    }
  }

  function serializeRoom(room) {
    return {
      code: room.code,
      room_code: room.code,
      mode: room.mode,
      host_id: room.hostId,
      status: room.status,
      max_players: room.maxPlayers,
      private: Boolean(room.private),
      settings: room.settings || {},
      players: [...room.players.values()].map((player) => ({
        user_id: player.userId,
        nickname: player.nickname,
        is_host: player.isHost,
        ready: player.ready,
        is_ready: player.ready,
        status: player.status,
        role: player.role,
        hp: player.hp || 0,
        rank: player.rank || 0,
        tag_count: player.tagCount || 0,
        tag_immune_until: player.tagImmuneUntil || 0,
        next_tag_allowed_until: player.nextTagAllowedUntil || 0,
        x: player.x,
        y: player.y,
        shield: player.shield,
      })),
    };
  }

  function resultPayload(player) {
    return {
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      survived_ms: player.survivedMs,
      infected_count: player.infectedCount,
      is_winner: player.rank === 1,
      coins: player.rank === 1 ? 20 : 5,
    };
  }

  function tagResultPayload(player) {
    const coins = Number.isFinite(player.coins) ? player.coins : tagCoinsForRank(player.rank);
    return {
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      score: Math.max(0, player.score || 0),
      survived_ms: player.survivedMs,
      tag_count: player.tagCount || 0,
      is_winner: player.rank === 1,
      coins,
    };
  }

  function battleRoyaleResultPayload(player) {
    const coins = Number.isFinite(player.coins) ? player.coins : battleRoyaleCoinsForRank(player.rank);
    return {
      user_id: player.userId,
      nickname: player.nickname,
      rank: player.rank,
      survived_ms: player.survivedMs,
      is_winner: player.rank === 1,
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
    shield_enabled: input.shield_enabled !== false,
    laser_speed: String(input.laser_speed || "기본").slice(0, 16),
  };
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

function battleRoyaleZone(room, now = Date.now()) {
  const elapsed = Math.max(0, now - (Number(room.startedAt) || now));
  const t = Math.min(1, elapsed / BR_ZONE_SHRINK_MS);
  const radius = BR_INITIAL_ZONE_RADIUS + (BR_FINAL_ZONE_RADIUS - BR_INITIAL_ZONE_RADIUS) * t;
  let damage = 0;
  if (elapsed >= 90_000) damage = 2;
  else if (elapsed >= 60_000) damage = 1;
  else if (elapsed >= 30_000) damage = 1;
  return { center: { x: 0, y: 0 }, radius, damage };
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

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function zombieSpeedMultiplier(elapsedMs) {
  if (elapsedMs >= 90_000) return 1.15;
  if (elapsedMs >= 60_000) return 1.0;
  if (elapsedMs >= 30_000) return 0.9;
  return 0.8;
}

function tagCoinsForRank(rank, reason = "time_up", elapsedMs = TAG_ROUND_MS) {
  if (reason !== "time_up" && elapsedMs < PLAYER_LEFT_REWARD_MIN_MS) return 0;
  if (rank === 1) return 30;
  if (rank === 2) return 18;
  if (rank === 3) return 12;
  return 8;
}

function battleRoyaleCoinsForRank(rank, reason = "last_survivor", elapsedMs = BR_ZONE_SHRINK_MS) {
  if (reason === "player_left" && elapsedMs < PLAYER_LEFT_REWARD_MIN_MS) return 0;
  if (rank === 1) return 100;
  if (rank === 2) return 60;
  if (rank === 3) return 40;
  if (rank === 4) return 20;
  return 10;
}
