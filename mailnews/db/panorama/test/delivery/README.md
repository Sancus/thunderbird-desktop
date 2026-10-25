# Manual delivery acceptance

This tooling runs source manifests that are deliberately absent from moz.build.
The final product target is one Panorama-only build with Mork and Gloda removed.
Mork comparison runs and legacy-source fixture preparation are transitional
reference evidence, not acceptable final runtime dependencies.

Use Python 3.11+ with the matching Mozilla test-harness dependencies installed.
After root integrates the reviewed helpers and domain cases, create a UTF-8 JSON
config with absolute native Windows paths, actual full Gecko/comm HEAD revisions,
a new evidence directory, and an explicit ordered selection from cases.json:

~~~json
{
  "source": "C:\\Builder\\source",
  "objdir": "C:\\Builder\\obj-thunderbird",
  "python": "C:\\Builder\\test-python\\python.exe",
  "evidence": "C:\\Builder\\evidence\\acceptance-002",
  "gecko_revision": "REPLACE_WITH_ACTUAL_40_HEX_GECKO_HEAD",
  "comm_revision": "REPLACE_WITH_ACTUAL_40_HEX_INTEGRATED_COMM_HEAD",
  "build_identity": "REPLACE_WITH_MATCHING_BUILDER_ARTIFACT_ID",
  "select": ["imap:mork:maildir:Backend"],
  "timeout_seconds": 600
}
~~~

The paths are examples. The revision placeholders intentionally cannot run.
Start transitional comparison with mork/maildir behavioral files to establish
the preconfigured fixture. Backend is a separate account-factory result.
Select each additional reviewed case ID explicitly; every selection runs in its
own process even after an earlier failure. The runner rejects empty selections,
unapproved contracts, unlisted/missing source files, and mismatched tuples.
Pending-product cases still expect PASS and their failures fail the aggregate.

Proposed Windows invocation (not executed against Thunderbird here):

~~~powershell
& 'C:\Builder\test-python\python.exe' 'C:\Builder\source\comm\mailnews\db\panorama\test\delivery\run_acceptance.py' --config 'C:\Builder\evidence\request.json'
~~~

The runner rejects dirty or untracked inputs in both source repositories, checking
comm separately from Gecko. It unsets MOZ_AUTOMATION and invokes runxpcshelltests with the
absolute source manifest and exactly one absolute test-file path. It saves the
config, expected tuple/scope/readiness, exact argv/cwd, relevant environment,
revisions, input hashes, stdout/stderr/raw JSONL paths, timestamps and results.
Each log must select/start/end exactly the requested file and finish its suite.
Skips, crashes, timeouts, expected failures, malformed logs and missing/extra
cases or diagnostics fail. Raw DB cases require backend diagnostics; only
folder/store fixtures require folder diagnostics. No failure claims coverage.
IMAP fixture mode and declared completion phase are checked independently.
The factory case is account-factory; UID cases are preconfigured-store. A
factory-blocked Panorama IMAP run has zero UID coverage. Parent timeout cleanup
of child processes remains the remote builder's responsibility.

The build_identity is a builder attestation: HEAD checks alone cannot prove which
source produced a binary. Root must supply matching clean source/build artifacts.
Core/migration owners must call assertBackend(expectedLane().backend) after their
startup fixtures are prepared. Folder cases must call assertFolder or use the
shared fixture. Old domain files without these diagnostics remain blocked.
No tooling change bypasses a test's product assertion or its cleanup.

Lightweight checker verification, from this directory:

~~~powershell
python -B -m unittest -v test_accounting.py
~~~

Those tests use synthetic logs and mocked subprocesses. Thunderbird runtime,
cleanup behavior, fixture sensitivity and commlint remain pending remotely.

IMAP uses head_delivery_paths.js first. The runner declares
PANORAMA_DELIVERY_TEST_ROOT=<objdir>\_tests\xpcshell\comm\ (native separators),
checks and hashes its mailnews/resources/mailShutdown.js, then loads source heads.
Every entry in a selected manifest must exist; missing peers/resources are recorded
as blocked-dependency before execution. Compatibility and migration use separate
manual manifests. NumericProperties is pending-contract and cannot execute.
Keep configs/evidence outside the source repositories to keep source checks clean.
