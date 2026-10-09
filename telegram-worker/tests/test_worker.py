import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from briefing_telegram.worker import (
    MAX_IMAGE_BYTES,
    Store,
    Worker,
    catchup_options,
    extract_urls,
    image_metadata,
    is_transient,
    reference,
)


def test_reference_formats_and_no_join_action():
    assert reference("@Hezu1") == ("public", "@Hezu1")
    assert reference("https://t.me/s/hezu1") == ("public", "@hezu1")
    assert reference("t.me/c/123/9") == ("private_message", -1000000000123)
    assert reference("https://t.me/+invite")[0] == "invite"


def test_url_extraction_excludes_prices_and_normalizes():
    assert extract_urls("0.85 11.30 Example.COM/a https://EXAMPLE.com:443/a#x") == ("https://example.com/a",)


def test_url_source_never_persists_message_content(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC).isoformat()
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@urlchan','url',-1001,'active',1,?,?,?)""", (now, now, now)).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    message = SimpleNamespace(id=9, message="private text https://example.com/x", date=datetime.now(UTC))
    store.save_urls(row, message)
    assert store.db.execute("SELECT count(*) FROM telegram_messages").fetchone()[0] == 0
    assert store.db.execute("SELECT normalized_url FROM telegram_urls").fetchone()[0] == "https://example.com/x"
    assert store.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_keep_messages_forever_ignores_telegram_deletion(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC).isoformat()
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@keepall','normal',-1002,'active',1,?,?,?)""", (now, now, now)).lastrowid
    store.db.execute("""INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at)
      VALUES(?,-1002,10,?,'keep me','hash',?)""", (source_id, now, now))
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=1 WHERE singleton=1")
    store.db.commit()
    store.delete_normal(-1002, [10])
    assert store.db.execute(
        "SELECT deleted_at FROM telegram_messages WHERE chat_id=-1002 AND message_id=10"
    ).fetchone()[0] is None


def test_image_types_and_pure_image_message_are_queued(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC)
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@images','normal',-1003,'active',1,?,?,?)""", (now.isoformat(), now.isoformat(), now.isoformat())).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    source = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    photo = SimpleNamespace(id=1, message="", date=now, edit_date=None, reply_to_msg_id=None,
                            photo=SimpleNamespace(id=99, sizes=[SimpleNamespace(size=1024)]), document=None)
    meta = image_metadata(photo)
    assert meta and meta[1] == "image/jpeg"
    store.save_normal(source, photo)
    pending = store.media_task(source, photo, meta)
    assert pending is not None
    assert pending[1].suffix == ".jpeg"
    assert store.db.execute("SELECT text FROM telegram_messages WHERE message_id=1").fetchone()[0] == ""
    assert store.db.execute("SELECT status FROM telegram_media_tasks WHERE message_id=1").fetchone()[0] == "downloading"

    animated = SimpleNamespace(photo=None, document=SimpleNamespace(id=2, size=1, mime_type="image/gif", attributes=[]), gif=True, sticker=None)
    sticker = SimpleNamespace(photo=None, document=SimpleNamespace(id=3, size=1, mime_type="image/webp",
                              attributes=[type("DocumentAttributeSticker", (), {})()]), gif=None, sticker=True)
    video = SimpleNamespace(photo=None, document=SimpleNamespace(id=4, size=1, mime_type="video/mp4", attributes=[]), gif=None, sticker=None)
    assert image_metadata(animated) is None
    assert image_metadata(sticker) is None
    assert image_metadata(video) is None


def test_image_size_boundary_and_url_source_isolation(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC)
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@normal','normal',-1004,'active',1,?,?,?)""", (now.isoformat(), now.isoformat(), now.isoformat())).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    source = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    exact = SimpleNamespace(id=2, message="caption", date=now, edit_date=None, reply_to_msg_id=None, photo=None,
                            document=SimpleNamespace(id=20, size=MAX_IMAGE_BYTES, mime_type="image/png", attributes=[]), gif=None, sticker=None)
    too_big = SimpleNamespace(id=3, message="caption", date=now, edit_date=None, reply_to_msg_id=None, photo=None,
                              document=SimpleNamespace(id=21, size=MAX_IMAGE_BYTES + 1, mime_type="image/png", attributes=[]), gif=None, sticker=None)
    store.save_normal(source, exact)
    exact_meta = image_metadata(exact)
    assert exact_meta is not None
    assert store.media_task(source, exact, exact_meta) is not None
    store.save_normal(source, too_big)
    too_big_meta = image_metadata(too_big)
    assert too_big_meta is not None
    assert store.media_task(source, too_big, too_big_meta) is None
    task = store.db.execute("SELECT status,error_type,temp_path FROM telegram_media_tasks WHERE message_id=3").fetchone()
    assert tuple(task) == ("skipped", "too_large", None)


