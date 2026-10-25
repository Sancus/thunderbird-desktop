# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Strict native log and shutdown-output checks, separate from artifact identity."""

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = json.loads((HERE / "native-cases.json").read_text(encoding="utf-8"))
FILTERS = {case["filter"] for case in CATALOG["cases"]}


def check_log(path, selected_filter, returncode, *, timed_out=False):
    """Check one Mozilla gtest JSONL stream, independently of xpcshell policy.

    The efd2 logger closes before XPCOM shutdown. A structurally complete log
    alone never certifies the process, artifacts, fixture or product.
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


# Anchored diagnostics avoid matching expected prose or JSON assertion messages.
DIAGNOSTIC = re.compile(
    r"^(?:\x07)?(?:\[[^\]\r\n]+\]\s*)?(?:"
    r"TEST-UNEXPECTED-FAIL(?:[ |]|$)|PROCESS-CRASH(?:[ |]|$)|"
    r"###!!! (?:ASSERTION|ABORT|BREAK):|Assertion failure:|Hit MOZ_CRASH\(|MOZ_CRASH(?:\(|:)|"
    r"WARNING: Problem removing profile directory|"
    r"==\d+==(?:ERROR|WARNING): (?:Address|Leak|Thread)Sanitizer:|"
    r"SUMMARY: (?:Address|Leak|Thread)Sanitizer:)"
)


def check_output(log, stdout, stderr, selected_filter, returncode, *, timed_out=False):
    result = check_log(log, selected_filter, returncode, timed_out=timed_out)
    console = []
    finished, suite_end = -1, -1
    native_events = {"suite_start", "suite_end", "group_start", "group_end",
                     "test_start", "test_end", "test_status"}
    stdout_events = []
    for stream, path in (("stdout", stdout), ("stderr", stderr)):
        try:
            for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
                try:
                    event = json.loads(line)
                except ValueError:
                    event = None
                bad = False
                if isinstance(event, dict) and "action" in event:
                    bad = (event["action"] == "crash"
                           or event.get("level") in ("ERROR", "CRITICAL", "FATAL")
                           or ("status" in event and event["status"] != "PASS")
                           or event.get("expected", "PASS") != "PASS")
                    if event["action"] in native_events:
                        if stream == "stdout":
                            stdout_events.append(event)
                        else:
                            bad = True
                    if stream == "stdout" and event["action"] == "suite_end":
                        suite_end = number
                else:
                    bad = bool(DIAGNOSTIC.match(line))
                    if stream == "stdout" and line == "Finished running GTest tests.":
                        finished = number
                if bad:
                    console.append({"stream": stream, "line": number, "message": line})
        except (OSError, UnicodeError) as error:
            console.append({"stream": stream, "message": str(error)})
    try:
        expected = [json.loads(line) for line in Path(log).read_text(encoding="utf-8").splitlines()]
        if stdout_events != [e for e in expected if isinstance(e, dict) and e.get("action") in native_events]:
            console.append({"stream": "stdout", "message": "native events differ from dedicated log"})
    except (OSError, UnicodeError, ValueError):
        pass  # check_log already rejects missing/malformed dedicated evidence.
    if finished <= suite_end or suite_end < 0:
        console.append({"stream": "stdout", "message": "missing post-suite XPCOM shutdown completion"})
    if console:
        result["errors"].append("raw output contains failure or incomplete shutdown")
        result["first_failure"] = result["first_failure"] or console[0]
    if result["first_failure"] is None and (returncode != 0 or timed_out):
        result["first_failure"] = {"action": "process_exit", "exit_code": returncode, "timed_out": timed_out}
    result.update(ok=result["log_complete"] and not console, console_failures=console,
                  leak_check="unavailable")
    return result
