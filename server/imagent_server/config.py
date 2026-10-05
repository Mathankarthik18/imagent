import os
import re
from dataclasses import dataclass, field
from pathlib import Path


def _ident(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError(f"invalid ClickHouse identifier: {value!r}")
    return value


@dataclass(frozen=True)
class Settings:
    clickhouse_host: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_HOST", "localhost"))
    clickhouse_port: int = field(default_factory=lambda: int(os.getenv("CLICKHOUSE_PORT", "8123")))
    clickhouse_user: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_USER", "default"))
    clickhouse_password: str = field(default_factory=lambda: os.getenv("CLICKHOUSE_PASSWORD", ""))
    clickhouse_database: str = field(default_factory=lambda: _ident(os.getenv("CLICKHOUSE_DATABASE", "imagent")))
    clickhouse_secure: bool = field(default_factory=lambda: os.getenv("CLICKHOUSE_SECURE", "false").lower() == "true")
    retention_days: int = field(default_factory=lambda: int(os.getenv("IMAGENT_RETENTION_DAYS", "30")))
    # Keys are optional; when set, ingest needs the ingest key and the read API needs the read key.
    ingest_key: str = field(default_factory=lambda: os.getenv("IMAGENT_INGEST_KEY", ""))
    read_key: str = field(default_factory=lambda: os.getenv("IMAGENT_READ_KEY", ""))
    stitch_enabled: bool = field(default_factory=lambda: os.getenv("IMAGENT_STITCH", "true").lower() != "false")
    price_sync: bool = field(default_factory=lambda: os.getenv("IMAGENT_PRICE_SYNC", "true").lower() != "false")
    price_source: str = field(default_factory=lambda: os.getenv("IMAGENT_PRICE_SOURCE", "https://openrouter.ai/api/v1/models"))
    pricing_file: str = field(default_factory=lambda: os.getenv("IMAGENT_PRICING_FILE", ""))
    ui_dir: Path = field(default_factory=lambda: Path(
        os.getenv("IMAGENT_UI_DIR", str(Path(__file__).resolve().parents[2] / "ui" / "dist"))))
    cors_origins: list[str] = field(default_factory=lambda: [
        o.strip() for o in os.getenv("IMAGENT_CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()])


settings = Settings()
