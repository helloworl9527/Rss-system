from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sqlite3
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from telethon import TelegramClient, events, functions, utils
from telethon.errors import SessionPasswordNeededError
from telethon.tl.types import Channel, Chat, ChatInviteAlready

USERNAME = re.compile(r"[A-Za-z0-9_]{5,32}")
URLISH = re.compile(r"https?://[^\s<>\"'，。；：！？、]+|(?<![@\w])(?:www\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})){1,}(?:/[^\s<>\"'，。；：！？、]*)?", re.IGNORECASE)
BARE_HOST = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{2,59})$", re.IGNORECASE)


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def extract_urls(text: str) -> tuple[str, ...]:
    result: list[str] = []
    for match in URLISH.finditer(text):
        raw = match.group(0).rstrip(".,;:!?，。；：！？、)]}》】'\"")
        explicit = raw.lower().startswith(("http://", "https://"))
        parsed = urlparse(raw if explicit else f"https://{raw}")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        if not explicit and not BARE_HOST.fullmatch(parsed.hostname):
            continue
        host = parsed.hostname.lower()
        port = f":{parsed.port}" if parsed.port and not (parsed.scheme == "http" and parsed.port == 80) and not (parsed.scheme == "https" and parsed.port == 443) else ""
        normalized = f"{parsed.scheme.lower()}://{host}{port}{parsed.path or '/'}"
        if parsed.query:
            normalized += f"?{parsed.query}"
        if normalized not in result:
            result.append(normalized)
    return tuple(result)


def reference(raw: str) -> tuple[str, str | int]:
    value = raw.strip()
    if value.startswith("@") and USERNAME.fullmatch(value[1:]):
        return "public", value
    parsed = urlparse(value if "://" in value else f"https://{value}")
    if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in {"t.me", "www.t.me", "telegram.me", "www.telegram.me"}:
        raise ValueError("unsupported Telegram reference")
    pieces = [x for x in parsed.path.split("/") if x]
    if pieces and pieces[0].lower() == "s":
        pieces.pop(0)
    if len(pieces) == 3 and pieces[0].lower() == "c" and pieces[1].isdigit() and pieces[2].isdigit():
        return "private_message", -1_000_000_000_000 - int(pieces[1])
    if (len(pieces) == 1 and pieces[0].startswith("+")) or (len(pieces) == 2 and pieces[0].lower() == "joinchat"):
        token = pieces[0][1:] if pieces[0].startswith("+") else pieces[1]
        return "invite", token
    if len(pieces) == 1 and USERNAME.fullmatch(pieces[0]):
        return "public", f"@{pieces[0]}"
    raise ValueError("unsupported Telegram reference")


