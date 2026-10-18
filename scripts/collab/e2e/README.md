# Two-user collaboration e2e

`two-users.ts` drives two real Libera desktop instances (Alice and Bob) against a real collab server and checks live editing end to end: sharing, joining, typing in Source, Visual and LaTeX, concurrent edits, status pill, presence, offline and reconnect, and a clean quit.

## Prerequisites

1. Server dependencies: `cd server && npm ci` (once).
2. A production build with the collab host bundle (Windows: run these in a shell with `LIBERA_COLLAB=1` set):

   ```bash
   LIBERA_COLLAB=1 npm run electron:build-next
   LIBERA_COLLAB=1 npm run electron:prepare-standalone
   ```

   Two `next dev` servers cannot share one checkout, so the run uses the standalone production server, like `npm run electron:start`. Rebuild after pulling changes.

## Run

```bash
node --import tsx scripts/collab/e2e/two-users.ts
```

| Variable | Effect |
|---|---|
| `E2E_WORK_DIR` | Parent folder for the run. Each run creates `run-<timestamp>/` inside it. Default: a new temp folder. |
| `E2E_KEEP=1` | Keep the throwaway profiles and server data after a passing run. They are always kept after a failure. |
| `E2E_PAUSE_ON_FAIL=1` | After a failed run, leave the apps and server running, write `paused.json` (DevTools ports) and wait until a `resume` file exists in the run folder. |
| `E2E_RELOAD_AFTER_SIGNIN=Alice,Bob` | Debug option: reload those windows after collaboration sign-in. |

The exit code is 0 when every step passes. The work folder contains:

- `screenshots/`: numbered PNGs of each step, plus `FAIL-*` shots of both windows when a step fails
- `results.json`: per-step result, notes, timings and observations (product behaviour worth reporting that the run worked around)
- `e2e.log`, `electron-alice.log`, `electron-bob.log`: the run log and each app's main-process output
- `credentials.json`: the generated throwaway passwords (local app and collab accounts)

## What it does

- Starts the collab server with `startServerProcess` (`scripts/collab/support/server-process.ts`) on a free port, with its own PGlite data folder.
- Prepares two profiles. Each one gets a userData folder with `libera-electron-config.json` (a scrypt `passwordHash` of a generated password, a dummy API key, `dataDir` pointing at its own library) and its own library. Alice's library gets the notebook `Thesis` with `notes.md` and `paper/main.tex`.
- Launches `electron . --user-data-dir=<profile> --remote-debugging-port=<port> --inspect=<port>` with `LIBERA_COLLAB=1` and `LIBERA_ELECTRON_NEXT_MODE=start`. It never touches the real Libera profile, and it only stops processes it started.
- Drives each window over the Chrome DevTools Protocol (`cdp.ts`, using Node's global `WebSocket`): real mouse clicks, `Input.insertText`, key events and screenshots.
- **Native menus.** The notebook menu (Share notebook…) and the file menu (Editor Mode) are OS popup menus, and CDP cannot click them. Through the main process's inspector, the run replaces `Menu.prototype.popup`. The renderer still builds the items and main still builds the real `Menu`. The stub then clicks the requested item and records what was offered. Everything else goes through the real UI.

Steps: 0 server and profiles · 1 launch and local login through the form · 2 create both collab accounts in the Collaboration dialog · 3 Alice shares and invites Bob as editor · 4 Bob joins with the link · 5 same bytes on both disks · 6 Alice types in Source and Bob sees it in Visual and on disk · 6b Bob types at the end in Visual and Alice sees it · 7 concurrent typing converges · 8 "Saved to workspace" · 9 presence avatars · 9b Alice comments (Review mode, Ctrl+Alt+M) and Bob sees it in Comments with Alice as author · 10 LaTeX typing both ways · 11 server stopped: offline pill with a pending count, and the editor stays responsive · 12 server restarted on the same port and data: both converge · 13 both apps quit, "[collab-host] Flushed and stopped." appears, and the text is still there after Alice relaunches.

Steps 6b, 9, 9b and 10 are soft: a failure is recorded and the run continues. Every other failure stops the run.
