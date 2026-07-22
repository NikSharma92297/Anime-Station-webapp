import os
import hmac
import hashlib
import json
import time
from urllib.parse import parse_qsl

import requests
from flask import Flask, request, jsonify, render_template
from pymongo import MongoClient

# ---------------------------------------------------------------------------
# Config (set these as Environment Variables on Render)
# ---------------------------------------------------------------------------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")            # same token your bot uses
DB_URI = os.environ.get("DATABASE_URL", "")             # same Mongo URI your bot uses
DB_NAME = os.environ.get("DATABASE_NAME", "AnimeStation")  # same DB name your bot uses
OWNER_ID = int(os.environ.get("OWNER_ID", "0"))          # fallback super-admin
INIT_DATA_MAX_AGE = 86400                                 # 24h, seconds
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# Your bot's own public URL (the Koyeb URL it already runs an aiohttp
# server on) and a shared secret matching WEBAPP_SECRET in the bot's config.
# Used to resolve @usernames the Bot API alone can't (see /resolve-user route).
BOT_INTERNAL_URL = os.environ.get("BOT_INTERNAL_URL", "").rstrip("/")
WEBAPP_SECRET = os.environ.get("WEBAPP_SECRET", "")

# Anime Station — same numeric ID as ADMIN_REQUESTS_CHANNEL_ID on the bot's Koyeb config.
ADMIN_REQUESTS_CHANNEL_ID = int(os.environ.get("ADMIN_REQUESTS_CHANNEL_ID", "0"))
# Separate private channel where anime issue reports get posted.
REPORTS_CHANNEL_ID = int(os.environ.get("REPORTS_CHANNEL_ID", "0"))
# Max new anime requests a single user can submit per rolling 24h window.
MAX_DAILY_REQUESTS = int(os.environ.get("MAX_DAILY_REQUESTS", "4"))
ANILIST_URL = "https://graphql.anilist.co"

_bot_username_cache = {"value": None}


def get_bot_username():
    if _bot_username_cache["value"]:
        return _bot_username_cache["value"]
    try:
        r = requests.get(f"{TELEGRAM_API}/getMe", timeout=8)
        data = r.json()
        if data.get("ok"):
            _bot_username_cache["value"] = data["result"]["username"]
    except Exception:
        pass
    return _bot_username_cache["value"]


app = Flask(__name__)

client = MongoClient(DB_URI)
db = client[DB_NAME]
users_col = db["users"]
admins_col = db["admins"]
banned_col = db["banned_user"]
anime_requests_col = db["anime_requests"]  # shared with the bot's `anime_requests_data`
anime_request_log_col = db["anime_request_log"]  # one doc per submitted request, for the daily limit
fsub_col = db["fsub"]  # shared with the bot's db.fsub_data (force-sub channels + mode)


# ---------------------------------------------------------------------------
# Force-sub gate — a lightweight yes/no check only. It does NOT try to
# reproduce the bot's full is_sub()/is_subscribed() logic (request-mode
# tracking, invite-link generation, etc.) — that stays on the bot side.
# This just decides whether to show the Access Denied screen at all; the
# screen's Join button hands off to the bot, which does the real,
# authoritative check (including request-mode) and messages the user
# directly if they still need to join something.
# ---------------------------------------------------------------------------
_JOINED_STATUSES = {"creator", "administrator", "member"}


def is_channel_member(user_id: int, channel_id: int) -> bool:
    try:
        r = requests.get(
            f"{TELEGRAM_API}/getChatMember",
            params={"chat_id": channel_id, "user_id": user_id},
            timeout=8,
        )
        data = r.json()
        if data.get("ok"):
            return data["result"].get("status") in _JOINED_STATUSES
    except Exception:
        pass
    return False


def is_user_fsub_ok(user_id: int) -> bool:
    """True if the user is a plain member of every configured force-sub
    channel. No channels configured at all also counts as OK."""
    for ch in fsub_col.find():
        if not is_channel_member(user_id, ch["_id"]):
            return False
    return True


