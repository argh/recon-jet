// place: the offline table (the real one), the nearest-town arithmetic, the context line and
// the fix surviving the receiver and a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Place, distanceKm, parsePlaces, nearest } from '../src/modules/place/index.js';
import { tmpdir } from './helpers.js';

const make = (over = {}) => { const clock = { t: 1_800_000_000_000 }; return { clock, place: Object.assign(new Place(), { table: 'assets/places/cities15000.tsv.gz', file: '', maxAgeS: 21600, gps: null, logger: null, now: () => clock.t }, over) }; };

test('place: distances, the table format, the nearest of a few', () => {
  assert.ok(Math.abs(distanceKm(37.7822, -122.2478, 37.7710, -122.2609) - 1.69) < 0.1);
  const t = parsePlaces('37.7710\t-122.2609\tAlameda\tCalifornia\tUS\n37.8044\t-122.2708\tOakland\tCalifornia\tUS\n47.6062\t-122.3321\tSeattle\tWashington\tUS\n');
  assert.deepEqual(t.label, ['Alameda, California, US', 'Oakland, California, US', 'Seattle, Washington, US']);
  assert.deepEqual(nearest(t, { lat: 37.7822, lon: -122.2478 }, 2).map((p) => p.label.split(',')[0]), ['Alameda', 'Oakland']);
  assert.deepEqual(nearest(t, { lat: 0, lon: 0 }, 2), [], 'nothing within reach is nothing');
});

test('place: a fix is named from the real table, offered to the agent with its age, and outlives the receiver', async () => {
  const gps = new EventEmitter();
  const { place, clock } = make({ gps });
  await place.start();
  assert.equal(place.context(), null, 'no fix, nothing to say');
  gps.emit('update', { good: false, lat: 1, lon: 1 });
  assert.equal(place.fix, null, 'a fix that fails the quality gate is not a position');
  gps.emit('update', { good: true, lat: 37.7822, lon: -122.2478 });
  assert.equal(place.context(), "Your partner's position by GPS (fix just now): 37.7822, -122.2478: in or near Alameda, California, US (1.7 km from its centre); Oakland is 3.2 km away. Only if the question is about where they are or what is around them: use the place name (you cannot tell places from coordinates yourself). Otherwise leave it out.");
  clock.t += 12 * 60_000;   // the receiver went off: the fix stays, older
  assert.match(place.context(), /\(fix 12 min old\): 37\.7822/);
  clock.t += 7 * 3_600_000;
  assert.equal(place.context(), null, 'too old to be where they are');
  await place.stop(); assert.equal(gps.listenerCount('update'), 0);
});

test('place: the last fix is kept across a restart', async () => {
  const file = path.join(tmpdir('jet-place-'), 'place.json');
  const { place } = make({ file });
  await place.start();
  place.locate(47.6062, -122.3321);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['lat', 'lon', 't']);
  const { place: back } = make({ file });
  await back.start();
  assert.match(back.context(), /in or near Seattle, Washington, US/);
});
