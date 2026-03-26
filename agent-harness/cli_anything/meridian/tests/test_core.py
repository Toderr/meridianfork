"""
Unit tests for cli_anything.meridian core modules.

Uses synthetic data — no external dependencies, no filesystem side effects
(journal/state/config reads are monkeypatched).
"""

import json
import pytest
from unittest.mock import patch
from pathlib import Path


# ─── Fixtures ────────────────────────────────────────────────────

SAMPLE_JOURNAL = {
    "entries": [
        {
            "id": 1000,
            "type": "open",
            "timestamp": "2026-03-24T10:00:00.000Z",
            "position": "POS1",
            "pool": "POOL1",
            "pool_name": "WIZARD-SOL",
            "strategy": "bid_ask",
            "amount_sol": 0.5,
            "initial_value_usd": 85.0,
            "sol_price": 170.0,
        },
        {
            "id": 2000,
            "type": "close",
            "timestamp": "2026-03-24T11:00:00.000Z",
            "position": "POS1",
            "pool": "POOL1",
            "pool_name": "WIZARD-SOL",
            "strategy": "bid_ask",
            "amount_sol": 0.5,
            "initial_value_usd": 85.0,
            "final_value_usd": 88.5,
            "fees_earned_usd": 3.5,
            "pnl_usd": 3.5,
            "pnl_sol": 0.0206,
            "pnl_pct": 4.12,
            "minutes_held": 60,
            "range_efficiency": 100.0,
            "close_reason": "take profit",
        },
        {
            "id": 3000,
            "type": "close",
            "timestamp": "2026-03-24T13:00:00.000Z",
            "position": "POS2",
            "pool": "POOL2",
            "pool_name": "CHIBI-SOL",
            "strategy": "spot",
            "amount_sol": 0.3,
            "initial_value_usd": 51.0,
            "final_value_usd": 50.8,
            "fees_earned_usd": 0.1,
            "pnl_usd": -0.2,
            "pnl_sol": -0.0012,
            "pnl_pct": -0.39,
            "minutes_held": 120,
            "range_efficiency": 60.0,
            "close_reason": "price pumped above range",
        },
        {
            "id": 4000,
            "type": "claim",
            "timestamp": "2026-03-24T12:00:00.000Z",
            "position": "POS3",
            "pool": "POOL3",
            "pool_name": "BONK-SOL",
            "fees_usd": 1.5,
            "fees_sol": 0.0088,
            "sol_price": 170.0,
        },
    ]
}

SAMPLE_STATE = {
    "positions": {
        "POS3": {
            "position": "POS3",
            "pool": "POOL3",
            "pool_name": "BONK-SOL",
            "strategy": "bid_ask",
            "amount_sol": 0.4,
            "initial_value_usd": 68.0,
            "deployed_at": "2026-03-24T08:00:00.000Z",
            "out_of_range_since": None,
            "closed": False,
            "closed_at": None,
            "total_fees_claimed_usd": 1.5,
            "rebalance_count": 0,
            "notes": [],
            "bin_step": 100,
            "volatility": 2,
            "organic_score": 75,
        }
    },
    "recentEvents": [
        {"ts": "2026-03-24T08:00:00.000Z", "action": "deploy", "pool_name": "BONK-SOL"}
    ],
    "lastUpdated": "2026-03-24T12:00:00.000Z",
}

SAMPLE_CONFIG = {
    "rpcUrl": "https://api.mainnet-beta.solana.com",
    "takeProfitFeePct": 5,
    "gasReserve": 0.2,
    "deployAmountSol": 0.5,
    "managementModel": "minimax/minimax-m2.7",
}

SAMPLE_LESSONS = {
    "lessons": [
        {
            "rule": "Avoid pools with volatility > 8; range blows out within 30m.",
            "type": "bad",
            "created_at": "2026-03-23T10:00:00.000Z",
            "pool_name": "DEGEN-SOL",
        },
        {
            "rule": "bid_ask on high volatility pools earns 2x fees vs spot.",
            "type": "good",
            "created_at": "2026-03-24T09:00:00.000Z",
            "pool_name": "WIZARD-SOL",
        },
    ],
    "performance": [
        {
            "position": "POS1",
            "pool_name": "WIZARD-SOL",
            "strategy": "bid_ask",
            "pnl_usd": 3.5,
            "pnl_pct": 4.12,
            "minutes_held": 60,
            "recorded_at": "2026-03-24T11:00:00.000Z",
        },
        {
            "position": "POS2",
            "pool_name": "CHIBI-SOL",
            "strategy": "spot",
            "pnl_usd": -0.2,
            "pnl_pct": -0.39,
            "minutes_held": 120,
            "recorded_at": "2026-03-24T13:00:00.000Z",
        },
    ],
}


