# Anime Station Webapp

A Flask-based Telegram Mini App (WebApp) for discovering, requesting, and reporting anime. Companion to the
[Anime Station bot](../anime-station-bot) — together they form one system sharing a single MongoDB database.

## Features

- **Trending & Popular** anime home feed, sourced live from [AniList](https://anilist.co)
- **Search** the full AniList catalog
- **Single anime detail view** with full metadata
- **Available anime** — anime your admins have linked to a channel or custom link, ready to watch
- **Voting** — users can upvote anime they want made available (locked once it's actually available)
- **Requests** — request an anime that isn't available yet; rate-limited per user per day
  (`MAX_DAILY_REQUESTS`), posts to your admin channel with Accept/Decline buttons (handled by the bot)
- **Top requested** — ranking of pending requests by vote count
- **Admin resolve** — admins link a channel (by ID, @username, or a direct invite link) to a requested anime,
  or set any custom URL
- **Admin remove** — pull an anime out of the Available list
- **Reports** — users can report a broken link, wrong anime, missing episodes, etc.; posts to a reports channel
  with a "Reply to reporter" button that deep-links straight into the bot
- **Join** — generates a one-time invite link (or returns a custom link) for an available anime's channel
- **Telegram `initData` authentication** — every write action is verified against Telegram's own signature, no
  separate login system
- **Force-sub gate** — `/api/auth` registers brand-new users immediately, then does a lightweight membership
  check (plain `getChatMember` per configured channel — no request-mode nuance, that stays on the bot). If the
  user seems to be missing a channel, the whole app is replaced with a full-screen "Access Denied" card with a
  **Join** button and a **Reload** button below it. Join deep-links into the bot (`t.me/<bot>?start=fsub`, or
  `?start=fsub_<startapp>` if the webapp itself was opened via a `startapp` link, e.g.
  `t.me/<bot>/anidex?startapp=anime_269`) — the bot then runs its own real, authoritative force-sub check
  (including request-mode) and takes it from there. Admins, the owner, and banned users skip this gate entirely
  (banned users just see their banned status instead).

## Project layout

```
anime-station-webapp/
├── app.py              # all routes + Telegram/AniList/Mongo logic
├── templates/
│   └── index.html       # the mini app's single page
├── static/
│   ├── app.js            # frontend logic
│   └── style.css          # styling
├── requirements.txt
└── render.yaml
```

## Requirements before you deploy

1. **The same bot token, MongoDB URI, and database name as the bot** — this webapp and the bot read/write the
   same collections (`users`, `admins`, `banned_user`, `anime_requests`).
2. **A shared secret** (`WEBAPP_SECRET`) — generate any random string, set it the same on both this service and
   the bot. Used so the webapp can call the bot's `/resolve-user` endpoint to look up channels by @username.
3. **Your bot's deployed URL** as `BOT_INTERNAL_URL` (no trailing slash) — deploy the bot first, or leave this
   blank temporarily and add it once the bot's URL exists (username resolution just falls back to the plain Bot
   API, which only works for public channels the bot can already see).
4. Two channels (can be different or the same): one for anime requests (`ADMIN_REQUESTS_CHANNEL_ID`) and one for
   issue reports (`REPORTS_CHANNEL_ID`) — the bot must be an admin in both.
5. In @BotFather, configure this deployed URL as your bot's **Mini App** (Menu Button or Direct Link) so it opens
   inside Telegram with a valid `initData`.

## Environment variables

See [`.env.example`](.env.example) for the full list with descriptions. At minimum you need: `BOT_TOKEN`,
`DATABASE_URL`, `OWNER_ID`, `ADMIN_REQUESTS_CHANNEL_ID`, `REPORTS_CHANNEL_ID`.

## Deploying on Render (free tier)

1. Push this repo to GitHub.
2. On Render: **New → Blueprint**, point it at your repo — it reads `render.yaml` automatically. (Or **New → Web
   Service** manually: build command `pip install -r requirements.txt`, start command `gunicorn app:app`.)
3. Fill in the environment variables marked `sync: false` in the Render dashboard.
4. Deploy, then open the service URL in a browser to sanity-check it loads (full functionality needs Telegram's
   `initData`, so most features only work when opened from inside Telegram).
5. Set the deployed URL as your bot's Mini App in @BotFather.

Free Render web services spin down after ~15 minutes of no traffic and take a few seconds to wake back up on the
next request — for a webapp that's opened on demand from Telegram, that's usually an acceptable trade-off (unlike
a bot, which needs to be always-on to receive Telegram updates).

## Notes

- `DATABASE_URL`/`DATABASE_NAME`, `ADMIN_REQUESTS_CHANNEL_ID`, and `WEBAPP_SECRET` must all match between this
  webapp and the bot — they're two halves of one system sharing one database.
- All admin checks (`is_admin`) look at the same `admins` collection the bot manages via `/add_admin`.
