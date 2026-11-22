// Browser half of dsh-live-tps.
//
// One `conversation.composer.dock` entry that reads the Session event window and
// folds the transient `assistant/live-chunk` rows into a sliding-window decode
// rate, so the reading is the speed of the answer being written right now rather
// than the finished-turn average the shipped `activity` pill shows.
//
// The entry is a permanent resident of that row: it keeps the last figure when
// the stream pauses, when the answer settles, and across Turns, and it shows the
// newest settled message's own decode rate after a reload instead of starting
// blank. Only a Session that has never produced an answer shows the empty dash.
//
// Nothing here touches the DOM outside its own span, and nothing polls: the
// window publish is the clock while tokens arrive, one short timer dims the
// figure once tokens stop, and the subscription detaches when the last consumer
// unmounts.

window.__ModuleLoader__.load({
  id: 'dsh-live-tps',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'live-tps';

    // How much history the rate averages over, how often it is re-read while
    // tokens arrive, how much silence freezes it, and how few tokens are too few
    // to state a rate at all.
    const WINDOW_MS = 2000;
    const TICK_MS = 200;
    const STALE_MS = 600;
    const MIN_TOKENS = 4;

    const STYLE_ID = 'dsh-live-tps-style';
    const STYLE_TEXT = [
      // A reading, not a control: no fill, no radius, no pointer, and every
      // shown form keeps a constant width so streaming cannot reflow the row.
      '.dsh-live-tps{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;',
      'padding:1px 4px;color:var(--dsw-alias-label-tertiary,currentColor);cursor:default;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'font-variant-numeric:tabular-nums;white-space:nowrap;transition:opacity 220ms ease,color 220ms ease}',
      '.dsh-live-tps--fresh{color:var(--dsw-alias-link,var(--dsw-static-deepseek-450))}',
      '.dsh-live-tps--stale{opacity:.55}',
      // The dot rides the reading's own colour: blue while tokens arrive, the
      // resting label colour once they stop.
      '.dsh-live-tps__dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.dsh-live-tps__reading{display:inline-flex;align-items:baseline;gap:3px;min-width:0}',
      '.dsh-live-tps__value{min-width:4ch;text-align:right}',
      '.dsh-live-tps__unit{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '@media (prefers-reduced-motion:no-preference){',
      '.dsh-live-tps--fresh .dsh-live-tps__dot{animation:dsh-live-tps-breathe 2s ease-in-out infinite}}',
      '@keyframes dsh-live-tps-breathe{0%,100%{opacity:1}50%{opacity:.45}}',
    ].join('');

    /** Nothing measured yet in this page; the row still holds the reading's place. */
    const EMPTY = Object.freeze({ fresh: false, tps: null });

    /** Whole tokens from ten up, one decimal below — the host's own decode figure. */
    function formatRate(tps) {
      const clamped = Math.max(0, tps);
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
    }

    /**
     * Whether one stream chunk carries a model output token.
     * Provider streams deliver one token per delta, so a non-empty text,
     * reasoning, or Tool-call argument fragment counts as one token; block,
     * usage, and finish chunks never do.
     */
    function countsAsToken(chunk) {
      if (chunk === null || typeof chunk !== 'object') return false;
      switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
          return typeof chunk.text === 'string' && chunk.text.length > 0;
        case 'tool-call-delta':
          return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0)
            || chunk.name !== undefined;
        default:
          return false;
      }
    }

    /**
     * Time of the first output token in one compacted durable stream: a packed
     * run carries its first member's offset plus per-member gaps, and a
     * name-bearing Tool-call run starts at its first member.
     * @returns the timestamp, or undefined when the stream carries no token.
     */
    function firstTokenTime(stream) {
      if (!Array.isArray(stream)) return undefined;
      for (const record of stream) {
        if (record === null || typeof record !== 'object') continue;
        if (record.type === 'chunk') {
          if (countsAsToken(record.chunk) && typeof record.time === 'number') return record.time;
          continue;
        }
        if (typeof record.time0 !== 'number') continue;
        const members = record.type === 'tool-call-chunks' ? record.args : record.texts;
        if (!Array.isArray(members)) continue;
        if (record.type === 'tool-call-chunks' && record.name !== undefined) return record.time0;
        let time = record.time0;
        for (let index = 0; index < members.length; index += 1) {
          if (index > 0) {
            const gap = Array.isArray(record.dt) ? record.dt[index - 1] : undefined;
            time += typeof gap === 'number' ? gap : 0;
          }
          const member = members[index];
          if (typeof member === 'string' && member.length > 0) return time;
        }
      }
      return undefined;
    }

    /**
     * Decode rate of one settled `assistant/message`, read exactly the way the
     * host reads it: output tokens over the span from the first streamed token to
     * the committed message.
     * @returns the formatted rate, or null when the message carries no usable
     * accounting (no usage, no streamed token, or a non-positive span).
     */
    function settledRate(event) {
      const data = event.data;
      if (data === null || typeof data !== 'object') return null;
      const usage = data.usage;
      if (usage === null || typeof usage !== 'object') return null;
      const output = usage.outputTokens;
      if (typeof output !== 'number' || !(output > 0)) return null;
      const first = firstTokenTime(data.stream);
      if (first === undefined) return null;
      const decode = event.time - first;
      if (!(decode > 0)) return null;
      return formatRate(output / (decode / 1000));
    }

    /**
     * Fold of one Session's Assistant deltas into a resident reading.
     *
     * Three figures, in order of preference:
     * - the live window while tokens are arriving (`fresh`);
     * - the last live figure once they stop, frozen so a paused stream never
     *   claims a speed it no longer has, and kept across Turns so the row does
     *   not blink when a new answer starts;
     * - the newest settled message's own rate, used only when this page has seen
     *   no live tokens yet (a reload lands here).
     */
    class LiveSpeedSource {
      constructor(lookupBinding) {
        this.lookupBinding = lookupBinding;
        this.listeners = new Set();
        this.value = EMPTY;
        this.times = [];
        this.attemptId = undefined;
        this.live = null;
        this.settled = null;
        this.detach = undefined;
        this.timer = undefined;
        this.retry = undefined;
        this.retries = 0;
        this.disposed = false;
      }

      getSnapshot() {
        return this.value;
      }

      subscribe(listener) {
        this.listeners.add(listener);
        if (this.detach === undefined) this.attach();
        return () => {
          this.listeners.delete(listener);
          if (this.listeners.size === 0) this.release();
        };
      }

      attach() {
        if (this.disposed) return;
        const binding = this.lookupBinding();
        if (binding === undefined) {
          // The composer can mount before the Conversation retains this
          // Session; retry briefly instead of publishing a dead entry.
          if (this.retry !== undefined || this.retries >= 20) return;
          this.retries += 1;
          this.retry = setTimeout(() => {
            this.retry = undefined;
            if (this.listeners.size > 0 && this.detach === undefined) this.attach();
          }, 500);
          return;
        }
        this.detach = binding.eventSource.subscribe(() => { this.onWindow(); });
        this.seed(binding.eventSource.getSnapshot().entries);
      }

      release() {
        if (this.detach !== undefined) this.detach();
        this.detach = undefined;
        if (this.retry !== undefined) clearTimeout(this.retry);
        this.retry = undefined;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.retries = 0;
        this.times = [];
        this.attemptId = undefined;
        this.live = null;
        this.settled = null;
        this.setValue(EMPTY);
      }

      dispose() {
        this.disposed = true;
        this.release();
        this.listeners.clear();
      }

      /** Adopt the newest settled message already inside a window. */
      seed(entries) {
        if (!Array.isArray(entries)) return;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue;
          if (entry.event.type !== 'assistant/message') continue;
          const rate = settledRate(entry.event);
          if (rate === null) continue;
          this.settled = rate;
          break;
        }
        this.publish();
      }

      onWindow() {
        if (this.detach === undefined) return;
        const binding = this.lookupBinding();
        if (binding === undefined) return;
        const change = binding.eventSource.getSnapshot().change;
        if (change.kind === 'append') {
          for (const entry of change.entries) this.accept(entry);
          return;
        }
        // A settlement swaps the attempt's transient rows for its durable event,
        // which therefore arrives here rather than as a plain append.
        if (change.kind === 'settle-assistant') {
          if (change.entry !== undefined) this.accept(change.entry);
          return;
        }
        // A rebuilt window (reconnect, history replacement) invalidates the
        // stream this reading averaged; a prepended page leaves the live tail
        // intact and adds nothing newer.
        if (change.kind === 'replace') {
          this.times = [];
          this.attemptId = undefined;
          this.live = null;
          this.settled = null;
          // Seeding publishes once, so a rebuilt window never flashes the dash
          // on its way to a figure it already has.
          this.seed(binding.eventSource.getSnapshot().entries);
        }
      }

      accept(entry) {
        if (entry === null || typeof entry !== 'object') return;
        if (entry.type === 'transient') {
          this.acceptChunk(entry.event);
          return;
        }
        if (entry.type === 'event' && entry.event.type === 'assistant/message') {
          const rate = settledRate(entry.event);
          if (rate !== null) this.settled = rate;
          this.publish();
        }
      }

      acceptChunk(event) {
        if (event === null || typeof event !== 'object' || event.type !== 'assistant/live-chunk') return;
        const data = event.data;
        if (data === null || typeof data !== 'object') return;
        if (!countsAsToken(data.chunk)) return;
        if (data.attemptId !== this.attemptId) {
          this.attemptId = data.attemptId;
          this.times = [];
        }
        // Arrival time, not the frame timestamp: a remote browser can carry a
        // skewed clock, but every arrival shares this one.
        this.times.push(Date.now());
        const last = this.times[this.times.length - 1];
        const cut = last - WINDOW_MS;
        let start = 0;
        while (start < this.times.length && this.times[start] < cut) start += 1;
        if (start > 0) this.times.splice(0, start);
        this.publish();
        this.schedule();
      }

      schedule() {
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (this.listeners.size === 0) return;
          this.publish();
          const last = this.times.length > 0 ? this.times[this.times.length - 1] : 0;
          if (Date.now() - last < STALE_MS) this.schedule();
        }, TICK_MS);
      }

      publish() {
        const count = this.times.length;
        if (count === 0) {
          this.setValue(this.resting(false));
          return;
        }
        const now = Date.now();
        const last = this.times[count - 1];
        const silence = now - last;
        const span = last - this.times[0];
        // A real rate needs enough samples; until then whatever is resting
        // stays on screen instead of flashing the dash, and it stays unlit —
        // `fresh` means the digits on screen come from this stream.
        const displayable = count >= MIN_TOKENS && span > 0;
        if (displayable) this.live = formatRate((count - 1) * 1000 / span);
        this.setValue(this.resting(displayable && silence <= STALE_MS));
      }

      /** The value to show, lit only when it was just measured. */
      resting(fresh) {
        return { fresh, tps: this.live ?? this.settled };
      }

      setValue(next) {
        const prev = this.value;
        if (prev.fresh === next.fresh && prev.tps === next.tps) return;
        this.value = next;
        for (const listener of [...this.listeners]) listener();
      }
    }

    const identity = value => value;

    function LiveSpeedPill(props) {
      const t = props.t;
      const reading = props.useLiveSpeed(identity);
      // One stable accessible name for a figure that would otherwise be read
      // out five times a second; the ticking digits stay out of the tree.
      const label = t('pill.label');
      return h('span', {
        className: reading.fresh ? 'dsh-live-tps dsh-live-tps--fresh' : 'dsh-live-tps dsh-live-tps--stale',
        'data-composer-stat': 'live-speed',
        role: 'img',
        'aria-label': label,
        title: label,
      },
      h('span', { className: 'dsh-live-tps__dot', 'aria-hidden': 'true' }),
      h('span', { className: 'dsh-live-tps__reading', 'aria-hidden': 'true' },
        h('span', { className: 'dsh-live-tps__value' }, reading.tps ?? t('pill.empty')),
        h('span', { className: 'dsh-live-tps__unit' }, t('pill.unit'))));
    }

    const MemoPill = React.memo(LiveSpeedPill);

    const DICTS = {
      en: { 'pill.unit': 'tok/s', 'pill.empty': '—', 'pill.label': 'Output speed — newest answer, including reasoning' },
      zh: { 'pill.unit': 'tok/s', 'pill.empty': '—', 'pill.label': '输出速度 — 最近一条回答，含思考内容' },
      ja: { 'pill.unit': 'tok/s', 'pill.empty': '—', 'pill.label': '出力速度 — 最新の応答（推論を含む）' },
      de: { 'pill.unit': 'Tok./s', 'pill.empty': '—', 'pill.label': 'Ausgabegeschwindigkeit — letzte Antwort, inkl. Denkschritten' },
      es: { 'pill.unit': 'tok/s', 'pill.empty': '—', 'pill.label': 'Velocidad de salida — última respuesta, incluido el razonamiento' },
      fr: { 'pill.unit': 'jetons/s', 'pill.empty': '—', 'pill.label': 'Débit de sortie — dernière réponse, raisonnement inclus' },
      pt: { 'pill.unit': 'tok/s', 'pill.empty': '—', 'pill.label': 'Velocidade de saída — última resposta, incluindo raciocínio' },
      ru: { 'pill.unit': 'ток/с', 'pill.empty': '—', 'pill.label': 'Скорость вывода — последний ответ, включая рассуждения' },
    };

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = STYLE_TEXT;
          document.head.append(style);
          return () => { style.remove(); };
        }, 'live-tps: styles');

        ctx.effect(
          () => ctx.locale.register(NS, DICTS),
          'live-tps: dictionaries',
        );

        const sources = new Map();
        const sourceFor = (sessionId) => {
          const existing = sources.get(sessionId);
          if (existing !== undefined) return existing;
          const source = new LiveSpeedSource(() => ctx.sessions.binding(sessionId));
          sources.set(sessionId, source);
          return source;
        };
        ctx.effect(() => () => {
          for (const source of sources.values()) source.dispose();
          sources.clear();
        }, 'live-tps: speed sources');

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'live-speed',
          order: 2,
          locale: NS,
          inject: sessionId => ({ hooks: { liveSpeed: sourceFor(sessionId) } }),
        }, MemoPill));
      },
    };
  },
});
