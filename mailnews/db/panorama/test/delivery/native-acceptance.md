# Manual native acceptance

TestDeliveryCoreReferences.cpp (41 cases), TestDeliveryFolderInfoProperties.cpp
(26), TestDeliveryMessageReferences.cpp (19 References, 10 HeaderProperties,
6 DetachedThreadIdentity and 7 CompleteHeader), TestDeliveryCoreMessageExistence.cpp
(24) and TestDeliveryCoreProperties.cpp (11) are linked to xul-gtest. The real
quarantine wrapper control in TestQuarantinedOutputStream.cpp adds one case. All 145 filters
retain DISABLED_ suites and pending-product status; no normal-CI
execution is added. EWS and search/browser registration remain separate slices.
The 144 Panorama cases select the concrete core and check panorama.sqlite identity.
The quarantine control exercises real wrapper/temp-file I/O and an inner Finish
failure; it claims no database, backend or body-store coverage. The catalog store
none is not physical-store evidence. No application-restart coverage is claimed.

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

The CoreMessageExistence suite uses stored membership and independent unshared
readers while requiring retained warm-header fields during deletion notification.
Cold means same-process core/connection reopen. Prepare and reached-step faults
propagate errors without changing output sentinels; the step witness proves actual
execution. Bind-failure injection, OOM/IO, process restart and cache eviction
lifetime are outside these cases. Compile, fault sensitivity, restored negative
controls and the OS-temp close/restoration/retention lifecycle remain pending.

The three stored-identity filter cases cover single, multi and virtual folder
matching without an account-backed folder object. Virtual coverage uses ALL;
non-ALL search is outside these cases. Each exact disabled filter requires its
own fresh process/profile and bound receipt;
missing identity zero must not match. The public event regression stays in the
existing core:Publication case. Matching native compilation and runtime are pending.

The five additional removal cases require committed cold-callback fields, stored
values replacing a stale warm cache, atomic rollback after reached step/commit
failure, and rejection of a caller-owned transaction without taking ownership.
Failure cases require no callback, preserved independent storage and a successful
retry after fixture recovery; an error alone is insufficient. Bind DatabaseCore
schema/connection lifecycle, MessageDatabase, Message and FolderDatabase sources
and headers. Same-process reopen is not application restart. Each exact disabled
case still needs matching native compilation, fault sensitivity, full shutdown
and profile/close qualification; the xpcshell ColdDeletion result gives no native
gtest credit.

The 27 property/identity additions remain manual and unqualified. CoreProperties
requires exact text/name/presence, independent stored types, same-process reopen,
reached write/read faults and schema-upgrade rollback/retry. HeaderProperties
requires exact hexadecimal conversion, adjacent canaries, null-before-SQL and
separate prepare/step witnesses. DetachedThreadIdentity requires independent
full-width IDs/canaries, null rejection and metadata preservation. Same-width
signed representations are not a runtime negative control for those IDs.

Receipts now require the pinned storage-service/unshared-open interfaces and
thread/event-target/async-close APIs in addition to schema, adapter, fixture,
IDL and build sources. Root must bind actual compiler/build receipts, matching
app/loaded library/INIs/configuration and complete shutdown/profile evidence.
Each exact filter still needs compilation, fault sensitivity and restored
negative controls. Windows and refcount leak qualification remain held. The
isolated 724 build packet retains its frozen 67-case catalog. Unregistered
date/thread snapshot and further publication gtests receive no credit here.

The eight ThreadKeys cases select depth-first membership/empty success, three
separate named-bind failures, preparation failure and first/after-seed step
failures. On failure the exact error and original caller keys must survive;
independent rows and reached function/count/key witnesses remain required. The
bind faults use a mismatched cached statement, not an ordinary production query.
Receipts also bind the Thread consumer/interface, MsgUnhex sources and Gecko
mozStorageBindingParams implementation/header. Those last two exact efd2 pins
need root verification before runtime admission. Matching SQLite planner, native
close/profile lifecycle and restored old-code negative controls remain NOTRUN.

The ten complete native publication controls and seven CompleteHeader adapter
controls precede one snapshot031 control, bringing the manual catalog to 120 before the six captured-data controls.
The current catalog contains 144 filters.
Both existing source files are already in xul-gtest; all filters remain DISABLED and require exact isolated selection.
Core publication binds the RawHdr declaration, named/default/extra/storage write
path and helpers. CompleteHeader binds the detached/PerFolder/live adapters and
the real shared fixture. Receipts also require pinned Maybe.h and RefPtr.h.
Generated IDL/layout/vtable dependents need a matching rebuild and xul-gtest link.
Late-property and References fault witnesses, unchanged outputs/control rows,
ended transactions and no replay must execute; error returns alone give no credit.
First-callback completeness, quiet internal delivery, keyword/name precedence,
DR023 vectors and reentrant borrowing retain all original assertions. Native
runtime, restored negative controls, raw shutdown/profile/loaded-image proof and
refcount/debug qualification remain pending; leak checking stays unavailable.
Snapshot031 adds only ConversationFilterRejectsThreadReadFailure, atomically with
its exact source and the nine-task Publication declaration. Its reached native
getter writes a matching thread identity but returns failure; the filter must
reject it while real matching/excluded controls and independent stored rows remain
correct. This is not a SQL fault claim. All 144 cases remain manual/DISABLED and
NOTRUN until matching compilation, isolated execution and close/profile evidence.

