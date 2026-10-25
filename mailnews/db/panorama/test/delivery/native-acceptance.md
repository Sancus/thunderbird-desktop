# Manual native acceptance (verification hold)

This directory links only TestDeliveryCoreReferences.cpp into xul-gtest. All cases
retain DISABLED_DeliveryCoreReferences, so ordinary gtest runs do not execute them.
No normal suite filter is added. TestDeliveryFolderInfoProperties.cpp is excluded:
its seven existing cases and owner-proposed boolean cases await corrected fixtures,
disabled names and independent review. EWS/search/conversation/browser remain
separate work. cases.json and its 93 xpcshell rows, including the NumericProperties
contract hold, are unchanged.

native-cases.json lists fourteen exact filters, independent observable expectations,
and raw-DB scope (Panorama, store none). The fixture selects DatabaseCore directly
and checks its panorama.sqlite file identity. There is no store/account fixture or
mbox/maildir claim. Core/connection reopen within one process is not process restart.
No automation or security preference is changed.

## Verified source and remaining pins

The exact efd2 mach_commands.py is available in delivery/state/pinned-gecko-harness,
SHA-256 01608bd9c06d2ecc085997b6f0528c33f6f3ea8b114e30e403bc56e53ec320f5.
Its gtest command dispatches a build of target gtest (1134-1136); running the command
is therefore a build action. It constructs app -unittest and thread-safe death-test
arguments (1194-1201), copies the environment and sets GTEST_FILTER (1216-1217),
and launches one process for --combine-suites with --jobs 1 (1293-1312).
Windows adds --wait-for-browser when MOZ_LAUNCHER_PROCESS is defined. Paths for
MOZ_XRE_DIR and MOZ_GMP_PATH are native platform paths (1219-1226).

The exact native logger, disabled-flag implementation, profile provider and linked
runtime sources were requested from root. Local runtime/src is older evidence,
not the pinned revision. Until those bytes are verified, the output format and
launch/profile assumptions remain provisional. No execution entrypoint is supplied.
The build declarations follow neighboring comm gtests; native compilation and
linkage, including Windows exports and fixture cleanup, remain unverified.

## Accounting and execution contract

native_accounting.py checks only a proposed dedicated Mozilla gtest JSONL stream,
independently of xpcshell diagnostics and suite selection rules. It requires one
program/group/case start and end in order, the exact selected case ending PASS,
and zero skips, failures, crashes, timeouts, extra executions or process errors.
The program's empty tests declaration is not evidence of selection. Passing
assertions need not emit events. log_complete is structural only; coverage remains
none and the verification hold remains present even for a complete synthetic log.
It is not an executor or artifact-identity gate.

Before an executor is approved, confirm from exact efd2 source that
GTEST_ALSO_RUN_DISABLED_TESTS=1 or --gtest_also_run_disabled_tests actually enables
the disabled suite, and that MOZ_GTEST_LOG_PATH produces the proposed dedicated
stream. The verified mach command retains the environment variable, but that alone
does not prove its native interpretation. Neither MOZ_AUTOMATION nor a security
preference is a substitute. Avoid mach's repeated implicit builds during acceptance;
root must separate the immutable native build from the per-case launch phase.

The future reviewed launcher must use one exact catalog filter per fresh native
process/profile, sequentially, with explicit disabled-test opt-in and no wildcard,
sharding, repeat, listing, retry or filter-set override. Preserve raw stdout/stderr,
dedicated native log, filter/argv/cwd/environment, PID, timestamps, exit code and
counts. Record clean comm/Gecko revisions plus hashes of test/product/build inputs,
app and loaded xul-gtest library, application/platform INIs, config.status and
mozconfig before and after execution. Root supplies matching artifact provenance;
HEAD alone does not establish binary identity. Use new evidence paths outside source
and never overwrite earlier logs. An early failure grants no later contract credit.

Require a new authorized allocation and root-reviewed deadlines before launch.
Bound every process and reserve finalization headroom; a timeout must clean only
that job's descendants, retain failure evidence and continue later eligible cases.
Every requested ID needs a result or explicit NOTRUN reason, with a failing
aggregate for any failure, timeout or incomplete selection. Linux needs verified
session/descendant cleanup; Windows needs launcher waiting and an owned Job Object
or an equivalently reviewed descendant mechanism. No name-based killing or unrelated
process cleanup. Neither mechanism is implemented or claimed by this offline checker.

The native fixture creates a unique disposable profile directory, restores the
previous directory provider and removes its own directory. Confirm the pinned
ScopedXPCOM provider and per-process isolation, close barrier and profile removal
on matching Linux and Windows before acceptance. Preserve crash stacks/symbol
identity when available. Native compile/runtime and targeted restored negative
controls remain pending; the existing compatibility/migration References lanes
also require their owners' dependent slices.

Lightweight verification from this directory (no native binary):

~~~powershell
python -B -m unittest -v test_native_accounting.py test_accounting.py
~~~
