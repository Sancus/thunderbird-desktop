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


Local-storage and workflow lanes are separate manual manifests (12 and 6 rows).
The predeclared folder_roles map names roles using the fixture's literal URI leaf
names; required folders must be distinct and share their account parent. Every
folder diagnostic must still match the actual backend/store and earlier contract
observation. Copy/Move require both source and destination, plus their terminal
local-copy-verified/local-move-verified phase. Publication requires its target and
local-publication-verified. Workflows have no artificial phase: the full file must
pass and every declared source/outside/saved-search folder must be observed.
These diagnostics establish instantiated stores, not body round-trip coverage
for membership-only workflows.

Results retain the first failing test/harness event and last observed phase.
Only an entirely passing file can certify completed_phase or coverage. Folder
setup evidence and a late phase after failure never grant later assertions credit.
Preflight/launch errors have disposition=blocked, test failures/timeouts=failed;
both fail the aggregate with zero coverage. These lanes require standard local
mail/view facilities: missing product behavior remains a failed assertion, never
inferred unsupported-build. Explicit optional-protocol unsupported-build gates
belong to their later registration slice. They must also have zero coverage.

Local Copy/Move here use the integrated source version. LS-N1's destination-first
correction is a separate owner commit awaiting review/integration; registration
does not import that code. A first source/property failure can hide destination
and later identity/body checks. Remote evidence must retain that first failure;
terminal phases remain required, with no partial case pass.

## Foundation registration and format readers

The manual inventory includes the reviewed core ownership/error/migration cases,
three factory cases in each Panorama store, and UIDVALIDITY in all four IMAP
lanes. Manual manifests remain outside normal test registration. The strict Mork
byte reader is packaged by `EXTRA_JS_MODULES.panorama`; its three files are lexical
format tests, with 17/20/12 normal tasks. They prove no full-document import, native
reader parity, database, account, body-store, or Mork-removal behavior.

Format rows declare `backend: null`, `store: null`, `fixture: "format-reader"`,
and `diagnostics: "format-reader"`. Their manifest has no heads, preferences or
lane environment. `source_dependencies` binds the reviewed module and its
packaging declaration; the two support fragments are also hashed. The runner
unsets inherited lane/installed-root variables, requires assertions and exact
file completion, and rejects product diagnostics. A missing packaged module
fails its real import; no source-path substitution is used.

UIDVALIDITY requires paired legacy reference results: run
`imap:mork:mbox:UidValidity` before `imap:panorama:mbox:UidValidity`, and
`imap:mork:maildir:UidValidity` before `imap:panorama:maildir:UidValidity`, each in
a separate process/profile with its declared artifact. Preserve all later
results if a reference fails, but do not accept the combined transition evidence
until both references pass or the failure is reviewed as legacy behavior.
Store diagnostics here prove selection/instantiation; online streaming does
not prove persisted body-store or offline replay behavior.

The new-source hold ledger may release `core:MessageProperties` and
`core:FolderProperties` only with the accepted exact-name correction in ancestry
(`4f9720478b4276bd45c5a24a5631d6c4a3739df2`, acceptance-009).
`migration:NumericProperties` remains pending-contract and is refused before
execution. Initial009 and its three frozen holds remain immutable. EWS,
conversation/search and remaining protocol registrations are later batches.

## NNTP manual lanes

Five existing reviewed files run independently in four NNTP tuples (20 IDs):
Backend, Identity, Body, Read and Flag. Run both Mork store lanes first as fixture
references, then both Panorama lanes as pending-product. No pending-product
failure is skipped or accepted. NumericProperties remains pending-contract.
The previous 73 catalog rows are unchanged.

The news head loads before head_delivery_paths.js so its default gDEPTH is replaced
with the declared installed test root before cleanup. Its shutdown helper resolves
to the same installed file as the normal suite. Preflight hashes and compares the
installed shutdown, AppInfo, MockRegistrar, LocalAccountUtils, Maild, Nntpd and
PromiseTestUtils helpers with their matching source bytes, and hashes their
packaging declarations. Missing/stale fixture dependencies block execution with
zero coverage; NNTP product/factory failures remain failures, not unsupported-build.
No invented account-support preference is set.

