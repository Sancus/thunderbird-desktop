# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Run explicit source-manifest cases and reject incomplete acceptance evidence."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
CONTRACTS = {"mbox": "berkeleystore", "maildir": "maildirstore"}


def _expected_folder_parents(case):
    if "folder_parent_uris" not in case:
        return None
    parents = case["folder_parent_uris"]
    roles = case.get("folder_roles", {})
    if (case.get("diagnostics") != "folder" or not isinstance(roles, dict) or not roles
        or not isinstance(parents, dict) or set(parents) != set(roles)
        or any(not isinstance(uri, str) or not re.fullmatch(r"mailbox://[^\s/?#\\]+", uri)
               for uri in parents.values())):
        raise ValueError("folder parent URIs require exactly every role and literal mailbox roots")
    return parents


def check_log(log, case, returncode=0, raw_logs=()):
    """Check one raw mozlog file against a tuple declared before execution."""
    errors = [] if returncode == 0 else [f"process exit: {returncode}"]
    starts, ends, suites, suite_ends = [], [], [], 0
    backends, folders, contracts, phases, modes = [], [], {}, [], []
    active = False
    assertions = 0
    tasks, task_assertions = [], 0
    declared_tasks = case.get("tasks", [])
    counts = dict.fromkeys(declared_tasks, 0)
    setup_events, setup_assertions, setup_backends = [], 0, 0
    is_format = case["diagnostics"] == "format-reader"
    first_failure, folder_evidence = None, {}
    try:
        expected_parents = _expected_folder_parents(case)
        raw = Path(log).read_text(encoding="utf-8")
        if not raw.endswith("\n"):
            errors.append("incomplete JSONL (missing final newline)")
        events = [json.loads(line) for line in raw.splitlines()]
        for event in events:
            if not isinstance(event, dict) or not isinstance(event.get("action"), str):
                raise ValueError("event must be an object with an action")
            action = event["action"]
            assertion = case.get("requires_non_debug") and any(
                "###!!! ASSERTION" in str(event.get(k, "")) for k in ("data", "message"))
            if assertion:
                errors.append("raw assertion diagnostic in non-DEBUG control")
            if first_failure is None and (
                assertion or action == "crash" or event.get("level") in ("ERROR", "CRITICAL", "FATAL")
                or (action in ("test_status", "test_end")
                    and (event.get("status") != "PASS"
                         or event.get("expected", "PASS") != "PASS"))
            ):
                first_failure = {k: event[k] for k in
                                 ("action", "test", "subtest", "status", "expected",
                                  "message", "stack", "data") if k in event}
            if action == "suite_start":
                selected = event.get("tests", {})
                suites.append([v for group in selected.values() for v in group])
            if action == "suite_end":
                suite_ends += 1
                if active or len(ends) != 1:
                    errors.append("suite ended before requested case completed")
            if "test" in event and event["test"] != case["file"]:
                errors.append(f"extra case: {event['test']}")
            if action == "test_start":
                if active or ends or len(suites) != 1 or suite_ends:
                    errors.append("invalid test_start order")
                starts.append(event.get("test"))
                active = True
            if action == "test_status":
                assertions += 1
                if setup_events == ["pending"]:
                    setup_assertions += 1
                if tasks == [(case.get("task"), "pending")]:
                    task_assertions += 1
                if tasks and tasks[-1][1] == "pending" and tasks[-1][0] in counts:
                    counts[tasks[-1][0]] += 1
            if action in ("test_status", "test_end"):
                if not active:
                    errors.append("result outside active case")
                if event.get("status") != "PASS" or event.get("expected", "PASS") != "PASS":
                    errors.append(f"non-passing {action}: {event.get('status')}")
            if action == "test_end":
                ends.append(event.get("test"))
                active = False
            if action == "crash" or event.get("status") in ("SKIP", "CRASH", "TIMEOUT", "NOTRUN"):
                errors.append(f"rejected event: {action}/{event.get('status')}")
            if event.get("level") in ("ERROR", "CRITICAL", "FATAL"):
                errors.append("harness or test error: " + event.get("message", ""))
            message = event.get("message", "") if action == "log" else ""
            # xpcshell info() adds literal enclosing quotes, not JSON escaping.
            if message.startswith('"DELIVERY_') and message.endswith('"'):
                message = message[1:-1]
            if case.get("task") or declared_tasks:
                task = re.fullmatch(
                    r"\(xpcshell/head\.js\) \| test(?: (test_\w+))? (pending|finished) \(\d+\)", message)
                if task:
                    if not active:
                        errors.append("task event outside active file")
                    name, state = task.groups()
                    if name:
                        if case.get("anonymous_setup") and setup_events != ["pending", "finished"]:
                            errors.append("task started before anonymous setup completed")
                        tasks.append((name, state))
                    elif case.get("anonymous_setup"):
                        if tasks:
                            errors.append("anonymous setup after named task")
                        setup_events.append(state)
            if message.startswith("DELIVERY_"):
                if is_format:
                    errors.append("format-reader case unexpectedly claimed product evidence")
                if not active:
                    errors.append("diagnostic outside active case")
                kind, payload = message.split(" ", 1)
                data = json.loads(payload)
                if not isinstance(data, dict):
                    raise ValueError("diagnostic must be an object")
                if kind == "DELIVERY_BACKEND":
                    backends.append(data)
                    if case.get("anonymous_setup"):
                        if setup_events != ["pending"]:
                            errors.append("backend evidence outside anonymous setup")
                        else:
                            setup_backends += 1
                elif kind == "DELIVERY_STORE_CONTRACT":
                    contracts[data["folderURI"]] = data
                elif kind == "DELIVERY_FOLDER":
                    prior = contracts.get(data.get("folderURI"))
                    if prior and "defaulted" not in data and "defaulted" in prior:
                        data = {**data, "defaulted": prior["defaulted"]}
                    folders.append(data)
                    if not prior or prior.get("contractBefore") != data.get("contractBefore"):
                        errors.append("missing prior store-contract observation")
                elif kind == "DELIVERY_IMAP_FIXTURE":
                    modes.append(data)
                elif kind == "DELIVERY_PHASE":
                    phases.append(data.get("phase"))
        if case.get("requires_non_debug"):
            if len(raw_logs) != 2:
                errors.append("non-DEBUG control requires both raw output streams")
            for path in raw_logs:
                text = Path(path).read_text(encoding="utf-8", errors="replace")
                if "###!!! ASSERTION" in text:
                    errors.append("raw assertion diagnostic: " + str(path))
                    if first_failure is None:
                        first_failure = {"action": "process_output", "message": next(
                            line for line in text.splitlines() if "###!!! ASSERTION" in line)}
        if suites != [[case["file"]]] or suite_ends != 1:
            errors.append("suite selection/completion differs from requested case")
        if starts != [case["file"]] or ends != [case["file"]]:
            errors.append("require exactly one requested file start and end")
        if not is_format and (not backends or any(
            d.get("expected") != case["backend"] or d.get("actualBackend") != case["backend"]
            for d in backends
        )):
            errors.append("missing or mismatched backend evidence")
        if case.get("task") and (tasks != [(case["task"], "pending"), (case["task"], "finished")]
                                 or not task_assertions):
            errors.append("require one complete requested task with assertions")
        expected_tasks = [(name, state) for name in declared_tasks for state in ("pending", "finished")]
        if declared_tasks and (tasks != expected_tasks or not all(counts.values())):
            errors.append("require every declared task to finish with assertions")
        if case.get("anonymous_setup") and (setup_events != ["pending", "finished"]
                                             or not setup_assertions or not setup_backends):
            errors.append("require anonymous setup with assertions and backend evidence")
        if (case.get("task") or case.get("anonymous_setup")) and any(d.get("store") != "none" or d.get("scope") != "metadata-only"
                                    for d in backends):
            errors.append("metadata-only case must not claim body-store coverage")
        if case.get("phase") and case["phase"] not in phases:
            errors.append("missing required completion phase")
        if case["id"].startswith("imap:") and (not modes or any(
            d.get("mode") != case["fixture"] or d.get("backend") != case["backend"]
            or d.get("store") != case["store"]
            or (case.get("selector") and d.get("discoveryCase") != case["selector"]) for d in modes
        )):
            errors.append("missing or mismatched IMAP fixture mode")
        if case["diagnostics"] == "folder":
            if not folders:
                errors.append("missing folder/store evidence")
            for d in folders:
                wanted = "@mozilla.org/msgstore/" + CONTRACTS[case["store"]] + ";1"
                if (not d.get("folderURI") or d.get("backend") != case["backend"]
                    or d.get("expectedStore") != case["store"]
                    or d.get("actualStore") != case["store"]
                    or "contractBefore" not in d or not isinstance(d.get("defaulted"), bool)
                    or d["defaulted"] != (not d["contractBefore"])
                    or (d["contractBefore"] and d["contractBefore"] != wanted)):
                    errors.append("mismatched folder/store evidence")
            for role, name in case.get("folder_roles", {}).items():
                matching = {d["folderURI"] for d in folders
                            if unquote(d["folderURI"].rsplit("/", 1)[-1]) == name}
                if len(matching) != 1:
                    errors.append("missing or ambiguous folder evidence: " + role)
                else:
                    folder_evidence[role] = matching.pop()
            if expected_parents is not None:
                for role, parent in expected_parents.items():
                    if role in folder_evidence and folder_evidence[role].rsplit("/", 1)[0] != parent:
                        errors.append("mismatched parent URI for folder role: " + role)
            elif len({uri.rsplit("/", 1)[0] for uri in folder_evidence.values()}) > 1:
                errors.append("declared fixture folders do not share a parent")
        elif is_format:
            if not assertions:
                errors.append("format-reader case executed no assertions")
        elif folders or contracts:
            errors.append("raw DB case unexpectedly claimed folder/store coverage")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        errors.append(f"malformed or missing log: {error}")
    if case["readiness"] == "pending-contract":
        errors.append("contract approval is pending")
    return {"ok": not errors, "errors": errors,
            "factory_blocked": any(p + "-factory" in phases and p + "-ready" not in phases
                                   for p in ("imap", "news")),
            "coverage": case["diagnostics"] if not errors else "none",
            "assertion_count": assertions,
            "first_failure": first_failure, "last_phase": phases[-1] if phases else None,
            "folder_evidence": folder_evidence,
            "completed_phase": case.get("phase") if not errors else None}


