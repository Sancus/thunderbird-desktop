# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Explicit Linux native cases after a separate, provenance-bound native build."""

import argparse
import configparser
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import native_accounting as accounting
import native_process as processes

HERE = Path(__file__).resolve().parent
CASES = {c["id"]: c for c in accounting.CATALOG["cases"]}
TERMINATION_REASON = None
COMM_INPUTS = ["mailnews/db/panorama/" + name for name in (
    "src/DatabaseCore.cpp", "src/DatabaseCore.h", "src/MessageDatabase.cpp",
    "src/MessageDatabase.h", "src/FolderDatabase.cpp", "src/FolderDatabase.h",
    "src/DatabaseUtils.cpp", "src/DatabaseUtils.h", "public/nsIDatabaseCore.idl",
    "public/nsIFolderDatabase.idl", "public/moz.build",
    "src/moz.build", "test/moz.build", "test/gtest/moz.build")]
COMM_INPUTS += ["mailnews/db/panorama/test/delivery/" + name for name in (
    "native_accounting.py", "native_process.py", "run_native.py", "native-cases.json")]
for suite in accounting.CATALOG["suites"].values():
    COMM_INPUTS += [suite["source"], *suite["source_dependencies"]]
COMM_INPUTS = list(dict.fromkeys(COMM_INPUTS))
GECKO_INPUTS = ["testing/gtest/mozilla/GTestRunner.cpp", "xpcom/tests/TestHarness.h",
                "third_party/googletest/googletest/src/gtest.cc", "toolkit/xre/nsAppRunner.cpp",
                "toolkit/library/gtest/moz.build", "xpcom/base/nsDebugImpl.cpp",
                "xpcom/base/nsTraceRefcnt.cpp", "mfbt/Assertions.h",
                "testing/gtest/rungtests.py", "testing/gtest/moz.build",
                "testing/gtest/mozilla/moz.build", "storage/mozStorageConnection.cpp",
                "xpcom/glue/standalone/nsXPCOMGlue.cpp", "storage/mozStorageStatement.cpp",
                "storage/mozStoragePrivateHelpers.cpp", "storage/mozIStorageFunction.idl",
                "storage/mozIStorageValueArray.idl",
                "storage/mozStorageService.cpp",
                "storage/mozStorageService.h",
                "storage/mozIStorageService.idl",
                "storage/mozIStorageConnection.idl",
                "storage/mozIStorageStatement.idl",
                "xpcom/threads/nsThreadUtils.h",
                "xpcom/threads/nsThreadUtils.cpp",
                "xpcom/threads/SpinEventLoopUntil.h",
                "storage/mozIStorageAsyncConnection.idl",
                "xpcom/threads/nsIEventTarget.idl",
                "storage/mozStorageBindingParams.cpp", "storage/mozStorageBindingParams.h",
                "mfbt/Maybe.h", "mfbt/RefPtr.h", "mfbt/fallible.h",
                "storage/mozIStorageProgressHandler.idl", "memory/mozalloc/cxxalloc.h",
                "xpcom/ds/nsTArray.h", "xpcom/string/nsTSubstring.h",
                "xpcom/string/nsReadableUtils.h", "xpcom/string/nsReadableUtils.cpp",
                "xpcom/base/nsCOMPtr.h", "mfbt/ScopeExit.h", "xpcom/ds/nsIVariant.idl",
                "third_party/googletest/googletest/include/gtest/internal/gtest-internal.h"]
GECKO_INPUTS += [
    "third_party/googletest/googletest/include/gtest/gtest.h",
    "xpcom/string/nsString.h",
    "xpcom/io/nsIInputStream.idl",
    "xpcom/io/nsIOutputStream.idl",
    "xpcom/io/nsISafeOutputStream.idl",
    "xpcom/io/nsIFile.idl",
    "xpcom/io/nsDirectoryServiceDefs.h",
    "netwerk/base/nsNetUtil.h",
    "xpcom/io/nsISeekableStream.idl",
    "mfbt/UniquePtr.h"
]


