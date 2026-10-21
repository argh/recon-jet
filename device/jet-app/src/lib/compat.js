// Node 20 (the Jet's Alpine build) lacks iterator helpers; @versionzero/module-manager 1.0.0
// calls `map.values().find(...)`. Add the few helpers to %IteratorPrototype% when missing.
const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

const helpers = {
  find(fn) { for (const v of this) if (fn(v)) return v; return undefined; },
  some(fn) { for (const v of this) if (fn(v)) return true; return false; },
  every(fn) { for (const v of this) if (!fn(v)) return false; return true; },
  forEach(fn) { for (const v of this) fn(v); },
  toArray() { return [...this]; },
  reduce(fn, acc) { for (const v of this) acc = fn(acc, v); return acc; },
  *map(fn) { for (const v of this) yield fn(v); },
  *filter(fn) { for (const v of this) if (fn(v)) yield v; },
};
for (const [name, fn] of Object.entries(helpers)) {
  if (typeof IteratorPrototype[name] !== 'function') Object.defineProperty(IteratorPrototype, name, { value: fn, writable: true, configurable: true });
}
