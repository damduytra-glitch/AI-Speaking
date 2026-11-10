"""Sync public-safe frontend configuration from centralized `.env` to `web/js/config.js`.

Usage:
    python scripts/sync_secrets.py
    python scripts/sync_secrets.py --check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from env_config import DEFAULT_ENV_FILE, get_frontend_config, load_project_env

TARGET_JS = ROOT / "web" / "js" / "config.js"


def render_config_js(cfg: dict[str, str]) -> str:
    payload = json.dumps(cfg, indent=2, ensure_ascii=False)
    return (
        "// ============================================================\n"
        "// AUTO-GENERATED FROM .env BY scripts/sync_secrets.py\n"
        "// File này được liệt kê trong .gitignore — KHÔNG commit lên Git!\n"
        "// ============================================================\n"
        f"export const APP_CONFIG = {payload};\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync centralized .env secrets to web/js/config.js")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate that SUPABASE_URL and SUPABASE_ANON_KEY are configured (non-placeholder).",
    )
    args = parser.parse_args()

    has_env = load_project_env()
    cfg = get_frontend_config()

    url = cfg.get("SUPABASE_URL", "")
    key = cfg.get("SUPABASE_ANON_KEY", "")
    missing = (
        not url
        or not key
        or "your-project-ref" in url
        or "your-supabase-anon-key" in key
    )

    if args.check:
        if missing:
            print("❌ Chưa cấu hình đủ SUPABASE_URL và SUPABASE_ANON_KEY trong .env / biến môi trường.", file=sys.stderr)
            return 1
        print(f"✅ Env config hợp lệ ({DEFAULT_ENV_FILE if has_env else 'process env'}).")
        return 0

    TARGET_JS.parent.mkdir(parents=True, exist_ok=True)
    TARGET_JS.write_text(render_config_js(cfg), encoding="utf-8")

    rel = TARGET_JS.relative_to(ROOT).as_posix()
    if missing:
        print(f"⚠️ Đã tạo {rel}, nhưng SUPABASE_URL hoặc SUPABASE_ANON_KEY vẫn đang trống/placeholder.")
        print("   Hãy điền vào file .env rồi chạy lại: python scripts/sync_secrets.py")
    else:
        print(f"✅ Đã đồng bộ cấu hình từ .env -> {rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

