# Users

Several people can use Libera on the same computer. Each person is a user with their own:

- master directory (notebooks, linked folders, workspaces),
- search index,
- preferences (General, Markdown, AI, Search, Speech and the rest),
- master password,
- collaboration sign-in and shared-document databases,
- Chromium cookies and local storage (including recent searches, prompts and appearance choices).

One user runs at a time. Switching users restarts Libera with the other person's settings.

## Signing in and switching

Libera opens the sign-in screen of the last user who signed in.

When there is more than one user, a small **Switch user** button sits under the password field. It replaces the logo with a bubble of initials for each user, with the current user ringed. Choosing another bubble restarts Libera as that user, and the sign-in screen then asks for their password. Choosing your own bubble, **Cancel** or Escape brings the logo back.

That choice holds for one start only. If the chosen person never signs in, the next start opens the last user who did.

Libera saves the workspace in every app window, including pop-outs, before scheduling the restart. Pop-outs close before the main window. A note, annotations or ink that are not saved cancel closing, as does a failed save: the switch is cancelled and the controls become available again. Annotations and ink are saved only with **Save** (Ctrl+S), as notes are; until then a local copy outside the synced master directory keeps them through a crash. No switch is queued for a later quit.

To change user while signed in, choose **Logout** in the sidebar, then use **Switch user**.

## Managing users

**Preferences → Users** (not shown during first-run setup) lists everyone. Each change there is saved at once and does not need **Save Preferences**.

Sign in with your master password before managing users. Opening this section from the sign-in screen explains how to sign in first. The main process verifies the running user's session cookie; signing out revokes management access.

- **Add a user**: enter a name, a master directory, and a master password with at least 8 characters. Leave **OPENAI_API_KEY** blank to share your key with them. They start with default preferences.
- **Rename**: changes the name on the sign-in screen and in this list. It does not change the user's **Your name** greeting. To rename someone else (including the first user), enter that person's master password and choose **Save name**.
- **Switch**: restarts Libera as that user.
- **Remove**: available for other users only, and never for the first user. Enter that person's master password before confirming removal. Their notebooks stay in their master directory. Their settings folder is moved aside, not deleted.

Each user needs their own master directory and search index file. Libera refuses overlapping master directories, an index that overlaps another user's master directory, a master directory that contains another user's index, or overlapping index paths. This includes custom indices in Search preferences and the effective default index. **Save Preferences**, **Load settings** in **I/O**, choosing an existing index, and adding a user check these rules. Paths are resolved through filesystem aliases (including symlinks, Windows junctions and namespace prefixes), even for folders that do not exist yet.

A master directory also cannot be Electron's `userData` folder, contain it, or lie inside it. This keeps notebooks outside the application settings and removed-profile storage.

Startup checks these rules before starting the collaboration host or the local Next server. If folders overlap, a dialog names the conflicting user and offers **Open Preferences** or **Quit**. Saving a separate folder/index allows startup to continue. Cancelling Preferences quits; a conflict that remains after that repair attempt stops startup instead of repeatedly reopening Preferences.

If a selected user's settings are missing, unreadable or incomplete, Libera names that user in an error dialog and opens the last signed-in user with complete settings, another configured user with complete settings, or the first user when none is available. The bad choice is cleared and that user's folder stays untouched. A new install still opens first-run setup for the first user.

Changes to the user registry and storage preferences are serialized. Names, the user limit and storage conflicts are checked again before a new user is committed; removal rereads the registry after confirmation so it preserves other changes made while the dialog was open.

At most 8 users can be configured, including the first user.

## Where data is stored

Settings live in Electron's `userData` folder:

- `profiles.json` holds the list of users, the last user who signed in, and a one-time choice from **Switch user**.
- The first user is the original install. Their settings keep their old place (`libera-electron-config.json` and `collab/` directly in `userData`), so an existing install needs no migration and an older Libera still opens it.
- Every other user has `profiles/<id>/`, laid out the same way.
- A removed user's folder is moved to `profiles/.removed/<id>-<time>/`.
- The first user keeps Electron's original default session, without migrating or deleting its data. Other users use persistent `profile-<id>` Chromium partitions under Electron's `Partitions/` folder. Main, Preferences, export and popped-out windows all use the running user's session.

If `profiles.json` is corrupt or unreadable, Libera recovers the user list from existing `profiles/<id>/` folders, using each config's **Your name** or a neutral name. A readable damaged registry is copied to `profiles.json.corrupt-<time>` and left in place until the recovered list is saved. Libera refuses to overwrite it with a default-only list, omit recovered folders, or replace it if a backup cannot be made. If recovery cannot read the profile folders, startup stops. Restore the registry from a backup if no non-default folders can be recovered; missing `profiles.json` on a new install remains normal.

## Limits

- Renderer storage is isolated per user, but some appearance choices are also scoped to the local server's origin and may reset when its port changes.
- Registry recovery cannot reconstruct renamed display names or the last signed-in choice from folders alone. The recovered list starts with the first user; it does not include folders under `.removed`.
- Removing a user retains their Chromium partition as well as the moved settings folder. Nothing deletes their notebooks or saved browser data.
- One instance can run per OS account, including when collaboration is disabled with `LIBERA_COLLAB=0`; opening Libera again focuses the existing main window.
- This is meant for people who share one operating-system account. People who each have their own OS account already get separate Libera settings.