class Store:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=30000")
        self.db.execute("PRAGMA journal_mode=WAL")
        path.chmod(0o600)

    def initialize(self) -> None:
        migrations = Path(__file__).parents[2] / "migrations"
        sql_path = migrations / "001_initial.sql"
        sql = sql_path.read_text(encoding="utf8")
        checksum = hashlib.sha256(sql.encode()).hexdigest()[:16]
        self.db.execute("CREATE TABLE IF NOT EXISTS telegram_schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT")
        row = self.db.execute("SELECT checksum FROM telegram_schema_migrations WHERE name='001_initial.sql'").fetchone()
        if row and row[0] != checksum:
            raise RuntimeError("applied Telegram migration changed")
        if not row:
            self.db.executescript(sql)
            self.db.execute("INSERT OR REPLACE INTO telegram_schema_migrations VALUES(?,?,?)", ("001_initial.sql", checksum, utc_now()))
            self.db.commit()

    def worker_state(self, state: str, *, authorized: bool = False, hint: str | None = None, error: str | None = None) -> None:
        self.db.execute("UPDATE telegram_worker_state SET authorized=?,login_state=?,account_hint=?,last_error=?,heartbeat_at=?,updated_at=? WHERE singleton=1", (authorized, state, hint, error, utc_now(), utc_now()))
        self.db.commit()

    def heartbeat(self, authorized: bool) -> None:
        self.db.execute("UPDATE telegram_worker_state SET authorized=?,heartbeat_at=?,updated_at=? WHERE singleton=1", (authorized, utc_now(), utc_now()))
        self.db.commit()

    def pending(self):
        return self.db.execute("SELECT * FROM telegram_sources WHERE status='pending' ORDER BY validation_requested_at,id").fetchall()

    def enabled(self):
        return self.db.execute("SELECT * FROM telegram_sources WHERE status='active' AND enabled=1 ORDER BY id").fetchall()

    def resolved(self, row: sqlite3.Row, entity) -> None:
        chat_id = utils.get_peer_id(entity)
        kind = "group" if isinstance(entity, Chat) or getattr(entity, "megagroup", False) else "channel"
        title = str(getattr(entity, "title", chat_id))
        username = getattr(entity, "username", None)
        try:
            self.db.execute("UPDATE telegram_sources SET chat_id=?,title=?,username=?,telegram_kind=?,status='active',enabled=1,last_error=NULL,validated_at=?,updated_at=? WHERE id=?", (chat_id, title, username, kind, utc_now(), utc_now(), row["id"]))
            self.db.execute("INSERT OR IGNORE INTO telegram_sync_state(source_id) VALUES(?)", (row["id"],))
            self.db.commit()
        except sqlite3.IntegrityError:
            self.db.rollback()
            self.failed(row["id"], "该 Telegram chat_id 已存在，不能重复添加")

    def failed(self, source_id: int, message: str) -> None:
        self.db.execute("UPDATE telegram_sources SET status='error',enabled=0,last_error=?,updated_at=? WHERE id=?", (message[:500], utc_now(), source_id))
        self.db.commit()

    def save_normal(self, source: sqlite3.Row, message) -> None:
        text = str(getattr(message, "message", "") or "")
        if not text.strip():
            return
        sent = utc(message.date); edited = utc(message.edit_date) if message.edit_date else None
        digest = hashlib.sha256(text.encode()).hexdigest()
        link = f"https://t.me/{source['username']}/{message.id}" if source["username"] else None
        now = utc_now()
        with self.db:
            self.db.execute("""INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,edited_at,reply_to_id,source_url,content_hash,collected_at,deleted_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(chat_id,message_id) DO UPDATE SET text=excluded.text,edited_at=excluded.edited_at,reply_to_id=excluded.reply_to_id,source_url=excluded.source_url,content_hash=excluded.content_hash,collected_at=excluded.collected_at,deleted_at=NULL""",
              (source["id"], source["chat_id"], message.id, sent, text, edited, getattr(message,"reply_to_msg_id",None), link, digest, now))
            self.db.execute("INSERT OR IGNORE INTO telegram_message_versions(chat_id,message_id,content_hash,text,edited_at,collected_at) VALUES(?,?,?,?,?,?)", (source["chat_id"],message.id,digest,text,edited,now))
            self.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?),last_synced_at=?,last_error=NULL WHERE source_id=?", (message.id,now,source["id"]))

    def save_urls(self, source: sqlite3.Row, message) -> None:
        # Deliberately do not persist message, sender, bio, link, or media metadata.
        urls = extract_urls(str(getattr(message, "message", "") or ""))
        found = utc_now()
        days = int(self.db.execute("SELECT url_retention_days FROM telegram_settings WHERE singleton=1").fetchone()[0])
        expires = (datetime.now(UTC) + timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.db:
            for url in urls:
                self.db.execute("""INSERT INTO telegram_urls(normalized_url,first_source_id,last_source_id,first_discovered_at,last_discovered_at,expires_at)
                  VALUES(?,?,?,?,?,?) ON CONFLICT(normalized_url) DO UPDATE SET last_source_id=excluded.last_source_id,last_discovered_at=excluded.last_discovered_at,expires_at=excluded.expires_at""",
                  (url,source["id"],source["id"],found,found,expires))
            self.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?),last_synced_at=?,last_error=NULL WHERE source_id=?", (message.id,found,source["id"]))

    def delete_normal(self, chat_id: int, ids: list[int]) -> None:
        if not ids:
            return
        with self.db:
            self.db.executemany("UPDATE telegram_messages SET deleted_at=? WHERE chat_id=? AND message_id=?", [(utc_now(),chat_id,x) for x in ids])


