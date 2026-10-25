# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Provisional native-log checks; no launcher or artifact acceptance is provided."""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = json.loads((HERE / "native-cases.json").read_text(encoding="utf-8"))
FILTERS = {case["filter"] for case in CATALOG["cases"]}


def check_log(path, selected_filter, returncode, *, timed_out=False):
    """Check one Mozilla gtest JSONL stream, independently of xpcshell policy.

    Format compatibility with efd2 is pending. log_complete is a structural
    result only; it never certifies the source, binary, fixture or product.
    """
    errors = []
    if selected_filter not in FILTERS:
        errors.append("require one exact catalog filter")
    if returncode != 0:
        errors.append(f"process exit: {returncode}")
    if timed_out:
        errors.append("process timed out")
    suite = CATALOG["suite"]
    state = "before-suite"
    counts = {name: 0 for name in ("suite_start", "group_start", "test_start",
                                  "test_end", "group_end", "suite_end", "test_status")}
    first_failure = None
    try:
        raw = Path(path).read_text(encoding="utf-8")
        if not raw.endswith("\n"):
            errors.append("incomplete JSONL (missing final newline)")
        for line in raw.splitlines():
            event = json.loads(line)
            if not isinstance(event, dict) or not isinstance(event.get("action"), str):
                raise ValueError("event must be an object with an action")
            action = event["action"]
            if action in counts:
                counts[action] += 1
            if "test" in event and event["test"] != selected_filter:
                errors.append("extra or wrong executed case: " + str(event["test"]))
            failure = (
                action == "crash" or event.get("level") in ("ERROR", "CRITICAL", "FATAL")
                or event.get("status") in ("SKIP", "CRASH", "TIMEOUT", "NOTRUN")
                or (action in ("test_status", "test_end")
                    and (event.get("status") != "PASS"
                         or event.get("expected", "PASS") != "PASS"))
            )
            if failure:
                errors.append("non-passing event: " + action)
                if first_failure is None:
                    first_failure = event
            transitions = {
                "suite_start": ("before-suite", "in-suite"),
                "group_start": ("in-suite", "in-group"),
                "test_start": ("in-group", "in-test"),
                "test_end": ("in-test", "after-test"),
                "group_end": ("after-test", "after-group"),
                "suite_end": ("after-group", "finished"),
            }
            if action in transitions:
                before, after = transitions[action]
                if state != before:
                    errors.append("invalid event order: " + action)
                state = after
            elif action == "test_status":
                if state != "in-test":
                    errors.append("assertion outside selected case")
            elif action == "log":
                pass
            else:
                errors.append("unexpected native event: " + action)
            if action == "suite_start" and (
                event.get("source") != "gtest" or event.get("name") != "gtest"
                or event.get("tests") != {}
            ):
                errors.append("wrong native program declaration")
            if action == "suite_end" and event.get("source") != "gtest":
                errors.append("wrong native program completion")
            if action in ("group_start", "group_end") and event.get("name") != suite:
                errors.append("wrong native suite")
            if action in ("test_start", "test_status", "test_end") and event.get("test") != selected_filter:
                errors.append("missing or wrong selected case name")
        if state != "finished" or any(counts[name] != 1 for name in counts if name != "test_status"):
            errors.append("require exactly one complete selected case and suite")
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        errors.append(f"malformed or missing native log: {error}")
    return {"log_complete": not errors, "errors": errors, "counts": counts,
            "selected_filter": selected_filter, "first_failure": first_failure,
            "coverage": "none", "execution_hold": CATALOG["execution_hold"]}