# ─── Journal tests ───────────────────────────────────────────────


class TestJournal:
    def _patch(self):
        return patch(
            "cli_anything.meridian.core.journal.load_entries",
            return_value=SAMPLE_JOURNAL["entries"],
        )

    def test_recent_returns_last_n(self):
        with self._patch():
            from cli_anything.meridian.core import journal
            result = journal.recent(n=2)
            assert len(result) == 2
            assert result[-1]["id"] == 4000

    def test_recent_closes(self):
        with self._patch():
            from cli_anything.meridian.core import journal
            closes = journal.recent_closes(n=5)
            assert all(e["type"] == "close" for e in closes)
            assert len(closes) == 2

    def test_all_time_stats_correct(self):
        with self._patch():
            from cli_anything.meridian.core import journal
            stats = journal.all_time_stats()
            assert stats["total_trades"] == 2
            assert stats["wins"] == 1
            assert stats["losses"] == 1
            assert stats["win_rate_pct"] == 50
            # Net PnL: 3.5 + (-0.2) = 3.3
            assert abs(stats["total_pnl_usd"] - 3.3) < 0.01

    def test_period_report_daily(self):
        with self._patch():
            from cli_anything.meridian.core import journal
            report = journal.period_report("daily")
            assert report["period"] == "daily"
            assert "positions_opened" in report
            assert "total_pnl_usd" in report

    def test_filter_by_type(self):
        from cli_anything.meridian.core.journal import filter_entries
        entries = SAMPLE_JOURNAL["entries"]
        opens = filter_entries(entries, type_="open")
        assert all(e["type"] == "open" for e in opens)
        assert len(opens) == 1

    def test_filter_by_timestamp(self):
        from cli_anything.meridian.core.journal import filter_entries
        entries = SAMPLE_JOURNAL["entries"]
        result = filter_entries(entries, from_ts="2026-03-24T11:30:00")
        assert all(e["timestamp"] >= "2026-03-24T11:30:00" for e in result)


# ─── State tests ─────────────────────────────────────────────────


class TestState:
    def _patch(self):
        return patch(
            "cli_anything.meridian.core.state.load_state",
            return_value=SAMPLE_STATE,
        )

    def test_get_open_positions(self):
        with self._patch():
            from cli_anything.meridian.core import state
            positions = state.get_open_positions()
            assert len(positions) == 1
            assert positions[0]["pool_name"] == "BONK-SOL"

    def test_get_overview(self):
        with self._patch():
            from cli_anything.meridian.core import state
            overview = state.get_overview()
            assert overview["open_positions"] == 1
            assert overview["closed_positions"] == 0
            assert overview["total_fees_claimed_usd"] == 1.5

    def test_summarize_positions(self):
        with self._patch():
            from cli_anything.meridian.core import state
            summary = state.summarize_positions()
            assert len(summary) == 1
            pos = summary[0]
            assert pos["pool_name"] == "BONK-SOL"
            assert pos["age_minutes"] is not None
            assert pos["minutes_out_of_range"] == 0

    def test_position_age_is_positive(self):
        from cli_anything.meridian.core.state import position_age_minutes
        pos = {"deployed_at": "2020-01-01T00:00:00.000Z"}
        age = position_age_minutes(pos)
        assert age is not None
        assert age > 0

    def test_minutes_out_of_range_zero_when_in_range(self):
        from cli_anything.meridian.core.state import minutes_out_of_range
        pos = {"out_of_range_since": None}
        assert minutes_out_of_range(pos) == 0


# ─── Config tests ─────────────────────────────────────────────────


