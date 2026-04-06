import os
from contextlib import asynccontextmanager

import aiosqlite

DB_PATH = "/workspace/data/speedreader.db"


@asynccontextmanager
async def get_db():
    """Async context manager that yields an aiosqlite connection."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    try:
        yield db
    finally:
        await db.close()


async def init_db():
    """Create database tables and indexes if they do not exist."""
    async with get_db() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS publications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                author TEXT,
                filename TEXT,
                status TEXT DEFAULT 'ready',
                total_segments INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS chapters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                publication_id INTEGER REFERENCES publications(id),
                chapter_index INTEGER,
                title TEXT,
                text_content TEXT
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chapter_id INTEGER REFERENCES chapters(id),
                segment_index INTEGER,
                text TEXT,
                word_count INTEGER,
                duration_ms INTEGER
            )
        """)

        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_segments_chapter_segment
            ON segments(chapter_id, segment_index)
        """)

        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_chapters_publication
            ON chapters(publication_id)
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS reading_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                publication_id INTEGER NOT NULL REFERENCES publications(id),
                chapter_id INTEGER NOT NULL REFERENCES chapters(id),
                segment_index INTEGER NOT NULL DEFAULT 0,
                wpm INTEGER NOT NULL DEFAULT 250,
                reading_mode TEXT NOT NULL DEFAULT 'phrase',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(publication_id)
            )
        """)

        # Migrations for existing DBs
        for col_sql in [
            "ALTER TABLE reading_progress ADD COLUMN reading_mode TEXT NOT NULL DEFAULT 'phrase'",
            "ALTER TABLE reading_progress ADD COLUMN word_index INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE publications ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text'",
            "ALTER TABLE publications ADD COLUMN total_pages INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE segments ADD COLUMN inline_images TEXT",
        ]:
            try:
                await db.execute(col_sql)
            except Exception:
                pass  # column already exists

        await db.execute("""
            CREATE TABLE IF NOT EXISTS image_pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chapter_id INTEGER NOT NULL REFERENCES chapters(id),
                page_index INTEGER NOT NULL,
                image_path TEXT NOT NULL,
                width INTEGER,
                height INTEGER,
                mime_type TEXT NOT NULL DEFAULT 'image/jpeg'
            )
        """)

        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_image_pages_chapter
            ON image_pages(chapter_id, page_index)
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS bookmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                publication_id INTEGER NOT NULL REFERENCES publications(id),
                chapter_id INTEGER NOT NULL REFERENCES chapters(id),
                segment_index INTEGER NOT NULL,
                note TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(publication_id, chapter_id, segment_index)
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS highlights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                publication_id INTEGER NOT NULL REFERENCES publications(id),
                chapter_id INTEGER NOT NULL REFERENCES chapters(id),
                segment_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT 'yellow',
                note TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)

        await db.commit()
