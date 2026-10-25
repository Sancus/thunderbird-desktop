# Manual native acceptance

Only TestDeliveryCoreReferences.cpp is linked here. Its fourteen cases remain
DISABLED_DeliveryCoreReferences; no normal-CI filter or execution is added.
The 93 xpcshell rows and NumericProperties hold are unchanged. FolderInfo19,
EWS and search/conversation/browser registration remain separate owner slices.
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
The core fixture independently creates/removes its unique child and closes the core.

gtest.cc:6819 parses --gtest_also_run_disabled_tests. The runner passes that flag
and one exact GTEST_FILTER; it uses no wildcard, repeat, sharding or filter-set.
nsAppRunner.cpp:5345-5360 enters the gtest runtime through MOZ_RUN_GTEST.
toolkit/library/gtest/moz.build targets dist/bin/gtest. Exact pinned mach commands
still build gtest before execution (:1134-1136); run_native.py never invokes mach.
Root must build/configure the target separately and freeze the resulting receipt.

Additional exact nsDebugImpl.cpp, nsTraceRefcnt.cpp, mfbt/Assertions.h and
nsXPCOMGlue.cpp pins have been requested from root for diagnostic/loader review.
Assertion/leak formatting beyond the supplied TestHarness literals is provisionally
corroborated by older source. These remaining pins/review are an execution hold;
literal preflight checks are not a substitute for that review. No native run occurred.

## Linux slice

run_native.py requires a fresh root-reviewed request and build receipt. Windows
is refused before launch: owned Job Object and conditional launcher waiting need
a separate reviewed implementation. No platform earns credit from synthetic tests.

Request fields are absolute source, objdir, evidence and receipt paths;
receipt_sha256; an ordered, distinct select array of native-cases.json IDs;
timeout_seconds (1-600); timezone-qualified test_stop_utc and finalize_utc with
at least 60 seconds reserved for final checks. All dates/allocation identifiers must
come from a newly approved allocation; the original allocation is closed.
No scheduling or allocation is performed by this tool.

The receipt contains build_identity, full comm_revision/gecko_revision, absolute
app/library/mozconfig paths, and inputs mapping absolute files to SHA-256 hashes.
prepare() declares mandatory test/product/build/driver/config inputs, app and
objdir/dist/bin/gtest/libxul.so, application.ini, platform.ini and config.status.
Root must bind those exact hashes to the separate reviewed native build; HEAD alone
is not artifact provenance. Source checkouts must be clean. Application [App] and
platform [Build] SourceStamp must match comm and Gecko respectively.

Use Python 3.11+ on Linux with /proc, pidfds and PR_SET_CHILD_SUBREAPER available.
The runner verifies source and hashes before/after each case and at finalization.
It captures /proc/pid/exe plus the actual mapped library's path/device/inode;
missing/stale mapping proof fails even when JSONL passes. A very fast process may
exit before proof is observed; that remains a failed evidence result, not inferred
success. No exe-name kill or process-name exemption exists.

Every case uses a new process session and exclusive evidence directory, with a
reserved native.jsonl, unfiltered stdout/stderr and a fresh HOME/TMPDIR. Environment
is explicit: PATH/LANG/LC_ALL are retained, native driver paths/flags are recorded;
other inherited variables, including GTEST overrides and MOZ_AUTOMATION, are absent.
No security/automation preference is changed. Linux subreaping and pidfd ownership
rechecks cover owned descendants, including reparented children. Cleanup is bounded;
any required termination fails the case, and survivors/cleanup uncertainty stop
later launches. Per-case failure otherwise does not stop later selected IDs.

JSONL completion, exit 0 and post-suite XPCOM completion are all required. The
stdout native event sequence must match the dedicated log; extra successful events
on either raw stream fail. Raw output also rejects anchored assertion/crash/profile failures and nonzero TOTAL
leak bytes/objects. Structured expected text, ordinary prose, crash-reporter setup
and zero-leak totals are not failures. First JSON failure is retained, otherwise the
first raw failure in stdout then stderr; cross-stream chronology is not inferred.

Every selected ID receives a result or NOTRUN reason; failures, timeouts, incomplete
selection and final identity errors fail the aggregate. Config/receipt bytes,
argv/cwd/environment, hashes, Git commands, PID/maps, deadlines, exit and counts
remain outside source. Existing evidence is never overwritten. Observed PASS is a
case/process result; coverage remains none while native profile isolation/removal,
close-barrier qualification and restored negative controls are pending.

Local lightweight checks use tiny Python children and temporary Git fixtures:

~~~powershell
python -B -m unittest -v test_native_runner.py test_native_accounting.py test_accounting.py
~~~

On Windows the Linux cleanup probe checks refusal only; Linux /proc/pidfd/subreaper
execution remains pending. Native compile/link, lifecycle, leak-detector sensitivity
and Linux runtime qualification require a new authorized allocation. No binary,
build or cloud operation is authorized by this document.
