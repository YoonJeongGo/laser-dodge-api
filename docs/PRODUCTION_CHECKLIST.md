# Laser Dodge Production Checklist

## Production Architecture

The Play Store build uses this single online path:

```text
Android app -> https://laser-dodge-api.onrender.com -> PostgreSQL
```

Rules:

- The app never connects to PostgreSQL directly.
- The app contains no `DATABASE_URL`, database user, database password, or PostgreSQL host.
- The app only calls `OnlineManager.API_BASE_URL` over HTTPS.
- The API server owns `DATABASE_URL` and `JWT_SECRET` through environment variables.
- All Play Store users share the same deployed API URL and therefore the same production database.
- Login/register responses issue a JWT. The app stores that token in `user://online_profile.cfg`.
- On the next launch, the app calls `/auth/me` with the saved token and skips the login screen if it is valid.

## Accounts and OAuth

Create provider apps and register these production callback URLs:

- Google: `https://laser-dodge-api.onrender.com/auth/google/callback`
- Naver: `https://laser-dodge-api.onrender.com/auth/naver/callback`
- Facebook: `https://laser-dodge-api.onrender.com/auth/facebook/callback`

Put issued credentials in the API server environment:

```env
PUBLIC_BASE_URL=https://laser-dodge-api.onrender.com
DATABASE_URL=postgres://...
DATABASE_SSL=true
JWT_SECRET=use-a-long-random-secret
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
FACEBOOK_CLIENT_ID=
FACEBOOK_CLIENT_SECRET=
```

Official references:

- Google OAuth: https://developers.google.com/identity/protocols/oauth2
- Naver Login: https://developers.naver.com/docs/login/overview/overview.md
- Facebook Login: https://developers.facebook.com/docs/facebook-login/

## Backend Deploy

Deploy `server/` to a HTTPS host. Render is preconfigured via `render.yaml`.

Required:

- PostgreSQL database reachable from API server
- HTTPS domain
- `DATABASE_URL`, `PORT`, `JWT_SECRET` set in the API environment
- `PUBLIC_BASE_URL` matching the HTTPS domain
- OAuth callback URLs matching the same domain exactly

After deploy:

```bash
curl https://laser-dodge-api.onrender.com/health
API_BASE_URL=https://laser-dodge-api.onrender.com npm run smoke
```

Release gate:

- Render must run the latest committed `server/server.js` and `server/src/socket/index.js`.
- Runtime logs must show successful server startup and WebSocket connections on `/zombie-ws`.
- Verify `quick_match`, `create_room`, `join_room`, `start_game`, `game_result`, and mode-specific events for `tag`, `zombie`, and `battle_royale`.
- Do not mark multiplayer fixes verified from APK build alone. Server-side changes are not live until Render is deployed.

## Local Development

Local startup scripts are development-only and are isolated in `dev/`:

```bat
dev\start_postgres.bat
dev\start_api.bat
```

Do not use these for Play Store production. Production must run `server/package.json`'s `start` command on Render, Railway, Fly.io, or another always-on HTTPS host.

## Database Migration

The API creates required tables and indexes on startup. `db_schema.sql` can still be used for manual database initialization.

Required production DB checks after Render deploy:

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'coin_transactions'
  AND indexdef ILIKE '%user_id%'
  AND indexdef ILIKE '%reason%'
  AND indexdef ILIKE '%ref_id%';
```

The production DB must include a unique or equivalent final defense for reward transactions:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS coin_tx_unique_user_reason_ref_idx
ON coin_transactions (user_id, reason, ref_id)
WHERE ref_id IS NOT NULL;
```

Reward transactions must always have a non-empty `ref_id`:

```sql
SELECT *
FROM coin_transactions
WHERE reason IN ('zombie_result', 'tag_result', 'battle_royale_result')
  AND (ref_id IS NULL OR TRIM(ref_id) = '');
```

Duplicate reward check must return zero rows:

```sql
SELECT user_id, reason, ref_id, COUNT(*) AS count
FROM coin_transactions
WHERE reason IN ('zombie_result', 'tag_result', 'battle_royale_result')
GROUP BY user_id, reason, ref_id
HAVING COUNT(*) > 1;
```

## Godot Release Settings

Update before export:

- `OnlineManager.API_BASE_URL` to the final HTTPS API domain
- `export_presets.cfg` package name from `com.yourname.laserdodge` to your final package ID
- Android release keystore path/user/password
- `version/code` and `version/name`

## Google Play

Required before production:

- Privacy Policy URL
- Data safety form
- In-app account deletion flow and a web deletion request URL if account creation/login is available
- Content rating questionnaire
- App access instructions for reviewer if login is required
- Internal testing release
- Production AAB signed with release key

Google Play official policy references:

- Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- User Data policy: https://support.google.com/googleplay/android-developer/answer/10144311
- Account deletion requirements: https://support.google.com/googleplay/android-developer/answer/13327111
- Privacy policy policy: https://support.google.com/googleplay/android-developer/answer/16543315

## QA Release Gate

Current release status: `Not ready`.

Stale references:

- Do not use old handoff notes that say `BattleRoyaleGame.tscn` or `BattleRoyaleGameMode.gd` is missing without checking the current repo first.
- In the current repo, BattleRoyale is a real scene path and must be treated as a flow verification target, not an unimplemented placeholder.

Local verified gates:

- `BattleRoyaleGame.tscn` exists and loads `BattleRoyaleGameMode.gd`.
- `RoomLobby` routes `battle_royale` to `res://scenes/multiplayer/BattleRoyaleGame.tscn`.
- `QuickMatch` routes `battle_royale` to `res://scenes/multiplayer/BattleRoyaleGame.tscn`.
- Zombie client `game_over` is disabled for result/coin saving.
- `saveZombieResult()` rejects non-zombie rooms.
- Zombie, tag, and battle royale reward saves use transaction-scoped duplicate checks.
- `coin_transactions(user_id, reason, ref_id)` has a partial unique index for non-null refs.

Manual verification gates:

- Render latest server deploy.
- Production DB unique index exists.
- TagGame 2-player complete match.
- TagGame 3-6 player match.
- ZombieGame 2-player complete match.
- ZombieGame 3-4 player match.
- BattleRoyale 2-player complete match.
- BattleRoyale 3-6 player match.
- Each multiplayer mode writes exactly one result/reward per `room/user/mode`.
- AdMob rewarded revive, shop reward, early close, no-fill, and rapid-tap cases on a real Android device.
- Privacy policy, terms, open-source notices, developer name, contact email, and data deletion web URL finalized.

Mode-specific multiplayer checks:

- TagGame: selected tagger, position sync, server-side tag validation, immunity/cooldown, laser stun, time-up result, player-left anti-farm rewards.
- ZombieGame: infection roles, server mode guard for `player_infected`, `client_result_disabled` on `game_over`, final result, zombie/team win conditions.
- BattleRoyale: 2-6 spawns, HP HUD, zone radius display, zone shrink, zone damage, laser damage, HP 0 elimination, spectator/result state, last survivor, reward persistence.