Backend checks the root factory/store only. Each behavioral case requires distinct
same-account test.subscribe.simple and test.filter folder/store diagnostics and
its declared terminal phase. A failure retains the first error and last phase,
certifies no completed phase or coverage, and does not stop later selections.
Body verifies online streaming and two ARTICLE requests with no offline body;
these lanes do not prove physical mbox/maildir persistence or restart durability.
Native execution requires a new authorized allocation and matching source/package,
test installation and harness dependencies. Registration is not runtime evidence.
EWS and conversation/search/browser remain pending batches.

## References metadata registration

The 38 additional References files each declare one exact named task in cases.json.
They use panorama:none and existing production-schema metadata fixtures, with no
account/body-store fixture. Backend evidence reports metadata-only scope and none;
folder/store diagnostics are rejected. The original three References rows retain
panorama:mbox. All prior 93 rows and the NumericProperties hold are unchanged.

Preflight binds the single named task and db/messages.sql. Accounting requires its
ordered pending/finished messages, assertions within that task, complete file PASS
and exit 0. Skip/expected-failure/crash policy remains strict. The five 65535-65537
token boundary cases have a 1800-second outer minimum and a supported efd2 harness
timeout factor of 50 (1500 seconds); other new cases use at least 600/300 seconds.
The runner records the effective outer limit and exact timeout-factor argv. Root
must budget each process and its descendants; any timeout fails with zero coverage.
No boundary or literal oracle is reduced. WriteError still needs the approved
automation-guarded connectionForTests prerequisite; no guard bypass is added.
Native build/runtime, negative controls and close/profile qualification are pending.

## IMAP discovery selection

Twenty one-entry manual manifests select child, nested, repeat, online-name or
delimiter in four backend/store lanes. The ten Mork rows are reference-only;
Panorama rows remain pending-product. Selector preference and fixture diagnostics
must agree with the catalog, with its required terminal phase and target folder.
These dynamic tasks do not use the metadata-only named-task policy. The nested
roles name only DeliveryChild; the domain assertions prove its parent separately.
Preflight binds matching installed direct IMAP fixture modules and shutdown bytes.

Only complete passing files certify their declared phase. Discovery/online-name
failures remain visible; an intermediate property phase gives no later credit.
These cases check live slash delimiters and folder-DB reopening, not process
restart, delimiter durability, UID/message ingest, body storage or offline replay.


## Direct folder initializer registration

Four reviewed files run as eight manual file/store cases (Panorama mbox/maildir).
Each file gets a fresh process/profile. Failure, Identity and Conflict have one
named task each; ParentConflict has two plus setupFolders. Thus each store runs
five tasks across four files. The tasks/setups declarations are checked against
source; every task must start, assert and finish in order. The earlier metadata
single-task and IMAP selector conventions are unchanged.

The two initializer manifests bind InitWithFolderId/lookup/cache, mailbox factory,
local store discovery, Reconcile and account/root dependencies. Preflight also
hashes the source and installed MessageGenerator/MockRegistrar modules and refuses
missing or stale copies. Folder roles prove the actual Panorama/store fixture;
Failure and ParentConflict additionally check retained body bytes in their tests.
Identity/Conflict do not claim a body round trip. No first error grants later
row, field, child, cache, body, fault-witness or recovery assertions credit.

ParentConflict alone requires_non_debug. Its raw missing-URI eviction control
reaches CreateDangling's NS_ERROR before NS_ERROR_UNEXPECTED. Pinned efd2
nsDebug.h:111-121 compiles NS_ERROR out only without DEBUG; the pinned xpcshell
harness:1641-1647 sets XPCOM_DEBUG_BREAK=stack-and-abort. Do not change that value.
Preflight requires mozinfo.json debug to be exactly false and binds that file,
config.status, the actual harness, nsDebug.h and nsDebugImpl.cpp. Root must verify
these are matching build outputs and confirm non-DEBUG from actual configuration
before input approval; an optimized/release label is insufficient. The recorded
harness value comes from pinned source, not a sampled child environment.

Unknown/DEBUG build mode blocks before launch (HOLD for a reviewed replacement
control). Success also requires both raw output streams and no ###!!! ASSERTION
in JSONL or stdout/stderr; a diagnostic fails the case, even after complete PASS
JSON and exit zero. No skip, assertion suppression or expected-failure allowance
is added. Failed-object numSubFolders remains a real runtime outcome.

