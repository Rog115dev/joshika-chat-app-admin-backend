# Joshikai Express API / Joshikai Express API

Express backend for the Flutter app (auth, ID verification, matching, messaging).  
Flutter アプリ向け Express バックエンド（認証・本人確認・マッチング・メッセージ）。

Data is stored in **MongoDB** (Mongoose). Numeric IDs are kept so the Flutter app stays compatible.  
データは **MongoDB**（Mongoose）に保存します。Flutter 互換のため数値 ID を維持しています。

---

## Prerequisites / 前提条件

- Node.js 18+
- MongoDB（ローカル、または [MongoDB Atlas](https://www.mongodb.com/atlas)）

---

## Environment setup / 環境変数の設定

1. Copy the example file / サンプルをコピーします:

```bash
cd server
copy .env.example .env
```

（macOS / Linux: `cp .env.example .env`）

2. Edit `.env` and set values / `.env` を編集して値を設定します。

| Variable / 変数 | Default / デフォルト | Description / 説明 |
|-----------------|----------------------|--------------------|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/joshikai` | MongoDB 接続文字列 |
| `PORT` | `4100` | HTTP ポート |
| `HOST` | `0.0.0.0` | バインドアドレス |
| `PUBLIC_API_BASE` | `http://23.27.186.171:4100` | セルフィー画像 URL のベース（スマホから届く公開 URL） |
| `ADMIN_EMAIL` | `admin@joshikai.local` | 管理画面ログイン用メール |
| `ADMIN_PASSWORD` | `admin123` | 管理画面パスワード（本番では必ず変更） |
| `RESEND_API_KEY` | — | パスワードリセットメール用（[Resend](https://resend.com/api-keys)） |
| `RESEND_FROM_EMAIL` | `Joshikai <onboarding@resend.dev>` | 送信元アドレス（本番は検証済みドメイン） |

`.env` の例 / Example:

```env
PORT=4100
HOST=0.0.0.0
PUBLIC_API_BASE=http://YOUR_PUBLIC_IP_OR_DOMAIN:4100
ADMIN_EMAIL=admin@joshikai.local
ADMIN_PASSWORD=change-me-strong-password
MONGODB_URI=mongodb://127.0.0.1:27017/joshikai
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM_EMAIL=Joshikai <noreply@yourdomain.com>
```

> `.env` is gitignored. Never commit secrets.  
> `.env` は Git 管理外です。秘密情報をコミットしないでください。

---

## Run locally / ローカル起動

```bash
cd server
npm install
npm start
```

開発時の自動再起動 / Dev watch mode:

```bash
npm run dev
```

- API: `http://localhost:4100`
- Admin: `http://localhost:4100/admin/`
- Health: `http://localhost:4100/health`（`mongo: true` なら DB 接続 OK）

初回起動で DB が空の場合、`data.json` があればインポートし、デモユーザーを投入します。  
On first start with an empty DB, imports `data.json` if present, then seeds demo users.

---

## Deploy guide / デプロイ手順

### 1. サーバー準備（VPS / クラウド VM）

推奨例: Ubuntu 22.04、Node.js 18+、MongoDB、ファイアウォールで `4100`（または 80/443）を開放。

```bash
# Node.js (例: NodeSource / nvm でも可)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# MongoDB（ローカルに入れる場合）
# 公式ドキュメントに従い mongodb-org をインストール
# https://www.mongodb.com/docs/manual/installation/
```

MongoDB Atlas を使う場合はローカル MongoDB は不要です。Atlas の接続文字列を `MONGODB_URI` に設定します。

### 2. コードを配置

```bash
# 例: git clone または scp / zip で server フォルダを配置
cd /opt/joshikai/server   # 任意のパス
npm install --omit=dev
```

### 3. `.env` を本番用に設定

```bash
cp .env.example .env
nano .env   # または vi
```

本番で必ず設定する項目:

1. **`MONGODB_URI`** — Atlas または同一マシンの MongoDB  
2. **`PUBLIC_API_BASE`** — スマホ・管理画面から到達できる `https://api.example.com` など  
3. **`ADMIN_EMAIL` / `ADMIN_PASSWORD`** — デフォルトのままにしない  
4. **`RESEND_API_KEY` / `RESEND_FROM_EMAIL`** — パスワードリセットを使う場合  
5. **`PORT` / `HOST`** — リバースプロキシ前なら `PORT=4100`、`HOST=127.0.0.1` も可

### 4. プロセス常駐（systemd 例）

`/etc/systemd/system/joshikai-api.service`:

```ini
[Unit]
Description=Joshikai Express API
After=network.target mongod.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/joshikai/server
EnvironmentFile=/opt/joshikai/server/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now joshikai-api
sudo systemctl status joshikai-api
```

または [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start index.js --name joshikai-api
pm2 save
pm2 startup
```

### 5. Nginx リバースプロキシ（HTTPS 推奨）

```nginx
server {
    listen 80;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20M;
    }
}
```

Let's Encrypt 例:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

その後 `.env` の `PUBLIC_API_BASE` を `https://api.example.com` に更新し、サービスを再起動します。

### 6. ファイアウォール

```bash
# 直接 4100 を公開する場合
sudo ufw allow 4100/tcp
# Nginx 経由の場合
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 7. デプロイ後の確認

```bash
curl https://api.example.com/health
# {"ok":true,"mongo":true,...}
```

ブラウザで `https://api.example.com/admin/` を開き、管理者でログインできることを確認します。

Flutter アプリの API ベース URL も同じ公開 URL に合わせてください。

### 8. 更新・再デプロイ

```bash
cd /opt/joshikai/server
git pull   # または新しいファイルを配置
npm install --omit=dev
sudo systemctl restart joshikai-api
# pm2 の場合: pm2 restart joshikai-api
```

### Deploy checklist / デプロイチェックリスト

- [ ] `MONGODB_URI` が本番 DB を向いている  
- [ ] `PUBLIC_API_BASE` が公開 HTTPS URL  
- [ ] `ADMIN_PASSWORD` を強力な値に変更済み  
- [ ] `RESEND_*` を設定（パスワードリセット利用時）  
- [ ] systemd / pm2 で常駐・自動起動  
- [ ] Nginx + SSL（推奨）  
- [ ] `/health` が `mongo: true`  
- [ ] Flutter の API URL を本番に更新  

---

## Admin web dashboard / 管理画面

Open `http://<host>:4100/admin/` in a browser.  
ブラウザで `http://<ホスト>:4100/admin/` を開きます。

Default credentials（本番では変更）:

- Email: `admin@joshikai.local`
- Password: `admin123`

---

## User auth API / ユーザー認証 API

- `POST /auth/register` — アカウント作成  
- `POST /auth/login` — `{ token, user }` を返す  
- `GET /auth/me` — Bearer ユーザートークン  
- `POST /auth/forgot-password` — `{ email }` → Resend で 6 桁コード送信  
- `POST /auth/reset-password` — `{ email, code, newPassword }`

キー未設定時、`/auth/forgot-password` は HTTP 503 を返します。

---

## Endpoints / エンドポイント一覧

| Method | Path | Description / 説明 |
|--------|------|-------------------|
| GET | `/id-verifications` | 一覧（`?status=` / `?limit=`） |
| GET | `/id-verifications/:id` | 1 件取得 |
| POST | `/id-verifications` | 提出作成 |
| PATCH | `/id-verifications/:id` | `status` / `adminNote` 更新 |
| GET | `/admin/users` | ユーザー一覧（admin Bearer） |
| GET | `/admin/users/:id` | ユーザー詳細 |
| PATCH | `/admin/users/:id` | プロフィール編集 |
| POST | `/admin/users/:id/reset-password` | パスワードリセット |
| DELETE | `/admin/users/:id` | ユーザー削除 |
| GET | `/health` | ヘルスチェック |

---

## Matching, invitations, messaging / マッチング・招待・メッセージ

Requires an approved user session (`Authorization: Bearer <token>`).  
承認済みユーザーのセッションが必要です。

- `GET /room/profiles` — 他の承認ユーザー一覧（`similarAge=1`, `nearby=1`）  
- `POST /room/pass` — `{ userId }` プロフィールを非表示（`passedUserIds` に保存）  
- `POST /invitations` — `{ toUserId, tableName, message, prompts[] }`  
- `GET /invitations?box=incoming&status=pending`  
- `POST /invitations/:id/accept` / `decline`  
- `GET /tables?status=active`  
- `GET|POST /tables/:id/messages`

Demo profiles / デモ（password `demo123`）:  
`yuki@joshikai.demo`, `aiko@joshikai.demo`, `hana@joshikai.demo`

---

## Collections / コレクション

- `users` — アカウント + `passedUserIds`  
- `verifications` — 本人確認・セルフィー提出  
- `invitations`, `tables`, `messages` — マッチング・チャット  
- `counters` — 数値 ID シーケンス（`userId`, `verificationId`, …）

Auth sessions and password-reset codes remain in process memory (cleared on restart).  
認証セッションとパスワードリセットコードはプロセスメモリ上にあり、再起動で消えます。