## Captured-data prerequisites

Six exact CoreReferences filters bind captured036 source and retain DISABLED and
pending-product status. Source and registration must be composed atomically;
the strict five-translation-unit filter inventory rejects either alone. Captures
require all eleven historical facts, unchanged error sentinels, a reached SQL
progress-handler interruption and recovery, owned prepared arrays, stable callback
snapshots and staged-SQL reads without cache mutation. Default batch hooks are
unwired data controls, with no producer/graph/queue or native consumer credit.

Receipts additionally bind the exact progress-handler IDL, fallible allocation,
mozalloc, nsTArray and nsTSubstring declarations. Source/API availability is not
compiler qualification. Matching generated headers, toolchain/build configuration,
xul-gtest linkage, fault sensitivity, actual loaded-image proof, full shutdown and
profile/close qualification remain required. Linux-only execution and unavailable
leak measurement are unchanged; no Windows or refcount qualification is added.

## Component discovery draft

Eleven additional CoreReferences filters bind only component038 source c8f7d7ef.
The 144-case catalog remains manual, DISABLED and NOTRUN. Source and registration
must land atomically after source acceptance and root checks; metadata alone and
source alone fail the strict five-translation-unit inventory. The 047C captured
source/126-case packet stays immutable. No extra JS case or readiness change is
included, and optional 047 A/B composition does not change these native rows.

Discovery requires exact physical keys/folders and sorted unique membership,
including late/absent parents, siblings, duplicate physical copies and whole
stored components. Exact case, space, NFC/NFD and empty-token controls retain the
038 stored-component preconditions and independent raw history. Missing-history
production handling remains HELD: the unused helper returns NOT_AVAILABLE rather
than fabricating lost References. Missing/read-error outputs retain sentinels;
the progress abort witness, handler removal, recovery and staged rollback must
execute. An early assertion supplies no later fault or membership credit.

Receipts reuse the schema/writer, folder, raw-header, fixture/close and build
sources plus the pinned storage/progress/fallible-array APIs from 047C. A receipt
must bind exact c8 source bytes to a separately compiled matching app/xul-gtest,
generated headers, configuration/INIs and actual loaded image. Native compiler,
query planner, fault sensitivity, restored negative controls and profile/close
qualification remain NOTRUN. The helper is unwired: no AddMessage integration,
graph mutation, queue, notification or native consumer qualification is implied.

## KnownArts opaque property controls

Seven additional FolderInfo filters bind corrected385 source and keep all144
cases manual, DISABLED and NOTRUN. Source and registration must land atomically;
source-only or metadata-only inventory fails. The original19 FolderInfo oracles,
all137 prior native rows,176JS rows, seven holds and Publication9 are unchanged.
The existing five-translation-unit build list needs no registration change.

These raw-core cases have store none. They require owned non-null empty results,
opaque UTF-8 bytes, a stable held copy, exact property aliases/folder scope and
independent missing/present row counts. SQL faults require actual call count and
folder ID, exact errors, cleared read output and preserved control values. Cold
means checked same-process close/reconstruction for opaque and empty values, not
application restart. An early failure supplies no later loop/fault/reopen credit.

Receipts bind the public adapter/FolderInfo IDLs, concrete property storage,
listener ownership and schema/fixture/close sources. Additional pinned inputs
cover ToNewCString allocation/copy, nsCOMPtr, ScopeExit, the SQL witness variant
IDL and the actual gtest fixture-subclass macro. These are source/API bindings,
not configured compiler or allocation/fault/cleanup proof. Existing Linux-only,
raw shutdown/profile/loaded-image and leak-unavailable gates remain unchanged.

Compile/link, SQL fault sensitivity, ownership/close restoration, all19 original
controls and restored alias/normalisation/error/null-result negatives remain
NOTRUN. Preserve the source review limits: C-string NUL/missing-versus-empty,
XPConnect, OOM/prepare/bind, configured SQLite and cold-reopen retention/leak or
partial-reopen failure cascade remain unqualified. Full news/readSet/article
mapping and GetDatabase QI remain HELD; no news011, graph or emission is admitted.
