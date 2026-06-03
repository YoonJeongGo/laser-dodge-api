import { WebSocketServer } from "ws";

const QUICK_MATCH_SIZE = 4;
const QUICK_MATCH_TIMEOUT_MS = 30_000;
const POSITION_SYNC_MS = 50;
const FIRST_ZOMBIE_DELAY_MS = 30_000;
const TOUCH_RADIUS = 30;

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
    clientsByUserId.set(client.userId, client);
    client.on("quick_match", () => joinQuickMatch(client));
    client.on("cancel_quick_match", () => leaveQuickMatch(client, true));
    client.on("create_room", (data, ack) => createRoom(client, data, ack));
    client.on("join_room", (data, ack) => joinRoom(client, data, ack));
    client.on("invite_friend", (data, ack) => inviteFriend(client, data, ack));
    client.on("accept_invite", (data, ack) => acceptInvite(client, data, ack));
    client.on("player_ready", (data) => setReady(client, data));
    client.on("start_game", () => startGameByHost(client));
    client.on("position_update", (data) => updatePosition(client, data));
    client.on("player_infected", (data) => requestInfection(client, data));
    client.on("game_over", (data, ack) => finishGame(client, data, ack));
    client.onClose(() => disconnectClient(client));
  }

  async function createRoom(client, data = {}, ack = null) {
    const maxPlayers = clampInt(data.max_players, 2, 4, 4);
    const room = makeRoom("zombie", client, maxPlayers, false);
    await persistRoom(room, client.userId);
    addPlayerToRoom(room, client, true);
    client.roomCode = room.code;
    sendAck(ack, { ok: true, room: serializeRoom(room) });
    client.send("room_created", { room: serializeRoom(room), room_code: room.code });
    broadcastRoom(room, "room_updated", serializeRoom(room));
  }

  async function joinRoom(client, data = {}, ack = null) {
    const code = String(data.room_code || data.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.status !== "waiting") return sendAck(ack, { ok: false, error: "room_not_found" });
    if (room.players.size >= room.maxPlayers) return sendAck(ack, { ok: false, error: "room_full" });
    addPlayerToRoom(room, client, false);
    await persistRoomPlayer(room, client.userId, false);
    sendAck(ack, { ok: true, room: serializeRoom(room) });
    broadcastRoom(room, "room_updated", serializeRoom(room));
  }

  async function joinQuickMatch(client) {
    leaveQuickMatch(client, false);
    const entry = { client, joinedAt: Date.now(), timer: null };
    quickQueue.push(entry);
    entry.timer = setTimeout(() => startQuickMatchFromEntry(entry), QUICK_MATCH_TIMEOUT_MS);
    emitQuickQueue();
    if (quickQueue.length >= QUICK_MATCH_SIZE) startQuickMatch(quickQueue.splice(0, QUICK_MATCH_SIZE));
  }

  function leaveQuickMatch(client, notify) {
    const idx = quickQueue.findIndex((entry) => entry.client === client);
    if (idx >= 0) {
      const [entry] = quickQueue.splice(idx, 1);
      clearTimeout(entry.timer);
      if (notify) client.send("room_updated", { queue_count: 0, max_players: QUICK_MATCH_SIZE, cancelled: true });
      emitQuickQueue();
    }
  }

  function startQuickMatchFromEntry(entry) {
    if (!quickQueue.includes(entry)) return;
    const group = quickQueue.splice(0, Math.min(QUICK_MATCH_SIZE, quickQueue.length));
    startQuickMatch(group);
  }

  async function startQuickMatch(entries) {
    if (entries.length === 0) return;
    for (const entry of entries) clearTimeout(entry.timer);
    const host = entries[0].client;
    const room = makeRoom("zombie", host, QUICK_MATCH_SIZE, true);
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
      entry.client.send("room_updated", { queue_count: quickQueue.length, max_players: QUICK_MATCH_SIZE });
    }
  }

  function inviteFriend(client, data = {}, ack = null) {
    const friendId = String(data.friend_id || data.user_id || "").trim();
    const target = clientsByUserId.get(friendId);
    if (!target) return sendAck(ack, { ok: false, error: "friend_offline" });
    let room = getClientRoom(client);
    if (!room) {
      room = makeRoom("zombie", client, 4, false);
      addPlayerToRoom(room, client, true);
      persistRoom(room, client.userId).then(() => persistRoomPlayer(room, client.userId, true)).catch(() => {});
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
      return sendAck(ack, { ok: false, error: "invite_expired" });
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
    if (!room || room.hostId !== client.userId || room.players.size < 2) return;
    if ([...room.players.values()].some((player) => !player.ready)) return;
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
      player.survivedMs = 0;
      player.rank = 0;
    }
    broadcastRoom(room, "game_starting", { countdown: 3, room: serializeRoom(room) });
    room.forceZombieTimer = setTimeout(() => forceFirstZombie(room), FIRST_ZOMBIE_DELAY_MS);
    room.syncTimer = setInterval(() => syncPositions(room), POSITION_SYNC_MS);
  }

  function updatePosition(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing") return;
    const player = room.players.get(client.userId);
    if (!player) return;
    player.x = Number(data.x) || 0;
    player.y = Number(data.y) || 0;
    player.vx = Number(data.vx) || 0;
    player.vy = Number(data.vy) || 0;
    player.shield = Boolean(data.shield);
    player.updatedAt = Date.now();
    serverCheckInfections(room);
  }

  function requestInfection(client, data = {}) {
    const room = getClientRoom(client);
    if (!room || room.status !== "playing") return;
    const player = room.players.get(client.userId);
    if (!player) return;
    const targetId = String(data.target_user_id || client.userId);
    const reason = String(data.reason || "laser");
    const target = room.players.get(targetId);
    if (!target || target.status === "zombie") return;
    if (reason === "contact" && player.status !== "zombie") return;
    infectPlayer(room, target, reason, player.userId);
  }

  function serverCheckInfections(room) {
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
    await saveZombieResult(room, client.userId, data);
    sendAck(ack, { ok: true });
  }

  function finishRoom(room, survivors) {
    if (room.status === "finished") return;
    room.status = "finished";
    clearTimeout(room.forceZombieTimer);
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
      saveZombieResult(room, player.userId, player).catch(() => {});
    });
    broadcastRoom(room, "game_result", {
      reason: winnerIds.length === 0 ? "zombie_team" : "last_survivor",
      winner_user_ids: winnerIds,
      players: players.map(resultPayload),
    });
  }

  async function saveZombieResult(room, userId, data = {}) {
    const rank = clampInt(data.rank, 1, 99, 1);
    const survivedMs = Math.max(0, Number.parseInt(data.survived_ms ?? data.survivedMs, 10) || 0);
    const infectedCount = Math.max(0, Number.parseInt(data.infected_count ?? data.infectedCount, 10) || 0);
    const isWinner = Boolean(data.is_winner || rank === 1);
    await pool.query(
      `INSERT INTO zombie_results (room_id, user_id, rank, survived_ms, infected_count, is_winner)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [room.dbId, userId, rank, survivedMs, infectedCount, isWinner],
    );
    const coins = isWinner ? 20 : 5;
    await pool.query("UPDATE users SET coin_balance = coin_balance + $1 WHERE id = $2", [coins, userId]);
    await pool.query(
      "INSERT INTO coin_transactions (user_id, amount, reason, ref_id) VALUES ($1, $2, 'zombie_result', $3)",
      [userId, coins, room.code],
    );
  }

  function syncPositions(room) {
    if (room.status !== "playing") return;
    const elapsed = Date.now() - room.startedAt;
    broadcastRoom(room, "positions_sync", {
      elapsed_ms: elapsed,
      zombie_speed_multiplier: zombieSpeedMultiplier(elapsed),
      players: [...room.players.values()].map((player) => ({
        user_id: player.userId,
        nickname: player.nickname,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        status: player.status,
        shield: player.shield,
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
      status: "waiting",
      createdAt: Date.now(),
      startedAt: 0,
      firstZombieDone: false,
      players: new Map(),
      syncTimer: null,
      forceZombieTimer: null,
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
      rank: 0,
      updatedAt: Date.now(),
    });
  }

  function removeFromCurrentRoom(client) {
    const room = getClientRoom(client);
    if (!room) return;
    room.players.delete(client.userId);
    client.roomCode = "";
    if (room.players.size === 0) {
      clearTimeout(room.forceZombieTimer);
      clearInterval(room.syncTimer);
      rooms.delete(room.code);
    } else {
      broadcastRoom(room, "room_updated", serializeRoom(room));
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
      players: [...room.players.values()].map((player) => ({
        user_id: player.userId,
        nickname: player.nickname,
        is_host: player.isHost,
        ready: player.ready,
        is_ready: player.ready,
        status: player.status,
        role: player.role,
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

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function distance(a, b) {
  const dx = (Number(a.x) || 0) - (Number(b.x) || 0);
  const dy = (Number(a.y) || 0) - (Number(b.y) || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function zombieSpeedMultiplier(elapsedMs) {
  if (elapsedMs >= 90_000) return 1.15;
  if (elapsedMs >= 60_000) return 1.0;
  if (elapsedMs >= 30_000) return 0.9;
  return 0.8;
}
