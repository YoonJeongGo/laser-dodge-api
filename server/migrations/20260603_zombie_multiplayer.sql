CREATE TABLE IF NOT EXISTS zombie_rooms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code   VARCHAR(6) UNIQUE NOT NULL,
  host_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  status      VARCHAR(20) DEFAULT 'waiting',
  max_players INT DEFAULT 4,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zombie_rooms_code_idx ON zombie_rooms (room_code);
CREATE INDEX IF NOT EXISTS zombie_rooms_status_idx ON zombie_rooms (status, created_at DESC);

CREATE TABLE IF NOT EXISTS zombie_players (
  id        BIGSERIAL PRIMARY KEY,
  room_id   UUID REFERENCES zombie_rooms(id) ON DELETE CASCADE,
  user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  is_host   BOOLEAN DEFAULT FALSE,
  is_ready  BOOLEAN DEFAULT FALSE,
  status    VARCHAR(20) DEFAULT 'alive',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS zombie_players_room_idx ON zombie_players (room_id);
CREATE INDEX IF NOT EXISTS zombie_players_user_idx ON zombie_players (user_id);

CREATE TABLE IF NOT EXISTS zombie_results (
  id             BIGSERIAL PRIMARY KEY,
  room_id        UUID REFERENCES zombie_rooms(id) ON DELETE SET NULL,
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  rank           INT NOT NULL,
  survived_ms    INT DEFAULT 0,
  infected_count INT DEFAULT 0,
  is_winner      BOOLEAN DEFAULT FALSE,
  played_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS zombie_results_user_idx ON zombie_results (user_id, played_at DESC);