class Worker:
    def __init__(self, store: Store, client: TelegramClient, socket_path: Path):
        self.store, self.client, self.socket_path = store, client, socket_path
        self.entities: dict[int, object] = {}
        self.phone = os.environ.get("TELEGRAM_PHONE", "")

    async def resolve(self, row: sqlite3.Row):
        kind, value = reference(row["reference"])
        if kind == "invite":
            checked = await self.client(functions.messages.CheckChatInviteRequest(value))
            if not isinstance(checked, ChatInviteAlready):
                raise ValueError("邀请链接对应群组尚未加入；系统不会自动加入")
            return checked.chat
        if kind == "private_message":
            for dialog in await self.client.get_dialogs():
                if utils.get_peer_id(dialog.entity) == value:
                    return dialog.entity
            raise ValueError("私群消息链接对应群组尚未加入；系统不会自动加入")
        return await self.client.get_entity(value)

    async def validate_pending(self) -> None:
        for row in self.store.pending():
            try:
                entity = await self.resolve(row)
                if not isinstance(entity, (Channel, Chat)):
                    raise TypeError("地址不是群组或频道")
                self.store.resolved(row, entity)
            except Exception as exc:  # noqa: BLE001 - isolate source validation failures
                self.store.failed(row["id"], str(exc) or type(exc).__name__)

    async def reload(self) -> None:
        self.entities = {}
        for row in self.store.enabled():
            try:
                self.entities[row["chat_id"]] = await self.client.get_entity(row["chat_id"])
            except Exception as exc:  # noqa: BLE001 - isolate source resolution failures
                self.store.failed(row["id"], f"来源解析失败：{type(exc).__name__}")

    async def backfill_source(self, row: sqlite3.Row, entity) -> None:
        settings = self.store.db.execute("SELECT timezone,raw_retention_days FROM telegram_settings WHERE singleton=1").fetchone()
        zone = ZoneInfo(settings["timezone"])
        local_now = datetime.now(UTC).astimezone(zone)
        cutoff_local = datetime.combine(local_now.date() - timedelta(days=int(settings["raw_retention_days"]) - 1), datetime.min.time(), zone)
        cutoff = cutoff_local.astimezone(UTC)
        state = self.store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (row["id"],)).fetchone()
        last_id = int(state[0]) if state else 0
        options = {"min_id": last_id, "reverse": True} if last_id else {}
        async for message in self.client.iter_messages(entity, **options):
            date = message.date if message.date.tzinfo else message.date.replace(tzinfo=UTC)
            if date < cutoff:
                break
            (self.store.save_urls if row["source_type"] == "url" else self.store.save_normal)(row,message)
        if row["source_type"] == "normal":
            retained = [int(item[0]) for item in self.store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=? AND sent_at>=? AND deleted_at IS NULL ORDER BY message_id", (row["id"], utc(cutoff))).fetchall()]
            for offset in range(0, len(retained), 500):
                requested = retained[offset:offset + 500]
                current = await self.client.get_messages(entity, ids=requested)
                returned: set[int] = set()
                for message in current:
                    if message is not None:
                        returned.add(int(message.id))
                        self.store.save_normal(row, message)
                self.store.delete_normal(row["chat_id"], [item for item in requested if item not in returned])
        self.store.db.execute("UPDATE telegram_sources SET last_success_at=?,last_error=NULL,updated_at=? WHERE id=?",(utc_now(),utc_now(),row["id"]))
        self.store.db.commit()

    async def reconcile(self) -> None:
        await self.validate_pending()
        await self.reload()
        for row in self.store.enabled():
            entity = self.entities.get(row["chat_id"])
            if entity is None:
                continue
            try:
                await self.backfill_source(row, entity)
            except Exception as exc:  # noqa: BLE001 - one source must not block others
                self.store.db.execute("UPDATE telegram_sources SET last_error=?,updated_at=? WHERE id=?",(f"同步失败：{type(exc).__name__}",utc_now(),row["id"]))
                self.store.db.commit()

    async def on_message(self, event) -> None:
        source = self.store.db.execute("SELECT * FROM telegram_sources WHERE chat_id=? AND enabled=1 AND status='active'",(event.chat_id,)).fetchone()
        if source:
            (self.store.save_urls if source["source_type"] == "url" else self.store.save_normal)(source,event.message)

    async def on_delete(self, event) -> None:
        if event.chat_id is not None:
            source=self.store.db.execute("SELECT source_type FROM telegram_sources WHERE chat_id=?",(event.chat_id,)).fetchone()
            if source and source[0] == "normal":
                self.store.delete_normal(event.chat_id,list(event.deleted_ids))

    async def login_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        response: dict[str, object]
        try:
            raw = await asyncio.wait_for(reader.readline(),10)
            obj = json.loads(raw[:8192]); command = obj.get("command"); value = str(obj.get("value", ""))
            if command == "start":
                if await self.client.is_user_authorized():
                    me=await self.client.get_me(); self.store.worker_state("authorized",authorized=True,hint=str(getattr(me,"id","")))
                    response={"ok":True,"state":"authorized"}
                elif not self.phone:
                    response={"ok":False,"error":"未配置 Telegram 手机号"}
                else:
                    await self.client.send_code_request(self.phone); self.store.worker_state("code_required")
                    response={"ok":True,"state":"code_required"}
            elif command == "code":
                try:
                    await self.client.sign_in(self.phone,value)
                    self.store.worker_state("authorized",authorized=True); response={"ok":True,"state":"authorized"}
                except SessionPasswordNeededError:
                    self.store.worker_state("password_required"); response={"ok":True,"state":"password_required"}
            elif command == "password":
                await self.client.sign_in(password=value); self.store.worker_state("authorized",authorized=True); response={"ok":True,"state":"authorized"}
            else:
                response={"ok":False,"error":"未知登录命令"}
            value = ""  # minimize lifetime of sensitive input
        except Exception as exc:  # noqa: BLE001 - return a redacted login failure
            self.store.worker_state("error",error=type(exc).__name__)
            response={"ok":False,"error":"Telegram 登录失败，请检查输入或 worker 日志中的错误类型"}
        writer.write((json.dumps(response,ensure_ascii=False)+"\n").encode()); await writer.drain(); writer.close(); await writer.wait_closed()

    async def run(self) -> None:
        await self.client.connect()
        authorized=await self.client.is_user_authorized()
        self.store.worker_state("authorized" if authorized else "idle",authorized=authorized)
        self.socket_path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.socket_path.unlink(missing_ok=True)
        server=await asyncio.start_unix_server(self.login_request,path=self.socket_path)
        self.socket_path.chmod(0o600)
        self.client.add_event_handler(self.on_message,events.NewMessage())
        self.client.add_event_handler(self.on_message,events.MessageEdited())
        self.client.add_event_handler(self.on_delete,events.MessageDeleted())
        try:
            while True:
                if await self.client.is_user_authorized():
                    await self.reconcile()
                self.store.heartbeat(await self.client.is_user_authorized())
                await asyncio.sleep(300)
        finally:
            server.close(); await server.wait_closed(); self.socket_path.unlink(missing_ok=True); await self.client.disconnect()


async def async_main() -> None:
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    db_path = Path(os.environ.get("TELEGRAM_DATABASE_PATH", "./data/telegram.sqlite3"))
    session = Path(os.environ.get("TELEGRAM_SESSION_PATH", "./data/telegram"))
    session.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    store=Store(db_path); store.initialize()
    client=TelegramClient(str(session),api_id,api_hash)
    try:
        await Worker(store,client,Path(os.environ.get("TELEGRAM_LOGIN_SOCKET","./data/telegram-login.sock"))).run()
    finally:
        for path in session.parent.glob(session.name+".session*"):
            with suppress(OSError): path.chmod(0o600)


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
