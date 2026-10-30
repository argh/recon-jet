// Assistant mode: push-to-talk. Front press starts a voice turn (voice module: capture through
// jetd, transcript, answer and speech through the host session); a press while listening ends
// the capture, a press while thinking/speaking barges in. The answer is wrapped in the big font
// (small when long), the transcript runs along the bottom; the status strip says what the turn
// is doing. Rear press cancels a running turn, or clears the last answer; nothing at an idle
// root. Leaving the mode cancels the turn. No other mode triggers voice by button; a wake-word
// question asked from another mode switches here so the answer is seen.
import { Schema } from '@versionzero/module-manager';
import { C, MARGIN, TOP, wrapWords, paragraph, hint } from '../../modules/ui/style.js';

const s = Schema.create;

export class AssistantMode {
  static moduleInfo = {
    name: 'assistant-mode',
    schema: s()
      .property('modes', s('Modes').meta('internal', true))
      .property('ui', s('Ui').meta('internal', true))
      .property('voice', s('Voice').meta('internal', true)),
  };
  modes; ui; voice;

  id = 'assistant'; label = 'Assistant'; spoken = ['radio', 'jet'];
  #current = false;

  async start() {
    this.modes.register(this);
    this.voice.on('state', () => { if (this.#current) this.ui.requestRender(); });
    this.voice.on('question', (q) => { if (q.wake && !this.#current) this.modes.switchTo(this.id); });   // "heya jet, <question>" from any mode: the answer shows here
  }
  enter() { this.#current = true; }
  leave() { this.#current = false; this.voice.cancel(); }

  onGesture(g) {
    if (g === 'press:front' || g === 'press:tap') { this.voice.startTurn(); return true; }
    if (g === 'press:rear') {
      if (this.voice.state !== 'idle') { this.voice.cancel(); return true; }
      if (this.voice.answer || this.voice.transcript) { this.voice.clear(); this.ui.requestRender(); return true; }
    }
    return false;
  }

  render(s) {
    const { main, small } = s.fonts, { state, transcript, answer } = this.voice, inner = s.width - 2 * MARGIN;
    const youRows = transcript ? wrapWords(`you: ${transcript}`, Math.floor(inner / small.width)).slice(-2) : [];
    const bottom = s.height - small.height - 4 - youRows.length * small.height;
    if (answer) paragraph(s, MARGIN, TOP, inner, bottom - TOP, answer);
    else if (state !== 'idle') {
      const word = { listening: 'listening...', thinking: transcript ? 'thinking...' : 'thinking', speaking: 'speaking' }[state] ?? state;
      s.text(s.width / 2, s.height / 2 - main.height, word, { font: main, colour: state === 'listening' ? C.ok : C.title, align: 'center' });
    } else s.text(s.width / 2, s.height / 2 - main.height, 'press front = talk', { font: main, colour: C.dim, align: 'center' });
    youRows.forEach((r, i) => s.text(MARGIN, bottom + i * small.height, r, { font: small, colour: C.dim }));
    hint(s, state === 'idle' ? (this.voice.configured ? 'front: talk' + (answer ? '   rear: clear' : '') : 'voice: not configured') : state === 'listening' ? 'front: done   rear: cancel' : 'front: interrupt   rear: cancel');
  }
}