All eight rows remain pending-product and must fully pass on matching source and
Gecko, with fresh profiles and complete cleanup. Negative controls against c460
and restored source, FolderFactoryChildren/Retry, local startup/Reconcile, root
factory, MailboxName and native017-qualified regressions remain root runtime
gates. Native017 and lightweight accounting checks give these new files no PASS.
Native gtest build/qualification proceeds independently.

## Raw database task groups and physical view identity

The manual catalog has 170 JS rows; NumericProperties remains pending-contract.
Publication declares all nine tasks with the accepted snapshot031 source;
ConversationIngestion retains all four.
These panorama:none files each require one literal anonymous setup, assertions
and backend evidence inside it, then every named task with assertions and exact
file/suite completion. Preflight binds the pinned xpcshell head.js task logger.
No account or body store is claimed; missing/extra tasks or setup evidence fail.
The singular metadata task and folder-initializer gates remain separate.

SingleFolderIdentity adds both Panorama stores; CrossFolderIdentity is a Mork
mbox reference with equal folder-scoped keys. Both require every literal fixture
folder/store diagnostic and full-file PASS. Root must also inspect their named
task completion, fresh-header lookup, exact rows and live deletion assertions.
Store selection gives no extra body-persistence credit. Matching build/source,
installed fixtures, fresh profiles, cleanup and negative controls remain required.
Unselected rows are NOTRUN; historical isolated jobs do not qualify this source.

The five PropertiesUint32 files each declare one existing singular metadata task.
Their task performs its own raw DatabaseCore/file/backend setup, so no anonymous
setup or folder/store scope is added. All fixed prefix/text/typed-field and
overwrite assertions remain; read/write fault cases require reached witnesses,
exact errors, unchanged committed state and recovery. Binding source is not
runtime fault qualification. Root must verify the exact string/SQLite APIs and
retain the approved write-trigger hex witness; no oracle is rewritten here.

## Complete header publication

CompletePublication and QuietPublication each select one existing named task in
a fresh Panorama mbox process/profile. Both require the literal fixture folder,
actual backend and pre-getter store proof, task assertions and full-file end.
Their synthetic token does not prove stored body bytes or retrieval. The first
checks all fields and NewList inside the legacy callback; the second requires
quiet legacy delivery and one complete internal LiveView publication. Reentrant
attach, consumed-draft identity and no replay remain strict runtime assertions.
Matching generated headers, source/build receipts, fresh cleanup and restored
notification/alias/state negative controls remain pending. All unselected cases
are NOTRUN. Mixed LocalStructure lanes remain held under strict skip rejection.

Snapshot031 source and admission must land atomically: the five-task
source fails the nine-task declaration, and the nine-task source fails the old
declaration. The same core:Publication ID requires all task assertions and file
completion; unselected cases remain NOTRUN. Date/thread membership controls need
matching-source runtime and restored setter negative controls, not metadata credit.

## Corrected local publication requests

The two PublicationCopy requests declare the nine accepted local018 tasks and
setupLocalPublicationCopy from local020. They are pending-product and NOTRUN after
joint source/registration review and the explicit readiness transition.
Preflight binds both original and installed PromiseTestUtils modules; missing or
stale installed bytes block launch. Actual module import/behavior still requires
matching runtime. No callback or store scan grants direct final-stop order or
member-three stream-open credit; those independent witness gates remain held.

## Root-cache requests and declared parents

All four ServerRoot requests are pending-product and NOTRUN after joint source/
registration review and the explicit readiness transition. Commit 738d26a supplies
actual Known and bystander diagnostics without changing product behavior. Failure
requests declare their two real account parents, with an exact role keyset and
observed-parent match. Identity retains the default common-parent rule. Failure
still requires matching non-DEBUG configuration and no raw assertion diagnostic.
Source availability and synthetic parser checks grant no runtime coverage.

The two Panorama PublicationWitness file/store cases require both native-stop
witness tasks and setupLocalPublicationWitness, with all six literal folders.
They remain pending-product and provide no runtime credit before matching-build,
XPConnect, fault/stop ordering, registrar restoration and process/profile checks.