# ---------------------------------------------------------------------------
# Telegram initData verification
# https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
# ---------------------------------------------------------------------------
def verify_init_data(init_data: str):
    if not init_data or not BOT_TOKEN:
        return None

    try:
        parsed = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None

    received_hash = parsed.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(
        f"{k}={v}" for k, v in sorted(parsed.items())
    )

    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        return None

    auth_date = int(parsed.get("auth_date", 0))
    if time.time() - auth_date > INIT_DATA_MAX_AGE:
        return None

    user = json.loads(parsed.get("user", "{}"))
    return user


def get_verified_user():
    """Pulls initData from the request (JSON body) and verifies it."""
    body = request.get_json(silent=True) or {}
    init_data = body.get("initData", "")
    return verify_init_data(init_data)


# ---------------------------------------------------------------------------
# AniList (anime data source for the Anime Station home page)
# ---------------------------------------------------------------------------
_ANIME_FIELDS = """
    id
    title { romaji english native }
    coverImage { large color }
    bannerImage
    genres
    description(asHtml: false)
    status
    episodes
    averageScore
    season
    seasonYear
"""

_ANIME_QUERY = f"""
query ($page: Int, $perPage: Int, $sort: [MediaSort], $search: String) {{
  Page(page: $page, perPage: $perPage) {{
    pageInfo {{ hasNextPage total }}
    media(type: ANIME, sort: $sort, search: $search) {{
      {_ANIME_FIELDS}
    }}
  }}
}}
"""

_anilist_cache = {}       # cache_key -> (expires_at, result)
_ANILIST_CACHE_TTL = 600  # 10 minutes — trending/popular don't change second to second


_ANIME_BY_IDS_QUERY = f"""
query ($ids: [Int]) {{
  Page(perPage: 50) {{
    media(id_in: $ids, type: ANIME) {{
      {_ANIME_FIELDS}
    }}
  }}
}}
"""


def anilist_query(variables, cache_key=None):
    if cache_key:
        hit = _anilist_cache.get(cache_key)
        if hit and hit[0] > time.time():
            return hit[1]

    try:
        r = requests.post(
            ANILIST_URL,
            json={"query": _ANIME_QUERY, "variables": variables},
            timeout=15,
        )
        data = r.json()
    except Exception:
        return None

    if "errors" in data or "data" not in data:
        return None

    result = data["data"]["Page"]
    if cache_key:
        _anilist_cache[cache_key] = (time.time() + _ANILIST_CACHE_TTL, result)
    return result


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/anime/trending")
def anime_trending():
    page = int(request.args.get("page", 1))
    result = anilist_query(
        {"page": page, "perPage": 10, "sort": ["TRENDING_DESC"], "search": None},
        cache_key=f"trending_{page}",
    )
    if result is None:
        return jsonify({"ok": False, "error": "anilist_unavailable"}), 502
    return jsonify({"ok": True, **result})


@app.route("/api/anime/popular")
def anime_popular():
    page = int(request.args.get("page", 1))
    result = anilist_query(
        {"page": page, "perPage": 20, "sort": ["POPULARITY_DESC"], "search": None},
        cache_key=f"popular_{page}",
    )
    if result is None:
        return jsonify({"ok": False, "error": "anilist_unavailable"}), 502
    return jsonify({"ok": True, **result})


@app.route("/api/anime/search")
def anime_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"ok": True, "media": [], "pageInfo": {}})

    result = anilist_query({"page": 1, "perPage": 24, "sort": ["SEARCH_MATCH"], "search": q})
    if result is None:
        return jsonify({"ok": False, "error": "anilist_unavailable"}), 502
    return jsonify({"ok": True, **result})


@app.route("/api/anime/single/<int:anilist_id>")
def anime_single(anilist_id):
    try:
        r = requests.post(
            ANILIST_URL,
            json={"query": _ANIME_BY_IDS_QUERY, "variables": {"ids": [anilist_id]}},
            timeout=15,
        )
        data = r.json()
        media_list = data.get("data", {}).get("Page", {}).get("media", [])
    except Exception:
        media_list = []

    if not media_list:
        return jsonify({"ok": False, "error": "not_found"}), 404

    return jsonify({"ok": True, "media": media_list[0]})


