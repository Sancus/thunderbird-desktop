# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Windows x64 ownership prerequisite; not wired to native acceptance execution.

Use in a dedicated single-threaded process. No breakaway or arbitrary PID kill.
"""

from contextlib import ExitStack
import ctypes as C
from ctypes import wintypes as W
import math
from pathlib import Path
import subprocess
import sys
import time


class Limits(C.Structure):
    _fields_ = [("process_time", C.c_longlong), ("job_time", C.c_longlong),
                ("flags", W.DWORD), ("min_working", C.c_size_t), ("max_working", C.c_size_t),
                ("active", W.DWORD), ("affinity", C.c_size_t),
                ("priority", W.DWORD), ("scheduling", W.DWORD)]


class ExtendedLimits(C.Structure):
    _fields_ = [("basic", Limits), ("io", C.c_ulonglong * 6),
                ("process_memory", C.c_size_t), ("job_memory", C.c_size_t),
                ("peak_process", C.c_size_t), ("peak_job", C.c_size_t)]


class Startup(C.Structure):
    _fields_ = [("cb", W.DWORD), ("reserved", W.LPWSTR), ("desktop", W.LPWSTR), ("title", W.LPWSTR),
                ("x", W.DWORD), ("y", W.DWORD), ("width", W.DWORD), ("height", W.DWORD),
                ("columns", W.DWORD), ("rows", W.DWORD), ("fill", W.DWORD), ("flags", W.DWORD),
                ("show", W.WORD), ("reserved_size", W.WORD), ("reserved_data", C.c_void_p),
                ("stdin", W.HANDLE), ("stdout", W.HANDLE), ("stderr", W.HANDLE)]


class StartupEx(C.Structure):
    _fields_ = [("startup", Startup), ("attributes", C.c_void_p)]


class ProcessInfo(C.Structure):
    _fields_ = [("process", W.HANDLE), ("thread", W.HANDLE), ("pid", W.DWORD), ("tid", W.DWORD)]


class FileInfo(C.Structure):
    _fields_ = [("attributes", W.DWORD), ("created", W.FILETIME), ("accessed", W.FILETIME),
                ("written", W.FILETIME), ("volume", W.DWORD), ("size_high", W.DWORD),
                ("size_low", W.DWORD), ("links", W.DWORD), ("index_high", W.DWORD), ("index_low", W.DWORD)]


api = None
CREATE_FLAGS = 0x08080404  # NO_WINDOW | EXTENDED_STARTUPINFO | UNICODE_ENVIRONMENT | SUSPENDED.


def checked(value):
    if value in (None, 0, C.c_void_p(-1).value):
        raise C.WinError(C.get_last_error())
    return value


def _close_handle_output(slot):
    if slot.value:
        checked(api.CloseHandle(slot.value))
        slot.value = None


def initialize():
    global api
    if sys.platform != "win32" or C.sizeof(C.c_void_p) != 8:
        raise ValueError("Windows x64 helper required")
    if api is None:
        library = C.WinDLL("kernel32", use_last_error=True)
        pointer = C.c_void_p
        signatures = {
            "CreateJobObjectW": (W.HANDLE, [pointer, W.LPCWSTR]),
            "SetInformationJobObject": (W.BOOL, [W.HANDLE, C.c_int, pointer, W.DWORD]),
            "QueryInformationJobObject": (W.BOOL, [W.HANDLE, C.c_int, pointer, W.DWORD, pointer]),
            "AssignProcessToJobObject": (W.BOOL, [W.HANDLE, W.HANDLE]),
            "TerminateJobObject": (W.BOOL, [W.HANDLE, W.UINT]),
            "IsProcessInJob": (W.BOOL, [W.HANDLE, W.HANDLE, C.POINTER(W.BOOL)]),
            "GetCurrentProcess": (W.HANDLE, []),
            "GetProcessHandleCount": (W.BOOL, [W.HANDLE, C.POINTER(W.DWORD)]),
            "OpenProcess": (W.HANDLE, [W.DWORD, W.BOOL, W.DWORD]),
            "CloseHandle": (W.BOOL, [W.HANDLE]),
            "DuplicateHandle": (W.BOOL, [W.HANDLE, W.HANDLE, W.HANDLE, C.POINTER(W.HANDLE), W.DWORD, W.BOOL, W.DWORD]),
            "InitializeProcThreadAttributeList": (W.BOOL, [pointer, W.DWORD, W.DWORD, C.POINTER(C.c_size_t)]),
            "UpdateProcThreadAttribute": (W.BOOL, [pointer, W.DWORD, C.c_size_t, pointer, C.c_size_t, pointer, pointer]),
            "DeleteProcThreadAttributeList": (None, [pointer]),
            "CreateProcessW": (W.BOOL, [W.LPCWSTR, W.LPWSTR, pointer, pointer, W.BOOL, W.DWORD,
                                       pointer, W.LPCWSTR, pointer, C.POINTER(ProcessInfo)]),
            "ResumeThread": (W.DWORD, [W.HANDLE]),
            "TerminateProcess": (W.BOOL, [W.HANDLE, W.UINT]),
            "WaitForSingleObject": (W.DWORD, [W.HANDLE, W.DWORD]),
            "GetExitCodeProcess": (W.BOOL, [W.HANDLE, C.POINTER(W.DWORD)]),
            "IsWow64Process2": (W.BOOL, [W.HANDLE, C.POINTER(W.USHORT), C.POINTER(W.USHORT)]),
            "QueryFullProcessImageNameW": (W.BOOL, [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)]),
            "K32EnumProcessModulesEx": (W.BOOL, [W.HANDLE, pointer, W.DWORD, C.POINTER(W.DWORD), W.DWORD]),
            "K32GetModuleFileNameExW": (W.DWORD, [W.HANDLE, W.HMODULE, W.LPWSTR, W.DWORD]),
            "K32GetMappedFileNameW": (W.DWORD, [W.HANDLE, pointer, W.LPWSTR, W.DWORD]),
            "QueryDosDeviceW": (W.DWORD, [W.LPCWSTR, W.LPWSTR, W.DWORD]),
            "CreateFileW": (W.HANDLE, [W.LPCWSTR, W.DWORD, W.DWORD, pointer, W.DWORD, W.DWORD, W.HANDLE]),
            "GetFileInformationByHandle": (W.BOOL, [W.HANDLE, C.POINTER(FileInfo)]),
        }
        for name, (result, arguments) in signatures.items():
            if not hasattr(library, name):
                raise ValueError("required Windows API unavailable: " + name)
            function = getattr(library, name)
            function.restype, function.argtypes = result, arguments
        api = library
    native_x64(api.GetCurrentProcess())


def native_x64(process):
    machine, native = W.USHORT(), W.USHORT()
    checked(api.IsWow64Process2(process, C.byref(machine), C.byref(native)))
    if machine.value != 0 or native.value != 0x8664:
        raise ValueError("Windows x64 native processes required; WOW64/ARM held")


def local_path(path):
    path = Path(path)
    if not path.is_absolute() or len(path.drive) != 2 or path.drive[1] != ":" or "\0" in str(path):
        raise ValueError("absolute, NUL-free local drive path required")
    return path


def file_identity(path):
    path = local_path(path).resolve(strict=True)
    handle = checked(api.CreateFileW(str(path), 0x80, 7, None, 3, 0, None))
    try:
        info = FileInfo()
        checked(api.GetFileInformationByHandle(handle, C.byref(info)))
        return {"path": str(path), "volume": info.volume,
                "file_index": info.index_high << 32 | info.index_low}
    finally:
        checked(api.CloseHandle(handle))


def device_path(path):
    path = local_path(path).resolve(strict=True)
    if len(path.drive) != 2 or path.drive[1] != ":":
        raise ValueError("local drive image paths required; UNC held")
    buffer = C.create_unicode_buffer(32768)
    checked(api.QueryDosDeviceW(path.drive, buffer, len(buffer)))
    return (buffer.value + str(path)[2:]).casefold()


def modules(process):
    for capacity in (256, 1024, 4096):
        values, needed = (W.HMODULE * capacity)(), W.DWORD()
        checked(api.K32EnumProcessModulesEx(process, values, C.sizeof(values), C.byref(needed), 3))
        if needed.value > C.sizeof(values):
            continue
        result = []
        for value in values[:needed.value // C.sizeof(W.HMODULE)]:
            name, mapped = C.create_unicode_buffer(32768), C.create_unicode_buffer(32768)
            for function, buffer in ((api.K32GetModuleFileNameExW, name), (api.K32GetMappedFileNameW, mapped)):
                length = checked(function(process, value, buffer, len(buffer)))
                if length >= len(buffer) - 1:
                    raise ValueError("truncated loaded-image path")
            result.append({"base": value, "path": name.value, "mapped_path": mapped.value})
        return result
    raise ValueError("loaded module list exceeds bounded capacity")


class Job:
    def __init__(self):
        initialize()
        self.handle = checked(api.CreateJobObjectW(None, None))
        self.info, self.assigned = ProcessInfo(), False
        self.request, self.cleanup, self.cleanup_error = None, None, None
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        try:
            checked(api.SetInformationJobObject(self.handle, 9, C.byref(limits), C.sizeof(limits)))
        except BaseException:
            checked(api.CloseHandle(self.handle))
            self.handle = None
            raise

    @property
    def process(self):
        return self.info.process

    @property
    def pid(self):
        return self.info.pid or None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close(time.monotonic()+2)

    def pids(self):
        if self.handle is None:
            raise ValueError("job is closed")
        for capacity in (64, 512, 4096):
            buffer = C.create_string_buffer(8 + capacity * C.sizeof(C.c_size_t))
            if not api.QueryInformationJobObject(self.handle, 3, buffer, len(buffer), None):
                if C.get_last_error() == 234:
                    continue
                raise C.WinError(C.get_last_error())
            assigned = W.DWORD.from_buffer(buffer).value
            count = W.DWORD.from_buffer(buffer, 4).value
            if assigned == count and count <= capacity:
                return list((C.c_size_t * count).from_buffer(buffer, 8))
        raise ValueError("owned process list exceeds bounded capacity")

    def launch(self, argv, env, cwd, stdout, stderr, cancel=lambda: None):
        import msvcrt

        if self.handle is None or self.request is not None:
            raise ValueError("one launch per fresh job required")
        if not argv:
            raise ValueError("explicit Windows argv required")
        for path in (argv[0], cwd, stdout, stderr):
            local_path(path)
        if any(not isinstance(v, str) or "\0" in v for v in argv):
            raise ValueError("invalid Windows argv")
        if (any(not k or "=" in k or "\0" in k or "\0" in v for k, v in env.items())
            or len({k.casefold() for k in env}) != len(env)):
            raise ValueError("invalid or ambiguous Windows environment")
        self.request = {"argv": list(argv), "creation_flags": CREATE_FLAGS, "environment": dict(env), "cwd": str(cwd),
                        "stdout": str(stdout), "stderr": str(stderr),
                        "flags": ["CREATE_SUSPENDED", "CREATE_NO_WINDOW", "CREATE_UNICODE_ENVIRONMENT",
                                  "EXTENDED_STARTUPINFO_PRESENT", "STARTF_USESHOWWINDOW", "HANDLE_LIST"]}
        info = self.info  # Filled by CreateProcessW even if its return is interrupted.
        try:
            cancel()
            with ExitStack() as stack:
                files = [stack.enter_context(open("NUL", "rb")),
                         stack.enter_context(Path(stdout).open("xb")), stack.enter_context(Path(stderr).open("xb"))]
                handles = (W.HANDLE * 3)()
                current = api.GetCurrentProcess()
                for i, stream in enumerate(files):
                    duplicate = W.HANDLE()
                    stack.callback(_close_handle_output, duplicate)
                    checked(api.DuplicateHandle(current, msvcrt.get_osfhandle(stream.fileno()), current,
                                                C.byref(duplicate), 0, True, 2))
                    handles[i] = duplicate.value
                size = C.c_size_t()
                api.InitializeProcThreadAttributeList(None, 1, 0, C.byref(size))
                if not size.value or C.get_last_error() != 122:
                    raise C.WinError(C.get_last_error())
                attributes = C.create_string_buffer(size.value)
                checked(api.InitializeProcThreadAttributeList(attributes, 1, 0, C.byref(size)))
                stack.callback(api.DeleteProcThreadAttributeList, attributes)
                checked(api.UpdateProcThreadAttribute(attributes, 0, 0x20002, handles, C.sizeof(handles), None, None))
                startup = StartupEx()
                startup.startup.cb = C.sizeof(startup)
                startup.startup.flags = 0x101  # STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, SW_HIDE.
                startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = handles
                startup.attributes = C.addressof(attributes)
                command = C.create_unicode_buffer(subprocess.list2cmdline(argv))
                block = C.create_unicode_buffer("\0".join(k+"="+v for k, v in sorted(env.items(), key=lambda p:p[0].casefold()))+"\0\0")
                checked(api.CreateProcessW(argv[0], command, None, None, True, CREATE_FLAGS,
                                           block, str(cwd), C.byref(startup), C.byref(info)))
                self.request["pid"] = self.pid
                checked(api.AssignProcessToJobObject(self.handle, self.process))
                self.assigned = True
                native_x64(self.process)
                cancel()
                previous = api.ResumeThread(info.thread)
                if previous == 0xFFFFFFFF:
                    raise C.WinError(C.get_last_error())
                if previous != 1:
                    raise ValueError("unexpected primary-thread suspension count")
        except BaseException:
            self.close(time.monotonic()+2)
            raise
        finally:
            if info.thread:
                checked(api.CloseHandle(info.thread))
                info.thread = None
        return self.pid

    def root_exit_code(self):
        state = api.WaitForSingleObject(self.process, 0)
        if state == 258:
            return None
        if state != 0:
            raise C.WinError(C.get_last_error())
        code = W.DWORD()
        checked(api.GetExitCodeProcess(self.process, C.byref(code)))
        return code.value

    def wait(self, deadline, cancel=lambda: None):
        if self.process is None or not math.isfinite(deadline):
            raise ValueError("launched process and finite deadline required")
        while True:
            cancel()
            if not self.pids():
                code = self.root_exit_code()
                if code is not None:
                    return code
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("owned processes still active: " + str(self.pids()))
            time.sleep(min(0.01, remaining))

    def observe(self, pid, app, library):
        if self.handle is None:
            raise ValueError("job is closed; observation refused")
        process = checked(api.OpenProcess(0x101410, False, pid))
        try:
            owned = W.BOOL()
            checked(api.IsProcessInJob(process, self.handle, C.byref(owned)))
            if not owned.value or api.WaitForSingleObject(process, 0) != 258:
                raise ValueError("live process is not owned by this job")
            native_x64(process)
            name, size = C.create_unicode_buffer(32768), W.DWORD(32768)
            checked(api.QueryFullProcessImageNameW(process, 0, name, C.byref(size)))
            image, expected = file_identity(name.value), file_identity(app)
            if (image["volume"], image["file_index"]) != (expected["volume"], expected["file_index"]):
                raise ValueError("executable identity differs from expected app")
            loaded = modules(process)
            main_name = C.create_unicode_buffer(32768)
            length = checked(api.K32GetModuleFileNameExW(process, None, main_name, len(main_name)))
            if (length >= len(main_name) - 1 or not loaded
                or loaded[0]["path"].casefold() != main_name.value.casefold()):
                raise ValueError("main executable module sample is inconsistent")
            main = loaded[0]
            main_file = file_identity(main["path"])
            if ((main_file["volume"], main_file["file_index"]) != (expected["volume"], expected["file_index"])
                or main["mapped_path"].casefold() != device_path(app)):
                raise ValueError("main executable mapping differs from expected app")
            matches = [m for m in loaded if Path(m["path"]).name.casefold() == Path(library).name.casefold()]
            if not matches:
                raise ValueError("expected DLL is not observed loaded")
            expected = file_identity(library)
            for match in matches:
                observed = file_identity(match["path"])
                if (observed["volume"], observed["file_index"]) != (expected["volume"], expected["file_index"]) or match["mapped_path"].casefold() != device_path(library):
                    raise ValueError("different loaded DLL image: " + str(match))
            if api.WaitForSingleObject(process, 0) != 258:
                raise ValueError("owned process exited during image observation")
            return {"pid": pid, "image": image, "main_module": {**main, "file_identity": main_file},
                    "library": observed, "modules": loaded}
        finally:
            checked(api.CloseHandle(process))

    def close(self, deadline):
        if self.handle is None and self.process is None:
            if self.cleanup_error:
                raise RuntimeError(self.cleanup_error)
            return self.cleanup
        complete = False
        try:
            for attempt in range(2):
                try:
                    result = self._stop(deadline)
                    self.cleanup_error = None
                    complete = True
                    return result
                except InterruptedError:
                    if attempt:
                        raise
        except BaseException as error:
            self.cleanup_error = str(error)
            raise
        finally:
            try:
                if self.process and (complete or self.assigned):
                    checked(api.CloseHandle(self.process))
                    self.info.process = None
            finally:
                if self.handle:
                    checked(api.CloseHandle(self.handle))
                    self.handle = None

    def _stop(self, deadline):
        if not math.isfinite(deadline):
            raise ValueError("finite cleanup deadline required")
        pids = self.pids() if self.handle else []
        if self.process and not self.assigned and self.root_exit_code() is None:
            pids.append(self.pid)
        self.cleanup = self.cleanup or {"terminated_pids": [], "survivor_pids": []}
        self.cleanup["terminated_pids"] = sorted(set(self.cleanup["terminated_pids"]) | set(pids))
        self.cleanup["survivor_pids"] = list(pids)
        if self.process and not self.assigned and self.root_exit_code() is None:
            checked(api.TerminateProcess(self.process, 1))
        if self.handle:
            checked(api.TerminateJobObject(self.handle, 1))
        while True:
            survivors = self.pids() if self.handle else []
            if self.process and self.root_exit_code() is None and self.pid not in survivors:
                survivors.append(self.pid)
            self.cleanup["survivor_pids"] = survivors
            if not survivors:
                return self.cleanup
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("job cleanup incomplete; last PIDs: " + str(survivors))
            time.sleep(min(0.01, remaining))
