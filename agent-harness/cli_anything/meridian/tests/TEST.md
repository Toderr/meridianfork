# TEST PLAN — cli-anything-meridian

## Overview

Two test suites:

| Suite | File | Type | Dependencies |
|-------|------|------|--------------|
| Unit | `test_core.py` | Synthetic data, monkeypatched I/O | None |
| E2E | `test_full_e2e.py` | Real CLI subprocess, real files | `cli-anything-meridian` in PATH |

## Unit Test Plan (`test_core.py`)

### TestJournal
- `test_recent_returns_last_n` — `recent(n=2)` returns exactly 2 entries
- `test_recent_closes` — all returned entries have `type == "close"`
- `test_all_time_stats_correct` — wins/losses/PnL computed correctly
- `test_period_report_daily` — period_report returns dict with expected keys
- `test_filter_by_type` — filter_entries respects type filter
- `test_filter_by_timestamp` — filter_entries respects from_ts bound

### TestState
- `test_get_open_positions` — only non-closed positions returned
- `test_get_overview` — counts, fees, lastUpdated correct
- `test_summarize_positions` — age_minutes and minutes_out_of_range populated
- `test_position_age_is_positive` — past deployed_at gives positive age
- `test_minutes_out_of_range_zero_when_in_range` — None OOR timestamp → 0

### TestConfig
- `test_get_config_all` — returns full config dict
- `test_get_config_key` — returns single value by key
- `test_get_config_missing_key` — returns None for unknown key
- `test_set_config_numeric` — casts string→int, writes file, returns old/new
- `test_set_config_bool` — "true" → True
- `test_set_config_requires_restart` — rpcUrl sets requires_restart=True
- `test_set_config_invalid_numeric` — raises ValueError on non-numeric input

### TestLessons
- `test_get_lessons_all` — returns all lessons
- `test_get_lessons_by_type` — filters by type correctly
- `test_get_performance` — returns performance records
- `test_performance_summary` — win_rate and counts correct

### TestFormatting
- `test_pnl_str_positive` — formats +$X.XX | +X.XXXX SOL | +X.XX%
- `test_pnl_str_negative` — formats -$X.XX with correct sign
- `test_pnl_str_none` — returns "N/A" for all-None input
- `test_age_str_minutes` — 45 → "45m"
- `test_age_str_hours` — 90 → "1h 30m"
- `test_age_str_none` — None → "?"
- `test_format_position_row` — pool name and strategy present in output
- `test_format_close_row` — pool name present in output

## E2E Test Plan (`test_full_e2e.py`)

Uses `CLI_ANYTHING_FORCE_INSTALLED=1` + `_resolve_cli()` to find binary.

### TestSmoke
- CLI exits 0 and shows help text
- `--version` shows "0.1.0"
- All 5 command group `--help` work

### TestStatus
- `status overview --json` returns valid schema
- `status positions --json` returns list with pool_name/strategy/amount_sol
- `status positions` human output has expected words
- `status config --json` returns a dict

### TestJournal
- `journal recent --json` returns list
- `--n 3` returns ≤ 3 items
- `journal closes --json` all entries are type=close
- `journal today --json` has positions_opened, total_pnl_usd
- `journal stats --json` has wins+losses == total_trades
- Human output exits 0

### TestReport
- `report daily/weekly/monthly --json` return correct period/label fields
- PnL fields are numeric

### TestConfig
- `config get --json` returns dict
- `config get KEY` exits 0
- `config get MISSING` exits nonzero or prints "not found"
- `config set KEY VALUE --json` round-trips (writes file, old/new correct)
- `config set rpcUrl` returns requires_restart=True

### TestLessons
- `lessons list --json` returns list
- `--type good` filters correctly
- `lessons performance --json` returns list
- `lessons summary --json` has correct schema

### TestMissingFiles
- All commands handle missing files gracefully (return zeros, exit 0)

## Running Tests

```bash
cd agent-harness

# Unit tests only
python3 -m pytest cli_anything/meridian/tests/test_core.py -v

# E2E tests (requires installation and MERIDIAN_DIR)
MERIDIAN_DIR=/path/to/meridianfork python3 -m pytest cli_anything/meridian/tests/test_full_e2e.py -v

# All tests
MERIDIAN_DIR=/path/to/meridianfork python3 -m pytest cli_anything/meridian/tests/ -v --tb=short
```

