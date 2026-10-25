# Manual native acceptance

TestDeliveryCoreReferences.cpp (14 cases), TestDeliveryFolderInfoProperties.cpp
(19 cases) and TestDeliveryMessageReferences.cpp (19 cases) are linked here. All
52 filters retain DISABLED_ suites and pending-product status; no normal-CI
execution is added. EWS and search/browser registration remain separate slices.
Native cases select the concrete Panorama core and check panorama.sqlite identity.
They have store none: no account/body-store or application-restart coverage.

## Verified driver and limits

Exact efd2 sources are hash-bound by delivery/reviews/pinned-gecko-efd2/native-inputs.json.
GTestRunner.cpp:52-68 opens MOZ_GTEST_LOG_PATH with w and closes it at suite_end;
:83-135 defines exact case events; :196-266 initializes ScopedXPCOM and returns
RUN_ALL_TESTS before its destructor. TestHarness.h:91-121 then removes its profile,
shuts down XPCOM and prints Finished running GTest tests. Thus JSONL plus exit 0
alone cannot establish successful shutdown. :126-147 creates a unique cpp-unit-profd
under NS_OS_CURRENT_PROCESS_DIR; :192-213 exposes the persistent profile provider.
The fixtures independently create/remove their unique child and close the core.
FolderInfo uses the accepted lifecycle fixture with provider restoration and an
async-close barrier. Full process output must include suite teardown; a case PASS
alone cannot establish close/removal. Compile and real lifecycle proof are pending.

gtest.cc:6819 parses --gtest_also_run_disabled_tests. The runner passes that flag
and one exact GTEST_FILTER; it uses no wildcard, repeat, sharding or filter-set.
nsAppRunner.cpp:5345-5360 enters the gtest runtime through MOZ_RUN_GTEST.
toolkit/library/gtest/moz.build targets dist/bin/gtest. Exact pinned mach commands
still build gtest before execution (:1134-1136); run_native.py never invokes mach.
Root must build/configure the target separately and freeze the resulting receipt.

Additional exact diagnostic/loader bytes are hash-bound by execution-inputs.json
in the same review directory. nsDebugImpl.cpp:400-450 supplies assertion prefixes;
Assertions.h:146-188 supplies Assertion failure and Hit MOZ_CRASH prefixes.
nsTraceRefcnt.cpp:503-597 requires explicit log environment settings.
nsXPCOMGlue.cpp:22,260-309 selects dependentlibs.list.gtest and loads its paths.
These four hashes were verified locally; native behavior remains unqualified.

## Linux slice

run_native.py requires a fresh root-reviewed request and build receipt. Windows
is refused before launch: owned Job Object and conditional launcher waiting need
a separate reviewed implementation. No platform earns credit from synthetic tests.

Request fields are absolute source, objdir, evidence and receipt paths;
receipt_sha256; an ordered, distinct select array of native-cases.json IDs;
timeout_seconds (1-600, a base limit); timezone-qualified test_stop_utc and finalize_utc with
at least 60 seconds reserved for final checks. All dates/allocation identifiers must
come from a newly approved allocation; the original allocation is closed.
No scheduling or allocation is performed by this tool. Catalog timeout_seconds is
a per-case minimum: the two MessageReferences 65536-token cases require 1800
seconds. The effective limit is the greater of base and catalog limits, bounded
by 1800 seconds and the test-stop deadline. A shortened timeout still fails.
Windows qualification is not a prerequisite for Linux compilation or execution.

The receipt contains build_identity, full comm_revision/gecko_revision, absolute
app/library/mozconfig paths, boolean refcount_logging capability, and inputs mapping
absolute files to SHA-256 hashes. Root must derive that capability from the actual
build configuration, never its optimization label. Missing/nonboolean declarations
are refused. This slice requires false: true is held before launch because leak-log
collection and validation are not implemented. Every case and batch reports
leak_check: unavailable; absent logs never mean zero leaks. Debug/refcount-logging
qualification with measured leak collection remains a future requirement.
native-cases.json schema 2 declares each suite source and tested implementation,
header and interface dependencies. prepare() binds their union plus the common
core/folder/storage helpers and build/driver/config inputs, app and
objdir/dist/bin/gtest/libxul.so, dependentlibs.list.gtest, application.ini, platform.ini
and config.status.
Root must bind those exact hashes to the separate reviewed native build; HEAD alone
is not artifact provenance. Source checkouts must be clean. Application [App] and
platform [Build] SourceStamp must match comm and Gecko respectively.

