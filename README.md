# Amber SOS — Backend

Node.js / Express / Mongoose / Socket.IO backend for the Amber safety app.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy the example env and fill in every value
cp .env.example .env

# 3. Start in development mode
npm run dev

# 4. Run tests
npm test
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | ✅ | MongoDB Atlas connection string |
| `JWT_SECRET` | ✅ | ≥ 32-char random secret. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | ✅ | Base64-encoded Firebase service account JSON |
| `INVITE_HMAC_SECRET` | ✅ | ≥ 32-char secret for HMAC-SHA256 invite code hashing. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `TRUST_PROXY` | — | Number of trusted reverse proxies (0 = direct, 1 = behind nginx/ALB). Defaults to 0 |
| `CLIENT_URL` | — | CORS origin. Only matters for browsers; the phone app does not need it |
| `PORT` | — | Defaults to 3000 |
| `NODE_ENV` | — | `development` or `production` |
| `CRITICAL_ALERTS_ENABLED` | — | `true` only after Apple grants entitlement |

## API Endpoints

### Auth

```
POST   /api/auth/register          Register a new user
POST   /api/auth/login             Login
GET    /api/auth/me                Get current user (JWT required)
POST   /api/auth/fcm-token         Register/refresh device push token
POST   /api/auth/logout            Deregister push token
DELETE /api/auth/me                Permanently delete the account { password } (see below)
```

**Account deletion** (required by the App Store and Google Play): re-checks the password
(wrong password → `403`, deliberately not `401` so the app does not log the user out),
cancels any alert the user sent, removes them from every circle (empty circles are deleted,
the creator role passes on), deletes the alerts they sent *with their location history*,
and disconnects their sockets.

**curl — register:**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com","password":"SecurePass1!"}'
```

**curl — login:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"SecurePass1!"}'
# → { "token": "eyJ...", "user": {...} }
```

### Circles (all require `Authorization: Bearer <token>`)

```
POST   /api/circles                  Create a circle (creator only as initial member)
GET    /api/circles                  List my circles
GET    /api/circles/:id              Get a circle
PATCH  /api/circles/:id              Rename circle (creator only)
DELETE /api/circles/:id              Delete circle (creator only)
POST   /api/circles/:id/invites      Create a single-use invite code (any member)
POST   /api/circles/join             Join with invite code { code }
POST   /api/circles/:id/leave        Leave a circle
DELETE /api/circles/:id/members/:uid Remove a member (creator only)
```

**curl — create circle:**
```bash
curl -X POST http://localhost:3000/api/circles \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Family"}'
```

**curl — create invite code:**
```bash
curl -X POST http://localhost:3000/api/circles/CIRCLE_ID/invites \
  -H 'Authorization: Bearer TOKEN'
# → { "code": "K7QX93MZ4R", "expiresInHours": 24 }   (10 characters)
```

**curl — join circle:**
```bash
curl -X POST http://localhost:3000/api/circles/join \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"code":"A1B2C3D4"}'
```

### SOS (all require `Authorization: Bearer <token>`)

```
POST   /api/sos/trigger         Trigger an SOS alert
GET    /api/sos/active          Get active alert for current user (their OWN alert first)
GET    /api/sos/:id             Details of ONE alert (circle members only): sender, status, last location, responders
PATCH  /api/sos/:id/resolve     End alert { status: 'resolved'|'cancelled' }
POST   /api/sos/:id/respond     Mark yourself as responding
POST   /api/sos/:id/location    HTTP fallback to push a location point (sender only)
POST   /api/sos/:id/locations   HTTP fallback, batch of up to 50 points, oldest first (sender only)
```

**curl — trigger SOS:**
```bash
curl -X POST http://localhost:3000/api/sos/trigger \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"circleId":"CIRCLE_ID","latitude":51.5074,"longitude":-0.1278}'
```

**curl — resolve SOS:**
```bash
curl -X PATCH http://localhost:3000/api/sos/ALERT_ID/resolve \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"status":"resolved"}'
```

**curl — push location (HTTP fallback — single point):**
```bash
curl -X POST http://localhost:3000/api/sos/ALERT_ID/location \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"latitude":51.51,"longitude":-0.13}'
```

**curl — push location (HTTP fallback — batch, up to 50 points):**
```bash
curl -X POST http://localhost:3000/api/sos/ALERT_ID/locations \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"points":[{"latitude":51.51,"longitude":-0.13},{"latitude":51.52,"longitude":-0.14,"at":"2026-01-01T10:00:00Z"}]}'
```

## Socket.IO events

Connect with `auth: { token: JWT }`.

