# Credential sync review — 20 October 2026

Scope: the local automatic collaboration sign-in changes, including encrypted file handling, Electron/Next handoff, server grants, and administrator recovery. Unrelated editor, audio, and chart changes were outside this review. The findings below have been fixed locally.

| Priority | Finding | Fix |
| --- | --- | --- |
| P1 | Administrator password reset left synced grants valid; disable followed by enable revived them. Someone holding a copied grant could bypass account recovery. | Reset and disable revoke grants and sessions transactionally under the account lock. |
| P1 | Grant exchange checked validity before creating a session outside a transaction. Revocation or password change could finish between those operations, leaving a new usable session. Concurrent minting could also exceed the grant limit. | Account locks serialize creation, exchange, and revocation. Exchange rechecks the grant inside the transaction that issues its session. Password changes revoke other sessions and grants in that same transaction. |
| P1 | A device missing a tombstone could renew an old revoked grant, or recreate sharing from a missing file. | Background creation is identified explicitly. Renewal checks the previous grant on the server; bootstrapping a missing file refuses accounts with grant history and no valid active grant. Manual sign-in can enable sharing again. |
| P1 | Independent KDF parameter limits allowed roughly 2 GiB of scrypt memory plus excessive work. The file itself was read without a size bound. | Limit total scrypt memory to 128 MiB and total work to the default derivation. Bound file reads to 16 KiB, validate salts and IV length, and reject invalid expiry values. |
| P2 | NFKC normalization allowed distinct master passwords, such as full-width and ASCII characters, to open the same file even though local authentication distinguishes them. | Derive from the exact password bytes used by local authentication. |
| P2 | Polling skipped unchanged files after a transient failure and never renewed a grant solely because time passed. | Reconcile on each poll while reusing the derived key. Permanent exchange refusals remain suppressed. Poll errors are handled and polling resumes. |
| P2 | In-flight exchange could install credentials after shutdown or explicit account actions. Minting could overwrite a newer synced choice that arrived during network or KDF work. | Invalidate automatic adoption on account intent changes, recheck inside the runtime queue, discard stale mint responses, and compare the file immediately before committing replacements. |
| P2 | A host that had not received an unlock could not rewrap an existing file after a master password change. Failed writes also lost pending replacement work. | Send the verified previous password from main, retain failed rewraps for retry, and only clear manual replacement intent after a successful write or a superseding synced choice. |
| P2 | An unreadable/corrupt local opt-out was treated as permission to sign in. Re-sharing from a still-active session ignored opt-out during sign-out. | Fail closed on opt-out read/parse errors and apply opt-out to both sharing and adoption. |

## Validation

- 29 desktop/client tests pass across shared sign-in, control API, Next proxy, and UI client suites. These include two real hosts against the real collaboration server, independent refresh sessions, encrypted file sharing, and sign-out behavior.
- 26 server tests pass across authentication and administrator CLI suites. A deterministic regression pauses exchange after its initial grant lookup, commits revocation or a password change, then verifies the resumed exchange is refused.
- Server typecheck, focused app/Electron/collaboration typecheck, targeted client/Electron lint, host bundle build, and Electron JavaScript syntax checks pass.
- The full repository typecheck reports four existing diagnostics in unchanged `scripts/editor/document-ocr-loop.test.ts` and `scripts/editor/pdf-text-layer-styles.test.ts`.
- Tests ran on Windows with the installed Windows esbuild binary from `server/node_modules`; the root dependency tree contains the macOS esbuild binary.

## Remaining design limits

A weak master password permits offline guessing against a copied encrypted file. Changing the master password rewraps the current file but does not invalidate grants recoverable from earlier sync versions; server-side revocation is required for that. Existing signed-in sessions intentionally remain active when automatic sign-in is stopped. File comparisons reduce stale writes but do not provide a global transaction across independent cloud sync clients. The tests simulate a shared folder locally; actual OneDrive/iCloud propagation and conflict behavior were not exercised.