@app.route("/api/anime/available")
def anime_available():
    docs = list(anime_requests_col.find({
        "$or": [{"channel_id": {"$ne": None}}, {"custom_link": {"$ne": None}}]
    }))
    ids = [d["_id"] for d in docs]
    if not ids:
        return jsonify({"ok": True, "media": []})

    try:
        r = requests.post(
            ANILIST_URL,
            json={"query": _ANIME_BY_IDS_QUERY, "variables": {"ids": ids}},
            timeout=15,
        )
        data = r.json()
        media = data.get("data", {}).get("Page", {}).get("media", [])
    except Exception:
        media = []

    return jsonify({"ok": True, "media": media})


@app.route("/api/anime/status/<int:anilist_id>")
def anime_status(anilist_id):
    req = anime_requests_col.find_one({"_id": anilist_id})
    if not req:
        return jsonify({"ok": True, "status": "none", "channel_id": None, "custom_link": None})
    return jsonify({
        "ok": True,
        "status": req.get("status", "none"),
        "channel_id": req.get("channel_id"),
        "custom_link": req.get("custom_link"),
    })


@app.route("/api/anime/votes/<int:anilist_id>", methods=["POST"])
def anime_votes(anilist_id):
    """Public vote count + whether the calling user (if signed in) has voted."""
    body = request.get_json(silent=True) or {}
    user = verify_init_data(body.get("initData", ""))

    req = anime_requests_col.find_one({"_id": anilist_id})
    voters = req.get("voters", []) if req else []
    voted = bool(user and user.get("id") in voters)

    return jsonify({"ok": True, "votes": len(voters), "voted": voted})


@app.route("/api/anime/vote", methods=["POST"])
def anime_vote():
    """Toggles the calling user's vote on a still-pending/accepted/declined
    request. Voting stops making sense once the anime is actually
    available (a channel or custom link is set), so that's rejected."""
    body = request.get_json(silent=True) or {}
    user = verify_init_data(body.get("initData", ""))
    if not user:
        return jsonify({"ok": False, "error": "invalid_init_data"}), 401

    try:
        anilist_id = int(body.get("anilist_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_anilist_id"}), 400

    req = anime_requests_col.find_one({"_id": anilist_id})
    if not req:
        return jsonify({"ok": False, "error": "not_found"}), 404

    if req.get("channel_id") or req.get("custom_link"):
        return jsonify({"ok": False, "error": "already_available"}), 400

    user_id = user.get("id")
    voters = req.get("voters", [])

    if user_id in voters:
        anime_requests_col.update_one({"_id": anilist_id}, {"$pull": {"voters": user_id}})
        voted = False
    else:
        anime_requests_col.update_one({"_id": anilist_id}, {"$addToSet": {"voters": user_id}})
        voted = True

    updated = anime_requests_col.find_one({"_id": anilist_id})
    votes = len(updated.get("voters", []))

    return jsonify({"ok": True, "voted": voted, "votes": votes})


