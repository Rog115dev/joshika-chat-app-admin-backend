# Joshikai Express API

In-memory Express backend for the Flutter app ID verification flow.

## Run

```bash
cd server
npm install
npm start
```

Listens on `0.0.0.0:3000` by default (matches `http://192.168.132.41:3000` in the Flutter API calls).

## Admin web dashboard

Open `http://<host>:3000/admin/` in a browser.

Default admin credentials (override with env):

- Email: `admin@joshikai.local`
- Password: `admin123`

The queue starts empty. When a user taps **Confirm and submit** in the app,
a live row is created via `POST /id-verifications` with their profile + selfie.

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in production.

## User auth API

- `POST /auth/register` — create account (email + password + profile fields)
- `POST /auth/login` — returns `{ token, user }`
- `GET /auth/me` — Bearer user token

Override with env vars:

```bash
set PORT=3000
set HOST=0.0.0.0
npm start
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/id-verifications` | List (optional `?status=` / `?limit=`) |
| GET | `/id-verifications/:id` | Get one |
| POST | `/id-verifications` | Create submission |
| PATCH | `/id-verifications/:id` | Update `status` / `adminNote` |
| GET | `/admin/users` | List users (admin Bearer; optional `?q=`) |
| GET | `/admin/users/:id` | Get user (admin) |
| PATCH | `/admin/users/:id` | Edit profile (admin) |
| POST | `/admin/users/:id/reset-password` | Reset password (admin; optional `{ password }`) |
| DELETE | `/admin/users/:id` | Delete user (admin) |
| GET | `/health` | Health check |

Data resets when the process restarts.

## Matching, invitations, messaging

Requires an approved user session (Authorization: Bearer <token>).

- GET /room/profiles — browse other approved users (supports similarAge=1, 
earby=1)
- POST /room/pass — { userId } hide a profile
- POST /invitations — { toUserId, tableName, message, prompts[] }
- GET /invitations?box=incoming&status=pending
- POST /invitations/:id/accept / decline
- GET /tables?status=active
- GET|POST /tables/:id/messages

Demo profiles (password demo123): yuki@joshikai.demo, iko@joshikai.demo, hana@joshikai.demo
