'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ShieldAlert } from 'lucide-react';

type Turn = {
  role: 'user' | 'record';
  text: string;
  sources?: string[];
  failed?: boolean;
};

const label: Record<string, string> = {
  liveStatus: 'collector health',
  strategyRecord: 'strategy record',
  recentSignals: 'signal log',
  marketContext: 'market snapshot',
  preRegistered: 'frozen rules',
  researchEvidence: 'research evidence',
  publicRecord: 'published posts',
};

const failure: Record<string, string> = {
  ask_not_configured:
    'The record agent is not switched on for this deployment yet.',
  rate_limited:
    'That is a lot of questions in a short time. Give it a minute, then ask again.',
  chat_busy: 'Another question is being read. Try again in a few seconds.',
  chat_budget_exhausted:
    'The agent has answered as many questions as it is allowed to today. Try again tomorrow.',
  chat_timeout: 'That question took too long to read. Try a shorter one.',
  chat_model_failed: 'The model behind the agent is unavailable right now.',
  chat_empty_answer: 'The agent returned nothing usable. Try rephrasing.',
  record_unreachable:
    'The live record on our server could not be reached just now.',
};

const suggestions = [
  'Is the collector healthy right now?',
  'What is v005 holding, and how has it done live?',
  'Has any strategy proven an edge on data it never saw?',
  'What did the last market update say?',
];

const reading = [
  'Reading the live record…',
  'Checking the strategy states…',
  'Counting the signals so far…',
  'Checking what was frozen before testing…',
];

export function AskConsole({
  variant = 'page',
}: {
  variant?: 'page' | 'section';
}) {
  const Heading = variant === 'page' ? 'h1' : 'h2';
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [slow, setSlow] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!busy) return;
    setStep(0);
    const timer = setInterval(() => setStep((s) => (s + 1) % reading.length), 4500);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 20000);
    return () => clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    const node = feed.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, busy]);

  async function ask(question: string) {
    const asked = question.trim();
    if (!asked || busy) return;
    const history = turns
      .filter((t) => !t.failed)
      .slice(-6)
      .map((t) => ({ role: t.role === 'record' ? 'assistant' : 'user', content: t.text }));
    setTurns((prev) => [...prev, { role: 'user', text: asked }]);
    setInput('');
    setBusy(true);
    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: asked, history }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && typeof body.answer === 'string')
        setTurns((prev) => [
          ...prev,
          { role: 'record', text: body.answer, sources: body.sources ?? [] },
        ]);
      else
        setTurns((prev) => [
          ...prev,
          {
            role: 'record',
            failed: true,
            text:
              failure[body.error as string] ??
              'The record agent could not answer that. Try asking again.',
          },
        ]);
    } catch {
      setTurns((prev) => [
        ...prev,
        { role: 'record', failed: true, text: failure.record_unreachable },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={variant === 'page' ? 'ask is-page' : 'ask'} id="ask">
      <div className="ask-intro" data-reveal>
        <span className="ask-eyebrow">Live record</span>
        <Heading className="ask-title">
          Ask the record
          <span className="ask-stop">.</span>
        </Heading>
        <p className="ask-lead">
          An agent that reads our own running record and answers in plain
          language. Every answer is drawn from the same files the dashboard and
          the signal log are built from, at the moment you ask.
        </p>
        <ul className="ask-can">
          <li>
            <b>Reads</b> collector health, every live strategy state, the signal
            log, the market snapshot, the frozen rules and what we have posted
            publicly.
          </li>
          <li>
            <b>Cannot</b> trade, edit a file, change a strategy or give advice.
            It has no write path at all.
          </li>
          <li>
            <b>Answers only</b> from what it read. Ask something the record does
            not cover and it will say so.
          </li>
        </ul>
        <div className="ask-suggest">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              disabled={busy}
            >
              {s}
            </button>
          ))}
        </div>
        <p className="ask-fine">
          Answers are paper-trading research, not financial advice. The agent is
          rate limited and free to use.
        </p>
      </div>

      <div className="ask-bezel" data-reveal>
        <div className="ask-core">
          <header className="ask-head">
            <span className="ask-dot" aria-hidden="true" />
            <b>Record agent</b>
            <span className="ask-model">paper data · free model</span>
          </header>

          <div className="ask-feed" ref={feed} aria-live="polite">
            {turns.length === 0 && (
              <p className="ask-empty">
                Ask anything about what Crosswake is running right now. For
                example: what is the collector doing, what is open, or what a
                strategy has returned since it went live.
              </p>
            )}
            {turns.map((turn, i) => (
              <article key={i} className={`ask-turn is-${turn.role}`}>
                <span className="ask-who">
                  {turn.role === 'user' ? 'You' : 'Record'}
                </span>
                <p className={turn.failed ? 'ask-text is-failed' : 'ask-text'}>
                  {turn.failed && <ShieldAlert size={14} aria-hidden="true" />}
                  {turn.text}
                </p>
                {!!turn.sources?.length && (
                  <p className="ask-sources">
                    read:{' '}
                    {turn.sources.map((s) => label[s] ?? s).join(' · ')}
                  </p>
                )}
              </article>
            ))}
            {busy && (
              <article className="ask-turn is-record">
                <span className="ask-who">Record</span>
                <p className="ask-text is-pending">
                  <span className="ask-typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {reading[step]}
                  {slow && (
                    <span className="ask-slow">
                      {' '}
                      The free model is slow just now, so this can take a minute.
                    </span>
                  )}
                </p>
              </article>
            )}
          </div>

          <form
            className="ask-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(input);
            }}
          >
            <label className="ask-field">
              <span className="sr-only">Your question about the record</span>
              <textarea
                value={input}
                rows={2}
                maxLength={600}
                placeholder="Ask about the live record…"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void ask(input);
                  }
                }}
              />
            </label>
            <button
              className="ask-send"
              type="submit"
              disabled={busy || input.trim().length < 3}
            >
              Ask
              <span className="ask-send-icon" aria-hidden="true">
                <ArrowUp size={16} />
              </span>
            </button>
          </form>
          <p className="ask-foot">
            Four questions a minute. The agent reads only, so nothing it does can
            change a position or a file.
          </p>
        </div>
      </div>
    </section>
  );
}
