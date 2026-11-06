import assert from "node:assert/strict";
import test from "node:test";
import { commandMenuItems, disabledMenu, menuCommands, serializeNativeMenu, type NativeMenuEntry } from "../../src/components/libera/native-menu";

const run = () => undefined;

test("a submenu's choices become palette commands, keeping their state", () => {
  const items: NativeMenuEntry[] = [
    { id: "add:new", label: "New Album…", onSelect: run },
    { type: "separator" },
    { id: "add:more", label: "More", submenu: [{ id: "add:trip", label: "Trip", enabled: false, onSelect: run }] },
    { id: "add:none", label: "No action" },
  ];
  const commands = menuCommands(items, { group: "Photo" }, (label) => `Add to album: ${label}`);
  assert.deepEqual(commands.map(({ id, title, group, disabled }) => ({ id, title, group, disabled })), [
    { id: "add:new", title: "Add to album: New Album…", group: "Photo", disabled: false },
    { id: "add:trip", title: "Add to album: Trip", group: "Photo", disabled: true },
  ]);
});

test("palette commands become menu items, toggles as checkboxes", () => {
  const items = commandMenuItems([
    { id: "plain", title: "Jump to 2026", run },
    { id: "toggle", title: "Group by day", checked: true, disabled: true, run },
  ], (title) => title.replace(/^(Jump to|Group by) /, ""));
  assert.deepEqual(items, [
    { id: "plain", label: "2026", enabled: true, onSelect: run },
    { id: "toggle", label: "day", enabled: false, type: "checkbox", checked: true, onSelect: run },
  ]);
});

test("a blocked menu registers no actions, including those in its submenus", () => {
  const actions = new Map<string, () => void>();
  serializeNativeMenu(disabledMenu([
    { id: "star", label: "Star", onSelect: run },
    { type: "separator" },
    { id: "add", label: "Add to Album", submenu: [{ id: "trip", label: "Trip", onSelect: run }] },
  ]), actions);
  assert.equal(actions.size, 0);
});
