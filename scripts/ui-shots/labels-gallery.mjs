// Writes gallery/labels.html: the "Check sound labels" card and the chip/profile once
// labels are shown, from fixed fixtures. Then: node scripts/ui-shots/gallery.cjs --only=labels
import { writeFileSync } from 'node:fs';
import { reviewHTML, reviewVM, reviewSample, withVerdict, checksFor, readingsOf, seenOf, labelSoundVM, mergeSoundVM } from '../../web/audio/labels-view.mjs';
import { soundChip, profileRow } from '../../web/ui/sound.mjs';

const names = [['Rollers', 'Jungle & Breaks'], ['Night Bus', 'Late Night'], ['Bounce', 'Donk'], ['Glow', 'Chill']];
const moodSets = [[['dark', .6], ['energetic', .4], ['heavy', .3]], [['dreamy', .5], ['calm', .4], ['sad', .3]], [['party', .6], ['happy', .5], ['upbeat', .4]], [['relaxing', .6], ['soft', .4], ['romantic', .2]]];
const records = new Map(), playlists = [];
names.forEach(([t, pl], p) => {
  const tracks = [];
  for (let i = 0; i < 3; i++) {
    const id = `t${p}${i}`;
    tracks.push({ id, name: `${t} ${i + 1}`, artists: [{ name: `Artist ${p + 1}` }] });
    records.set(id, { id, heads: { moods: moodSets[p], voice: (p + i) % 2 ? 0.8 : 0.2 }, dsp: { energy: [0.85, 0.3, 0.7, 0.2][p] } });
  }
  playlists.push({ id: `P${p}`, name: pl, tracks });
});
const lib = { playlists };
const sample = reviewSample(lib, records, { n: 5 });
let all = {};
sample.slice(0, 2).forEach(({ track }, i) => {
  const r = readingsOf(records.get(track.id));
  all = withVerdict(all, 'u', track.id, 'mood', true, seenOf('mood', r.mood));
  all = withVerdict(all, 'u', track.id, 'voice', i === 0, seenOf('voice', r.voice));
});
const card = reviewHTML(reviewVM(sample, records, checksFor(all, 'u')));
const r = records.get('t00');
const chip = soundChip(mergeSoundVM({ bpm: 174, key: 'A minor', camelot: '8A', keyConf: .8, bpmConf: .9 }, labelSoundVM(r, { mood: true, voice: true, energy: true })));
const prof = profileRow({ heard: 12, members: 40, energy: [0.55, 0.9], styles: [['Electronic---Jungle', .5], ['Electronic---Drum n Bass', .3]] });
writeFileSync(new URL('./gallery/labels.html', import.meta.url), `<h2>Check sound labels (Sources)</h2>
<div class="srcgrid"><section class="srccard srclabels" id="src-labels">${card}</section></div>
<h2>Once shown: chip and playlist profile</h2>
<div class="rowx">${chip}</div><div class="rowx">${prof}</div>
`);
