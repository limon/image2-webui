from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import shutil
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except Exception:  # pragma: no cover - optional dependency for thumbnail acceleration
    Image = None
    ImageOps = None
    UnidentifiedImageError = Exception


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
JOBS_DIR = DATA_DIR / "jobs"
FILES_DIR = DATA_DIR / "files"
THUMBS_DIR = DATA_DIR / "thumbs"
FAVORITES_ROOT = FILES_DIR / "favorites"
DB_PATH = JOBS_DIR / "jobs.sqlite3"

MULTIPLE_OF = 16
MAX_LONGEST = 3840
MIN_PIXELS = 700_000
MAX_PIXELS = 8_850_000
DEFAULT_BASE_URL = "https://img-cn.65535.space/v1"
DEFAULT_MODEL = "gpt-5.4-mini"
DEFAULT_IMAGE_TOOL_MODEL = "gpt-image-2"
DEFAULT_REASONING_EFFORT = "medium"
DEFAULT_QUALITY = "high"
DEFAULT_MODERATION = "low"
DEFAULT_BATCH_MODE = "fanout"
DEFAULT_PREVIEW_COUNT = 3
DEFAULT_PROFILE_NAME = "默认"
MAX_REF_IMAGES = 10
MAX_IMAGE_COUNT = 4


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_base_url(value: str) -> str:
    base = (value or DEFAULT_BASE_URL).strip()
    if not base.startswith(("http://", "https://")):
        raise ValueError("API Base URL 必须以 http:// 或 https:// 开头")
    parsed = urlparse(base)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("API Base URL 格式不正确")
    return base.rstrip("/")


def ensure_dirs() -> None:
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    FAVORITES_ROOT.mkdir(parents=True, exist_ok=True)


def escape_filename(name: str, fallback: str) -> str:
    raw = Path(name or fallback).name
    safe = "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "_" for ch in raw)
    return safe or fallback


def parse_size(size: str) -> None:
    if size == "auto":
        return
    parts = size.lower().split("x")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise ValueError("尺寸格式应为 宽x高，例如 1024x1024")
    width, height = (int(parts[0]), int(parts[1]))
    if width % MULTIPLE_OF != 0 or height % MULTIPLE_OF != 0:
        raise ValueError(f"宽和高必须都能被 {MULTIPLE_OF} 整除")
    if max(width, height) > MAX_LONGEST:
        raise ValueError(f"最长边不能超过 {MAX_LONGEST}")
    pixels = width * height
    if pixels < MIN_PIXELS:
        raise ValueError(f"总像素至少 {(MIN_PIXELS / 1e6):.2f} MP")
    if pixels > MAX_PIXELS:
        raise ValueError(f"总像素不能超过 {(MAX_PIXELS / 1e6):.2f} MP")


def parse_quality(value: str) -> str:
    quality = (value or DEFAULT_QUALITY).strip().lower()
    if quality not in {"low", "medium", "high", "auto"}:
        raise ValueError("quality 仅支持 low / medium / high / auto")
    return quality


def parse_moderation(value: str) -> str:
    moderation = (value or DEFAULT_MODERATION).strip().lower()
    if moderation not in {"auto", "low"}:
        raise ValueError("moderation 仅支持 auto / low")
    return moderation


def parse_batch_mode(value: str) -> str:
    batch_mode = (value or DEFAULT_BATCH_MODE).strip().lower()
    if batch_mode not in {"fanout", "direct"}:
        raise ValueError("多图模式仅支持 fanout / direct")
    return batch_mode


def parse_preview_count(value: Any) -> int:
    try:
        count = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("预览图个数仅支持 0 / 1 / 2 / 3") from exc
    if count < 0 or count > 3:
        raise ValueError("预览图个数仅支持 0 / 1 / 2 / 3")
    return count


def parse_image_count(value: Any) -> int:
    try:
        count = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("生图数量必须是 1 到 4 的整数") from exc
    if count < 1 or count > MAX_IMAGE_COUNT:
        raise ValueError(f"生图数量必须在 1 到 {MAX_IMAGE_COUNT} 之间")
    return count