def handle_termination(signum, frame):
    global TERMINATION_REASON
    if TERMINATION_REASON is None:
        TERMINATION_REASON = f"termination requested (signal {signum})"
        raise InterruptedError(TERMINATION_REASON)


def require_running():
    if TERMINATION_REASON:
        raise InterruptedError(TERMINATION_REASON)


def check_leak_capability(receipt):
    if type(receipt.get("refcount_logging")) is not bool:
        raise ValueError("build receipt must declare boolean refcount_logging capability")
    if receipt["refcount_logging"]:
        raise ValueError("refcount-logging build held: leak collection/validation not implemented")


def save(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)


def digest(path, deadline):
    if time.monotonic() >= deadline:
        raise TimeoutError("identity deadline reached")
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            if time.monotonic() >= deadline:
                raise TimeoutError("identity check exceeded finalization deadline")
            value.update(chunk)
    return value.hexdigest()


def verify(config, receipt, deadline, evidence=None):
    snapshot = {"git": [], "inputs": {}, "source_stamps": {}}
    try:
        if digest(config["receipt"], deadline) != config["receipt_sha256"]:
            raise ValueError("build receipt changed")
        env = {**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"}
        source = Path(config["source"])
        for directory, name in ((source, "gecko_revision"), (source / "comm", "comm_revision")):
            def git(*args):
                allowed = min(10, deadline - time.monotonic())
                if allowed <= 0:
                    raise TimeoutError("source verification deadline")
                argv = ["git", "-C", str(directory), "-c", "maintenance.auto=false", "-c", "gc.auto=0", *args]
                process = subprocess.run(argv, capture_output=True, text=True, env=env, timeout=allowed)
                snapshot["git"].append({"argv":argv, "exit_code":process.returncode,
                                        "stdout":process.stdout, "stderr":process.stderr})
                process.check_returncode()
                return process.stdout.strip()
            if Path(git("rev-parse", "--show-toplevel")).resolve() != directory.resolve():
                raise ValueError("unexpected source repository")
            if git("rev-parse", "HEAD") != receipt[name]:
                raise ValueError("source revision differs from build receipt")
            paths = ["--", ".", ":(exclude)comm"] if name == "gecko_revision" else []
            if git("status", "--porcelain", "--untracked-files=normal", *paths):
                raise ValueError("dirty source checkout")
        for name in receipt["inputs"]:
            snapshot["inputs"][name] = digest(name, deadline)
        if snapshot["inputs"] != receipt["inputs"]:
            raise ValueError("source/binary/configuration differs from build receipt")
        for filename, section in (("application.ini", "App"), ("platform.ini", "Build")):
            parser = configparser.ConfigParser()
            parser.read(Path(config["objdir"]) / "dist/bin" / filename)
            snapshot["source_stamps"][filename] = parser.get(section, "SourceStamp")
        for filename, key in (("application.ini", "comm_revision"), ("platform.ini", "gecko_revision")):
            if snapshot["source_stamps"][filename] != receipt[key]:
                raise ValueError("stale native SourceStamp: " + filename)
        return snapshot
    finally:
        if evidence is not None:
            save(evidence, snapshot)

def prepare(config, deadline, evidence=None):
    if sys.platform != "linux":
        raise ValueError("Windows held: Job Object and launcher waiting need a reviewed slice")
    for name in ("source", "objdir", "receipt", "evidence"):
        if not Path(config[name]).is_absolute():
            raise ValueError("absolute native paths required")
    if digest(config["receipt"], deadline) != config["receipt_sha256"]:
        raise ValueError("build receipt hash mismatch")
    receipt = json.loads(Path(config["receipt"]).read_text(encoding="utf-8"))
    check_leak_capability(receipt)
    if not receipt.get("build_identity") or receipt.get("gecko_revision") != "efd2d1e6f77570ae6bc5294731a68101e45c81a3":
        raise ValueError("matching identified efd2 build receipt required")
    for name in ("comm_revision", "gecko_revision"):
        if len(receipt[name]) != 40 or any(c not in "0123456789abcdef" for c in receipt[name]):
            raise ValueError("full source revision required")
    source, obj = Path(config["source"]), Path(config["objdir"])
    expected_runner = source / "comm/mailnews/db/panorama/test/delivery/run_native.py"
    if Path(__file__).resolve() != expected_runner.resolve():
        raise ValueError("execute the runner from the declared source checkout")
    app, library = Path(receipt["app"]), Path(receipt["library"])
    if not app.resolve().is_relative_to((obj / "dist/bin").resolve()) or library.resolve() != (obj / "dist/bin/gtest/libxul.so").resolve():
        raise ValueError("app/gtest library must be matching object-directory artifacts")
    required = [source / "comm" / p for p in COMM_INPUTS] + [source / p for p in GECKO_INPUTS]
    required += [app, library, obj / "dist/bin/application.ini", obj / "dist/bin/platform.ini",
                 obj / "dist/bin/dependentlibs.list.gtest", obj / "config.status", Path(receipt["mozconfig"])]
    if any(str(p) not in receipt["inputs"] for p in required):
        raise ValueError("build receipt omits required source, binary, INI or config identity")
    if not Path(receipt["mozconfig"]).is_absolute():
        raise ValueError("absolute mozconfig required")
    if any(not isinstance(v, str) or len(v) != 64 or any(c not in "0123456789abcdef" for c in v)
           for v in receipt["inputs"].values()):
        raise ValueError("full SHA-256 identities required")
    if any(not Path(p).is_absolute() for p in receipt["inputs"]):
        raise ValueError("receipt identities require absolute paths")
    for name in receipt["inputs"]:
        p = Path(name).resolve()
        if any(part.lower() in (".aws", ".codex") for part in p.parts) or p.name.lower() == "aws.txt":
            raise ValueError("credential paths are forbidden receipt inputs")
        if not (p.is_relative_to(source.resolve()) or p.is_relative_to(obj.resolve())
                or p == Path(receipt["mozconfig"]).resolve()):
            raise ValueError("receipt input outside declared source/build/config")
    # Diagnostic sources are bound to the exact checkout, including the formats.
    for relative, token in (("xpcom/base/nsDebugImpl.cpp", "###!!! ASSERTION"),
                             ("xpcom/base/nsTraceRefcnt.cpp", "XPCOM_MEM_LEAK_LOG"),
                             ("mfbt/Assertions.h", "Assertion failure:"),
                             ("mfbt/Assertions.h", "Hit MOZ_CRASH(")):
        if token not in (source / relative).read_text(encoding="utf-8"):
            raise ValueError("diagnostic format requires renewed source review: " + relative)
    verify(config, receipt, deadline, evidence)
    return receipt


def environment(config, selected, output):
    obj = Path(config["objdir"])
    home, temp = output / "home", output / "tmp"
    home.mkdir()
    temp.mkdir()
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL") if name in os.environ}
    env.update(HOME=str(home), TMPDIR=str(temp), MOZ_HEADLESS="1", MOZ_RUN_GTEST="1",
               MOZ_XRE_DIR=str(obj / "dist/bin"), LD_LIBRARY_PATH=str(obj / "dist/bin"),
               MOZ_GMP_PATH=os.pathsep.join(str(obj / "dist/bin" / p / "1.0")
                                           for p in ("gmp-fake", "gmp-fakeopenh264")),
               MOZ_WEBRENDER="0", MOZ_ENABLE_INC_ORIGIN_INIT="0", PYTHON=sys.executable,
               GTEST_FILTER=selected, MOZ_GTEST_LOG_PATH=str(output / "native.jsonl"))
    return env


def run_case(config, receipt, case, output, stop, final):
    record = {"id": case["id"], "filter": case["filter"], "observed": "NOTRUN",
              "ok": False, "coverage": "none", "executed": False, "leak_check": "unavailable",
              "backend": accounting.CATALOG["backend"], "store": accounting.CATALOG["store"],
              "logs": {name: str(output / file) for name, file in (("native", "native.jsonl"),
                       ("stdout", "stdout.log"), ("stderr", "stderr.log"), ("maps", "maps.log"))}, "started_utc": datetime.now(timezone.utc).isoformat()}
    profile_root = Path(receipt["app"]).resolve().parent
    record["profile_root"] = str(profile_root)
    try:
        require_running()
        check_leak_capability(receipt)
        timeout = max(config["timeout_seconds"], case.get("timeout_seconds", 0))
        if not 0 < timeout <= 1800:
            raise ValueError("case timeout must be positive and at most 1800 seconds")
        before_profiles = sorted(str(p) for p in profile_root.glob("cpp-unit-profd*"))
        record["preexisting_profiles"] = before_profiles
        if before_profiles:
            raise ValueError("stale cpp-unit-profd entries in executable directory")
        record["hashes_before"] = verify(config, receipt, final, output / "identity-before.json")
        if time.monotonic() + 4 >= stop:
            raise TimeoutError("test-stop leaves no process/cleanup budget")
        env = environment(config, case["filter"], output)
        raw = output / "native.jsonl"
        raw.touch(exist_ok=False)
        argv = [receipt["app"], "-unittest", "--gtest_death_test_style=threadsafe",
                "--gtest_also_run_disabled_tests"]
        record.update(argv=argv, environment=env, cwd=str(output),
                      timeout_seconds=timeout, deadline_shortened=
                      time.monotonic() + timeout + 3 > stop)
        save(output / "request.json", record)
        require_running()
        processes.capture(argv, env, output, output, timeout,
                          stop, Path(receipt["app"]), Path(receipt["library"]))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        record["error"] = str(error)
        record["interrupted"] = bool(TERMINATION_REASON) or isinstance(error, InterruptedError)
    if (output / "process.json").exists():
        record.update(json.loads((output / "process.json").read_text(encoding="utf-8")))
        record["executed"] = bool(record.get("pid"))
        if record.get("loaded"):
            (output / "maps.log").write_text(record["loaded"].pop("maps"), encoding="utf-8")
        record.update(accounting.check_output(output / "native.jsonl", output / "stdout.log",
                                             output / "stderr.log", case["filter"],
                                             record["exit_code"], timed_out=record["timed_out"]))
        record["leftover_profiles"] = [str(p) for p in profile_root.glob("cpp-unit-profd*")]
        if (record.get("error") or record.get("process_error") or record.get("cleanup_failed")
            or record.get("terminated_pids") or record.get("survivor_pids")
            or not record.get("loaded") or record["leftover_profiles"]):
            record["ok"] = False
            record["errors"].append("process/cleanup/profile or loaded-artifact identity incomplete")
        record["observed"] = "PASS" if record["ok"] else "FAIL"
        if record["timed_out"]:
            record["timeout_kind"] = "deadline-shortened" if record["deadline_shortened"] else "case-limit"
    try:
        record["hashes_after"] = verify(config, receipt, final, output / "identity-after.json")
    except (OSError, ValueError, KeyError, configparser.Error, subprocess.SubprocessError) as error:
        record.update(ok=False, identity_error=str(error),
                      interrupted=bool(TERMINATION_REASON) or isinstance(error, InterruptedError))
        if record["observed"] == "PASS":
            record["observed"] = "FAIL"
    if TERMINATION_REASON:
        record.update(ok=False, interrupted=True, reason=TERMINATION_REASON)
        if record["observed"] == "PASS":
            record["observed"] = "FAIL"
    if not record["ok"] and record.get("first_failure") is None:
        record["first_failure"] = {"action": "infrastructure", "message": record.get("error") or record.get("identity_error") or "process evidence incomplete"}
    record["runtime_gates"] = ["native profile isolation/removal and close barrier require qualification",
                               "Windows executor held"]
    record["finished_utc"] = datetime.now(timezone.utc).isoformat()
    try:
        save(output / "result.json", record)
    except OSError as error:
        record.update(ok=False, observed="FAIL", finalization_error=str(error),
                      interrupted=bool(TERMINATION_REASON) or isinstance(error, InterruptedError))
        if record["interrupted"]:
            record["reason"] = TERMINATION_REASON or str(error)
        record["first_failure"] = record.get("first_failure") or {"action": "finalization", "message": str(error)}
    return record

def run_batch(config, raw_config=None):
    output = Path(config["evidence"])
    if any(output.resolve().is_relative_to(Path(config[p]).resolve()) for p in ("source", "objdir")):
        raise ValueError("evidence must remain outside source and object directories")
    output.mkdir(parents=True, exist_ok=False)
    save(output / "config.json", config)
    if raw_config is not None:
        (output / "original-config.json").write_bytes(raw_config)
    save(output / "invocation.json", {"argv": sys.argv, "cwd": os.getcwd()})
    requested = config.get("select", [])
    selected, results, error = requested if isinstance(requested, list) else [], [], None
    try:
        require_running()
        if not selected or len(selected) != len(set(selected)) or any(i not in CASES for i in selected):
            raise ValueError("distinct explicit native catalog IDs required")
        stop_utc, final_utc = (datetime.fromisoformat(config[k]) for k in ("test_stop_utc", "finalize_utc"))
        if stop_utc.utcoffset() is None or final_utc.utcoffset() is None or (final_utc - stop_utc).total_seconds() < 60:
            raise ValueError("UTC deadlines and at least 60 seconds finalization headroom required")
        offset = time.monotonic() - time.time()
        stop, final = stop_utc.timestamp() + offset, final_utc.timestamp() + offset
        if not 0 < config["timeout_seconds"] <= 600 or time.monotonic() + 4 >= stop:
            raise ValueError("bounded per-case timeout and future stop required")
        receipt = prepare(config, final, output / "preflight.json")
        check_leak_capability(receipt)
        save(output / "build-receipt.json", receipt)
        (output / "original-build-receipt.json").write_bytes(Path(config["receipt"]).read_bytes())
        for index, name in enumerate(selected):
            if time.monotonic() + 4 >= stop or error or TERMINATION_REASON:
                results.append({"id": name, "observed": "NOTRUN", "ok": False,
                                "reason": TERMINATION_REASON or error or "test-stop reached",
                                "interrupted": bool(TERMINATION_REASON), "coverage": "none",
                                "leak_check": "unavailable"})
                continue
            directory = output / f"{index:02}-{name.replace(':', '-')}"
            directory.mkdir()
            try:
                row = run_case(config, receipt, CASES[name], directory, stop, final)
            except (OSError, ValueError, KeyError, TypeError) as failure:
                row = {"id": name, "observed": "FAIL", "ok": False, "coverage": "none",
                       "error": "case evidence finalization failed: " + str(failure),
                       "interrupted": bool(TERMINATION_REASON) or isinstance(failure, InterruptedError),
                       "reason": TERMINATION_REASON or str(failure), "leak_check": "unavailable",
                       "first_failure": {"action": "finalization", "message": str(failure)}}
            results.append(row)
            if row.get("survivor_pids") or row.get("cleanup_failed") or row.get("interrupted"):
                error = TERMINATION_REASON or "cleanup unresolved or runner interrupted; later launches refused"
        verify(config, receipt, final, output / "final-identity.json")
    except (OSError, ValueError, KeyError, TypeError, configparser.Error, subprocess.SubprocessError) as failure:
        error = TERMINATION_REASON or str(failure)
    error = TERMINATION_REASON or error
    results += [{"id": name, "observed": "NOTRUN", "ok": False, "reason": error,
                 "coverage": "none", "interrupted": bool(TERMINATION_REASON),
                 "leak_check": "unavailable"} for name in selected[len(results):]]
    summary = {"ok": bool(results) and not error and all(r["ok"] for r in results),
               "infrastructure_error": error, "results": results, "leak_check": "unavailable",
               "interrupted": bool(TERMINATION_REASON),
               "counts": {s: sum(r["observed"] == s for r in results) for s in ("PASS", "FAIL", "NOTRUN")},
               "requested": len(selected), "executed": sum(bool(r.get("executed")) for r in results)}
    try:
        save(output / "summary.json", summary)
    except InterruptedError as failure:
        summary.update(ok=False, interrupted=True, infrastructure_error=TERMINATION_REASON or str(failure))
        save(output / "interrupted-summary.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, handle_termination)
    signal.signal(signal.SIGINT, handle_termination)
    raw_config = args.config.read_bytes()
    return 0 if run_batch(json.loads(raw_config), raw_config)["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