Use Python 3.11+ on Linux with /proc, pidfds and PR_SET_CHILD_SUBREAPER available.
The runner verifies source and hashes before/after each case and at finalization.
It captures /proc/pid/exe plus the actual mapped library's path/device/inode;
a different additional libxul image is rejected, including after initial proof.
Missing/stale mapping proof fails even when JSONL passes. A very fast process may
exit before proof is observed; that remains a failed evidence result, not inferred
success. No exe-name kill or process-name exemption exists.

Every case uses a new process session and exclusive evidence directory, with a
reserved native.jsonl, unfiltered stdout/stderr and a fresh HOME/TMPDIR. Environment
is explicit: PATH/LANG/LC_ALL are retained, native driver paths/flags are recorded;
other inherited variables, including GTEST overrides and MOZ_AUTOMATION, are absent.
No security/automation preference is changed. Linux subreaping and pidfd ownership
rechecks cover owned descendants, including reparented children. Cleanup is bounded;
any required termination fails the case, and survivors/cleanup uncertainty stop
later launches. SIGTERM/SIGINT set a permanent cancellation reason before raising;
all later launches are refused, including after hashing or finalization interruption.
Further termination signals leave that reason set and allow evidence finalization.
Per-case I/O failure otherwise does not stop later selected IDs. The resolved app
directory must have no stale cpp-unit-profd entries before launch; any new leftovers
also fail the case. These profiles are created beside the executable, not in evidence.

JSONL completion, exit 0 and post-suite XPCOM completion are all required. The
stdout native event sequence must match the dedicated log; extra successful events
on either raw stream fail. Raw output also rejects anchored assertion/crash/profile
and sanitizer failures. It does not measure refcount leaks. Structured expected text,
ordinary prose and crash-reporter setup are not failures. First JSON failure is
retained, otherwise the first raw failure in stdout then stderr; cross-stream chronology is not inferred.

Every selected ID receives a result or NOTRUN reason; failures, timeouts, incomplete
selection and final identity errors fail the aggregate. A timeout shortened by the
test-stop budget is labelled timeout_kind: deadline-shortened and remains FAIL.
Config/receipt bytes, argv/cwd/environment, hashes, Git commands, PID/maps, deadlines, exit and counts
remain outside source. Existing evidence is never overwritten. If cancellation
interrupts summary writing,
interrupted-summary.json contains the complete failed ledger; partial summary.json
is retained. Case result write failures remain in the batch ledger. Observed PASS is a
case/process result; coverage remains none while native profile isolation/removal,
close-barrier qualification and restored negative controls are pending.

Local lightweight checks use tiny Python children and temporary Git fixtures:

~~~powershell
python -B -m unittest -v test_native_runner.py test_native_accounting.py test_accounting.py
~~~

On Windows the Linux cleanup probe checks refusal only; Linux /proc/pidfd/subreaper
execution remains pending. Native compile/link, lifecycle and Linux runtime
qualification require a new authorized allocation. Refcount leak qualification
remains unavailable in this slice. No binary, build or cloud operation is authorized
by this document.

## MessageReferences fault and cleanup qualification

The registered fixture is the accepted 014+015 source, including independent SQL
row-presence checks and the externally linked fault witness. It uses a unique
OS-temp child and the concrete core/database file; store none claims no bodies.
The receipt additionally binds nsIMsgHdr IDL, the adapter and native fixture,
plus pinned SQLite statement/error-mapping/function interfaces.

Require the read UDF to be called once during ExecuteStep after successful prepare;
the ordinal-1 insert ABORT to report constraint and roll back; and the deferred-FK
probe to fail at COMMIT with an active transaction before product rollback. The
setter must reach both commit-fault witnesses, leave no transaction and preserve
the independent committed-token snapshot. Early failures certify none of these
later assertions. Native compile and actual mechanisms remain unqualified.

Retain full case evidence and any failed child, including retained_profile XML
property/path where available. This executor does not collect gtest XML properties;
identifying retained child paths remains a runtime collection gate. Confirm close
barrier, provider restoration and removal/retention under the actual OS-temp path.
Root must approve recorded temporary negative-control revisions, then restore:
remove count zeroing, widen output writes, bypass null-count errors, clear indexed
sentinels, parse past NUL, disable the read UDF/insert ABORT/deferred FK, or make
CheckMessageRow vacuous. Each intended case must fail before qualification.
The separate stale MessageExists cache and ingestion/setter parity findings remain
with their owners. No Windows executor or interruption-contract change is included.