@app.route("/api/anime/request", methods=["POST"])
def anime_request():
    body = request.get_json(silent=True) or {}
    user = verify_init_data(body.get("initData", ""))
    if not user:
        return jsonify({"ok": False, "error": "invalid_init_data"}), 401

    try:
        anilist_id = int(body.get("anilist_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_anilist_id"}), 400

    title = str(body.get("title") or "Unknown title")[:200]

    existing = anime_requests_col.find_one({"_id": anilist_id})
    if existing:
        return jsonify({"ok": True, "status": existing.get("status", "pending")})

    if not ADMIN_REQUESTS_CHANNEL_ID:
        return jsonify({"ok": False, "error": "admin_channel_not_configured"}), 500

    requester_id = user.get("id")

    is_requester_admin = bool(admins_col.find_one({"_id": requester_id})) or requester_id == OWNER_ID

    if not is_requester_admin:
        cutoff = time.time() - 86400
        recent_count = anime_request_log_col.count_documents({"user_id": requester_id, "timestamp": {"$gte": cutoff}})
        if recent_count >= MAX_DAILY_REQUESTS:
            return jsonify({"ok": False, "error": "daily_limit_reached", "limit": MAX_DAILY_REQUESTS}), 429

    requester_username = user.get("username")
    handle = f"@{requester_username}" if requester_username else "no username"
    ts = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())

    text = (
        f"🎬 <b>New Anime Request</b>\n\n"
        f"<b>Anime:</b> {title}\n"
        f"<b>AniList ID:</b> <code>{anilist_id}</code>\n"
        f"<b>Requested by:</b> {requester_id} ({handle})\n"
        f"<b>Time:</b> {ts}"
    )
    keyboard = {
        "inline_keyboard": [[
            {"text": "✅ Accept", "callback_data": f"areq_accept_{anilist_id}"},
            {"text": "❌ Decline", "callback_data": f"areq_decline_{anilist_id}"},
        ]]
    }

    try:
        r = requests.post(
            f"{TELEGRAM_API}/sendMessage",
            json={
                "chat_id": ADMIN_REQUESTS_CHANNEL_ID,
                "text": text,
                "parse_mode": "HTML",
                "reply_markup": keyboard,
            },
            timeout=10,
        )
        data = r.json()
        if not data.get("ok"):
            return jsonify({"ok": False, "error": "failed_to_notify_admins"}), 502
        admin_msg_id = data["result"]["message_id"]
    except Exception:
        return jsonify({"ok": False, "error": "failed_to_notify_admins"}), 502

    anime_requests_col.update_one(
        {"_id": anilist_id},
        {"$setOnInsert": {
            "_id": anilist_id,
            "title": title,
            "status": "pending",
            "channel_id": None,
            "requester_id": requester_id,
            "requester_username": requester_username,
            "admin_chat_id": ADMIN_REQUESTS_CHANNEL_ID,
            "admin_msg_id": admin_msg_id,
            "requested_at": time.time(),
            "voters": [],
        }},
        upsert=True,
    )

    anime_request_log_col.insert_one({"user_id": requester_id, "anilist_id": anilist_id, "timestamp": time.time()})

    return jsonify({"ok": True, "status": "pending"})


@app.route("/api/anime/set-channel", methods=["POST"])
def anime_set_channel():
    body = request.get_json(silent=True) or {}
    user = verify_init_data(body.get("initData", ""))
    if not user:
        return jsonify({"ok": False, "error": "invalid_init_data"}), 401

    user_id = user.get("id")
    is_admin = bool(admins_col.find_one({"_id": user_id})) or user_id == OWNER_ID
    if not is_admin:
        return jsonify({"ok": False, "error": "not_admin"}), 403

    try:
        anilist_id = int(body.get("anilist_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_anilist_id"}), 400

    raw_value = str(body.get("value", "")).strip()
    if not raw_value:
        return jsonify({"ok": False, "error": "empty_value"}), 400

    title = str(body.get("title") or "Unknown title")[:200]

    # A direct link (e.g. a pre-made invite, or any external URL) — used
    # as-is on Join, no channel lookup or invite-link generation involved.
    if raw_value.lower().startswith("http://") or raw_value.lower().startswith("https://"):
        anime_requests_col.update_one(
            {"_id": anilist_id},
            {
                "$set": {
                    "custom_link": raw_value,
                    "channel_id": None,
                    "status": "resolved",
                    "title": title,
                },
                "$setOnInsert": {
                    "requester_id": user_id,
                    "requester_username": user.get("username"),
                    "admin_chat_id": None,
                    "admin_msg_id": None,
                    "requested_at": time.time(),
                },
            },
            upsert=True,
        )
        return jsonify({"ok": True, "custom_link": raw_value})

    # Otherwise resolve to a numeric Telegram channel ID — same approach as /api/admin/add.
    channel_id = None
    try:
        channel_id = int(raw_value)
    except ValueError:
        username = raw_value.lstrip("@")

        if BOT_INTERNAL_URL and WEBAPP_SECRET:
            try:
                r = requests.post(
                    f"{BOT_INTERNAL_URL}/resolve-user",
                    json={"username": username},
                    headers={"X-Webapp-Secret": WEBAPP_SECRET},
                    timeout=10,
                )
                data = r.json()
                if data.get("ok"):
                    channel_id = data["id"]
            except Exception:
                pass

        if channel_id is None:
            try:
                r = requests.get(f"{TELEGRAM_API}/getChat", params={"chat_id": f"@{username}"}, timeout=8)
                data = r.json()
                if data.get("ok"):
                    channel_id = data["result"]["id"]
            except Exception:
                pass

    if channel_id is None:
        return jsonify({"ok": False, "error": "not_found"}), 400

    # Confirm Telegram actually knows this as a channel.
    try:
        r = requests.get(f"{TELEGRAM_API}/getChat", params={"chat_id": channel_id}, timeout=8)
        data = r.json()
        if not data.get("ok") or data["result"].get("type") != "channel":
            return jsonify({"ok": False, "error": "not_a_channel"}), 400
    except Exception:
        return jsonify({"ok": False, "error": "lookup_failed"}), 400

    anime_requests_col.update_one(
        {"_id": anilist_id},
        {
            "$set": {"channel_id": channel_id, "custom_link": None, "status": "resolved", "title": title},
            "$setOnInsert": {
                "requester_id": user_id,
                "requester_username": user.get("username"),
                "admin_chat_id": None,
                "admin_msg_id": None,
                "requested_at": time.time(),
            },
        },
        upsert=True,
    )

    return jsonify({"ok": True, "channel_id": channel_id})


