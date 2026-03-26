"""
Resolve paths to Meridian runtime files.

The project root is determined by MERIDIAN_DIR env var (default: two levels
up from this file, i.e. the meridianfork directory).
"""

import os
from pathlib import Path


def get_project_root() -> Path:
    env = os.environ.get("MERIDIAN_DIR")
    if env:
        return Path(env).resolve()
    # agent-harness/cli_anything/meridian/core/paths.py → go up 4 levels
    return Path(__file__).resolve().parents[4]


def journal_path() -> Path:
    return get_project_root() / "journal.json"


def state_path() -> Path:
    return get_project_root() / "state.json"


def lessons_path() -> Path:
    return get_project_root() / "lessons.json"


def config_path() -> Path:
    return get_project_root() / "user-config.json"


def stats_path() -> Path:
    return get_project_root() / "agent-stats.json"


def strategy_library_path() -> Path:
    return get_project_root() / "strategy-library.json"


def pool_memory_path() -> Path:
    return get_project_root() / "pool-memory.json"
