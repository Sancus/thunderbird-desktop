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
EWS, conversation/search/browser and native gtests remain separate pending batches.
