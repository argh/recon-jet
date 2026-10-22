// Menu nesting as a state machine, against a stub ui (no rendering).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Menu } from '../src/modules/ui/menu.js';

function make() {
  const log = [];
  const ui = { closed: 0, renders: 0, requestRender() { this.renders++; }, closeMenu() { this.closed++; }, surface: { stopViewfinder() {} } };
  const menu = new Menu(ui, { title: 'MENU', items: [
    { label: 'A', action: () => log.push('A') },
    { label: 'Group', children: [
      { label: 'B', action: () => log.push('B') },
      { label: 'Deeper', children: [{ label: 'C', action: () => log.push('C') }, { label: 'Back', back: true }] },
      { label: 'Back', back: true },
    ] },
  ] });
  return { ui, menu, log };
}

test('menu: children open a level titled by the item, rear/Back go up, rear at the root closes', () => {
  const { ui, menu, log } = make();
  assert.equal(menu.depth, 1); assert.equal(menu.title, 'MENU');
  menu.onGesture('swipe:down'); menu.onGesture('press:front');
  assert.equal(menu.depth, 2); assert.equal(menu.title, 'GROUP'); assert.equal(menu.selected, 0);
  assert.deepEqual(menu.items.map((i) => i.label), ['B', 'Deeper', 'Back']);
  menu.onGesture('swipe:down'); menu.onGesture('press:tap');
  assert.equal(menu.depth, 3); assert.equal(menu.title, 'DEEPER');
  menu.onGesture('press:front');
  assert.deepEqual(log, ['C'], 'a leaf runs its action and stays put');
  assert.equal(menu.depth, 3);
  menu.onGesture('press:rear');
  assert.equal(menu.depth, 2); assert.equal(menu.selected, 1, 'the parent keeps its selection');
  menu.onGesture('swipe:down'); menu.onGesture('press:front');   // Back
  assert.equal(menu.depth, 1); assert.equal(menu.selected, 1);
  assert.equal(ui.closed, 0);
  menu.onGesture('press:rear');
  assert.equal(ui.closed, 1, 'rear at the root closes the menu');
  assert.equal(menu.depth, 1);
});

test('menu: hold:front closes from any depth; selection wraps per level; unknown gestures fall through', () => {
  const { ui, menu } = make();
  menu.onGesture('swipe:up');
  assert.equal(menu.selected, 1, 'wraps at the root');
  menu.onGesture('press:front');
  menu.onGesture('swipe:up');
  assert.equal(menu.selected, 2, 'wraps in the sub-level (3 items)');
  assert.equal(menu.onGesture('press:nonsense'), false);
  assert.equal(menu.onGesture('hold:front'), true);
  assert.equal(ui.closed, 1);
  assert.ok(ui.renders > 0, 'moves and level changes request renders');
});
