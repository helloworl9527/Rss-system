from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from briefing_telegram.worker import Store, extract_urls, reference


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
