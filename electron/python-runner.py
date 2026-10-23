"""Runs the cells of a note's Python sidecar for Libera (src/lib/python/execute.ts).

Usage: python python-runner.py <request.json>

The request names the sidecar (for tracebacks), the cells to run in order, and
an output folder. Cells share one namespace, as in a notebook, and each run
starts from a fresh process. After each cell with an id, every open
matplotlib figure is saved as <output>/<cell index>.<n>.png and closed. The
result is rewritten to <output>/result.json after every cell, so a run that
times out still reports the cells it finished.
"""

import ast
import contextlib
import io
import json
import os
import sys
import time
import traceback

OUTPUT_LIMIT = 20_000
TRACEBACK_LINES = 40


def capped(text):
    if len(text) <= OUTPUT_LIMIT:
        return text
    return text[:OUTPUT_LIMIT] + f"\n[Output truncated at {OUTPUT_LIMIT:,} characters.]"


def display_value(value):
    """A notebook-style display of a cell's last expression, or None."""
    if value is None:
        return None
    items = value if isinstance(value, (list, tuple)) and value else [value]
    # plt.plot(...) and friends return artists; showing them is noise.
    if all(type(item).__module__.startswith("matplotlib") for item in items):
        return None
    try:
        return capped(repr(value))
    except Exception as error:  # noqa: BLE001 - a broken __repr__ must not fail the cell
        return f"<unprintable {type(value).__name__}: {error}>"


def compile_cell(code, filename, start_line):
    try:
        tree = ast.parse(code, filename, "exec")
    except SyntaxError as error:
        if error.lineno is not None:
            error.lineno += start_line - 1
        if error.end_lineno is not None:
            error.end_lineno += start_line - 1
        raise
    ast.increment_lineno(tree, start_line - 1)
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    body = compile(tree, filename, "exec")
    return body, (compile(last, filename, "eval") if last else None)


def format_error(error, filename):
    lines = traceback.format_exception(type(error), error, error.__traceback__)
    # Drop this runner's own frames; keep the sidecar's and the libraries'.
    kept = [line for line in lines if __file__ not in line]
    text = "".join(kept).rstrip()
    tail = text.splitlines()[-TRACEBACK_LINES:]
    line = None
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename == filename:
            line = frame.lineno
    if isinstance(error, SyntaxError) and error.filename == filename:
        line = error.lineno
    return {"type": type(error).__name__, "message": str(error), "traceback": "\n".join(tail), "line": line}


def main():
    isolate_windows_children()
    with open(sys.argv[1], encoding="utf-8") as handle:
        request = json.load(handle)
    filename = request["sidecar"]
    output = request["output"]
    dpi = int(request.get("dpi", 200))
    result_path = os.path.join(output, "result.json")
    results = []

    def write_result(done):
        temporary = result_path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({"cells": results, "done": done, "python": sys.version.split()[0]}, handle)
        # Windows scanners can briefly hold the previous checkpoint open.
        for attempt in range(10):
            try:
                os.replace(temporary, result_path)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 9:
                    raise
                time.sleep(0.02 * (attempt + 1))

    write_result(False)
    plt = None
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt  # noqa: F811

        # Figures are saved after each cell; show() has nothing to do.
        plt.show = lambda *args, **kwargs: None
        matplotlib.rcParams.update({"savefig.bbox": "tight", "savefig.dpi": dpi, "figure.dpi": 100})
    except ImportError:
        pass

    namespace = {"__name__": "__main__", "__file__": filename}
    sys.argv = [filename]
    for position, cell in enumerate(request["cells"]):
        stdout, stderr = io.StringIO(), io.StringIO()
        entry = {"id": cell.get("id"), "stdout": "", "stderr": "", "value": None, "error": None, "figures": [], "seconds": 0}
        started = time.monotonic()
        try:
            body, last = compile_cell(cell["code"], filename, cell["startLine"])
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exec(body, namespace)  # noqa: S102 - running the user's notebook is the point
                if last is not None:
                    entry["value"] = display_value(eval(last, namespace))  # noqa: S307
        except BaseException as error:  # noqa: BLE001 - SystemExit and KeyboardInterrupt stop the run too
            entry["error"] = format_error(error, filename)
        entry["seconds"] = round(time.monotonic() - started, 3)
        entry["stdout"] = capped(stdout.getvalue())
        entry["stderr"] = capped(stderr.getvalue())
        if plt is not None:
            if cell.get("id") and entry["error"] is None:
                for number, figure_number in enumerate(plt.get_fignums(), start=1):
                    name = f"{position}.{number}.png"
                    try:
                        plt.figure(figure_number).savefig(os.path.join(output, name))
                        entry["figures"].append(name)
                    except Exception as error:  # noqa: BLE001
                        entry["error"] = format_error(error, filename)
                        break
            elif plt.get_fignums() and entry["error"] is None:
                entry["discardedFigures"] = len(plt.get_fignums())
            plt.close("all")
        results.append(entry)
        write_result(False)
        if entry["error"] is not None:
            break
    write_result(True)


def isolate_windows_children():
    """A private job kills descendants when Python exits, including native crashes."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("minimum", ctypes.c_size_t),
                    ("maximum", ctypes.c_size_t), ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("io", ctypes.c_uint64 * 6),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    # Keep the non-inheritable handle open until the OS tears down this process.
    globals()["_children_job"] = job


if __name__ == "__main__":
    main()
