"""
Read and write Meridian user-config.json.

The agent hot-reloads user-config.json every 2 seconds, so writes from this
CLI take effect in the running agent within ~2 seconds without a restart.

Note: rpcUrl, walletKey, dryRun, and schedule intervals require a restart.
"""

import json
from typing import Any, Optional

from cli_anything.meridian.core.paths import config_path

# Fields that require a process restart to take effect
REQUIRES_RESTART = {"rpcUrl", "walletKey", "dryRun", "managementIntervalMin", "screeningIntervalMin", "healthCheckIntervalMin"}

# Numeric fields (for auto-casting from string input)
NUMERIC_FIELDS = {
    "minFeeActiveTvlRatio", "minTvl", "maxTvl", "minVolume", "minOrganic",
    "minHolders", "minMcap", "maxMcap", "minBinStep", "maxBinStep",
    "minTokenFeesSol", "minClaimAmount", "outOfRangeBinsToClose",
    "outOfRangeWaitMinutes", "minVolumeToRebalance", "emergencyPriceDropPct",
    "takeProfitFeePct", "minFeeTvl24h", "minAgeForYieldExit", "minSolToOpen",
    "deployAmountSol", "gasReserve", "positionSizePct", "fastTpPct",
    "trailingActivate", "trailingFloor", "maxPositions", "maxDeployAmount",
    "temperature", "maxTokens", "maxSteps", "binsBelow", "dashboardPort",
    "managementIntervalMin", "screeningIntervalMin", "healthCheckIntervalMin",
}

BOOL_FIELDS = {"dryRun", "dashboardEnabled"}


def load_config() -> dict:
    path = config_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def get_config(key: Optional[str] = None) -> Any:
    cfg = load_config()
    if key is None:
        return cfg
    return cfg.get(key)


def set_config(key: str, value: str) -> dict:
    """
    Write a single key to user-config.json.

    Returns { "key": key, "old": old_value, "new": new_value,
              "requires_restart": bool, "warning": str|None }
    """
    cfg = load_config()
    old_value = cfg.get(key)

    # Cast value to appropriate type
    if key in BOOL_FIELDS:
        parsed: Any = value.lower() in ("true", "1", "yes")
    elif key in NUMERIC_FIELDS:
        try:
            parsed = float(value)
            if parsed == int(parsed):
                parsed = int(parsed)
        except ValueError:
            raise ValueError(f"Key '{key}' expects a number, got: {value!r}")
    else:
        parsed = value

    cfg[key] = parsed
    path = config_path()
    path.write_text(json.dumps(cfg, indent=2))

    warning = None
    if key in REQUIRES_RESTART:
        warning = f"'{key}' requires a process restart to take effect (pm2 restart meridian)"

    return {
        "key": key,
        "old": old_value,
        "new": parsed,
        "requires_restart": key in REQUIRES_RESTART,
        "warning": warning,
    }