| Direction | Event | Payload |
|---|---|---|
| client → server | `join_sos` | `{ alertId }` |
| client → server | `leave_sos` | `{ alertId }` |
| client → server | `update_location` | `{ alertId, latitude, longitude }` |
| server → client | `sos_triggered` | `{ alertId, senderId, senderName, circleId, startedAt }` |
| server → client | `sos_ended` | `{ alertId, status }` |
| server → client | `location_updated` | `{ alertId, location: { lat, lng, at } }` |
| server → client | `location_history` | `{ alertId, locations: [...] }` |
| server → client | `member_responding` | `{ alertId, responderId, responderName }` |
| server → client | `error` | `{ message }` |

## Security decisions

- **userId from JWT only**: `req.user._id` / `socket.data.userId` — never from request body.
- **Socket auth in handshake**: `auth: { token }` — never in message payload.
- **Sender-only location**: only the alert sender can call `update_location` / `/location`.
- **Partial unique index**: one active alert per user — duplicate-key errors return the existing alert.
- **Invite code hashed**: SHA-256 stored, plaintext returned once. Max 5 pending per circle.
- **Atomic location push**: `$push { $each, $slice: -2000 }` — never loads full array.
- **Data retention**: alerts older than 30 days are deleted nightly.
- **JWT validation at startup**: server refuses to start if JWT_SECRET is missing, < 32 chars, or a placeholder.

## Running tests

```bash
npm test
```

Tests use `mongodb-memory-server` (no real DB needed) and cover:
- 401 without token
- 403 for non-members
- rate limiting
- duplicate active alert
- sender-only location
- location rejected after resolve
- invite code single-use and expiry
- leave circle
- empty socket payload safety

## Push notification types

| `data.type` | Sent when | Who gets it | How it sounds |
|---|---|---|---|
| `sos_triggered` | someone presses SOS | every other circle member | **Alarm**: Android channel `sos_alarm_v1` (max priority); iPhone time-sensitive, or critical once `CRITICAL_ALERTS_ENABLED=true`. Expires after 10 minutes so a stale SOS is never delivered hours later |
| `member_responding` | a member taps "I'm responding" | everyone except the responder | quiet: Android channel `sos_updates_v1`, iPhone normal |
| `sos_ended` | the alert is resolved / cancelled / auto-expired / its circle dissolved | everyone except the person who ended it | quiet, same as above |

The app creates both Android channels at start-up. If the alarm channel does not exist yet
(app never opened after install), Android falls back to its default channel.

## Changes in this version
- Circle membership logic lives in `services/circleService.js` (shared by the circle routes and account deletion).
- Sockets are closed when their login token expires.
- A broad API rate limit (600/min per IP) sits in front of the stricter per-user / per-email limits.
- `serviceAccountKey*.json` and similar names are git-ignored.

## Invitations: QR code and email

Besides the manual 10-character code, a circle member can invite people with a **QR code** (in person)
or an **email link**. Both use single-use, 256-bit tokens. See `INVITES.md` in the app project for the full guide.

```
POST /api/circles/:id/invites/qr    Short-lived QR invitation → { circleId, token, link, expiresAt, ttlSeconds }
POST /api/circles/invite-email      { circleId, emails: [up to 5] } → emails each person a link
POST /api/circles/invite-preview    { circleId, token } → who invited me to what (does NOT use up the invite)
POST /api/circles/join-invite       { circleId, token } → accept (single use)

GET  /invite?c=<circleId>&t=<token>             web page behind the emailed link (opens the app, or offers to install it)
GET  /.well-known/assetlinks.json               Android app-link verification
GET  /.well-known/apple-app-site-association    iPhone universal-link verification
```

Refusals use these `code`s: `INVITE_INVALID` (wrong / expired / used: all deliberately look the same),
`INVITE_MALFORMED`, `ALREADY_MEMBER`, `CIRCLE_FULL`, `EMAIL_MISMATCH` (email invites only work for the address they were sent to).

| Setting | Default | Meaning |
|---|---|---|
| `QR_INVITE_TTL_MINUTES` | 10 | how long a QR code works |
| `EMAIL_INVITE_TTL_HOURS` | 48 | how long an email link works |
| `INVITE_REQUIRE_EMAIL_MATCH` | true | email invites can only be accepted by that address |
| `APP_LINK_BASE_URL` | – | public https address of this server (links in emails and QR codes). **Required in production** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | – | email server. Without `SMTP_HOST` + `MAIL_FROM`, email invitations are disabled (QR still works) |
| `EMAIL_DRY_RUN` | false | development: print the email in the console instead of sending |

Abuse limits for the email endpoint: 5 addresses per request, 10 emails per user per hour, 20 requests
per user per hour, 10 pending email invitations per circle, 3 invitations per address per day.
Invitations live in the `invites` collection with a **TTL index** (`expiresAt`), so MongoDB deletes them
itself; every query also checks `expiresAt`, because the cleaner only runs about once a minute.
#   A m b e r - b a c k e n d  
 