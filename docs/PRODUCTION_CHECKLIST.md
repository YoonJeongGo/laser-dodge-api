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

- Google: `https://YOUR_API_DOMAIN/auth/google/callback`
- Naver: `https://YOUR_API_DOMAIN/auth/naver/callback`
- Facebook: `https://YOUR_API_DOMAIN/auth/facebook/callback`

Put issued credentials in the API server environment:

```env
PUBLIC_BASE_URL=https://YOUR_API_DOMAIN
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
curl https://YOUR_API_DOMAIN/health
API_BASE_URL=https://YOUR_API_DOMAIN npm run smoke
```

## Local Development

Local startup scripts are development-only and are isolated in `dev/`:

```bat
dev\start_postgres.bat
dev\start_api.bat
```

Do not use these for Play Store production. Production must run `server/package.json`'s `start` command on Render, Railway, Fly.io, or another always-on HTTPS host.

## Database Migration

The API creates required tables and indexes on startup. `db_schema.sql` can still be used for manual database initialization.

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
- Content rating questionnaire
- App access instructions for reviewer if login is required
- Internal testing release
- Production AAB signed with release key

Google Play official policy references:

- Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- User Data policy: https://support.google.com/googleplay/android-developer/answer/10144311
- Privacy policy policy: https://support.google.com/googleplay/android-developer/answer/16543315