@app.route("/api/anime/remove-available", methods=["POST"])
def anime_remove_available():
    """Admin-only: pulls an anime out of the Available list entirely by
    deleting its request record — clears the linked channel/link and any
    request history/votes, so it starts clean if requested again later."""
    body = request.get_json(silent=True) or {}
    user = verify_init_data(body.get("initData", ""))
    if not user:
        return jsonify({"ok": False, "error": "invalid_init_data"}), 401

    user_id = user.get("id")
    is_admin = bool(admins_col.find_one({"_id": user_id})) or user_id == OWNER_ID
    if not is_admin:
        return jsonify({"ok": False, "error": "not_admin"}), 403

    try:
        anilist_id = int(body.get("anilist_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_anilist_id"}), 400

    result = anime_requests_col.delete_one({"_id": anilist_id})
    if result.deleted_count == 0:
        return jsonify({"ok": False, "error": "not_found"}), 404

    return jsonify({"ok": True})


@app.route("/api/anime/top-requested")
def anime_top_requested():
    """Anime that have been requested but aren't available yet, ranked by
    vote count (ties broken by whoever was requested first)."""
    docs = list(anime_requests_col.find({"channel_id": None, "custom_link": None}))
    docs.sort(key=lambda d: (-len(d.get("voters", [])), d.get("requested_at", 0)))
    docs = docs[:50]

    ids = [d["_id"] for d in docs]
    if not ids:
        return jsonify({"ok": True, "media": []})

    try:
        r = requests.post(
            ANILIST_URL,
            json={"query": _ANIME_BY_IDS_QUERY, "variables": {"ids": ids}},
            timeout=15,
        )
        data = r.json()
        media_by_id = {m["id"]: m for m in data.get("data", {}).get("Page", {}).get("media", [])}
    except Exception:
        media_by_id = {}

    # Keep the vote-sorted order from `docs` (AniList doesn't preserve it),
    # tacking the vote count and request status onto each media object.
    media = []
    for d in docs:
        m = media_by_id.get(d["_id"])
        if not m:
            continue
        m = dict(m)
        m["votes"] = len(d.get("voters", []))
        m["request_status"] = d.get("status", "pending")
        media.append(m)

    return jsonify({"ok": True, "media": media})


REPORT_REASONS = {
    "link_not_working": "Link isn't working",
    "wrong_anime": "Wrong anime uploaded",
    "missing_episodes": "Episodes are missing",
    "poor_quality": "Poor video quality",
    "wrong_channel": "Wrong channel linked",
    "other": "Other",
}


