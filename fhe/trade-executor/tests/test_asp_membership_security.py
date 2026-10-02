import os
import subprocess
import sys


def _allow_fail_open_for(env_name: str) -> str:
    env = os.environ.copy()
    env.update(
        {
            "SIPHON_ENV": env_name,
            "ASP_ALLOW_LABEL_FAIL_OPEN": "1",
        }
    )
    result = subprocess.run(
        [sys.executable, "-c", "import asp_membership; print(asp_membership._ALLOW_FAIL_OPEN)"],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return result.stdout.strip()


def test_fail_open_override_is_disabled_in_production():
    assert _allow_fail_open_for("production") == "False"
    assert _allow_fail_open_for("mainnet") == "False"


def test_fail_open_override_remains_available_for_local_fault_testing():
    assert _allow_fail_open_for("development") == "True"