def prepare(config, case):
    """Resolve native source paths and reject mismatched manifest declarations."""
    source = Path(config["source"])
    comm = source / "comm"
    manifest = (comm / case["manifest"]).resolve()
    if not manifest.is_relative_to(comm.resolve()) or Path(case["file"]).name != case["file"]:
        raise ValueError("case paths must remain in source comm/")
    is_format = case["fixture"] == "format-reader"
    if is_format:
        if (case["backend"] is not None or case["store"] is not None
            or case["diagnostics"] != "format-reader" or case.get("phase")):
            raise ValueError("format-reader cases must not declare a backend/store/phase")
    else:
        if case["backend"] not in ("mork", "panorama") or case["store"] not in (*CONTRACTS, "none"):
            raise ValueError("invalid expected tuple")
        if case["diagnostics"] != ("backend" if case["store"] == "none" else "folder"):
            raise ValueError("diagnostic policy must match fixture scope")
        if (case["store"] == "none") != (case["fixture"] == "raw-db"):
            raise ValueError("store=none is reserved for raw DB fixtures")
    roles = case.get("folder_roles", {})
    if (not isinstance(roles, dict) or (roles and case["diagnostics"] != "folder")
        or any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z][A-Za-z0-9]*)*", name)
               for name in roles.values()) or len(set(roles.values())) != len(roles)):
        raise ValueError("folder roles require distinct literal fixture names and folder scope")
    _expected_folder_parents(case)
    if case["readiness"] not in ("ready", "pending-product", "pending-contract"):
        raise ValueError("invalid readiness")
    if case["readiness"] == "pending-contract":
        raise ValueError("contract approval is pending; do not run")
    doc = tomllib.loads(manifest.read_text(encoding="utf-8"))
    entry = doc[case["file"]]
    defaults = doc["DEFAULT"]
    for section in (defaults, entry):
        if any(k in section for k in ("skip-if", "fail-if", "run-if", "disabled", "expected")):
            raise ValueError("conditional or expected-failure case is not acceptance")
    if is_format:
        if any(section.get("head", "") or section.get("prefs") or section.get("environment")
               for section in (defaults, entry)):
            raise ValueError("format-reader manifest must have no product heads, prefs or environment")
    else:
        env = dict(v.split("=", 1) for v in entry.get("environment", defaults["environment"]))
        lane = case["backend"] + ":" + case["store"]
        if env.get("PANORAMA_DELIVERY_EXPECT") != lane or "MOZ_AUTOMATION" in env:
            raise ValueError("manifest environment differs from declared tuple")
        prefs = dict(v.split("=", 1) for v in defaults.get("prefs", []) + entry.get("prefs", []))
        if prefs.get("mail.panorama.enabled") != str(case["backend"] == "panorama").lower():
            raise ValueError("manifest backend preference differs from declared tuple")
        if case.get("selector") and prefs.get("mail.test.panorama.discovery_case") != case["selector"]:
            raise ValueError("manifest discovery selector differs from declared case")
        if case["fixture"] == "preconfigured-store":
            contract = "@mozilla.org/msgstore/" + CONTRACTS[case["store"]] + ";1"
            if any(prefs.get(p) != contract for p in (
                "mail.serverDefaultStoreContractID", "mail.server.default.storeContractID"
            )):
                raise ValueError("preconfigured fixture must set both store preferences")
    module_pairs = []
    paths = [manifest] + [manifest.parent / name for name in doc if name != "DEFAULT"]
    if "tasks" in case:
        raw_tasks = case["fixture"] == "raw-db" and case["store"] == "none"
        names = case["tasks"]
        setups = case.get("setups", [])
        if (case.get("task") or case["backend"] != "panorama"
            or (not raw_tasks and case["fixture"] != "preconfigured-store")
            or (raw_tasks and (case.get("anonymous_setup") is not True or setups))
            or (not raw_tasks and case.get("anonymous_setup"))
            or not isinstance(names, list) or not names
            or not isinstance(setups, list)
            or any(not isinstance(n, str) or not re.fullmatch(r"test_\w+", n) for n in names)
            or any(not isinstance(n, str) or not re.fullmatch(r"\w+", n) for n in setups)
            or len(set(names)) != len(names) or len(set(setups)) != len(setups)):
            raise ValueError("invalid named tasks/setup declaration")
        text = (manifest.parent / case["file"]).read_text(encoding="utf-8")
        for kind, wanted in (("task", names), ("setup", setups)):
            actual = re.findall(r"\badd_" + kind + r"\s*\(\s*(?:async\s+)?function\s+(\w+)\s*\(", text)
            anonymous = int(raw_tasks and kind == "setup")
            if anonymous and len(re.findall(r"\badd_setup\s*\(\s*(?:async\s+)?function\s*\(", text)) != 1:
                raise ValueError("raw DB named tasks/setup require one anonymous setup")
            if actual != wanted or len(re.findall(r"\badd_" + kind + r"\s*\(", text)) != len(wanted) + anonymous:
                raise ValueError("named tasks/setup differ from source")
        if re.search(r"\b(?:add_test|run_test)\s*\(", text):
            raise ValueError("named tasks/setup must be unconditional")
        if raw_tasks:
            paths += [source / "testing/xpcshell/head.js"]
        else:
            modules = {"MockRegistrar.sys.mjs": source / "testing/modules/MockRegistrar.sys.mjs",
                       "mailnews/MessageGenerator.sys.mjs": comm / "mailnews/test/resources/MessageGenerator.sys.mjs",
                       "mailnews/PromiseTestUtils.sys.mjs": comm / "mailnews/test/resources/PromiseTestUtils.sys.mjs"}
            module_pairs = [(original, Path(config["objdir"]) / "_tests/modules" / name)
                            for name, original in modules.items()]
            paths += [p for pair in module_pairs for p in pair]
            paths += [comm / "mailnews/moz.build", source / "testing/modules/moz.build",
                      source / "testing/xpcshell/runxpcshelltests.py", source / "xpcom/base/nsDebug.h",
                      source / "xpcom/base/nsDebugImpl.cpp"]
    if case.get("requires_non_debug"):
        info = Path(config["objdir"]) / "mozinfo.json"
        if json.loads(info.read_text(encoding="utf-8")).get("debug") is not False:
            raise ValueError("held-build-mode: raw missing-URI control requires verified non-DEBUG build")
        paths += [info, Path(config["objdir"]) / "config.status", source / "xpcom/base/nsDebug.h",
                  source / "testing/xpcshell/runxpcshelltests.py"]
    if case["id"].startswith("imap:"):
        paths += [manifest.parent / "head_server.js",
                  Path(config["objdir"]) / "_tests/xpcshell/comm/mailnews/resources/mailShutdown.js"]
    if case.get("selector"):
        modules = {"mailnews/" + name + ".sys.mjs": comm / "mailnews/test" / folder / (name + ".sys.mjs")
                   for folder, names in (
                       ("resources", ("IMAPpump", "LocalAccountUtils", "MailTestUtils",
                                      "MessageGenerator", "PromiseTestUtils")),
                       ("fakeserver", ("Maild", "Imapd", "Auth", "Smtpd"))) for name in names}
        modules.update({name: source / "testing/modules" / name
                        for name in ("AppInfo.sys.mjs", "MockRegistrar.sys.mjs")})
        module_pairs = [(original, Path(config["objdir"]) / "_tests/modules" / name)
                        for name, original in modules.items()]
        module_pairs.append((comm / "mailnews/test/resources/mailShutdown.js",
                             Path(config["objdir"]) / "_tests/xpcshell/comm/mailnews/resources/mailShutdown.js"))
        paths += [p for pair in module_pairs for p in pair]
        paths += [comm / "mailnews/moz.build", source / "testing/modules/moz.build"]
    if case["id"].startswith("news:"):
        modules = {
            "mailnews/LocalAccountUtils.sys.mjs": comm / "mailnews/test/resources/LocalAccountUtils.sys.mjs",
            "mailnews/Maild.sys.mjs": comm / "mailnews/test/fakeserver/Maild.sys.mjs",
            "mailnews/Nntpd.sys.mjs": comm / "mailnews/test/fakeserver/Nntpd.sys.mjs",
            "mailnews/PromiseTestUtils.sys.mjs": comm / "mailnews/test/resources/PromiseTestUtils.sys.mjs",
        }
        modules.update({name: source / "testing/modules" / name
                        for name in ("AppInfo.sys.mjs", "MockRegistrar.sys.mjs")})
        module_pairs = [(original, Path(config["objdir"]) / "_tests/modules" / name)
                        for name, original in modules.items()]
        module_pairs.append((comm / "mailnews/test/resources/mailShutdown.js",
                             Path(config["objdir"]) / "_tests/xpcshell/comm/mailnews/resources/mailShutdown.js"))
        paths += [p for pair in module_pairs for p in pair]
        paths += [comm / "mailnews/moz.build", source / "testing/modules/moz.build"]
    paths += [(manifest.parent / h).resolve() for h in entry.get("head", defaults["head"]).split()]
    if is_format and not case.get("source_dependencies"):
        raise ValueError("format-reader case must bind its source module/packaging")
    dependencies = []
    for name in defaults.get("support-files", []) + entry.get("support-files", []):
        if "*" in name:
            pattern = name + ("/*" if name.endswith("**") else "")
            matches = [p.resolve() for p in manifest.parent.glob(pattern) if p.is_file()]
            if not matches:
                raise ValueError("blocked-dependency: empty support-file glob: " + name)
            dependencies += matches
        else:
            dependencies.append((manifest.parent / name).resolve())
    dependencies += [(comm / name).resolve() for name in case.get("source_dependencies", [])]
    if any(not p.is_relative_to(comm.resolve()) for p in dependencies):
        raise ValueError("fixture dependencies must remain in source comm/")
    paths += dependencies
    if any(not p.is_file() for p in paths):
        missing = ", ".join(str(p) for p in paths if not p.is_file())
        raise ValueError("blocked-dependency: " + missing)
    if case.get("task"):
        if case["store"] != "none" or case["backend"] != "panorama":
            raise ValueError("named metadata tasks require panorama:none")
        text = (manifest.parent / case["file"]).read_text(encoding="utf-8")
        tasks = re.findall(r"\badd_task\s*\(\s*(?:async\s+)?function\s+(\w+)\s*\(", text)
        if (tasks != [case["task"]] or len(re.findall(r"\badd_task\s*\(", text)) != 1
            or re.search(r"\b(?:add_test|run_test)\s*\(", text)):
            raise ValueError("require one unconditional named task matching the catalog")
    for original, installed in module_pairs:
        if original.read_bytes() != installed.read_bytes():
            raise ValueError("blocked-dependency: installed protocol fixture differs from source: " + str(installed))
    return manifest, paths