class TestConfig:
    def _patch_load(self):
        return patch(
            "cli_anything.meridian.core.config.load_config",
            return_value=dict(SAMPLE_CONFIG),
        )

    def test_get_config_all(self):
        with self._patch_load():
            from cli_anything.meridian.core import config
            result = config.get_config()
            assert result["takeProfitFeePct"] == 5

    def test_get_config_key(self):
        with self._patch_load():
            from cli_anything.meridian.core import config
            result = config.get_config("gasReserve")
            assert result == 0.2

    def test_get_config_missing_key(self):
        with self._patch_load():
            from cli_anything.meridian.core import config
            result = config.get_config("nonExistentKey")
            assert result is None

    def test_set_config_numeric(self, tmp_path):
        cfg_file = tmp_path / "user-config.json"
        cfg_file.write_text(json.dumps({"takeProfitFeePct": 5}))
        with patch("cli_anything.meridian.core.config.config_path", return_value=cfg_file):
            from cli_anything.meridian.core import config
            result = config.set_config("takeProfitFeePct", "8")
            assert result["old"] == 5
            assert result["new"] == 8
            assert result["requires_restart"] is False
            saved = json.loads(cfg_file.read_text())
            assert saved["takeProfitFeePct"] == 8

    def test_set_config_bool(self, tmp_path):
        cfg_file = tmp_path / "user-config.json"
        cfg_file.write_text(json.dumps({"dryRun": False}))
        with patch("cli_anything.meridian.core.config.config_path", return_value=cfg_file):
            from cli_anything.meridian.core import config
            result = config.set_config("dryRun", "true")
            assert result["new"] is True

    def test_set_config_requires_restart(self, tmp_path):
        cfg_file = tmp_path / "user-config.json"
        cfg_file.write_text(json.dumps({}))
        with patch("cli_anything.meridian.core.config.config_path", return_value=cfg_file):
            from cli_anything.meridian.core import config
            result = config.set_config("rpcUrl", "https://new-rpc.com")
            assert result["requires_restart"] is True
            assert result["warning"] is not None

    def test_set_config_invalid_numeric(self, tmp_path):
        cfg_file = tmp_path / "user-config.json"
        cfg_file.write_text(json.dumps({}))
        with patch("cli_anything.meridian.core.config.config_path", return_value=cfg_file):
            from cli_anything.meridian.core import config
            with pytest.raises(ValueError):
                config.set_config("takeProfitFeePct", "not-a-number")


# ─── Lessons tests ───────────────────────────────────────────────


class TestLessons:
    def _patch(self):
        return patch(
            "cli_anything.meridian.core.lessons.load_lessons_data",
            return_value=dict(SAMPLE_LESSONS),
        )

    def test_get_lessons_all(self):
        with self._patch():
            from cli_anything.meridian.core import lessons
            result = lessons.get_lessons()
            assert len(result) == 2

    def test_get_lessons_by_type(self):
        with self._patch():
            from cli_anything.meridian.core import lessons
            result = lessons.get_lessons(lesson_type="good")
            assert all(l["type"] == "good" for l in result)
            assert len(result) == 1

    def test_get_performance(self):
        with self._patch():
            from cli_anything.meridian.core import lessons
            result = lessons.get_performance()
            assert len(result) == 2

    def test_performance_summary(self):
        with self._patch():
            from cli_anything.meridian.core import lessons
            summary = lessons.performance_summary()
            assert summary["total_records"] == 2
            assert summary["win_rate_pct"] == 50
            assert summary["lessons_count"] == 2


# ─── Formatting tests ────────────────────────────────────────────


class TestFormatting:
    def test_pnl_str_positive(self):
        from cli_anything.meridian.utils.formatting import pnl_str
        result = pnl_str(3.5, 0.0206, 4.12)
        assert "+$3.50" in result
        assert "+0.0206 SOL" in result
        assert "+4.12%" in result

    def test_pnl_str_negative(self):
        from cli_anything.meridian.utils.formatting import pnl_str
        result = pnl_str(-0.2, -0.0012, -0.39)
        assert "-$0.20" in result

    def test_pnl_str_none(self):
        from cli_anything.meridian.utils.formatting import pnl_str
        result = pnl_str(None, None, None)
        assert result == "N/A"

    def test_age_str_minutes(self):
        from cli_anything.meridian.utils.formatting import age_str
        assert age_str(45) == "45m"

    def test_age_str_hours(self):
        from cli_anything.meridian.utils.formatting import age_str
        assert age_str(90) == "1h 30m"

    def test_age_str_none(self):
        from cli_anything.meridian.utils.formatting import age_str
        assert age_str(None) == "?"

    def test_format_position_row(self):
        from cli_anything.meridian.utils.formatting import format_position_row
        pos = {
            "pool_name": "WIZARD-SOL",
            "strategy": "bid_ask",
            "amount_sol": 0.5,
            "age_minutes": 74,
            "minutes_out_of_range": 0,
            "instruction": None,
        }
        row = format_position_row(pos)
        assert "WIZARD-SOL" in row
        assert "bid_ask" in row

    def test_format_close_row(self):
        from cli_anything.meridian.utils.formatting import format_close_row
        entry = {
            "pool_name": "CHIBI-SOL",
            "pnl_usd": -0.2,
            "pnl_sol": -0.0012,
            "pnl_pct": -0.39,
            "timestamp": "2026-03-24T13:00:00.000Z",
            "minutes_held": 120,
            "close_reason": "price pumped above range",
        }
        row = format_close_row(entry)
        assert "CHIBI-SOL" in row
