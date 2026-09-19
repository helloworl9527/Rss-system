from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from briefing_telegram.worker import (
    MAX_IMAGE_BYTES,
    Store,
    extract_urls,
    image_metadata,
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