def _active_source(store: Store, chat_id: int, ref: str) -> int:
    now = datetime.now(UTC).isoformat()
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES(?,'normal',?,'active',1,?,?,?)""", (ref, chat_id, now, now, now)).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    assert source_id is not None
    return source_id


class FakeClient:
    def __init__(self, messages=(), entity_error: Exception | None = None):
        self.messages = list(messages)
        self.entity_error = entity_error
        self.calls: list[dict] = []

    async def get_entity(self, chat_id):
        if self.entity_error:
            raise self.entity_error
        return SimpleNamespace(id=chat_id)

    async def iter_messages(self, entity, **options):
        self.calls.append(options)
        found = [m for m in self.messages if m.id > options.get("min_id", 0)]
        for message in sorted(found, key=lambda m: m.id, reverse=not options.get("reverse")):
            yield message

    async def get_messages(self, entity, ids):
        return [m for m in self.messages if m.id in ids]


def _text(message_id: int, sent: datetime):
    return SimpleNamespace(id=message_id, message=f"m{message_id}", date=sent, edit_date=None,
                           reply_to_msg_id=None, photo=None, document=None, gif=None, sticker=None)


def test_transient_errors_are_classified():
    assert is_transient(ConnectionError("Connection to Telegram failed 5 time(s)"))
    assert is_transient(asyncio.TimeoutError())
    assert not is_transient(ValueError("No user has \"x\" as username"))


def test_reload_connection_error_keeps_source_enabled(tmp_path: Path):
    # 2026-09-29：一次断线让 reload() 把全部来源标为 error/enabled=0，采集停了 10 天
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1005, "@flaky")
    worker = Worker(store, FakeClient(entity_error=ConnectionError("Connection to Telegram failed")), tmp_path / "s.sock")
    asyncio.run(worker.reload())
    status, enabled, error = store.db.execute(
        "SELECT status,enabled,last_error FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    assert (status, enabled) == ("active", 1)
    assert "ConnectionError" in error

    worker = Worker(store, FakeClient(entity_error=ValueError("No user has that username")), tmp_path / "s.sock")
    asyncio.run(worker.reload())
    assert tuple(store.db.execute("SELECT status,enabled FROM telegram_sources WHERE id=?", (source_id,)).fetchone()) == ("error", 0)


def test_catchup_options():
    cutoff = datetime(2026, 10, 4, tzinfo=UTC)
    assert catchup_options(0, True, cutoff) == {}
    assert catchup_options(100, True, cutoff) == {"min_id": 100, "reverse": True}
    assert catchup_options(100, False, cutoff) == {"min_id": 100, "reverse": True, "offset_date": cutoff}


def test_catchup_past_retention_backfills_gap_when_keeping_forever(tmp_path: Path):
    # 断点早于保留期：正序补采遇到的第一条就是旧消息，原来的 break 会一条都补不回来
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=1, raw_retention_days=6 WHERE singleton=1")
    source_id = _active_source(store, -1006, "@gap")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=100 WHERE source_id=?", (source_id,))
    store.db.commit()
    now = datetime.now(UTC)
    messages = [_text(101, now - timedelta(days=10)), _text(102, now - timedelta(days=8)), _text(103, now - timedelta(hours=1))]
    client = FakeClient(messages)
    worker = Worker(store, client, tmp_path / "s.sock")
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1006)))
    saved = [r[0] for r in store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=? ORDER BY message_id", (source_id,))]
    assert saved == [101, 102, 103]
    assert client.calls[0] == {"min_id": 100, "reverse": True}
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] == 103


def test_catchup_past_retention_skips_old_when_not_keeping(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=0, raw_retention_days=6 WHERE singleton=1")
    source_id = _active_source(store, -1007, "@gap2")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=100 WHERE source_id=?", (source_id,))
    store.db.commit()
    now = datetime.now(UTC)
    worker = Worker(store, FakeClient([_text(101, now - timedelta(days=10)), _text(102, now - timedelta(hours=1))]), tmp_path / "s.sock")
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1007)))
    saved = [r[0] for r in store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=?", (source_id,))]
    assert saved == [102]
