# Windows native helper prerequisite

native_windows.py is not connected to run_native.py. Windows acceptance execution
still refuses before launch. No native case, manifest or product change is included.
The 14 native cases, 93 xpcshell rows and NumericProperties hold are unchanged.

Use Job as a context manager in a dedicated single-threaded Windows x64 process.
launch(argv, env, cwd, stdout, stderr, cancel) permits one launch per fresh job.
Paths are absolute; output files are exclusive. The caller supplies the environment
and sticky cancellation check. The helper adds no launcher argument or preference.
request retains argv, environment, cwd, output paths, creation flags and root PID.

CreateProcessW uses CREATE_SUSPENDED and CREATE_NO_WINDOW. Only duplicate standard
handles are inherited through STARTUPINFOEX's handle list. Job assignment precedes
ResumeThread; no breakaway limit is enabled. PROCESS_INFORMATION remains owned even
if returning from CreateProcessW is interrupted. DuplicateHandle output slots have
cleanup registered before the native call, including interrupted returns.
Assignment/resume failures use the created process handle, not a name or PID search.

wait(deadline, cancel) waits for the whole job, including children remaining after
the original parent exits. A finite absolute monotonic deadline is required. Timeout
and cancellation raise; always retain the enclosing context manager for cleanup.
close(deadline) terminates only job members (or the created, still-unassigned root),
waits within that deadline and retains terminated/surviving PID evidence. It retries
one InterruptedError without losing prior evidence. Context exit reserves two
seconds; final execution wiring must keep cleanup inside the request's final budget.
The non-inheritable job handle has KILL_ON_JOB_CLOSE as an owner-exit backstop.
Cleanup errors propagate; they never establish that descendants exited. Failed or
timed-out unassigned-root termination retains Job.process after closing the job.
Keep that Job reference and call close with a new bounded deadline to retry; no
further launch is permitted. Successful retry releases the handle and clears the
error. Persistent denial requires external resolution, not a clean result.

Only InterruptedError is retried automatically, once. KeyboardInterrupt propagates
without that retry: assigned members have kill-on-close as a backstop; an unassigned
root remains retained. Duplicate acquisition unwinds its registered slots for both
exceptions. Tests inject each exception after DuplicateHandle returns; they do not
qualify arbitrary console-signal timing or repeated interruptions during cleanup.

observe(pid, app, library) opens a process handle and verifies live membership in
this job before collecting evidence. The first enumerated module must agree with
GetModuleFileNameExW(NULL). Its section-mapped device path must match app, and its
loader-path file ID must match the current app file ID. QueryFullProcessImageNameW
alone is insufficient. DLLs retain equivalent mapped-path and loader-file checks.
These are samples of names and current disk metadata, not immutable section/file
identity or a hash of executing bytes. A same-path replacement can remain invisible
if all sampled names still agree. Independent receipt checks remain required. Observation errors, missing DLLs
and conflicting images refuse proof. Native x64 and local drive image paths only;
WOW64/ARM and UNC are explicitly refused. Module enumeration is a sample; it can
race with image changes and cannot certify images between observations. File-ID
and device-path behavior on the eventual build filesystem still needs qualification.

Exact efd2 mach commands:1197-1201 append --wait-for-browser only for Windows with
MOZ_LAUNCHER_PROCESS defined. Future wiring must preserve that condition and bind
the actual build declaration; this helper never invokes mach. The supplied pins
include nsAppRunner.cpp:5345-5360's gtest entry, not the launcher implementation.
The three requested launcher files are now hash-verified in launcher-inputs.json.
LauncherProcessWin.cpp:244-260 selects wait mode; :621-670 creates/resumes the child
and forwards its exit code when waiting. Nested-job/deelevation behavior is still
a future wiring/qualification requirement. No launcher code is invoked here. Current comm
mail/app/nsMailApp.cpp:212-235 distinguishes TB's entry and calls XRE_main; that is
not proof of another build's launcher configuration. Windows artifact names and
loader paths must also be bound to the eventual build receipt, not guessed here.

Still required: reviewed Windows runner wiring, conditional launcher wait and child
exit handling, matching immutable build/source/app/DLL/INI/config receipt, repeated
owned-process image proof, fresh profile/removal and close barrier qualification,
strict per-case output accounting, root-reviewed deadlines and a new authorized
allocation. Direct handle-return acquisition in CreateJobObjectW, OpenProcess and
CreateFileW still lacks an atomic owner if an exception lands before assignment;
the DuplicateHandle output-slot fix does not solve those boundaries. A reviewed
interrupt-deferral/ownership strategy is required before executor enablement. leak_check remains unavailable; this helper collects no leak logs.

Existing Linux nonblockers remain open: interruption inside cleanup can leave
owned descendants without retry. Root must treat interrupted-summary.json and a
nonzero exit as authoritative even when summary.json was fully written with ok=true.
No claim is made that these are fixed by the Windows helper.

Run lightweight checks from this directory:

~~~powershell
python -B -m unittest -v test_native_windows.py test_native_runner.py test_native_accounting.py test_accounting.py
~~~

Windows probes use tiny Python child/grandchild programs and a system DLL. They
qualify those exercised primitives on this host, not Thunderbird, its launcher,
profile, acceptance executor or another Windows build. No native build is run.