def digest(paths):
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def run_case(config, case, output):
    """Run one file; retain argv, selected tuple, hashes, and unfiltered logs."""
    source, obj = Path(config["source"]), Path(config["objdir"])
    raw, stdout, stderr = [output / n for n in ("raw.jsonl", "stdout.log", "stderr.log")]
    manifest = source / "comm" / case["manifest"]
    executable = obj / "dist" / "bin" / ("xpcshell.exe" if os.name == "nt" else "xpcshell")
    argv = [config["python"], str(source / "testing/xpcshell/runxpcshelltests.py"),
            "--xpcshell", str(executable), "--app-path", str(executable.parent),
            "--xre-path", str(executable.parent), "--utility-path", str(executable.parent),
            "--testing-modules-dir", str(obj / "_tests/modules"),
            "--build-info-json", str(obj / "mozinfo.json"), "--manifest", str(manifest),
            "--headless", "--sequential", "--verbose", "--log-raw", str(raw),
            str(manifest.parent / case["file"])]
    timeout = config.get("timeout_seconds", 600)
    if case.get("task"):
        timeout = max(timeout, case.get("timeout_seconds", 600))
        if type(timeout) is not int or not 600 <= timeout <= 3600:
            raise ValueError("case timeout must be an integer from 600 to 3600 seconds")
        argv[2:2] = ["--timeout-factor", str((timeout - 300) // 30)]
    env = os.environ.copy()
    env.pop("MOZ_AUTOMATION", None)
    if case["diagnostics"] == "format-reader":
        env.pop("PANORAMA_DELIVERY_EXPECT", None)
    else:
        env["PANORAMA_DELIVERY_EXPECT"] = case["backend"] + ":" + case["store"]
    env.pop("PANORAMA_DELIVERY_TEST_ROOT", None)
    if case["id"].startswith(("imap:", "news:")):
        env["PANORAMA_DELIVERY_TEST_ROOT"] = str(obj / "_tests/xpcshell/comm") + os.sep
    record = {"case": case, "argv": argv, "cwd": str(source), "observed": "not-run",
              "environment": {"MOZ_AUTOMATION": None,
                              "PANORAMA_DELIVERY_EXPECT": env.get("PANORAMA_DELIVERY_EXPECT"),
                              "PANORAMA_DELIVERY_TEST_ROOT": env.get("PANORAMA_DELIVERY_TEST_ROOT")},
              "logs": {"raw": str(raw), "stdout": str(stdout), "stderr": str(stderr)},
              "started_utc": datetime.now(timezone.utc).isoformat(), "exit_code": None,
              "timeout_seconds": timeout}
    (output / "request.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    try:
        _, paths = prepare(config, case)
        paths += [executable, obj / "mozinfo.json", Path(__file__)]
        before = digest(paths)
        if case.get("requires_non_debug"):
            record["build_mode"] = {"debug": False, "harness_XPCOM_DEBUG_BREAK": "stack-and-abort",
                                    "evidence": str(obj / "mozinfo.json"),
                                    "environment_basis": "pinned harness buildCoreEnvironment; not a child sample"}
        with stdout.open("wb") as out, stderr.open("wb") as err:
            result = subprocess.run(argv, cwd=source, env=env, stdout=out, stderr=err,
                                    timeout=timeout, check=False)
        record.update(check_log(raw, case, result.returncode, (stdout, stderr)))
        record.update(observed="PASS" if record["ok"] else "FAIL",
                      disposition="passed" if record["ok"] else "failed", exit_code=result.returncode,
                      hashes_before=before, hashes_after=digest(paths))
        if record["hashes_after"] != before:
            record["ok"] = False
            record["observed"] = "FAIL"
            record["disposition"] = "failed"
            record["coverage"] = "none"
            record["completed_phase"] = None
            record["errors"].append("source/build inputs changed during execution")
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        record.update(ok=False, errors=[str(error)], coverage="none", completed_phase=None,
                      disposition="failed" if isinstance(error, subprocess.TimeoutExpired) else "blocked")
        if str(error).startswith("blocked-dependency:"):
            record["observed"] = str(error)
        if isinstance(error, subprocess.TimeoutExpired):
            record["observed"] = "TIMEOUT"
    record["finished_utc"] = datetime.now(timezone.utc).isoformat()
    (output / "result.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def run_batch(config, cases):
    """Retain all results and a failing aggregate even when earlier cases fail."""
    output = Path(config["evidence"])
    output.mkdir(parents=True, exist_ok=False)
    (output / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    results = []
    for index, case in enumerate(cases):
        directory = output / f"{index:03}-{case['id'].replace(':', '-')}"
        directory.mkdir()
        results.append(run_case(config, case, directory))
    summary = {"ok": bool(results) and all(r["ok"] for r in results), "results": results}
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def verify_source(config):
    """Check both repository revisions and reject dirty/untracked source inputs."""
    env = {**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"}
    for directory, key in ((Path(config["source"]), "gecko_revision"),
                           (Path(config["source"]) / "comm", "comm_revision")):
        top = subprocess.run(["git", "-C", str(directory), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, check=True, env=env).stdout.strip()
        if Path(top).resolve() != directory.resolve():
            raise ValueError("not the expected repository: " + str(directory))
        status = ["git", "-C", str(directory), "status", "--porcelain", "--untracked-files=normal"]
        if key == "gecko_revision":
            status += ["--", ".", ":(exclude)comm"]
        dirty = subprocess.run(status, capture_output=True, text=True, check=True, env=env).stdout
        if dirty.strip():
            raise ValueError("dirty source checkout: " + str(directory))
        revision = config[key]
        if not re.fullmatch("[0-9a-f]{40}", revision):
            raise ValueError("require full revision: " + key)
        actual = subprocess.run(["git", "-C", str(directory), "rev-parse", "HEAD"],
                                capture_output=True, text=True, check=True, env=env).stdout.strip()
        if revision != actual:
            raise ValueError("checkout revision mismatch: " + key)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    inventory = {c["id"]: c for c in json.loads((HERE / "cases.json").read_text(encoding="utf-8"))}
    selected = config["select"]
    if not selected or len(selected) != len(set(selected)):
        raise ValueError("select must contain distinct explicit case IDs")
    for name in ("source", "objdir", "python", "evidence"):
        if not Path(config[name]).is_absolute():
            raise ValueError(name + " must be a native absolute path")
    verify_source(config)
    return 0 if run_batch(config, [inventory[i] for i in selected])["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