def normalize_model(value: str | None) -> str:
    model = (value or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    if model.startswith(("http://", "https://")):
        raise ValueError("Model 不能是 URL，可能把 API Base URL 填到了 Model 一栏")
    return model


def normalize_api_key(value: str) -> str:
    api_key = (value or "").strip()
    if not api_key:
        raise ValueError("请填写 API Key")
    if api_key.startswith(("http://", "https://")):
        raise ValueError("API Key 不能是 URL，可能把 API Base URL 填到了 API Key 一栏")
    return api_key


def normalize_stored_api_key(value: str | None) -> str:
    api_key = (value or "").strip()
    if api_key.startswith(("http://", "https://")):
        raise ValueError("API Key 不能是 URL，可能把 API Base URL 填到了 API Key 一栏")
    return api_key


def uses_direct_images_api(model: str | None) -> bool:
    return normalize_model(model).lower().startswith("gpt-image-")


def to_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def from_json(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def file_url(relpath: str | None, version: int | str | None = None) -> str | None:
    if not relpath:
        return None
    url = "/files/" + relpath.replace("\\", "/")
    if version is not None and version != "":
        url += f"?v={version}"
    return url


def file_version(relpath: str | None) -> int | None:
    if not relpath:
        return None
    path = FILES_DIR / relpath
    try:
        return path.stat().st_mtime_ns
    except FileNotFoundError:
        return None


def versioned_file_url(relpath: str | None) -> str | None:
    return file_url(relpath, file_version(relpath))


def is_preview_relpath(relpath: str | None) -> bool:
    if not relpath:
        return False
    return Path(relpath).name.startswith("preview-")


def effective_terminal_status(status: str, final_count: int) -> str:
    if status in {"succeeded", "cancelled"} and final_count <= 0:
        return "failed"
    return status


def is_preview_file_url(url: str | None) -> bool:
    if not url:
        return False
    path = url.split("?", 1)[0]
    return Path(path).name.startswith("preview-")


def thumb_file_url(relpath: str | None, version: int | str | None = None) -> str | None:
    if not relpath:
        return None
    url = "/thumbs/" + relpath.replace("\\", "/")
    if version is not None and version != "":
        url += f"?v={version}"
    return url


def thumb_cache_relpath(source_relpath: str, *, size: int = 320) -> str:
    version = file_version(source_relpath) or 0
    digest = hashlib.sha1(f"{source_relpath}:{version}:{size}".encode("utf-8")).hexdigest()
    return f"{size}/{digest[:2]}/{digest}.webp"


def ensure_thumbnail(source_relpath: str | None, *, size: int = 320) -> str | None:
    if not source_relpath:
        return None
    source_path = FILES_DIR / source_relpath
    if not source_path.exists():
        return None
    if Image is None or ImageOps is None:
        return None
    thumb_relpath = thumb_cache_relpath(source_relpath, size=size)
    thumb_path = THUMBS_DIR / thumb_relpath
    if thumb_path.exists():
        return thumb_relpath
    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(source_path) as img:
            normalized = ImageOps.exif_transpose(img)
            if normalized.mode not in {"RGB", "L"}:
                normalized = normalized.convert("RGB")
            elif normalized.mode == "L":
                normalized = normalized.convert("RGB")
            normalized.thumbnail((size, size))
            normalized.save(thumb_path, format="WEBP", quality=82, method=6)
        return thumb_relpath
    except (FileNotFoundError, OSError, UnidentifiedImageError):
        return None


def thumbnail_url_for_relpath(source_relpath: str | None, *, size: int = 320) -> str | None:
    thumb_relpath = ensure_thumbnail(source_relpath, size=size)
    if thumb_relpath:
        return thumb_file_url(thumb_relpath)
    return versioned_file_url(source_relpath)


def first_non_empty(items: list[str | None] | None) -> str | None:
    for item in items or []:
        if item:
            return item
    return None


def count_occupied_slots(
    primary_items: list[str | None] | None,
    fallback_items: list[str | None] | None,
    expected_n: int,
) -> int:
    total_slots = max(
        int(expected_n or 1),
        len(primary_items or []),
        len(fallback_items or []),
        1,
    )
    count = 0
    for idx in range(total_slots):
        primary = primary_items[idx] if primary_items and idx < len(primary_items) else ""
        fallback = fallback_items[idx] if fallback_items and idx < len(fallback_items) else ""
        if primary or fallback:
            count += 1
    return min(max(int(expected_n or 1), 1), count)


def count_final_slots(
    result_items: list[str | None] | None,
    preview_items: list[str | None] | None,
    expected_n: int,
) -> int:
    total_slots = max(
        int(expected_n or 1),
        len(result_items or []),
        len(preview_items or []),
        1,
    )
    count = 0
    for idx in range(total_slots):
        result_item = result_items[idx] if result_items and idx < len(result_items) else ""
        preview_item = preview_items[idx] if preview_items and idx < len(preview_items) else ""
        if not result_item:
            continue
        if is_preview_relpath(result_item):
            continue
        if preview_item and result_item == preview_item:
            continue
        count += 1
    return min(max(int(expected_n or 1), 1), count)


def first_final_relpath(
    result_items: list[str | None] | None,
    preview_items: list[str | None] | None,
) -> str | None:
    total_slots = max(
        len(result_items or []),
        len(preview_items or []),
        0,
    )
    for idx in range(total_slots):
        result_item = result_items[idx] if result_items and idx < len(result_items) else ""
        preview_item = preview_items[idx] if preview_items and idx < len(preview_items) else ""
        if not result_item:
            continue
        if is_preview_relpath(result_item):
            continue
        if preview_item and result_item == preview_item:
            continue
        return result_item
    return None


def count_final_file_urls(
    result_items: list[str | None] | None,
    preview_items: list[str | None] | None,
    expected_n: int,
) -> int:
    total_slots = max(
        int(expected_n or 1),
        len(result_items or []),
        len(preview_items or []),
        1,
    )
    count = 0
    for idx in range(total_slots):
        result_item = result_items[idx] if result_items and idx < len(result_items) else ""
        preview_item = preview_items[idx] if preview_items and idx < len(preview_items) else ""
        if not result_item:
            continue
        if is_preview_file_url(result_item):
            continue
        if preview_item and result_item == preview_item:
            continue
        count += 1
    return count


def normalize_slot_notes(items: list[Any] | None, size: int) -> list[str]:
    normalized: list[str] = []
    source = items or []
    for idx in range(size):
        value = source[idx] if idx < len(source) else ""
        normalized.append(value.strip() if isinstance(value, str) else "")
    return normalized


def normalize_slot_numbers(items: list[Any] | None, size: int) -> list[int]:
    normalized: list[int] = []
    source = items or []
    for idx in range(size):
        value = source[idx] if idx < len(source) else 0
        normalized.append(value if isinstance(value, int) and value >= 0 else 0)
    return normalized


class GenerateRequest(BaseModel):
    api_key: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    size: str = "1024x1024"
    n: int = 1
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    quality: str = DEFAULT_QUALITY
    moderation: str = DEFAULT_MODERATION
    batch_mode: str = DEFAULT_BATCH_MODE
    preview_count: int = DEFAULT_PREVIEW_COUNT


class FavoriteCreateRequest(BaseModel):
    job_id: str = Field(min_length=1)
    slot_index: int = Field(ge=0)


class FavoriteImportRequest(BaseModel):
    id: str | None = None
    jobId: str | None = None
    slotIndex: int = Field(default=0, ge=0)
    src: str = Field(min_length=1)
    prompt: str = ""
    type: str = "generate"
    label: str | None = None
    createdAt: int | None = None
    imageDataUrl: str | None = None


class SettingsProfileCreateRequest(BaseModel):
    name: str = ""
    clone_from_id: str | None = None


class SettingsProfileUpdateRequest(BaseModel):
    name: str = ""
    api_key: str = ""
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    quality: str = DEFAULT_QUALITY
    moderation: str = DEFAULT_MODERATION
    batch_mode: str = DEFAULT_BATCH_MODE
    preview_count: int = DEFAULT_PREVIEW_COUNT
    activate: bool = True


class SettingsProfileStore:
    def __init__(self, path: Path):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS settings_profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    api_key TEXT NOT NULL DEFAULT '',
                    base_url TEXT NOT NULL DEFAULT 'https://img-cn.65535.space/v1',
                    model TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
                    quality TEXT NOT NULL DEFAULT 'high',
                    moderation TEXT NOT NULL DEFAULT 'low',
                    batch_mode TEXT NOT NULL DEFAULT 'fanout',
                    preview_count INTEGER NOT NULL DEFAULT 3,
                    is_active INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(settings_profiles)").fetchall()}
            if "api_key" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN api_key TEXT NOT NULL DEFAULT ''")
            if "base_url" not in cols:
                conn.execute(
                    "ALTER TABLE settings_profiles ADD COLUMN base_url TEXT NOT NULL DEFAULT 'https://img-cn.65535.space/v1'"
                )
            if "model" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-5.4-mini'")
            if "quality" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN quality TEXT NOT NULL DEFAULT 'high'")
            if "moderation" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN moderation TEXT NOT NULL DEFAULT 'low'")
            if "batch_mode" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN batch_mode TEXT NOT NULL DEFAULT 'fanout'")
            if "preview_count" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN preview_count INTEGER NOT NULL DEFAULT 3")
            if "is_active" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0")
            if "created_at" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0")
            if "updated_at" not in cols:
                conn.execute("ALTER TABLE settings_profiles ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0")
            self._ensure_seeded(conn)
            conn.commit()

    def list_profiles(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM settings_profiles
                ORDER BY is_active DESC, created_at ASC, name COLLATE NOCASE ASC
                """
            ).fetchall()
        return [self._serialize(row) for row in rows]

    def get_profile(self, profile_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM settings_profiles WHERE id = ?", (profile_id,)).fetchone()
        return self._serialize(row) if row else None

    def get_active_profile(self) -> dict[str, Any]:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM settings_profiles
                WHERE is_active = 1
                ORDER BY updated_at DESC, created_at ASC
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                row = conn.execute(
                    """
                    SELECT * FROM settings_profiles
                    ORDER BY created_at ASC, name COLLATE NOCASE ASC
                    LIMIT 1
                    """
                ).fetchone()
                if row is None:
                    raise RuntimeError("settings_profiles 未初始化")
                conn.execute("UPDATE settings_profiles SET is_active = 0")
                conn.execute("UPDATE settings_profiles SET is_active = 1 WHERE id = ?", (row["id"],))
                conn.commit()
        return self._serialize(row)

    def create_profile(self, name: str = "", clone_from_id: str | None = None) -> dict[str, Any]:
        with self.connect() as conn:
            source = self._fetch_profile_row(conn, clone_from_id) if clone_from_id else None
            profile_id = uuid.uuid4().hex
            ts = now_ms()
            total = int(
                conn.execute("SELECT COUNT(*) AS count FROM settings_profiles").fetchone()["count"] or 0
            )
            profile_name = self._unique_name(conn, name, exclude_id=None, fallback=f"Profile {total + 1}")
            conn.execute("UPDATE settings_profiles SET is_active = 0")
            conn.execute(
                """
                INSERT INTO settings_profiles (
                    id, name, api_key, base_url, model, quality, moderation, batch_mode, preview_count,
                    is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    profile_id,
                    profile_name,
                    source["api_key"] if source else "",
                    source["base_url"] if source else DEFAULT_BASE_URL,
                    source["model"] if source else DEFAULT_MODEL,
                    source["quality"] if source else DEFAULT_QUALITY,
                    source["moderation"] if source else DEFAULT_MODERATION,
                    source["batch_mode"] if source else DEFAULT_BATCH_MODE,
                    parse_preview_count(source["preview_count"]) if source else DEFAULT_PREVIEW_COUNT,
                    1,
                    ts,
                    ts,
                ),
            )
            conn.commit()
        profile = self.get_profile(profile_id)
        if not profile:
            raise RuntimeError("新建 profile 失败")
        return profile

    def update_profile(
        self,
        profile_id: str,
        *,
        name: str,
        api_key: str,
        base_url: str,
        model: str,
        quality: str,
        moderation: str,
        batch_mode: str,
        preview_count: int,
        activate: bool = True,
    ) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = self._fetch_profile_row(conn, profile_id)
            if row is None:
                return None
            profile_name = self._unique_name(conn, name, exclude_id=profile_id, fallback=row["name"] or DEFAULT_PROFILE_NAME)
            ts = now_ms()
            if activate:
                conn.execute("UPDATE settings_profiles SET is_active = 0")
            conn.execute(
                """
                UPDATE settings_profiles
                SET name = ?, api_key = ?, base_url = ?, model = ?, quality = ?, moderation = ?,
                    batch_mode = ?, preview_count = ?, is_active = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    profile_name,
                    api_key,
                    base_url,
                    model,
                    quality,
                    moderation,
                    batch_mode,
                    preview_count,
                    1 if activate else int(row["is_active"] or 0),
                    ts,
                    profile_id,
                ),
            )
            conn.commit()
        return self.get_profile(profile_id)

    def activate_profile(self, profile_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = self._fetch_profile_row(conn, profile_id)
            if row is None:
                return None
            conn.execute("UPDATE settings_profiles SET is_active = 0")
            conn.execute(
                "UPDATE settings_profiles SET is_active = 1, updated_at = ? WHERE id = ?",
                (now_ms(), profile_id),
            )
            conn.commit()
        return self.get_profile(profile_id)

    def delete_profile(self, profile_id: str) -> dict[str, Any]:
        with self.connect() as conn:
            row = self._fetch_profile_row(conn, profile_id)
            if row is None:
                raise ValueError("Profile 不存在")
            total = int(
                conn.execute("SELECT COUNT(*) AS count FROM settings_profiles").fetchone()["count"] or 0
            )
            if total <= 1:
                raise ValueError("至少保留一个 profile")
            conn.execute("DELETE FROM settings_profiles WHERE id = ?", (profile_id,))
            next_row = conn.execute(
                """
                SELECT * FROM settings_profiles
                ORDER BY is_active DESC, created_at ASC, name COLLATE NOCASE ASC
                LIMIT 1
                """
            ).fetchone()
            if next_row is None:
                raise RuntimeError("删除 profile 后未找到剩余 profile")
            conn.execute("UPDATE settings_profiles SET is_active = 0")
            conn.execute(
                "UPDATE settings_profiles SET is_active = 1, updated_at = ? WHERE id = ?",
                (now_ms(), next_row["id"]),
            )
            conn.commit()
        return self.get_active_profile()

    def _ensure_seeded(self, conn: sqlite3.Connection) -> None:
        row = conn.execute("SELECT COUNT(*) AS count FROM settings_profiles").fetchone()
        count = int(row["count"] or 0)
        if count <= 0:
            ts = now_ms()
            conn.execute(
                """
                INSERT INTO settings_profiles (
                    id, name, api_key, base_url, model, quality, moderation, batch_mode, preview_count,
                    is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    DEFAULT_PROFILE_NAME,
                    "",
                    DEFAULT_BASE_URL,
                    DEFAULT_MODEL,
                    DEFAULT_QUALITY,
                    DEFAULT_MODERATION,
                    DEFAULT_BATCH_MODE,
                    DEFAULT_PREVIEW_COUNT,
                    1,
                    ts,
                    ts,
                ),
            )
            return
        active_count = int(
            conn.execute("SELECT COUNT(*) AS count FROM settings_profiles WHERE is_active = 1").fetchone()["count"] or 0
        )
        if active_count <= 0:
            first = conn.execute(
                """
                SELECT id FROM settings_profiles
                ORDER BY created_at ASC, name COLLATE NOCASE ASC
                LIMIT 1
                """
            ).fetchone()
            if first:
                conn.execute("UPDATE settings_profiles SET is_active = 0")
                conn.execute("UPDATE settings_profiles SET is_active = 1 WHERE id = ?", (first["id"],))

    def _fetch_profile_row(self, conn: sqlite3.Connection, profile_id: str | None) -> sqlite3.Row | None:
        if not profile_id:
            return None
        return conn.execute("SELECT * FROM settings_profiles WHERE id = ?", (profile_id,)).fetchone()

    def _unique_name(
        self,
        conn: sqlite3.Connection,
        requested: str,
        *,
        exclude_id: str | None,
        fallback: str,
    ) -> str:
        base = (requested or "").strip() or fallback
        rows = conn.execute("SELECT id, name FROM settings_profiles").fetchall()
        taken = {
            str(row["name"]).strip().casefold()
            for row in rows
            if row["name"] and row["id"] != exclude_id
        }
        if base.casefold() not in taken:
            return base
        idx = 2
        while True:
            candidate = f"{base} ({idx})"
            if candidate.casefold() not in taken:
                return candidate
            idx += 1

    def _serialize(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"] or DEFAULT_PROFILE_NAME,
            "api_key": row["api_key"] or "",
            "base_url": row["base_url"] or DEFAULT_BASE_URL,
            "model": row["model"] or DEFAULT_MODEL,
            "quality": row["quality"] or DEFAULT_QUALITY,
            "moderation": row["moderation"] or DEFAULT_MODERATION,
            "batch_mode": row["batch_mode"] or DEFAULT_BATCH_MODE,
            "preview_count": parse_preview_count(row["preview_count"] if row["preview_count"] is not None else DEFAULT_PREVIEW_COUNT),
            "is_active": bool(row["is_active"]),
            "created_at": int(row["created_at"] or 0),
            "updated_at": int(row["updated_at"] or 0),
        }


class FavoriteStore:
    def __init__(self, path: Path):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS favorites (
                    id TEXT PRIMARY KEY,
                    job_id TEXT,
                    slot_index INTEGER NOT NULL,
                    prompt TEXT NOT NULL,
                    type TEXT NOT NULL,
                    label TEXT,
                    size TEXT,
                    image_count INTEGER NOT NULL DEFAULT 1,
                    image_relpath TEXT NOT NULL,
                    source_relpaths TEXT NOT NULL,
                    mask_relpath TEXT,
                    archived INTEGER NOT NULL DEFAULT 0,
                    archived_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(favorites)").fetchall()}
            if "archived" not in cols:
                conn.execute("ALTER TABLE favorites ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
            if "archived_at" not in cols:
                conn.execute("ALTER TABLE favorites ADD COLUMN archived_at INTEGER")
            conn.commit()

    def list_favorites(self, *, archived: bool | None = False) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if archived is None:
                rows = conn.execute(
                    "SELECT * FROM favorites ORDER BY created_at DESC, updated_at DESC"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM favorites WHERE archived = ? ORDER BY created_at DESC, updated_at DESC",
                    (1 if archived else 0,),
                ).fetchall()
        return [self._serialize(row) for row in rows]

    def get_favorite(self, favorite_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM favorites WHERE id = ?", (favorite_id,)).fetchone()
        return self._serialize(row) if row else None

    def save_favorite(self, record: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO favorites (
                    id, job_id, slot_index, prompt, type, label, size, image_count,
                    image_relpath, source_relpaths, mask_relpath, archived, archived_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    job_id = excluded.job_id,
                    slot_index = excluded.slot_index,
                    prompt = excluded.prompt,
                    type = excluded.type,
                    label = excluded.label,
                    size = excluded.size,
                    image_count = excluded.image_count,
                    image_relpath = excluded.image_relpath,
                    source_relpaths = excluded.source_relpaths,
                    mask_relpath = excluded.mask_relpath,
                    archived = 0,
                    archived_at = NULL,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                (
                    record["id"],
                    record.get("job_id"),
                    record["slot_index"],
                    record.get("prompt") or "",
                    record.get("type") or "generate",
                    record.get("label"),
                    record.get("size"),
                    record.get("image_count", 1),
                    record["image_relpath"],
                    to_json(record.get("source_relpaths", [])),
                    record.get("mask_relpath"),
                    0,
                    None,
                    record["created_at"],
                    record["updated_at"],
                ),
            )
            conn.commit()

    def archive_favorite(self, favorite_id: str) -> dict[str, Any] | None:
        favorite = self.get_favorite(favorite_id)
        if not favorite:
            return None
        with self.connect() as conn:
            conn.execute(
                "UPDATE favorites SET archived = 1, archived_at = ?, updated_at = ? WHERE id = ?",
                (now_ms(), now_ms(), favorite_id),
            )
            conn.commit()
        return favorite

    def archive_all_favorites(self) -> list[dict[str, Any]]:
        favorites = self.list_favorites()
        with self.connect() as conn:
            conn.execute(
                "UPDATE favorites SET archived = 1, archived_at = ?, updated_at = ? WHERE archived = 0",
                (now_ms(), now_ms()),
            )
            conn.commit()
        return favorites

    def restore_favorite(self, favorite_id: str) -> dict[str, Any] | None:
        favorite = self.get_favorite(favorite_id)
        if not favorite:
            return None
        with self.connect() as conn:
            conn.execute(
                "UPDATE favorites SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?",
                (now_ms(), favorite_id),
            )
            conn.commit()
        return self.get_favorite(favorite_id)

    def count_favorites(self, *, archived: bool | None = None) -> int:
        with self.connect() as conn:
            if archived is None:
                row = conn.execute("SELECT COUNT(*) AS count FROM favorites").fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS count FROM favorites WHERE archived = ?",
                    (1 if archived else 0,),
                ).fetchone()
        return int(row["count"] or 0)

    def _serialize(self, row: sqlite3.Row) -> dict[str, Any]:
        job_id = row["job_id"] or None
        source_relpaths = from_json(row["source_relpaths"], [])
        return {
            "id": row["id"],
            "job_id": job_id,
            "slot_index": int(row["slot_index"]),
            "job_slot_key": f"{job_id}:{int(row['slot_index'])}" if job_id else row["id"],
            "prompt": row["prompt"] or "",
            "type": row["type"] or "generate",
            "label": row["label"] or "",
            "size": row["size"] or "",
            "n": int(row["image_count"] or 1),
            "image_url": versioned_file_url(row["image_relpath"]),
            "source_urls": [versioned_file_url(item) for item in source_relpaths if item],
            "mask_url": versioned_file_url(row["mask_relpath"]),
            "archived": bool(row["archived"]),
            "archived_at": int(row["archived_at"]) if row["archived_at"] else None,
            "created_at": int(row["created_at"]),
            "updated_at": int(row["updated_at"]),
            "job_available": bool(job_id and store.get_job(job_id)),
        }


class JobStore:
    def __init__(self, path: Path):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    size TEXT NOT NULL,
                    model TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    quality TEXT NOT NULL DEFAULT 'high',
                    moderation TEXT NOT NULL DEFAULT 'low',
                    batch_mode TEXT NOT NULL DEFAULT 'fanout',
                    preview_count INTEGER NOT NULL DEFAULT 3,
                    revised_prompt TEXT,
                    progress_message TEXT,
                    debug_log TEXT,
                    error_message TEXT,
                    image_count INTEGER NOT NULL DEFAULT 1,
                    preview_relpath TEXT,
                    result_relpath TEXT,
                    preview_relpaths TEXT,
                    result_relpaths TEXT,
                    slot_errors TEXT,
                    slot_revised_prompts TEXT,
                    slot_preview_phases TEXT,
                    source_relpaths TEXT NOT NULL,
                    mask_relpath TEXT,
                    trashed INTEGER NOT NULL DEFAULT 0,
                    trashed_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    duration_ms INTEGER
                )
                """
            )
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
            if "debug_log" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN debug_log TEXT")
            if "quality" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN quality TEXT NOT NULL DEFAULT 'high'")
            if "moderation" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN moderation TEXT NOT NULL DEFAULT 'low'")
            if "batch_mode" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN batch_mode TEXT NOT NULL DEFAULT 'fanout'")
            if "preview_count" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN preview_count INTEGER NOT NULL DEFAULT 3")
            if "revised_prompt" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN revised_prompt TEXT")
            if "image_count" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN image_count INTEGER NOT NULL DEFAULT 1")
            if "preview_relpaths" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN preview_relpaths TEXT")
            if "result_relpaths" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN result_relpaths TEXT")
            if "slot_errors" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN slot_errors TEXT")
            if "slot_revised_prompts" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN slot_revised_prompts TEXT")
            if "slot_preview_phases" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN slot_preview_phases TEXT")
            if "trashed" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0")
            if "trashed_at" not in cols:
                conn.execute("ALTER TABLE jobs ADD COLUMN trashed_at INTEGER")
            conn.commit()

    def create_job(self, record: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, type, status, prompt, size, model, base_url, quality, moderation, batch_mode, preview_count, revised_prompt,
                    progress_message, debug_log, error_message, image_count, preview_relpath, result_relpath,
                    preview_relpaths, result_relpaths, slot_errors, slot_revised_prompts, slot_preview_phases,
                    source_relpaths, mask_relpath, created_at, updated_at, completed_at, duration_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["type"],
                    record["status"],
                    record["prompt"],
                    record["size"],
                    record["model"],
                    record["base_url"],
                    record["quality"],
                    record["moderation"],
                    record["batch_mode"],
                    record["preview_count"],
                    record.get("revised_prompt"),
                    record.get("progress_message"),
                    to_json(record.get("debug_log", [])),
                    record.get("error_message"),
                    record.get("image_count", 1),
                    record.get("preview_relpath"),
                    record.get("result_relpath"),
                    to_json(record.get("preview_relpaths", [])),
                    to_json(record.get("result_relpaths", [])),
                    to_json(record.get("slot_errors", [])),
                    to_json(record.get("slot_revised_prompts", [])),
                    to_json(record.get("slot_preview_phases", [])),
                    to_json(record.get("source_relpaths", [])),
                    record.get("mask_relpath"),
                    record["created_at"],
                    record["updated_at"],
                    record.get("completed_at"),
                    record.get("duration_ms"),
                ),
            )
            conn.commit()

    def update_job(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        fields.setdefault("updated_at", now_ms())
        assignments = []
        values = []
        for key, value in fields.items():
            if key in {
                "source_relpaths",
                "preview_relpaths",
                "result_relpaths",
                "slot_errors",
                "slot_revised_prompts",
                "slot_preview_phases",
            }:
                value = to_json(value)
            assignments.append(f"{key} = ?")
            values.append(value)
        values.append(job_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE jobs SET {', '.join(assignments)} WHERE id = ?", values)
            conn.commit()

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._serialize(row) if row else None

    def _summary_where(
        self,
        *,
        trashed: bool | None = False,
        status: str | None = None,
        job_type: str | None = None,
        search: str = "",
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        if trashed is not None:
            clauses.append("trashed = ?")
            values.append(1 if trashed else 0)
        if status:
            clauses.append("status = ?")
            values.append(status)
        if job_type:
            clauses.append("type = ?")
            values.append(job_type)
        search_text = search.strip()
        if search_text:
            clauses.append("prompt LIKE ?")
            values.append(f"%{search_text}%")
        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return where_sql, values

    def list_job_summaries(
        self,
        limit: int = 32,
        *,
        offset: int = 0,
        trashed: bool | None = False,
        status: str | None = None,
        job_type: str | None = None,
        search: str = "",
    ) -> list[dict[str, Any]]:
        where_sql, values = self._summary_where(
            trashed=trashed,
            status=status,
            job_type=job_type,
            search=search,
        )
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM jobs {where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (*values, limit, offset),
            ).fetchall()
        return [self._serialize_summary(row) for row in rows]

    def count_job_summaries(
        self,
        *,
        trashed: bool | None = False,
        status: str | None = None,
        job_type: str | None = None,
        search: str = "",
    ) -> int:
        where_sql, values = self._summary_where(
            trashed=trashed,
            status=status,
            job_type=job_type,
            search=search,
        )
        with self.connect() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS count FROM jobs {where_sql}",
                values,
            ).fetchone()
        return int(row["count"] if row else 0)

    def list_jobs(self, limit: int = 200, *, trashed: bool | None = False) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if trashed is None:
                rows = conn.execute(
                    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM jobs WHERE trashed = ? ORDER BY created_at DESC LIMIT ?",
                    (1 if trashed else 0, limit),
                ).fetchall()
        return [self._serialize(row) for row in rows]

    def count_jobs(self, *, trashed: bool | None = False) -> int:
        with self.connect() as conn:
            if trashed is None:
                row = conn.execute("SELECT COUNT(*) AS count FROM jobs").fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS count FROM jobs WHERE trashed = ?",
                    (1 if trashed else 0,),
                ).fetchone()
        return int(row["count"])

    def repair_partial_success_jobs(self) -> int:
        repaired = 0
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM jobs WHERE status = 'failed'").fetchall()
            for row in rows:
                image_count = int(row["image_count"] or 1)
                preview_relpaths = from_json(row["preview_relpaths"], [])
                result_relpaths = from_json(row["result_relpaths"], [])
                if not preview_relpaths and row["preview_relpath"]:
                    preview_relpaths = [row["preview_relpath"]]
                if not result_relpaths and row["result_relpath"]:
                    result_relpaths = [row["result_relpath"]]
                success_count = count_final_slots(result_relpaths, preview_relpaths, image_count)
                if success_count <= 0:
                    continue
                progress_message = (
                    f"任务部分完成，成功生成 {success_count} / {image_count} 张"
                    if success_count < image_count
                    else f"任务完成，共生成 {success_count} 张"
                )
                items = from_json(row["debug_log"], [])
                items.append(
                    {
                        "ts": now_ms(),
                        "kind": "info",
                        "message": f"系统已自动修复历史任务状态：保留 {success_count} / {image_count} 张结果",
                    }
                )
                if len(items) > 200:
                    items = items[-200:]
                conn.execute(
                    """
                    UPDATE jobs
                    SET status = 'succeeded',
                        error_message = NULL,
                        progress_message = ?,
                        debug_log = ?,
                        preview_relpath = ?,
                        result_relpath = ?,
                        preview_relpaths = ?,
                        result_relpaths = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        progress_message,
                        to_json(items),
                        first_non_empty(preview_relpaths),
                        first_non_empty(result_relpaths),
                        to_json(preview_relpaths),
                        to_json(result_relpaths),
                        now_ms(),
                        row["id"],
                    ),
                )
                repaired += 1
            conn.commit()
        return repaired

    def normalize_zero_final_terminal_jobs(self) -> int:
        normalized = 0
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM jobs WHERE status IN ('succeeded', 'cancelled')").fetchall()
            for row in rows:
                image_count = int(row["image_count"] or 1)
                preview_relpaths = from_json(row["preview_relpaths"], [])
                result_relpaths = from_json(row["result_relpaths"], [])
                if not preview_relpaths and row["preview_relpath"]:
                    preview_relpaths = [row["preview_relpath"]]
                if not result_relpaths and row["result_relpath"]:
                    result_relpaths = [row["result_relpath"]]
                final_count = count_final_slots(result_relpaths, preview_relpaths, image_count)
                if final_count > 0:
                    continue
                items = from_json(row["debug_log"], [])
                items.append(
                    {
                        "ts": now_ms(),
                        "kind": "warn",
                        "message": "系统已自动修正任务状态：无最终图输出，按失败处理",
                    }
                )
                if len(items) > 200:
                    items = items[-200:]
                conn.execute(
                    """
                    UPDATE jobs
                    SET status = 'failed',
                        error_message = ?,
                        progress_message = '任务失败',
                        debug_log = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        "任务已结束，未生成最终图" if row["status"] == "cancelled" else (row["error_message"] or "未生成最终图"),
                        to_json(items),
                        now_ms(),
                        row["id"],
                    ),
                )
                normalized += 1
            conn.commit()
        return normalized

    def fail_incomplete_jobs(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE jobs
                SET status = 'failed',
                    error_message = '服务端重启，未完成任务已中止',
                    progress_message = '任务中止',
                    updated_at = ?,
                    completed_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (now_ms(), now_ms()),
            )
            conn.commit()

    def trash_job(self, job_id: str) -> dict[str, Any] | None:
        job = self.get_job(job_id)
        if not job:
            return None
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ?",
                (now_ms(), now_ms(), job_id),
            )
            conn.commit()
        return self.get_job(job_id)

    def restore_job(self, job_id: str) -> dict[str, Any] | None:
        job = self.get_job(job_id)
        if not job:
            return None
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ?",
                (now_ms(), job_id),
            )
            conn.commit()
        return self.get_job(job_id)

    def purge_jobs(self, *, status: str | None = None, trashed: bool | None = None) -> list[dict[str, Any]]:
        jobs = self.list_jobs(limit=10_000, trashed=trashed)
        if status:
            jobs = [job for job in jobs if job["status"] == status]
        with self.connect() as conn:
            if status and trashed is None:
                conn.execute("DELETE FROM jobs WHERE status = ?", (status,))
            elif status and trashed is not None:
                conn.execute("DELETE FROM jobs WHERE status = ? AND trashed = ?", (status, 1 if trashed else 0))
            elif trashed is None:
                conn.execute("DELETE FROM jobs")
            else:
                conn.execute("DELETE FROM jobs WHERE trashed = ?", (1 if trashed else 0,))
            conn.commit()
        return jobs

    def append_debug_log(self, job_id: str, message: str, kind: str = "info") -> None:
        with self.connect() as conn:
            row = conn.execute("SELECT debug_log FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                return
            items = from_json(row["debug_log"], [])
            items.append(
                {
                    "ts": now_ms(),
                    "kind": kind,
                    "message": message,
                }
            )
            if len(items) > 200:
                items = items[-200:]
            conn.execute(
                "UPDATE jobs SET debug_log = ?, updated_at = ? WHERE id = ?",
                (to_json(items), now_ms(), job_id),
            )
            conn.commit()

    def _serialize_summary(self, row: sqlite3.Row) -> dict[str, Any]:
        source_relpaths = from_json(row["source_relpaths"], [])
        preview_relpaths = from_json(row["preview_relpaths"], [])
        result_relpaths = from_json(row["result_relpaths"], [])
        image_count = int(row["image_count"] or 1)
        if not preview_relpaths and row["preview_relpath"]:
            preview_relpaths = [row["preview_relpath"]]
        if not result_relpaths and row["result_relpath"]:
            result_relpaths = [row["result_relpath"]]
        primary_source = first_non_empty(source_relpaths)
        primary_preview = first_non_empty(preview_relpaths)
        final_count = count_final_slots(result_relpaths, preview_relpaths, image_count)
        status = effective_terminal_status(str(row["status"] or ""), final_count)
        primary_result = first_final_relpath(result_relpaths, preview_relpaths)
        if status == "failed":
            thumb_relpath = primary_source or primary_preview or primary_result
        else:
            thumb_relpath = primary_result or primary_preview or primary_source
        prompt = str(row["prompt"] or "").strip()
        rendered_count = count_occupied_slots(result_relpaths, preview_relpaths, image_count)
        return {
            "id": row["id"],
            "type": row["type"],
            "status": status,
            "prompt": prompt[:180],
            "n": image_count,
            "preview_count": parse_preview_count(row["preview_count"] if row["preview_count"] is not None else DEFAULT_PREVIEW_COUNT),
            "final_count": final_count,
            "rendered_count": rendered_count,
            "trashed": bool(row["trashed"]),
            "created_at": int(row["created_at"]),
            "updated_at": int(row["updated_at"]),
            "thumb_url": thumbnail_url_for_relpath(thumb_relpath, size=320),
        }

    def _serialize(self, row: sqlite3.Row) -> dict[str, Any]:
        updated_at = int(row["updated_at"])
        source_relpaths = from_json(row["source_relpaths"], [])
        debug_log = from_json(row["debug_log"], [])
        preview_relpaths = from_json(row["preview_relpaths"], [])
        result_relpaths = from_json(row["result_relpaths"], [])
        image_count = int(row["image_count"] or 1)
        slot_errors = normalize_slot_notes(from_json(row["slot_errors"], []), image_count)
        slot_revised_prompts = normalize_slot_notes(from_json(row["slot_revised_prompts"], []), image_count)
        slot_preview_phases = normalize_slot_numbers(from_json(row["slot_preview_phases"], []), image_count)
        if not preview_relpaths and row["preview_relpath"]:
            preview_relpaths = [row["preview_relpath"]]
        if not result_relpaths and row["result_relpath"]:
            result_relpaths = [row["result_relpath"]]
        final_count = count_final_slots(result_relpaths, preview_relpaths, image_count)
        status = effective_terminal_status(str(row["status"] or ""), final_count)
        preview_urls = [versioned_file_url(item) if item else None for item in preview_relpaths]
        result_urls = [versioned_file_url(item) if item else None for item in result_relpaths]
        primary_preview_url = next((item for item in preview_urls if item), None)
        primary_result_relpath = first_final_relpath(result_relpaths, preview_relpaths)
        primary_result_url = versioned_file_url(primary_result_relpath) if primary_result_relpath else None
        return {
            "id": row["id"],
            "type": row["type"],
            "status": status,
            "prompt": row["prompt"],
            "size": row["size"],
            "n": image_count,
            "model": row["model"],
            "base_url": row["base_url"],
            "quality": row["quality"] or DEFAULT_QUALITY,
            "moderation": row["moderation"] or DEFAULT_MODERATION,
            "batch_mode": row["batch_mode"] or DEFAULT_BATCH_MODE,
            "preview_count": parse_preview_count(row["preview_count"] if row["preview_count"] is not None else DEFAULT_PREVIEW_COUNT),
            "revised_prompt": row["revised_prompt"],
            "progress_message": row["progress_message"],
            "debug_log": debug_log,
            "error_message": row["error_message"],
            "preview_url": primary_preview_url or versioned_file_url(row["preview_relpath"]),
            "result_url": primary_result_url or versioned_file_url(row["result_relpath"]),
            "preview_urls": preview_urls,
            "result_urls": result_urls,
            "slot_errors": slot_errors,
            "slot_revised_prompts": slot_revised_prompts,
            "slot_preview_phases": slot_preview_phases,
            "source_urls": [versioned_file_url(item) for item in source_relpaths],
            "mask_url": versioned_file_url(row["mask_relpath"]),
            "trashed": bool(row["trashed"]),
            "trashed_at": int(row["trashed_at"]) if row["trashed_at"] else None,
            "created_at": int(row["created_at"]),
            "updated_at": updated_at,
            "completed_at": int(row["completed_at"]) if row["completed_at"] else None,
            "duration_ms": row["duration_ms"],
        }


store = JobStore(DB_PATH)
favorites_store = FavoriteStore(DB_PATH)
settings_store = SettingsProfileStore(DB_PATH)

# `StaticFiles(...)` validates directories at import time, so these
# paths must exist before the app mounts are created.
ensure_dirs()


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init()
    favorites_store.init()
    settings_store.init()
    store.fail_incomplete_jobs()
    store.repair_partial_success_jobs()
    store.normalize_zero_final_terminal_jobs()
    app.state.job_secrets = {}
    app.state.active_tasks = {}
    app.state.job_semaphore = asyncio.Semaphore(2)
    yield


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/files", StaticFiles(directory=FILES_DIR), name="files")
app.mount("/thumbs", StaticFiles(directory=THUMBS_DIR), name="thumbs")


def save_bytes(job_id: str, relative_name: str, content: bytes) -> str:
    target = FILES_DIR / job_id / relative_name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return str(target.relative_to(FILES_DIR))


async def save_upload(job_id: str, category: str, upload: UploadFile, fallback_name: str) -> str:
    filename = escape_filename(upload.filename or fallback_name, fallback_name)
    target = FILES_DIR / job_id / category / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    content = await upload.read()
    target.write_bytes(content)
    return str(target.relative_to(FILES_DIR))


def job_dir(job_id: str) -> Path:
    return FILES_DIR / job_id


def relpath_from_file_url(url: str | None) -> str | None:
    if not url or not url.startswith("/files/"):
        return None
    return url.removeprefix("/files/").split("?", 1)[0]


def favorite_dir_name(favorite_id: str) -> str:
    return escape_filename(favorite_id, "favorite")


def favorite_dir(favorite_id: str) -> Path:
    return FAVORITES_ROOT / favorite_dir_name(favorite_id)


def favorite_relpath(favorite_id: str, relative_name: str) -> str:
    return str((Path("favorites") / favorite_dir_name(favorite_id) / relative_name).as_posix())


def copy_relpath_to_favorite(relpath: str | None, favorite_id: str, relative_name: str) -> str | None:
    if not relpath:
        return None
    src = FILES_DIR / relpath
    if not src.exists() or not src.is_file():
        return None
    target_relpath = favorite_relpath(favorite_id, relative_name)
    target = FILES_DIR / target_relpath
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, target)
    return target_relpath


def write_favorite_bytes(favorite_id: str, relative_name: str, content: bytes) -> str:
    target_relpath = favorite_relpath(favorite_id, relative_name)
    target = FILES_DIR / target_relpath
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return target_relpath


def build_settings_profiles_response() -> dict[str, Any]:
    active = settings_store.get_active_profile()
    return {
        "active_profile_id": active["id"],
        "items": settings_store.list_profiles(),
    }


def decode_data_url_image(data_url: str | None) -> tuple[bytes, str] | None:
    if not data_url or not isinstance(data_url, str):
        return None
    if not data_url.startswith("data:") or "," not in data_url:
        return None
    header, payload = data_url.split(",", 1)
    if ";base64" not in header:
        return None
    mime = header[5:].split(";", 1)[0] or "image/png"
    try:
        return base64.b64decode(payload), mime
    except Exception:
        return None


def create_favorite_snapshot(
    *,
    favorite_id: str,
    job_id: str | None,
    slot_index: int,
    prompt: str,
    job_type: str,
    label: str,
    size: str,
    image_count: int,
    image_relpath: str | None = None,
    image_data_url: str | None = None,
    source_relpaths: list[str] | None = None,
    mask_relpath: str | None = None,
    created_at: int | None = None,
) -> dict[str, Any]:
    shutil.rmtree(favorite_dir(favorite_id), ignore_errors=True)
    copied_image = copy_relpath_to_favorite(image_relpath, favorite_id, "image.png") if image_relpath else None
    if not copied_image and image_data_url:
        decoded = decode_data_url_image(image_data_url)
        if decoded:
            content, mime = decoded
            ext = mimetypes.guess_extension(mime) or ".png"
            if ext == ".jpe":
                ext = ".jpg"
            copied_image = write_favorite_bytes(favorite_id, f"image{ext}", content)
    if not copied_image:
        raise FileNotFoundError("收藏图片文件不存在")

    copied_sources: list[str] = []
    for idx, relpath in enumerate(source_relpaths or [], start=1):
        copied = copy_relpath_to_favorite(relpath, favorite_id, f"source-{idx}.png")
        if copied:
            copied_sources.append(copied)

    copied_mask = copy_relpath_to_favorite(mask_relpath, favorite_id, "mask.png") if mask_relpath else None
    ts = now_ms()
    record = {
        "id": favorite_id,
        "job_id": job_id,
        "slot_index": slot_index,
        "prompt": prompt or "",
        "type": job_type or "generate",
        "label": label or f"最终图 {slot_index + 1}",
        "size": size or "",
        "image_count": image_count or 1,
        "image_relpath": copied_image,
        "source_relpaths": copied_sources,
        "mask_relpath": copied_mask,
        "created_at": created_at or ts,
        "updated_at": ts,
    }
    favorites_store.save_favorite(record)
    return favorites_store.get_favorite(favorite_id) or record


def make_job_record(
    *,
    job_id: str,
    job_type: str,
    prompt: str,
    size: str,
    model: str,
    base_url: str,
    quality: str,
    moderation: str,
    batch_mode: str,
    preview_count: int,
    image_count: int,
    source_relpaths: list[str] | None = None,
    mask_relpath: str | None = None,
) -> dict[str, Any]:
    ts = now_ms()
    return {
        "id": job_id,
        "type": job_type,
        "status": "queued",
        "prompt": prompt,
        "size": size,
        "model": model,
        "base_url": base_url,
        "quality": quality,
        "moderation": moderation,
        "batch_mode": batch_mode,
        "preview_count": preview_count,
        "image_count": image_count,
        "revised_prompt": None,
        "progress_message": "任务已提交，排队中…",
        "debug_log": [{"ts": ts, "kind": "info", "message": "任务已提交，排队中…"}],
        "preview_relpaths": [],
        "result_relpaths": [],
        "slot_errors": [""] * image_count,
        "slot_revised_prompts": [""] * image_count,
        "slot_preview_phases": [0] * image_count,
        "source_relpaths": source_relpaths or [],
        "mask_relpath": mask_relpath,
        "created_at": ts,
        "updated_at": ts,
    }


def enqueue_job(job_id: str) -> None:
    task = asyncio.create_task(process_job(job_id))
    app.state.active_tasks[job_id] = task

    def _cleanup(done_task: asyncio.Task) -> None:
        app.state.active_tasks.pop(job_id, None)
        try:
            done_task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    task.add_done_callback(_cleanup)


def mark_job_cancelled(job_id: str, message: str = "任务已主动结束") -> dict[str, Any] | None:
    job = store.get_job(job_id)
    if not job:
        return None
    slot_errors = normalize_slot_notes(job.get("slot_errors"), job["n"])
    result_urls = job.get("result_urls") or ([job.get("result_url")] if job.get("result_url") else [])
    preview_urls = job.get("preview_urls") or ([job.get("preview_url")] if job.get("preview_url") else [])
    final_count = count_final_file_urls(result_urls, preview_urls, int(job.get("n") or 1))
    for idx in range(job["n"]):
        final_url = result_urls[idx] if idx < len(result_urls) else ""
        preview_url = preview_urls[idx] if idx < len(preview_urls) else ""
        has_final = bool(final_url) and not is_preview_file_url(final_url) and not (preview_url and final_url == preview_url)
        if not has_final:
            slot_errors[idx] = message
    completed_at = now_ms()
    status = "cancelled" if final_count > 0 else "failed"
    error_message = message if status == "cancelled" else "任务已结束，未生成最终图"
    progress_message = message if status == "cancelled" else "任务失败"
    store.update_job(
        job_id,
        status=status,
        error_message=error_message,
        progress_message=progress_message,
        slot_errors=slot_errors,
        completed_at=completed_at,
    )
    return store.get_job(job_id)


def parse_upstream_error(content: bytes, status_code: int) -> str:
    try:
        payload = json.loads(content.decode("utf-8"))
        error = payload.get("error")
        if isinstance(error, dict):
            return error.get("message") or json.dumps(error, ensure_ascii=False)
        if error:
            return str(error)
        return json.dumps(payload, ensure_ascii=False)[:400]
    except Exception:
        text = content.decode("utf-8", errors="ignore").strip()
        return text[:400] or f"HTTP {status_code}"


def summarize_payload(payload: dict[str, Any]) -> str:
    keys = sorted(payload.keys())
    if not keys:
        return "空 payload"
    if len(keys) > 6:
        keys = keys[:6] + ["..."]
    return "payload keys: " + ", ".join(keys)


def summarize_event_payload(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    payload_type = payload.get("type")
    if payload_type:
        parts.append(f"type={payload_type}")
    status = payload.get("status")
    if status:
        parts.append(f"status={status}")
    keys = sorted(payload.keys())
    if keys:
        shown_keys = keys[:8] + (["..."] if len(keys) > 8 else [])
        parts.append("keys=" + ",".join(shown_keys))
    if isinstance(payload.get("error"), dict) and payload["error"].get("message"):
        parts.append("error=" + str(payload["error"]["message"])[:140])
    elif payload.get("message"):
        parts.append("message=" + str(payload["message"])[:140])
    return " | ".join(parts) if parts else "空 payload"


def summarize_request_payload(payload: dict[str, Any]) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False)
    except Exception:
        return str(payload)


def redact_large_strings(value: Any, *, max_len: int = 160) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if key in {"b64_json", "partial_image_b64", "image_b64", "result"} and isinstance(item, str):
                result[key] = f"<{key}:{len(item)} chars>"
            else:
                result[key] = redact_large_strings(item, max_len=max_len)
        return result
    if isinstance(value, list):
        return [redact_large_strings(item, max_len=max_len) for item in value[:8]]
    if isinstance(value, str) and len(value) > max_len:
        return value[:max_len] + "…"
    return value


def summarize_payload_details(payload: dict[str, Any]) -> str:
    try:
        return json.dumps(redact_large_strings(payload), ensure_ascii=False)
    except Exception:
        return str(redact_large_strings(payload))


def relpath_to_data_url(relpath: str) -> str:
    path = FILES_DIR / relpath
    content = path.read_bytes()
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    b64 = base64.b64encode(content).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def build_responses_image_request(
    *,
    main_model: str,
    prompt: str,
    action: str,
    size: str,
    quality: str,
    moderation: str,
    preview_count: int,
    image_count: int,
    input_image_relpaths: list[str] | None = None,
    mask_relpath: str | None = None,
) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
    for relpath in input_image_relpaths or []:
        content.append({"type": "input_image", "image_url": relpath_to_data_url(relpath)})

    tool: dict[str, Any] = {
        "type": "image_generation",
        "action": action,
        "model": DEFAULT_IMAGE_TOOL_MODEL,
        "partial_images": preview_count,
    }
    if size:
        tool["size"] = size
    if quality:
        tool["quality"] = quality
    if moderation:
        tool["moderation"] = moderation
    if image_count > 1:
        tool["n"] = image_count
    if mask_relpath:
        tool["input_image_mask"] = {"image_url": relpath_to_data_url(mask_relpath)}

    return {
        "model": normalize_model(main_model),
        "stream": True,
        "store": False,
        "reasoning": {"effort": DEFAULT_REASONING_EFFORT},
        "parallel_tool_calls": image_count > 1,
        "tool_choice": {"type": "image_generation"},
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": content,
            }
        ],
        "tools": [tool],
    }


def relpath_for_slot(job_id: str, kind: str, slot: int) -> str:
    return f"{job_id}/{kind}-{slot}.png"


def update_job_image_paths(
    job_id: str,
    *,
    preview_relpaths: list[str] | None = None,
    result_relpaths: list[str] | None = None,
    slot_errors: list[str] | None = None,
    slot_revised_prompts: list[str] | None = None,
    slot_preview_phases: list[int] | None = None,
    progress_message: str | None = None,
) -> None:
    fields: dict[str, Any] = {}
    if preview_relpaths is not None:
        fields["preview_relpaths"] = preview_relpaths
        fields["preview_relpath"] = first_non_empty(preview_relpaths)
    if result_relpaths is not None:
        fields["result_relpaths"] = result_relpaths
        fields["result_relpath"] = first_non_empty(result_relpaths)
    if slot_errors is not None:
        fields["slot_errors"] = slot_errors
    if slot_revised_prompts is not None:
        fields["slot_revised_prompts"] = slot_revised_prompts
    if slot_preview_phases is not None:
        fields["slot_preview_phases"] = slot_preview_phases
    if progress_message is not None:
        fields["progress_message"] = progress_message
    if fields:
        store.update_job(job_id, **fields)


def compact_relpaths(items: list[str]) -> list[str]:
    return [item for item in items if item]


def merge_result_slots(result_relpaths: list[str], preview_relpaths: list[str], expected_n: int) -> list[str]:
    merged: list[str] = []
    for idx in range(expected_n):
        result_item = result_relpaths[idx] if idx < len(result_relpaths) else ""
        preview_item = preview_relpaths[idx] if idx < len(preview_relpaths) else ""
        merged.append(result_item or preview_item or "")
    return merged


def extract_payload_images(payload: dict[str, Any]) -> list[tuple[int | None, str | None, str]]:
    items = payload.get("data") if isinstance(payload.get("data"), list) else None
    candidates = items if items is not None else [payload]
    images: list[tuple[int | None, str | None, str]] = []

    def append_image(item: dict[str, Any], *, fallback_index: int | None = None, fallback_key: str | None = None) -> bool:
        b64 = item.get("b64_json") or item.get("partial_image_b64") or item.get("image_b64") or item.get("result")
        if not isinstance(b64, str) or not b64:
            return False
        index = None
        index_key = None
        for key in ("index", "image_index", "output_index", "image_number", "partial_image_index"):
            raw = item.get(key)
            if isinstance(raw, int):
                index = raw
                index_key = key
                break
        if index is None:
            index = fallback_index
            index_key = fallback_key
        images.append((index, index_key, b64))
        return True

    for item in candidates:
        if not isinstance(item, dict):
            continue
        appended = append_image(item)
        if appended and images[-1][0] is None and item is not payload:
            for key in ("index", "image_index", "output_index", "image_number", "partial_image_index"):
                raw = payload.get(key)
                if isinstance(raw, int):
                    images[-1] = (raw, key, images[-1][2])
                    break

    response = payload.get("response")
    if isinstance(response, dict):
        output = response.get("output")
        if isinstance(output, list):
            for output_index, item in enumerate(output):
                if not isinstance(item, dict) or item.get("type") != "image_generation_call":
                    continue
                append_image(item, fallback_index=output_index, fallback_key="output_index")

    item = payload.get("item")
    if isinstance(item, dict) and item.get("type") == "image_generation_call":
        fallback_index = payload.get("output_index") if isinstance(payload.get("output_index"), int) else None
        append_image(item, fallback_index=fallback_index, fallback_key="output_index" if fallback_index is not None else None)
    return images


def is_final_image_payload(payload: dict[str, Any], last_event: str | None) -> bool:
    if (last_event and last_event.endswith(".completed")) or payload.get("type") == "response.completed":
        return True
    if payload.get("type") == "response.output_item.done":
        item = payload.get("item")
        if isinstance(item, dict) and item.get("type") == "image_generation_call":
            result = item.get("result")
            if isinstance(result, str) and result:
                return True
    return False


def normalize_slot(index: int | None, index_key: str | None, expected_n: int, next_slot: int) -> int:
    if isinstance(index, int):
        if index_key in {"partial_image_index", "image_index", "output_index"}:
            if 0 <= index < expected_n:
                return index + 1
        if index_key == "image_number":
            if 1 <= index <= expected_n:
                return index
        if 1 <= index <= expected_n:
            return index
        if 0 <= index < expected_n:
            return index + 1
    return min(next_slot, expected_n)


def extract_revised_prompt(payload: dict[str, Any]) -> str | None:
    value = payload.get("revised_prompt")
    if isinstance(value, str) and value.strip():
        return value.strip()

    data = payload.get("data")
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                value = item.get("revised_prompt")
                if isinstance(value, str) and value.strip():
                    return value.strip()

    response = payload.get("response")
    if isinstance(response, dict):
        output = response.get("output")
        if isinstance(output, list):
            for item in output:
                if not isinstance(item, dict):
                    continue
                value = item.get("revised_prompt")
                if isinstance(value, str) and value.strip():
                    return value.strip()
    item = payload.get("item")
    if isinstance(item, dict):
        value = item.get("revised_prompt")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def extract_partial_phase_index(payload: dict[str, Any]) -> int | None:
    raw = payload.get("partial_image_index")
    if isinstance(raw, int):
        return raw
    item = payload.get("item")
    if isinstance(item, dict):
        raw = item.get("partial_image_index")
        if isinstance(raw, int):
            return raw
    data = payload.get("data")
    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict):
                raw = entry.get("partial_image_index")
                if isinstance(raw, int):
                    return raw
    return None


def maybe_store_revised_prompt(
    job_id: str,
    original_prompt: str,
    payload: dict[str, Any],
    current_value: str | None,
    *,
    log_debug: Any | None = None,
) -> str | None:
    revised_prompt = extract_revised_prompt(payload)
    if not revised_prompt or revised_prompt == current_value:
        return current_value

    debug = log_debug or (lambda message, kind="response": store.append_debug_log(job_id, message, kind))
    store.update_job(job_id, revised_prompt=revised_prompt)
    if revised_prompt == original_prompt.strip():
        debug("上游返回 revised_prompt，与原始 prompt 一致", "response")
    else:
        debug(f"上游返回 revised_prompt: {revised_prompt[:300]}", "response")
    return revised_prompt


def failure_label(message: str) -> str:
    lower = (message or "").lower()
    if "rejected by the safety system" in lower or "safety_violations" in lower:
        return "安全拦截"
    if "timeout" in lower or "超时" in message:
        return "上游超时"
    http_marker = "http "
    if http_marker in lower:
        start = lower.find(http_marker)
        return message[start : start + 8].upper().strip()
    if "提前结束" in message:
        return "流提前结束"
    return "生成失败"


def summarize_slot_failures(slot_errors: list[str]) -> str:
    counts: dict[str, int] = {}
    for message in slot_errors:
        if not message:
            continue
        label = failure_label(message)
        counts[label] = counts.get(label, 0) + 1
    ordered = ["安全拦截", "上游超时", "流提前结束"]
    parts = [f"{label} {counts[label]} 路" for label in ordered if counts.get(label)]
    other_count = sum(value for key, value in counts.items() if key not in set(ordered))
    if other_count:
        parts.append(f"其它失败 {other_count} 路")
    return "；".join(parts)


async def run_stream_request(
    job_id: str,
    *,
    expected_n: int,
    total_slots: int | None = None,
    slot_start: int = 1,
    url: str,
    headers: dict[str, str],
    json_body: dict[str, Any] | None = None,
    data_body: dict[str, str] | None = None,
    file_specs: list[tuple[str, str, str]] | None = None,
    original_prompt: str,
    on_update: Any | None = None,
) -> tuple[list[str], str | None]:
    timeout = httpx.Timeout(connect=20.0, read=600.0, write=600.0, pool=20.0)
    result_relpaths: list[str] = []
    fallback_note: str | None = None
    slot_count = total_slots or expected_n
    debug_prefix = f"[槽位 {slot_start}/{slot_count}] " if expected_n == 1 and slot_count > 1 else ""

    def log_debug(message: str, kind: str = "info") -> None:
        store.append_debug_log(job_id, f"{debug_prefix}{message}", kind)

    async with httpx.AsyncClient(timeout=timeout) as client:
        if file_specs:
            log_debug(f"向上游发送 multipart 请求: {url}", "request")
            if data_body:
                log_debug(
                    f"请求参数: {summarize_request_payload(redact_large_strings(data_body))}",
                    "request",
                )
            files = []
            handles = []
            try:
                file_labels = []
                for field_name, relpath, content_type in file_specs:
                    path = FILES_DIR / relpath
                    handle = path.open("rb")
                    handles.append(handle)
                    files.append((field_name, (path.name, handle, content_type)))
                    file_labels.append({"field": field_name, "filename": path.name, "content_type": content_type})
                log_debug(
                    f"上传文件: {summarize_request_payload(file_labels)}",
                    "request",
                )
                async with client.stream(
                    "POST",
                    url,
                    headers=headers,
                    data=data_body,
                    files=files,
                ) as resp:
                    result_relpaths, fallback_note = await consume_stream_response(
                        job_id,
                        resp,
                        expected_n,
                        total_slots=slot_count,
                        slot_start=slot_start,
                        original_prompt=original_prompt,
                        on_update=on_update,
                        log_debug=log_debug,
                    )
            finally:
                for handle in handles:
                    handle.close()
        else:
            log_debug(f"向上游发送 JSON 请求: {url}", "request")
            if json_body:
                log_debug(
                    f"请求参数: {summarize_request_payload(redact_large_strings(json_body))}",
                    "request",
                )
            async with client.stream(
                "POST",
                url,
                headers=headers,
                json=json_body,
            ) as resp:
                result_relpaths, fallback_note = await consume_stream_response(
                    job_id,
                    resp,
                    expected_n,
                    total_slots=slot_count,
                    slot_start=slot_start,
                    original_prompt=original_prompt,
                    on_update=on_update,
                    log_debug=log_debug,
                )

    if not result_relpaths:
        detail = f"（{fallback_note}）" if fallback_note else ""
        raise RuntimeError(f"响应里没有图片数据{detail}")

    return result_relpaths, fallback_note


async def consume_stream_response(
    job_id: str,
    resp: httpx.Response,
    expected_n: int,
    *,
    total_slots: int,
    slot_start: int,
    original_prompt: str,
    on_update: Any | None = None,
    log_debug: Any | None = None,
) -> tuple[list[str], str | None]:
    slot_errors: list[str | None] = [None] * total_slots
    slot_revised_prompts: list[str | None] = [None] * total_slots
    slot_preview_phases: list[int | None] = [None] * total_slots

    async def publish_update(
        *,
        preview: list[str | None] | None = None,
        result: list[str | None] | None = None,
        errors: list[str | None] | None = None,
        revised_prompts: list[str | None] | None = None,
        preview_phases: list[int | None] | None = None,
        progress_message: str | None = None,
    ) -> None:
        if on_update:
            await on_update(preview, result, errors, revised_prompts, preview_phases, progress_message)
        else:
            update_job_image_paths(
                job_id,
                preview_relpaths=preview,
                result_relpaths=result,
                slot_errors=errors,
                slot_revised_prompts=revised_prompts,
                slot_preview_phases=preview_phases,
                progress_message=progress_message,
            )

    debug = log_debug or (lambda message, kind="info": store.append_debug_log(job_id, message, kind))
    if resp.status_code >= 400:
        body = await resp.aread()
        debug(f"上游返回 HTTP {resp.status_code}", "error")
        message = parse_upstream_error(body, resp.status_code)
        target_indexes = [slot_start - 1] if expected_n == 1 else [idx for idx in range(total_slots)]
        for idx in target_indexes:
            slot_errors[idx] = message
        await publish_update(
            errors=slot_errors,
            revised_prompts=slot_revised_prompts,
            preview_phases=slot_preview_phases,
            progress_message="部分请求失败，其他请求继续处理中…",
        )
        raise RuntimeError(message)

    content_type = resp.headers.get("content-type", "")
    debug(f"上游响应: HTTP {resp.status_code} · {content_type or 'unknown content-type'}", "response")
    last_event: str | None = None
    buffer = ""
    fallback_note: str | None = None
    last_payload_summary: str | None = None
    payload_count = 0
    chunk_count = 0
    total_chars = 0
    raw_line_count = 0
    revised_prompt: str | None = None
    preview_relpaths: list[str | None] = [None] * total_slots
    result_relpaths: list[str | None] = [None] * total_slots
    next_preview_slot = 1
    next_result_slot = 1

    if "text/event-stream" not in content_type:
        payload = json.loads((await resp.aread()).decode("utf-8"))
        debug("收到非流式 JSON 响应", "response")
        revised_prompt = maybe_store_revised_prompt(
            job_id,
            original_prompt,
            payload,
            revised_prompt,
            log_debug=debug,
        )
        for index, index_key, b64 in extract_payload_images(payload)[:expected_n]:
            slot = normalize_slot(index, index_key, expected_n, next_result_slot)
            next_result_slot = max(next_result_slot, min(slot + 1, expected_n))
            absolute_slot = slot_start + slot - 1
            relpath = relpath_for_slot(job_id, "result", absolute_slot)
            save_bytes(job_id, f"result-{absolute_slot}.png", base64.b64decode(b64))
            result_relpaths[absolute_slot - 1] = relpath
            slot_errors[absolute_slot - 1] = ""
            if revised_prompt:
                slot_revised_prompts[absolute_slot - 1] = revised_prompt
            debug(f"已写入最终图片 result-{absolute_slot}.png", "file")
        saved_results = compact_relpaths(result_relpaths)
        if saved_results:
            await publish_update(
                result=result_relpaths,
                errors=slot_errors,
                revised_prompts=slot_revised_prompts,
                preview_phases=slot_preview_phases,
                progress_message=f"图片生成完成，共 {len(saved_results)} 张",
            )
        return saved_results, None

    async for chunk in resp.aiter_text():
        chunk_count += 1
        total_chars += len(chunk)
        if chunk_count <= 5:
            debug(f"SSE chunk #{chunk_count}: {chunk[:180]!r}", "event")
        buffer += chunk
        lines = buffer.split("\n")
        buffer = lines.pop() if lines else ""
        for raw_line in lines:
            raw_line_count += 1
            line = raw_line.rstrip("\r")
            if not line:
                last_event = None
                continue
            if line.startswith("event:"):
                last_event = line[6:].strip()
                debug(f"SSE event: {last_event}", "event")
                continue
            if not line.startswith("data:"):
                if raw_line_count <= 12:
                    debug(f"SSE raw line: {line[:180]}", "event")
                continue
            data_str = line[5:].strip()
            if not data_str:
                continue
            if data_str == "[DONE]":
                debug("SSE data: [DONE]", "event")
                continue
            try:
                payload = json.loads(data_str)
            except json.JSONDecodeError:
                debug(f"收到无法解析的 SSE data，已跳过: {data_str[:180]}", "warn")
                continue
            payload_count += 1
            last_payload_summary = summarize_event_payload(payload)
            revised_prompt = maybe_store_revised_prompt(
                job_id,
                original_prompt,
                payload,
                revised_prompt,
                log_debug=debug,
            )
            images = extract_payload_images(payload)
            if images:
                image_meta = [
                    {
                        "index": index,
                        "index_key": index_key,
                        "b64_len": len(b64),
                    }
                    for index, index_key, b64 in images
                ]
                debug(
                    f"SSE 图片 payload #{payload_count}: {summarize_request_payload({'images': image_meta, 'raw': redact_large_strings(payload)})[:1200]}",
                    "event",
                )
            elif is_final_image_payload(payload, last_event):
                debug(
                    f"SSE completed payload #{payload_count}: {summarize_payload_details(payload)[:1200]}",
                    "event",
                )

            if last_event == "error" or payload.get("type") == "error":
                message = (
                    payload.get("error", {}).get("message")
                    if isinstance(payload.get("error"), dict)
                    else payload.get("message")
                ) or "上游错误"
                debug(f"上游错误: {message}", "error")
                unresolved_indexes = [idx for idx in range(total_slots) if not result_relpaths[idx]]
                target_indexes = [slot_start - 1] if expected_n == 1 else unresolved_indexes
                for idx in target_indexes:
                    slot_errors[idx] = message
                await publish_update(
                    preview=preview_relpaths,
                    result=result_relpaths,
                    errors=slot_errors,
                    revised_prompts=slot_revised_prompts,
                    preview_phases=slot_preview_phases,
                    progress_message="部分请求失败，其他请求继续处理中…",
                )
                if compact_relpaths(preview_relpaths) or compact_relpaths(result_relpaths):
                    await publish_update(
                        preview=preview_relpaths,
                        result=result_relpaths,
                        errors=slot_errors,
                        revised_prompts=slot_revised_prompts,
                        preview_phases=slot_preview_phases,
                        progress_message="上游已结束，已保留最终图和可用预览",
                    )
                    return compact_relpaths(result_relpaths), message
                raise RuntimeError(message)

            if not images:
                event_name = last_event or "处理中…"
                store.update_job(job_id, progress_message=f"{event_name}…")
                continue

            is_final = is_final_image_payload(payload, last_event)
            for index, index_key, b64 in images:
                if is_final:
                    slot = normalize_slot(index, index_key, expected_n, next_result_slot)
                    next_result_slot = max(next_result_slot, min(slot + 1, expected_n))
                    absolute_slot = slot_start + slot - 1
                    relpath = relpath_for_slot(job_id, "result", absolute_slot)
                    save_bytes(job_id, f"result-{absolute_slot}.png", base64.b64decode(b64))
                    result_relpaths[absolute_slot - 1] = relpath
                    slot_errors[absolute_slot - 1] = ""
                    if revised_prompt:
                        slot_revised_prompts[absolute_slot - 1] = revised_prompt
                    index_note = f"（上游索引 {index}）" if isinstance(index, int) else ""
                    debug(f"收到最终图片 {absolute_slot}{index_note}，已写入 result-{absolute_slot}.png", "file")
                else:
                    slot = normalize_slot(index, index_key, expected_n, next_preview_slot)
                    next_preview_slot = max(next_preview_slot, min(slot + 1, expected_n))
                    absolute_slot = slot_start + slot - 1
                    relpath = relpath_for_slot(job_id, "preview", absolute_slot)
                    save_bytes(job_id, f"preview-{absolute_slot}.png", base64.b64decode(b64))
                    preview_relpaths[absolute_slot - 1] = relpath
                    phase_index = extract_partial_phase_index(payload)
                    if isinstance(phase_index, int):
                        slot_preview_phases[absolute_slot - 1] = phase_index + 1
                    phase_note = f"（阶段预览 #{phase_index + 1}）" if isinstance(phase_index, int) else ""
                    debug(f"槽位 {absolute_slot} 收到预览图{phase_note}，已写入 preview-{absolute_slot}.png", "file")

            preview_count = len(compact_relpaths(preview_relpaths))
            result_count = len(compact_relpaths(result_relpaths))
            if is_final:
                await publish_update(
                    preview=preview_relpaths,
                    result=result_relpaths,
                    errors=slot_errors,
                    revised_prompts=slot_revised_prompts,
                    preview_phases=slot_preview_phases,
                    progress_message=f"图片生成完成，共 {result_count} 张",
                )
                if result_count >= expected_n:
                    return compact_relpaths(result_relpaths), fallback_note
            else:
                await publish_update(
                    preview=preview_relpaths,
                    result=result_relpaths,
                    errors=slot_errors,
                    revised_prompts=slot_revised_prompts,
                    preview_phases=slot_preview_phases,
                    progress_message=f"已接收预览 {preview_count} / {expected_n}（服务端继续处理中…）",
                )

    if compact_relpaths(preview_relpaths) or compact_relpaths(result_relpaths):
        final_count = len(compact_relpaths(result_relpaths))
        preview_count = len(compact_relpaths(preview_relpaths))
        unresolved_indexes = [idx for idx in range(total_slots) if not result_relpaths[idx] and not preview_relpaths[idx]]
        target_indexes = [slot_start - 1] if expected_n == 1 else unresolved_indexes
        fallback_note = "流式响应提前结束"
        for idx in target_indexes:
            slot_errors[idx] = fallback_note
        debug(f"流提前结束，保留 {final_count} 张最终图和 {preview_count} 张可用预览", "warn")
        await publish_update(
            preview=preview_relpaths,
            result=result_relpaths,
            errors=slot_errors,
            revised_prompts=slot_revised_prompts,
            preview_phases=slot_preview_phases,
            progress_message="流式响应提前结束，已保留最终图和可用预览",
        )
        return compact_relpaths(result_relpaths), "流式响应提前结束，已保留最终图和可用预览"
    details = []
    details.append(f"chunk 数: {chunk_count}")
    details.append(f"字符数: {total_chars}")
    if last_event:
        details.append(f"最后事件: {last_event}")
    if last_payload_summary:
        details.append(f"最近 payload: {last_payload_summary}")
    if payload_count:
        details.append(f"payload 数: {payload_count}")
    else:
        details.append("未收到可解析的 payload")
    fallback_note = "；".join(details)
    target_indexes = [slot_start - 1] if expected_n == 1 else [idx for idx in range(total_slots) if not result_relpaths[idx]]
    for idx in target_indexes:
        slot_errors[idx] = fallback_note
    await publish_update(
        errors=slot_errors,
        revised_prompts=slot_revised_prompts,
        preview_phases=slot_preview_phases,
        progress_message="上游未返回图片",
    )
    debug(f"流结束但未收到图片数据: {fallback_note}", "warn")
    return [], fallback_note


async def process_job(job_id: str) -> None:
    async with app.state.job_semaphore:
        job = store.get_job(job_id)
        secret = app.state.job_secrets.get(job_id)
        if not job:
            return
        if not secret:
            store.append_debug_log(job_id, "任务凭据已丢失，无法继续执行", "error")
            store.update_job(
                job_id,
                status="failed",
                error_message="任务凭据已丢失，无法继续执行",
                progress_message="任务失败",
                completed_at=now_ms(),
            )
            return

        start_ms = now_ms()
        store.append_debug_log(job_id, "服务端已接管任务，开始处理", "info")
        store.update_job(job_id, status="running", progress_message="服务端已接管任务，开始请求上游…")
        try:
            headers = {
                "Authorization": f"Bearer {secret['api_key']}",
                "Accept": "text/event-stream",
            }
            batch_mode = parse_batch_mode(job.get("batch_mode") or DEFAULT_BATCH_MODE)
            merged_preview_relpaths = [""] * job["n"]
            merged_result_relpaths = [""] * job["n"]
            merged_slot_errors = [""] * job["n"]
            merged_slot_revised_prompts = [""] * job["n"]
            merged_slot_preview_phases = [0] * job["n"]
            merge_lock = asyncio.Lock()

            async def merge_job_paths(
                preview_relpaths: list[str] | None = None,
                result_relpaths: list[str] | None = None,
                slot_errors: list[str] | None = None,
                slot_revised_prompts: list[str] | None = None,
                slot_preview_phases: list[int] | None = None,
                progress_message: str | None = None,
            ) -> None:
                async with merge_lock:
                    if preview_relpaths is not None:
                        for idx, value in enumerate(preview_relpaths[: job["n"]]):
                            if value:
                                merged_preview_relpaths[idx] = value
                    if result_relpaths is not None:
                        for idx, value in enumerate(result_relpaths[: job["n"]]):
                            if value:
                                merged_result_relpaths[idx] = value
                    if slot_errors is not None:
                        for idx, value in enumerate(slot_errors[: job["n"]]):
                            if value is None:
                                continue
                            merged_slot_errors[idx] = value
                    if slot_revised_prompts is not None:
                        for idx, value in enumerate(slot_revised_prompts[: job["n"]]):
                            if value is None:
                                continue
                            merged_slot_revised_prompts[idx] = value
                    if slot_preview_phases is not None:
                        for idx, value in enumerate(slot_preview_phases[: job["n"]]):
                            if value is None:
                                continue
                            merged_slot_preview_phases[idx] = value
                    update_job_image_paths(
                        job_id,
                        preview_relpaths=merged_preview_relpaths,
                        result_relpaths=merged_result_relpaths,
                        slot_errors=merged_slot_errors,
                        slot_revised_prompts=merged_slot_revised_prompts,
                        slot_preview_phases=merged_slot_preview_phases,
                        progress_message=progress_message,
                    )

            result_relpaths: list[str]
            note: str | None
            if job["type"] == "generate":
                headers["Content-Type"] = "application/json"
                use_direct_images = uses_direct_images_api(job.get("model"))
                generate_url = f"{job['base_url']}/images/generations" if use_direct_images else f"{job['base_url']}/responses"
                if job["n"] == 1 or batch_mode == "direct":
                    if job["n"] > 1 and batch_mode == "direct":
                        store.append_debug_log(job_id, f"多图任务将通过单个 n={job['n']} 的流式请求执行", "info")
                        store.update_job(job_id, progress_message=f"正在通过单个请求生成 {job['n']} 张图片…")
                    if use_direct_images:
                        json_body = {
                            "model": job["model"],
                            "prompt": job["prompt"],
                            "n": job["n"],
                            "size": job["size"],
                            "quality": job["quality"],
                            "moderation": job["moderation"],
                            "stream": True,
                            "partial_images": job["preview_count"],
                        }
                    else:
                        store.append_debug_log(job_id, f"当前 model={job['model']}，将 image2 请求中转为 responses API", "info")
                        json_body = build_responses_image_request(
                            main_model=job["model"],
                            prompt=job["prompt"],
                            action="generate",
                            size=job["size"],
                            quality=job["quality"],
                            moderation=job["moderation"],
                            preview_count=job["preview_count"],
                            image_count=job["n"],
                        )
                    result_relpaths, note = await run_stream_request(
                        job_id,
                        expected_n=job["n"],
                        url=generate_url,
                        headers=headers,
                        json_body=json_body,
                        original_prompt=job["prompt"],
                    )
                else:
                    store.append_debug_log(job_id, f"多图任务将拆分为 {job['n']} 个 n=1 的流式请求并行执行", "info")
                    store.update_job(job_id, progress_message=f"正在并行请求 {job['n']} 张图片…")

                    async def generate_one(slot: int) -> tuple[list[str], str | None]:
                        return await run_stream_request(
                            job_id,
                            expected_n=1,
                            total_slots=job["n"],
                            slot_start=slot,
                            url=generate_url,
                            headers=headers,
                            json_body=(
                                {
                                    "model": job["model"],
                                    "prompt": job["prompt"],
                                    "n": 1,
                                    "size": job["size"],
                                    "quality": job["quality"],
                                    "moderation": job["moderation"],
                                    "stream": True,
                                    "partial_images": job["preview_count"],
                                }
                                if use_direct_images
                                else build_responses_image_request(
                                    main_model=job["model"],
                                    prompt=job["prompt"],
                                    action="generate",
                                    size=job["size"],
                                    quality=job["quality"],
                                    moderation=job["moderation"],
                                    preview_count=job["preview_count"],
                                    image_count=1,
                                )
                            ),
                            original_prompt=job["prompt"],
                            on_update=merge_job_paths,
                        )

                    results = await asyncio.gather(
                        *(generate_one(slot) for slot in range(1, job["n"] + 1)),
                        return_exceptions=True,
                    )
                    errors = [result for result in results if isinstance(result, Exception)]
                    success_count = len(compact_relpaths(merged_result_relpaths))
                    if errors:
                        failure_summary = summarize_slot_failures(merged_slot_errors)
                        store.append_debug_log(
                            job_id,
                            (
                                f"并行子任务结束：成功 {success_count} / {job['n']}；{failure_summary}"
                                if failure_summary
                                else f"并行子任务结束：成功 {success_count} / {job['n']}；失败 {len(errors)} 路"
                            ),
                            "warn",
                        )
                    if success_count == 0:
                        message = "；".join(str(item) for item in errors[:3]) if errors else "上游未返回任何图片"
                        raise RuntimeError(message)
                    result_relpaths = merged_result_relpaths[:]
                    if success_count < job["n"]:
                        note = f"任务部分完成，成功生成 {success_count} / {job['n']} 张"
                    else:
                        note = f"任务完成，共生成 {success_count} 张"
            else:
                source_urls = job["source_urls"]
                source_relpaths = [url.removeprefix("/files/").split("?", 1)[0] for url in source_urls]
                use_direct_images = uses_direct_images_api(job.get("model"))
                direct_edit_url = f"{job['base_url']}/images/edits"
                responses_url = f"{job['base_url']}/responses"
                file_specs: list[tuple[str, str, str]] = []
                if job["type"] == "edit":
                    if not source_relpaths:
                        raise RuntimeError("原图不存在")
                    if use_direct_images:
                        file_specs.append(("image", source_relpaths[0], "image/png"))
                        if job["mask_url"]:
                            mask_relpath = job["mask_url"].removeprefix("/files/").split("?", 1)[0]
                            file_specs.append(("mask", mask_relpath, "image/png"))
                else:
                    if not source_relpaths:
                        raise RuntimeError("参考图不存在")
                    if use_direct_images:
                        for relpath in source_relpaths:
                            file_specs.append(("image[]", relpath, "image/png"))

                if job["n"] == 1 or batch_mode == "direct":
                    if job["n"] > 1 and batch_mode == "direct":
                        store.append_debug_log(job_id, f"多图任务将通过单个 n={job['n']} 的流式请求执行", "info")
                        store.update_job(job_id, progress_message=f"正在通过单个请求生成 {job['n']} 张图片…")
                    if use_direct_images:
                        result_relpaths, note = await run_stream_request(
                            job_id,
                            expected_n=job["n"],
                            url=direct_edit_url,
                            headers=headers,
                            data_body={
                                "model": job["model"],
                                "prompt": job["prompt"],
                                "n": str(job["n"]),
                                "size": job["size"],
                                "quality": job["quality"],
                                "moderation": job["moderation"],
                                "stream": "true",
                                "partial_images": str(job["preview_count"]),
                            },
                            file_specs=file_specs,
                            original_prompt=job["prompt"],
                        )
                    else:
                        store.append_debug_log(job_id, f"当前 model={job['model']}，将 image2 请求中转为 responses API", "info")
                        result_relpaths, note = await run_stream_request(
                            job_id,
                            expected_n=job["n"],
                            url=responses_url,
                            headers={**headers, "Content-Type": "application/json"},
                            json_body=build_responses_image_request(
                                main_model=job["model"],
                                prompt=job["prompt"],
                                action="edit",
                                size=job["size"],
                                quality=job["quality"],
                                moderation=job["moderation"],
                                preview_count=job["preview_count"],
                                image_count=job["n"],
                                input_image_relpaths=source_relpaths,
                                mask_relpath=(
                                    job["mask_url"].removeprefix("/files/").split("?", 1)[0]
                                    if job["type"] == "edit" and job.get("mask_url")
                                    else None
                                ),
                            ),
                            original_prompt=job["prompt"],
                        )
                else:
                    store.append_debug_log(job_id, f"多图任务将拆分为 {job['n']} 个 n=1 的流式请求并行执行", "info")
                    store.update_job(job_id, progress_message=f"正在并行请求 {job['n']} 张图片…")

                    async def edit_one(slot: int) -> tuple[list[str], str | None]:
                        if use_direct_images:
                            return await run_stream_request(
                                job_id,
                                expected_n=1,
                                total_slots=job["n"],
                                slot_start=slot,
                                url=direct_edit_url,
                                headers=headers,
                                data_body={
                                    "model": job["model"],
                                    "prompt": job["prompt"],
                                    "n": "1",
                                    "size": job["size"],
                                    "quality": job["quality"],
                                    "moderation": job["moderation"],
                                    "stream": "true",
                                    "partial_images": str(job["preview_count"]),
                                },
                                file_specs=file_specs,
                                original_prompt=job["prompt"],
                                on_update=merge_job_paths,
                            )
                        return await run_stream_request(
                            job_id,
                            expected_n=1,
                            total_slots=job["n"],
                            slot_start=slot,
                            url=responses_url,
                            headers={**headers, "Content-Type": "application/json"},
                            json_body=build_responses_image_request(
                                main_model=job["model"],
                                prompt=job["prompt"],
                                action="edit",
                                size=job["size"],
                                quality=job["quality"],
                                moderation=job["moderation"],
                                preview_count=job["preview_count"],
                                image_count=1,
                                input_image_relpaths=source_relpaths,
                                mask_relpath=(
                                    job["mask_url"].removeprefix("/files/").split("?", 1)[0]
                                    if job["type"] == "edit" and job.get("mask_url")
                                    else None
                                ),
                            ),
                            original_prompt=job["prompt"],
                            on_update=merge_job_paths,
                        )

                    results = await asyncio.gather(
                        *(edit_one(slot) for slot in range(1, job["n"] + 1)),
                        return_exceptions=True,
                    )
                    errors = [result for result in results if isinstance(result, Exception)]
                    success_count = len(compact_relpaths(merged_result_relpaths))
                    if errors:
                        failure_summary = summarize_slot_failures(merged_slot_errors)
                        store.append_debug_log(
                            job_id,
                            (
                                f"并行子任务结束：成功 {success_count} / {job['n']}；{failure_summary}"
                                if failure_summary
                                else f"并行子任务结束：成功 {success_count} / {job['n']}；失败 {len(errors)} 路"
                            ),
                            "warn",
                        )
                    if success_count == 0:
                        message = "；".join(str(item) for item in errors[:3]) if errors else "上游未返回任何图片"
                        raise RuntimeError(message)
                    result_relpaths = merged_result_relpaths[:]
                    if success_count < job["n"]:
                        note = f"任务部分完成，成功生成 {success_count} / {job['n']} 张"
                    else:
                        note = f"任务完成，共生成 {success_count} 张"

            latest_job = store.get_job(job_id) or {}
            merged_slot_errors = normalize_slot_notes(latest_job.get("slot_errors"), job["n"])
            merged_slot_revised_prompts = normalize_slot_notes(latest_job.get("slot_revised_prompts"), job["n"])
            merged_slot_preview_phases = normalize_slot_numbers(latest_job.get("slot_preview_phases"), job["n"])

            end_ms = now_ms()
            store.update_job(
                job_id,
                status="succeeded",
                result_relpath=first_non_empty(result_relpaths),
                result_relpaths=result_relpaths,
                slot_errors=merged_slot_errors,
                slot_revised_prompts=merged_slot_revised_prompts,
                slot_preview_phases=merged_slot_preview_phases,
                progress_message=note or f"任务完成，共生成 {len(result_relpaths)} 张",
                completed_at=end_ms,
                duration_ms=end_ms - start_ms,
            )
            store.append_debug_log(job_id, f"任务完成，用时 {((end_ms - start_ms) / 1000):.1f}s", "success")
        except asyncio.CancelledError:
            end_ms = now_ms()
            current = store.get_job(job_id)
            if current and current.get("status") != "cancelled":
                result_urls = current.get("result_urls") or ([current.get("result_url")] if current.get("result_url") else [])
                preview_urls = current.get("preview_urls") or ([current.get("preview_url")] if current.get("preview_url") else [])
                final_count = count_final_file_urls(result_urls, preview_urls, int(current.get("n") or 1))
                store.append_debug_log(job_id, "任务已主动结束", "warn")
                store.update_job(
                    job_id,
                    status="cancelled" if final_count > 0 else "failed",
                    error_message="任务已主动结束" if final_count > 0 else "任务已结束，未生成最终图",
                    progress_message="任务已主动结束" if final_count > 0 else "任务失败",
                    completed_at=end_ms,
                    duration_ms=end_ms - start_ms,
                )
            elif current:
                store.update_job(
                    job_id,
                    completed_at=end_ms,
                    duration_ms=end_ms - start_ms,
                )
            return
        except Exception as exc:
            end_ms = now_ms()
            store.append_debug_log(job_id, f"任务失败: {exc}", "error")
            store.update_job(
                job_id,
                status="failed",
                error_message=str(exc),
                progress_message="任务失败",
                completed_at=end_ms,
                duration_ms=end_ms - start_ms,
            )
        finally:
            app.state.job_secrets.pop(job_id, None)


def create_job_response(job_id: str) -> dict[str, Any]:
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return job


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favorites")
async def favorites_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "favorites.html")


@app.get("/api/favorites")
async def list_favorites(archived: str = "0") -> dict[str, Any]:
    if archived == "all":
        archived_filter = None
    elif archived in {"1", "true"}:
        archived_filter = True
    else:
        archived_filter = False
    return {
        "items": favorites_store.list_favorites(archived=archived_filter),
        "counts": {
            "active": favorites_store.count_favorites(archived=False),
            "archived": favorites_store.count_favorites(archived=True),
        },
    }


@app.get("/api/favorites/{favorite_id}")
async def get_favorite(favorite_id: str) -> dict[str, Any]:
    favorite = favorites_store.get_favorite(favorite_id)
    if not favorite:
        raise HTTPException(status_code=404, detail="收藏不存在")
    return favorite


@app.post("/api/favorites")
async def create_favorite(payload: FavoriteCreateRequest) -> dict[str, Any]:
    job = store.get_job(payload.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="原任务不存在")

    slot_index = int(payload.slot_index)
    result_urls = job.get("result_urls") or ([job["result_url"]] if job.get("result_url") else [])
    if slot_index < 0 or slot_index >= len(result_urls) or not result_urls[slot_index]:
        raise HTTPException(status_code=400, detail="该位置没有可收藏的最终图")

    favorite_id = f"{payload.job_id}:{slot_index}"
    image_relpath = relpath_from_file_url(result_urls[slot_index])
    if not image_relpath:
        raise HTTPException(status_code=400, detail="最终图文件不存在")

    source_relpaths = [item for item in (relpath_from_file_url(url) for url in job.get("source_urls", [])) if item]
    mask_relpath = relpath_from_file_url(job.get("mask_url"))
    favorite = create_favorite_snapshot(
        favorite_id=favorite_id,
        job_id=payload.job_id,
        slot_index=slot_index,
        prompt=job.get("prompt") or "",
        job_type=job.get("type") or "generate",
        label=f"最终图 {slot_index + 1}",
        size=job.get("size") or "",
        image_count=int(job.get("n") or 1),
        image_relpath=image_relpath,
        source_relpaths=source_relpaths,
        mask_relpath=mask_relpath,
    )
    return favorite


@app.post("/api/favorites/import")
async def import_favorite(payload: FavoriteImportRequest) -> dict[str, Any]:
    favorite_id = payload.id or (f"{payload.jobId}:{payload.slotIndex}" if payload.jobId else uuid.uuid4().hex)
    image_relpath = relpath_from_file_url(payload.src)
    if not image_relpath and not payload.imageDataUrl:
        raise HTTPException(status_code=400, detail="收藏图片地址无效")

    job = store.get_job(payload.jobId) if payload.jobId else None
    source_relpaths = [item for item in (relpath_from_file_url(url) for url in (job.get("source_urls", []) if job else [])) if item]
    mask_relpath = relpath_from_file_url(job.get("mask_url")) if job else None
    try:
        favorite = create_favorite_snapshot(
            favorite_id=favorite_id,
            job_id=payload.jobId,
            slot_index=int(payload.slotIndex),
            prompt=(job.get("prompt") if job else payload.prompt) or "",
            job_type=(job.get("type") if job else payload.type) or "generate",
            label=payload.label or f"最终图 {int(payload.slotIndex) + 1}",
            size=(job.get("size") if job else "") or "",
            image_count=int((job.get("n") if job else 1) or 1),
            image_relpath=image_relpath,
            image_data_url=payload.imageDataUrl,
            source_relpaths=source_relpaths,
            mask_relpath=mask_relpath,
            created_at=payload.createdAt,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return favorite


@app.delete("/api/favorites/{favorite_id}")
async def delete_favorite(favorite_id: str) -> dict[str, bool]:
    favorite = favorites_store.archive_favorite(favorite_id)
    if not favorite:
        raise HTTPException(status_code=404, detail="收藏不存在")
    return {"ok": True}


@app.post("/api/favorites/{favorite_id}/restore")
async def restore_favorite(favorite_id: str) -> dict[str, Any]:
    favorite = favorites_store.restore_favorite(favorite_id)
    if not favorite:
        raise HTTPException(status_code=404, detail="收藏不存在")
    return favorite


@app.delete("/api/favorites")
async def clear_favorites() -> dict[str, bool]:
    favorites_store.archive_all_favorites()
    return {"ok": True}


@app.get("/api/settings/profiles")
async def list_settings_profiles() -> dict[str, Any]:
    return build_settings_profiles_response()


@app.post("/api/settings/profiles")
async def create_settings_profile(payload: SettingsProfileCreateRequest) -> dict[str, Any]:
    settings_store.create_profile(name=payload.name, clone_from_id=payload.clone_from_id)
    return build_settings_profiles_response()


@app.put("/api/settings/profiles/{profile_id}")
async def update_settings_profile(profile_id: str, payload: SettingsProfileUpdateRequest) -> dict[str, Any]:
    try:
        api_key = normalize_stored_api_key(payload.api_key)
        base_url = normalize_base_url(payload.base_url)
        model = normalize_model(payload.model)
        quality = parse_quality(payload.quality)
        moderation = parse_moderation(payload.moderation)
        batch_mode = parse_batch_mode(payload.batch_mode)
        preview_count = parse_preview_count(payload.preview_count)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    profile = settings_store.update_profile(
        profile_id,
        name=payload.name,
        api_key=api_key,
        base_url=base_url,
        model=model,
        quality=quality,
        moderation=moderation,
        batch_mode=batch_mode,
        preview_count=preview_count,
        activate=payload.activate,
    )
    if not profile:
        raise HTTPException(status_code=404, detail="Profile 不存在")
    return build_settings_profiles_response()


@app.post("/api/settings/profiles/{profile_id}/activate")
async def activate_settings_profile(profile_id: str) -> dict[str, Any]:
    profile = settings_store.activate_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile 不存在")
    return build_settings_profiles_response()


@app.delete("/api/settings/profiles/{profile_id}")
async def delete_settings_profile(profile_id: str) -> dict[str, Any]:
    try:
        settings_store.delete_profile(profile_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return build_settings_profiles_response()


@app.get("/api/jobs/count")
async def get_job_count() -> dict[str, int]:
    return {
        "count": store.count_jobs(trashed=False),
        "trash_count": store.count_jobs(trashed=True),
    }


@app.get("/api/jobs")
async def list_jobs(limit: int = 200, trashed: str = "0") -> dict[str, Any]:
    capped = max(1, min(limit, 500))
    if trashed == "all":
        trashed_filter = None
    elif trashed in {"1", "true"}:
        trashed_filter = True
    else:
        trashed_filter = False
    return {
        "items": store.list_jobs(limit=capped, trashed=trashed_filter),
        "counts": {
            "active": store.count_jobs(trashed=False),
            "trash": store.count_jobs(trashed=True),
        },
    }


def parse_summary_filter(value: str) -> tuple[str | None, str | None]:
    normalized = (value or "all").strip().lower()
    if normalized in {"all", ""}:
        return None, None
    if normalized in {"succeeded", "failed", "cancelled", "queued", "running"}:
        return normalized, None
    if normalized in {"generate", "edit", "reference"}:
        return None, normalized
    raise HTTPException(status_code=400, detail="不支持的筛选条件")


@app.get("/api/jobs/summary")
async def list_job_summaries(
    limit: int = 32,
    page: int = 1,
    trashed: str = "0",
    filter: str = "all",
    search: str = "",
) -> dict[str, Any]:
    capped = max(1, min(limit, 64))
    safe_page = max(1, page)
    if trashed == "all":
        trashed_filter = None
    elif trashed in {"1", "true"}:
        trashed_filter = True
    else:
        trashed_filter = False
    status_filter, type_filter = parse_summary_filter(filter)
    total = store.count_job_summaries(
        trashed=trashed_filter,
        status=status_filter,
        job_type=type_filter,
        search=search,
    )
    total_pages = max(1, (total + capped - 1) // capped)
    offset = (safe_page - 1) * capped
    items = store.list_job_summaries(
        limit=capped,
        offset=offset,
        trashed=trashed_filter,
        status=status_filter,
        job_type=type_filter,
        search=search,
    )
    return {
        "items": items,
        "page": safe_page,
        "limit": capped,
        "total": total,
        "total_pages": total_pages,
        "counts": {
            "active": store.count_jobs(trashed=False),
            "trash": store.count_jobs(trashed=True),
        },
    }


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return job


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict[str, Any]:
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job["status"] not in {"queued", "running"}:
        return job

    store.append_debug_log(job_id, "收到主动结束请求，正在停止任务", "warn")
    cancelled = mark_job_cancelled(job_id)
    task = app.state.active_tasks.get(job_id)
    if task and not task.done():
        task.cancel()
    app.state.job_secrets.pop(job_id, None)
    return cancelled or create_job_response(job_id)


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str) -> dict[str, bool]:
    job = store.trash_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/restore")
async def restore_job(job_id: str) -> dict[str, Any]:
    job = store.restore_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return job


@app.delete("/api/jobs")
async def clear_jobs(status: str | None = None, trashed: str = "0") -> dict[str, bool]:
    if status not in {None, "failed"}:
        raise HTTPException(status_code=400, detail="仅支持删除全部任务或删除 failed 任务")
    trashed_filter = True if trashed in {"1", "true"} else False
    if status == "failed" and trashed_filter:
        raise HTTPException(status_code=400, detail="回收站不支持按 failed 清空")
    jobs = store.purge_jobs(status=status, trashed=trashed_filter)
    for job in jobs:
        shutil.rmtree(job_dir(job["id"]), ignore_errors=True)
    return {"ok": True}


@app.post("/api/jobs/generate")
async def submit_generate(payload: GenerateRequest) -> dict[str, Any]:
    try:
        parse_size(payload.size)
        image_count = parse_image_count(payload.n)
        quality = parse_quality(payload.quality)
        moderation = parse_moderation(payload.moderation)
        batch_mode = parse_batch_mode(payload.batch_mode)
        preview_count = parse_preview_count(payload.preview_count)
        api_key = normalize_api_key(payload.api_key)
        model = normalize_model(payload.model)
        base_url = normalize_base_url(payload.base_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    store.create_job(
        make_job_record(
            job_id=job_id,
            job_type="generate",
            prompt=payload.prompt.strip(),
            size=payload.size,
            model=model,
            base_url=base_url,
            quality=quality,
            moderation=moderation,
            batch_mode=batch_mode,
            preview_count=preview_count,
            image_count=image_count,
        )
    )
    app.state.job_secrets[job_id] = {"api_key": api_key}
    enqueue_job(job_id)
    return create_job_response(job_id)


@app.post("/api/jobs/edit")
async def submit_edit(
    api_key: str = Form(...),
    prompt: str = Form(...),
    size: str = Form("1024x1024"),
    base_url: str = Form(DEFAULT_BASE_URL),
    model: str = Form(DEFAULT_MODEL),
    n: str = Form("1"),
    quality: str = Form(DEFAULT_QUALITY),
    moderation: str = Form(DEFAULT_MODERATION),
    batch_mode: str = Form(DEFAULT_BATCH_MODE),
    preview_count: str = Form(str(DEFAULT_PREVIEW_COUNT)),
    image: UploadFile = File(...),
    mask: UploadFile | None = File(None),
) -> dict[str, Any]:
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="请填写修改描述")
    try:
        parse_size(size)
        image_count = parse_image_count(n)
        quality = parse_quality(quality)
        moderation = parse_moderation(moderation)
        batch_mode = parse_batch_mode(batch_mode)
        preview_count = parse_preview_count(preview_count)
        normalized_api_key = normalize_api_key(api_key)
        normalized_model = normalize_model(model)
        normalized_base_url = normalize_base_url(base_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    source_relpath = await save_upload(job_id, "inputs", image, "source.png")
    mask_relpath = await save_upload(job_id, "inputs", mask, "mask.png") if mask else None
    store.create_job(
        make_job_record(
            job_id=job_id,
            job_type="edit",
            prompt=prompt.strip(),
            size=size,
            model=normalized_model,
            base_url=normalized_base_url,
            quality=quality,
            moderation=moderation,
            batch_mode=batch_mode,
            preview_count=preview_count,
            image_count=image_count,
            source_relpaths=[source_relpath],
            mask_relpath=mask_relpath,
        )
    )
    app.state.job_secrets[job_id] = {"api_key": normalized_api_key}
    enqueue_job(job_id)
    return create_job_response(job_id)


@app.post("/api/jobs/reference")
async def submit_reference(
    api_key: str = Form(...),
    prompt: str = Form(...),
    size: str = Form("1024x1024"),
    base_url: str = Form(DEFAULT_BASE_URL),
    model: str = Form(DEFAULT_MODEL),
    n: str = Form("1"),
    quality: str = Form(DEFAULT_QUALITY),
    moderation: str = Form(DEFAULT_MODERATION),
    batch_mode: str = Form(DEFAULT_BATCH_MODE),
    preview_count: str = Form(str(DEFAULT_PREVIEW_COUNT)),
    images: list[UploadFile] = File(..., alias="image"),
) -> dict[str, Any]:
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="请填写 prompt")
    if not images:
        raise HTTPException(status_code=400, detail="请至少上传一张参考图")
    if len(images) > MAX_REF_IMAGES:
        raise HTTPException(status_code=400, detail=f"最多 {MAX_REF_IMAGES} 张参考图")
    try:
        parse_size(size)
        image_count = parse_image_count(n)
        quality = parse_quality(quality)
        moderation = parse_moderation(moderation)
        batch_mode = parse_batch_mode(batch_mode)
        preview_count = parse_preview_count(preview_count)
        normalized_api_key = normalize_api_key(api_key)
        normalized_model = normalize_model(model)
        normalized_base_url = normalize_base_url(base_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job_id = uuid.uuid4().hex
    source_relpaths = []
    for idx, image in enumerate(images, start=1):
        source_relpaths.append(await save_upload(job_id, "inputs", image, f"reference-{idx}.png"))

    store.create_job(
        make_job_record(
            job_id=job_id,
            job_type="reference",
            prompt=prompt.strip(),
            size=size,
            model=normalized_model,
            base_url=normalized_base_url,
            quality=quality,
            moderation=moderation,
            batch_mode=batch_mode,
            preview_count=preview_count,
            image_count=image_count,
            source_relpaths=source_relpaths,
        )
    )
    app.state.job_secrets[job_id] = {"api_key": normalized_api_key}
    enqueue_job(job_id)
    return create_job_response(job_id)
