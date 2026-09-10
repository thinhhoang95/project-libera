const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('native chat submenu preserves labels, disabled state, and child actions', () => {
  const source = readFileSync(path.join(__dirname, '../../electron/main.cjs'), 'utf8');
  const start = source.indexOf('function buildNativeMenuTemplate(');
  const end = source.indexOf('function installNativeMenuHandlers()', start);
  const context = vm.createContext({
    MAX_NATIVE_MENU_ITEMS: 100, MAX_NATIVE_MENU_ID_LENGTH: 100, MAX_NATIVE_MENU_LABEL_LENGTH: 100,
    NATIVE_MENU_ITEM_TYPES: new Set(['normal', 'checkbox', 'radio']),
    normalizeNativeMenuString: (value) => typeof value === 'string' ? value.trim() : '',
  });
  const build = vm.runInContext(`${source.slice(start, end)}; buildNativeMenuTemplate`, context);
  let selected;
  const menu = build([{ id: 'manage', label: 'Manage Chats' }, { id: 'export', label: 'Export Chat', enabled: false, submenu: [
    { id: 'save-md', label: 'Save MD file' }, { id: 'save-notebook', label: 'Save to Notebook' },
  ] }], (id) => { selected = id; });
  assert.equal(menu[1].enabled, false);
  assert.equal(menu[1].submenu.length, 2);
  menu[1].submenu[0].click();
  assert.equal(selected, 'save-md');
  menu[1].submenu[1].click();
  assert.equal(selected, 'save-notebook');
  const cyclic = { id: 'cycle', label: 'Cycle' }; cyclic.submenu = [cyclic];
  assert.equal(build([cyclic], () => {}).length, 0);
});