@app.route("/api/anime/report", methods=["POST"])
def anime_report():
    body = request.get_json(silent=True) or {}
    user = verify_init_data(body.get("initData", ""))
    if not user:
        return jsonify({"ok": False, "error": "invalid_init_data"}), 401

    try:
        anilist_id = int(body.get("anilist_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_anilist_id"}), 400

    reason_key = body.get("reason", "")
    if reason_key not in REPORT_REASONS:
        return jsonify({"ok": False, "error": "invalid_reason"}), 400

    if not REPORTS_CHANNEL_ID:
        return jsonify({"ok": False, "error": "reports_channel_not_configured"}), 500

    title = str(body.get("title") or "Unknown title")[:200]
    custom_message = str(body.get("message") or "").strip()[:50]

    reporter_id = user.get("id")
    reporter_username = user.get("username")
    handle = f"@{reporter_username}" if reporter_username else "no username"
    ts = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())

    text = (
        f"🚩 <b>Anime Report</b>\n\n"
        f"<b>Anime:</b> {title}\n"
        f"<b>AniList ID:</b> <code>{anilist_id}</code>\n"
        f"<b>Reason:</b> {REPORT_REASONS[reason_key]}\n"
    )
    if custom_message:
        text += f"<b>Details:</b> {custom_message}\n"
    text += (
        f"\n<b>Reported by:</b> {reporter_id} ({handle})\n"
        f"<b>Time:</b> {ts}"
    )

    keyboard = None
    bot_username = get_bot_username()
    if bot_username:
        deep_link = f"https://t.me/{bot_username}?start=reply_{reporter_id}"
        keyboard = {"inline_keyboard": [[{"text": "💬 Reply to reporter", "url": deep_link}]]}

    try:
        payload = {"chat_id": REPORTS_CHANNEL_ID, "text": text, "parse_mode": "HTML"}
        if keyboard:
            payload["reply_markup"] = keyboard
        r = requests.post(f"{TELEGRAM_API}/sendMessage", json=payload, timeout=10)
        data = r.json()
        if not data.get("ok"):
            return jsonify({"ok": False, "error": "failed_to_send_report"}), 502
    except Exception:
        return jsonify({"ok": False, "error": "failed_to_send_report"}), 502

    return jsonify({"ok": True})


@app.route("/api/anime/join", methods=["POST"])
def anime_join():
    body = request.get_json(silent=True) or {}
    user = verify_init_data(body.get("initData", ""))
    if not user:
        return jsonify({"ok": False, "error": "invalid_init_data"}), 401

    try:
        anilist_id = int(body.get("anilist_id"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_anilist_id"}), 400

    req = anime_requests_col.find_one({"_id": anilist_id})
    custom_link = req.get("custom_link") if req else None
    if custom_link:
        return jsonify({"ok": True, "invite_link": custom_link})

    channel_id = req.get("channel_id") if req else None
    if not channel_id:
        return jsonify({"ok": False, "error": "no_channel_linked"}), 404

    try:
        r = requests.post(
            f"{TELEGRAM_API}/createChatInviteLink",
            json={
                "chat_id": channel_id,
                "member_limit": 1,
                "name": f"anime-{anilist_id}-{int(time.time())}",
            },
            timeout=10,
        )
        data = r.json()
        if not data.get("ok"):
            return jsonify({"ok": False, "error": "invite_generation_failed"}), 502
        link = data["result"]["invite_link"]
    except Exception:
        return jsonify({"ok": False, "error": "invite_generation_failed"}), 502

    return jsonify({"ok": True, "invite_link": link})


@app.route("/api/auth", methods=["POST"])
def auth():
    user = get_verified_user()
    if not user:
        return jsonify({"ok": False, "error": "invalid_init_data"}), 401

    user_id = user.get("id")
    is_registered = bool(users_col.find_one({"_id": user_id}))
    is_admin = bool(admins_col.find_one({"_id": user_id})) or user_id == OWNER_ID
    is_banned = bool(banned_col.find_one({"_id": user_id}))

    if not is_registered:
        # First time we've ever seen this user anywhere (webapp or bot) —
        # just register them, plain and simple.
        users_col.insert_one({"_id": user_id})
        is_registered = True

    response_user = {
        "id": user_id,
        "first_name": user.get("first_name", ""),
        "last_name": user.get("last_name", ""),
        "username": user.get("username", ""),
        "photo_url": user.get("photo_url", ""),
    }

    # Force-sub gate — skipped for admins/owner and banned users, same as
    # the bot's own is_subscribed(). Banned users get told they're banned
    # elsewhere in the UI regardless of fsub status.
    fsub_required = False
    if not is_admin and not is_banned:
        fsub_required = not is_user_fsub_ok(user_id)

    return jsonify({
        "ok": True,
        "user": response_user,
        "registered": is_registered,
        "is_admin": is_admin,
        "is_banned": is_banned,
        "fsub_required": fsub_required,
        "bot_username": get_bot_username(),
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
