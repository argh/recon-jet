// VoiceScreen: what a voice turn shows under the status strip. The answer, wrapped, in the big
// font (small when it is long); the transcript in the small font along the bottom; a state
// word when there is nothing else yet. Rear press goes back to the status screen.
import { Screen, C, MARGIN, STRIP_H, wrapWords } from '../ui/screen.js';

const TOP = STRIP_H + 4;

export class VoiceScreen extends Screen {
  /** @param {import('../ui/index.js').Ui} ui @param {import('./index.js').Voice} voice */
  constructor(ui, voice) { super(ui); this.voice = voice; }

  onGesture(gesture) {
    if (gesture !== 'press:rear') return false;
    this.ui.show(this.ui.status);
    return true;
  }

  render(s) {
    const { main, small } = s.fonts, { width, height } = s, { state, transcript, answer } = this.voice;
    const inner = width - 2 * MARGIN;
    const youRows = transcript ? wrapWords(`you: ${transcript}`, Math.floor(inner / small.width)).slice(-2) : [];
    const bottom = height - youRows.length * small.height - 2;
    if (answer) {
      let font = main, rows = wrapWords(answer, Math.floor(inner / main.width));
      if (TOP + rows.length * main.height > bottom) { font = small; rows = wrapWords(answer, Math.floor(inner / small.width)); }
      const max = Math.floor((bottom - TOP) / font.height);
      rows.slice(0, max).forEach((row, i) => s.text(MARGIN, TOP + i * font.height, row, { font, colour: C.white }));
    } else if (state !== 'idle') {
      const word = { listening: 'listening...', thinking: transcript ? 'thinking...' : 'thinking', speaking: 'speaking' }[state] ?? state;
      s.text(width / 2, height / 2 - main.height, word, { font: main, colour: state === 'listening' ? C.ok : C.title, align: 'center' });
    } else {
      s.text(width / 2, height / 2 - main.height, 'press front = talk', { font: main, colour: C.dim, align: 'center' });
    }
    youRows.forEach((row, i) => s.text(MARGIN, bottom + i * small.height, row, { font: small, colour: C.dim }));
  }
}
