"""
E2E tests for cli-anything-meridian.

Uses the installed CLI binary via subprocess. Reads from the real Meridian
project directory (MERIDIAN_DIR env var must point to a valid meridianfork
directory with journal.json, state.json, etc.).

Set CLI_ANYTHING_FORCE_INSTALLED=1 to use the installed binary regardless
of whether we're in editable install mode.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest


def _resolve_cli():
    """Find cli-anything-meridian binary in PATH."""
    import shutil
    cli = shutil.which("cli-anything-meridian")
    if not cli and os.environ.get("CLI_ANYTHING_FORCE_INSTALLED"):
        raise RuntimeError("cli-anything-meridian not found in PATH — run: pip install -e .")
    if not cli:
        # Fallback to running the module directly (editable install)
        return [sys.executable, "-m", "cli_anything.meridian.meridian_cli"]
    return [cli]


CLI = _resolve_cli()

# Path to the real meridianfork directory
MERIDIAN_DIR = os.environ.get(
    "MERIDIAN_DIR",
    str(Path(__file__).resolve().parents[5]),  # 5 levels up from this file
)


def run(*args, meridian_dir=None, input_=None):
    """Run CLI command and return (returncode, stdout, stderr)."""
    env = {**os.environ, "MERIDIAN_DIR": meridian_dir or MERIDIAN_DIR}
    result = subprocess.run(
        CLI + list(args),
        capture_output=True,
        text=True,
        env=env,
        input=input_,
    )
    return result.returncode, result.stdout, result.stderr


def run_json(*args, meridian_dir=None):
    """Run CLI command with --json and parse the output."""
    rc, stdout, stderr = run(*args, "--json", meridian_dir=meridian_dir)
    assert rc == 0, f"Command failed (rc={rc}):\nstdout: {stdout}\nstderr: {stderr}"
    return json.loads(stdout)


# ─── Help / smoke tests ──────────────────────────────────────────


class TestSmoke:
    def test_help(self):
        rc, out, _ = run("--help")
        assert rc == 0
        assert "meridian" in out.lower()

    def test_version(self):
        rc, out, _ = run("--version")
        assert rc == 0
        assert "0.1.0" in out

    def test_status_help(self):
        rc, out, _ = run("status", "--help")
        assert rc == 0

    def test_journal_help(self):
        rc, out, _ = run("journal", "--help")
        assert rc == 0

    def test_report_help(self):
        rc, out, _ = run("report", "--help")
        assert rc == 0

    def test_config_help(self):
        rc, out, _ = run("config", "--help")
        assert rc == 0

    def test_lessons_help(self):
        rc, out, _ = run("lessons", "--help")
        assert rc == 0


# ─── Status commands ─────────────────────────────────────────────


class TestStatus:
    def test_overview_json_schema(self):
        data = run_json("status", "overview")
        assert "open_positions" in data
        assert "closed_positions" in data
        assert "total_fees_claimed_usd" in data
        assert isinstance(data["open_positions"], int)

    def test_positions_json_is_list(self):
        data = run_json("status", "positions")
        assert isinstance(data, list)
        for pos in data:
            assert "pool_name" in pos
            assert "strategy" in pos
            assert "amount_sol" in pos

    def test_positions_human_readable(self):
        rc, out, _ = run("status", "positions")
        assert rc == 0
        # Either shows positions or "No open positions."
        assert "positions" in out.lower() or "no open" in out.lower()

    def test_config_json_schema(self):
        data = run_json("status", "config")
        # Config may be empty dict if user-config.json doesn't exist
        assert isinstance(data, dict)


# ─── Journal commands ────────────────────────────────────────────


class TestJournal:
    def test_recent_json_is_list(self):
        data = run_json("journal", "recent", "--n", "5")
        assert isinstance(data, list)

    def test_recent_respects_n(self):
        data = run_json("journal", "recent", "--n", "3")
        assert len(data) <= 3

    def test_closes_json_schema(self):
        data = run_json("journal", "closes", "--n", "5")
        assert isinstance(data, list)
        for e in data:
            assert e.get("type") == "close"

    def test_today_json_schema(self):
        data = run_json("journal", "today")
        assert "positions_opened" in data
        assert "positions_closed" in data
        assert "total_pnl_usd" in data

    def test_stats_json_schema(self):
        data = run_json("journal", "stats")
        assert "total_trades" in data
        assert "wins" in data
        assert "losses" in data
        assert "total_pnl_usd" in data

    def test_stats_wins_losses_sum_to_total(self):
        data = run_json("journal", "stats")
        assert data["wins"] + data["losses"] == data["total_trades"]

    def test_recent_human_output(self):
        rc, out, _ = run("journal", "recent", "--n", "5")
        assert rc == 0


# ─── Report commands ─────────────────────────────────────────────


class TestReport:
    def test_daily_json_schema(self):
        data = run_json("report", "daily")
        assert data["period"] == "daily"
        assert "positions_opened" in data
        assert "total_pnl_usd" in data

    def test_weekly_json_schema(self):
        data = run_json("report", "weekly")
        assert data["period"] == "weekly"
        assert data["label"] == "Last 7 Days"

    def test_monthly_json_schema(self):
        data = run_json("report", "monthly")
        assert data["period"] == "monthly"

    def test_report_pnl_type(self):
        data = run_json("report", "daily")
        assert isinstance(data["total_pnl_usd"], (int, float))

    def test_report_human_output(self):
        rc, out, _ = run("report", "daily")
        assert rc == 0
        assert "PnL" in out or "pnl" in out.lower() or "Report" in out


# ─── Config commands ─────────────────────────────────────────────


class TestConfig:
    def test_config_get_all_json(self):
        data = run_json("config", "get")
        assert isinstance(data, dict)

    def test_config_get_key_exists(self):
        # Only run if user-config.json has a known key
        rc, out, _ = run("config", "get", "gasReserve")
        assert rc == 0

    def test_config_get_missing_key(self):
        rc, out, err = run("config", "get", "definitelyNotAKey123")
        # Should exit with nonzero or print "not found"
        assert rc != 0 or "not found" in out.lower()

    def test_config_set_roundtrip(self, tmp_path):
        """Set a value in a temporary config and verify it persists."""
        cfg_file = tmp_path / "user-config.json"
        cfg_file.write_text(json.dumps({"takeProfitFeePct": 5}))
        env = {**os.environ, "MERIDIAN_DIR": str(tmp_path)}

        # Write a fake journal/state so other reads don't fail
        (tmp_path / "journal.json").write_text(json.dumps({"entries": []}))
        (tmp_path / "state.json").write_text(json.dumps({"positions": {}}))

        result = subprocess.run(
            CLI + ["config", "set", "takeProfitFeePct", "8", "--json"],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["old"] == 5
        assert data["new"] == 8

        # Verify file was written
        saved = json.loads(cfg_file.read_text())
        assert saved["takeProfitFeePct"] == 8

    def test_config_set_restart_warning(self, tmp_path):
        """rpcUrl should warn about restart."""
        cfg_file = tmp_path / "user-config.json"
        cfg_file.write_text(json.dumps({}))
        env = {**os.environ, "MERIDIAN_DIR": str(tmp_path)}
        (tmp_path / "journal.json").write_text(json.dumps({"entries": []}))
        (tmp_path / "state.json").write_text(json.dumps({"positions": {}}))

        result = subprocess.run(
            CLI + ["config", "set", "rpcUrl", "https://rpc.example.com", "--json"],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["requires_restart"] is True


# ─── Lessons commands ────────────────────────────────────────────


class TestLessons:
    def test_list_json_is_list(self):
        data = run_json("lessons", "list", "--n", "5")
        assert isinstance(data, list)

    def test_list_type_filter(self):
        rc, out, _ = run("lessons", "list", "--type", "good", "--json")
        if rc == 0 and out.strip():
            data = json.loads(out)
            assert all(l.get("type") == "good" for l in data)

    def test_performance_json_is_list(self):
        data = run_json("lessons", "performance", "--n", "5")
        assert isinstance(data, list)

    def test_summary_json_schema(self):
        data = run_json("lessons", "summary")
        assert "total_records" in data
        assert "win_rate_pct" in data
        assert "lessons_count" in data

    def test_summary_win_rate_range(self):
        data = run_json("lessons", "summary")
        wr = data.get("win_rate_pct")
        if wr is not None:
            assert 0 <= wr <= 100


# ─── Missing file graceful handling ──────────────────────────────


class TestMissingFiles:
    def test_status_overview_no_state(self, tmp_path):
        """Should return zeros when state.json doesn't exist."""
        env = {**os.environ, "MERIDIAN_DIR": str(tmp_path)}
        result = subprocess.run(
            CLI + ["status", "overview", "--json"],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["open_positions"] == 0

    def test_journal_stats_no_journal(self, tmp_path):
        """Should return zeros when journal.json doesn't exist."""
        env = {**os.environ, "MERIDIAN_DIR": str(tmp_path)}
        result = subprocess.run(
            CLI + ["journal", "stats", "--json"],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["total_trades"] == 0

    def test_lessons_summary_no_file(self, tmp_path):
        """Should return zeros when lessons.json doesn't exist."""
        env = {**os.environ, "MERIDIAN_DIR": str(tmp_path)}
        result = subprocess.run(
            CLI + ["lessons", "summary", "--json"],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["total_records"] == 0