---

## Test Results

```
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-7.4.4, pluggy-1.4.0
collected 66 items

cli_anything/meridian/tests/test_core.py::TestJournal::test_recent_returns_last_n PASSED
cli_anything/meridian/tests/test_core.py::TestJournal::test_recent_closes PASSED
cli_anything/meridian/tests/test_core.py::TestJournal::test_all_time_stats_correct PASSED
cli_anything/meridian/tests/test_core.py::TestJournal::test_period_report_daily PASSED
cli_anything/meridian/tests/test_core.py::TestJournal::test_filter_by_type PASSED
cli_anything/meridian/tests/test_core.py::TestJournal::test_filter_by_timestamp PASSED
cli_anything/meridian/tests/test_core.py::TestState::test_get_open_positions PASSED
cli_anything/meridian/tests/test_core.py::TestState::test_get_overview PASSED
cli_anything/meridian/tests/test_core.py::TestState::test_summarize_positions PASSED
cli_anything/meridian/tests/test_core.py::TestState::test_position_age_is_positive PASSED
cli_anything/meridian/tests/test_core.py::TestState::test_minutes_out_of_range_zero_when_in_range PASSED
cli_anything/meridian/tests/test_core.py::TestConfig::test_get_config_all PASSED
cli_anything/meridian/tests/test_core.py::TestConfig::test_get_config_key PASSED
cli_anything/meridian/tests/test_core.py::TestConfig::test_get_config_missing_key PASSED
cli_anything/meridian/tests/test_core.py::TestConfig::test_set_config_numeric PASSED
cli_anything/meridian/tests/test_core.py::TestConfig::test_set_config_bool PASSED
cli_anything/meridian/tests/test_core.py::TestConfig::test_set_config_requires_restart PASSED
cli_anything/meridian/tests/test_core.py::TestConfig::test_set_config_invalid_numeric PASSED
cli_anything/meridian/tests/test_core.py::TestLessons::test_get_lessons_all PASSED
cli_anything/meridian/tests/test_core.py::TestLessons::test_get_lessons_by_type PASSED
cli_anything/meridian/tests/test_core.py::TestLessons::test_get_performance PASSED
cli_anything/meridian/tests/test_core.py::TestLessons::test_performance_summary PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_pnl_str_positive PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_pnl_str_negative PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_pnl_str_none PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_age_str_minutes PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_age_str_hours PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_age_str_none PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_format_position_row PASSED
cli_anything/meridian/tests/test_core.py::TestFormatting::test_format_close_row PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestSmoke::test_help PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestSmoke::test_version PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestSmoke::test_status_help PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestSmoke::test_journal_help PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestSmoke::test_report_help PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestSmoke::test_config_help PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestSmoke::test_lessons_help PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestStatus::test_overview_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestStatus::test_positions_json_is_list PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestStatus::test_positions_human_readable PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestStatus::test_config_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestJournal::test_recent_json_is_list PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestJournal::test_recent_respects_n PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestJournal::test_closes_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestJournal::test_today_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestJournal::test_stats_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestJournal::test_stats_wins_losses_sum_to_total PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestJournal::test_recent_human_output PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestReport::test_daily_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestReport::test_weekly_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestReport::test_monthly_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestReport::test_report_pnl_type PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestReport::test_report_human_output PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestConfig::test_config_get_all_json PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestConfig::test_config_get_key_exists PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestConfig::test_config_get_missing_key PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestConfig::test_config_set_roundtrip PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestConfig::test_config_set_restart_warning PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestLessons::test_list_json_is_list PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestLessons::test_list_type_filter PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestLessons::test_performance_json_is_list PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestLessons::test_summary_json_schema PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestLessons::test_summary_win_rate_range PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestMissingFiles::test_status_overview_no_state PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestMissingFiles::test_journal_stats_no_journal PASSED
cli_anything/meridian/tests/test_full_e2e.py::TestMissingFiles::test_lessons_summary_no_file PASSED

============================== 66 passed in 5.31s ==============================
```

**66 passed, 0 failed** — 100% pass rate.
