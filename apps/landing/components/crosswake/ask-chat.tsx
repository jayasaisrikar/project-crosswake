'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ShieldAlert } from 'lucide-react';

export type Turn = {
  role: 'user' | 'record';
  text: string;
  sources?: string[];
  failed?: boolean;
};

export const SOURCE_LABELS: Record<string, string> = {
  liveStatus: 'collector health',
  strategyRecord: 'strategy record',
  recentSignals: 'signal log',
  marketContext: 'market snapshot',
  preRegistered: 'frozen rules',
  researchEvidence: 'research evidence',
  publicRecord: 'published posts',
};

const FAILURES: Record<string, string> = {
  ask_not_configured:
    'The record agent is not switched on for this deployment yet.',
  rate_limited:
    'That is a lot of questions in a short time. Give it a minute, then ask again.',
  chat_busy: 'Another question is being read. Try again in a few seconds.',
  chat_budget_exhausted:
    'The agent has answered as many questions as it is allowed to today. Try again tomorrow.',
  chat_timeout: 'That question took too long. Try a shorter one.',
  chat_model_failed: 'The model behind the agent is unavailable right now.',
  chat_empty_answer: 'The agent returned nothing usable. Try rephrasing.',
  record_unreachable:
    'The live record on our server could not be reached just now.',
};

export const SUGGESTIONS = [
  'What is every live strategy holding right now?',
  'Has anything been proven on data it never saw?',
  'How does the v005 entry rule actually work?',
  'Explain basis points like I am new to this',
];

const READING = [
  'Reading the live record…',
  'Checking the strategy states…',
  'Counting the signals so far…',
  'Checking what was frozen before testing…',
];

export function useAskChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!busy) return;
    setStep(0);
    const timer = setInterval(
      () => setStep((s) => (s + 1) % READING.length),
      4500,
    );
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, [busy]);

  async function ask(question: string) {
    const asked = question.trim();
    if (!asked || busy) return;
    const history = turns
      .filter((t) => !t.failed)
      .slice(-6)
      .map((t) => ({
        role: t.role === 'record' ? 'assistant' : 'user',
        content: t.text,
      }));
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
              FAILURES[body.error as string] ??
              'That did not come back. Try asking again.',
          },
        ]);
    } catch {
      setTurns((prev) => [
        ...prev,
        { role: 'record', failed: true, text: FAILURES.record_unreachable! },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return { turns, input, setInput, busy, step, slow, ask, reading: READING };
}

const BOLD = /(\*\*[^*\n]+\*\*)/g;

function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(BOLD).map((part, i) =>
        part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** The model is asked for a lead line and dash bullets; anything else is rendered as prose. */
export function Answer({ text }: { text: string }) {
  const blocks: { kind: 'p' | 'ul'; lines: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-*•]\s+/.test(line)
      ? line.replace(/^[-*•]\s+/, '').replace(/^#+\s*/, '')
      : null;
    const last = blocks[blocks.length - 1];
    if (bullet === null) blocks.push({ kind: 'p', lines: [line] });
    else if (last?.kind === 'ul') last.lines.push(bullet);
    else blocks.push({ kind: 'ul', lines: [bullet] });
  }
  return (
    <div className="ask-answer">
      {blocks.map((block, i) =>
        block.kind === 'ul' ? (
          <ul key={i} className="ask-list">
            {block.lines.map((line, j) => (
              <li key={j}>
                <Inline text={line} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            <Inline text={block.lines[0]!} />
          </p>
        ),
      )}
    </div>
  );
}

export function Transcript({
  chat,
  empty,
}: {
  chat: ReturnType<typeof useAskChat>;
  empty: string;
}) {
  const { turns, busy, slow, step, reading } = chat;
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = feed.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, busy]);

  return (
    <div className="ask-feed" ref={feed} aria-live="polite">
      {turns.length === 0 && <p className="ask-empty">{empty}</p>}
      {turns.map((turn, i) => (
        <article key={i} className={`ask-turn is-${turn.role}`}>
          <span className="ask-who">
            {turn.role === 'user' ? 'You' : 'Crosswake'}
          </span>
          {turn.failed ? (
            <p className="ask-text is-failed">
              <ShieldAlert size={14} aria-hidden="true" />
              {turn.text}
            </p>
          ) : (
            <div className="ask-text">
              <Answer text={turn.text} />
            </div>
          )}
          {!!turn.sources?.length && (
            <p className="ask-sources">
              read:{' '}
              {turn.sources.map((s) => SOURCE_LABELS[s] ?? s).join(' · ')}
            </p>
          )}
        </article>
      ))}
      {busy && (
        <article className="ask-turn is-record">
          <span className="ask-who">Crosswake</span>
          <p className="ask-text is-pending">
            <span className="ask-typing" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {reading[step]}
            {slow && (
              <span className="ask-slow"> Still reading. This can take a bit.</span>
            )}
          </p>
        </article>
      )}
    </div>
  );
}

export function Composer({ chat }: { chat: ReturnType<typeof useAskChat> }) {
  const { input, setInput, busy, ask } = chat;
  return (
    <form
      className="ask-form"
      onSubmit={(event) => {
        event.preventDefault();
        void ask(input);
      }}
    >
      <label className="ask-field">
        <span className="sr-only">Your question</span>
        <textarea
          value={input}
          rows={2}
          maxLength={600}
          placeholder="Ask anything…"
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
  );
}

export function Suggestions({ chat }: { chat: ReturnType<typeof useAskChat> }) {
  const { busy, ask } = chat;
  return (
    <div className="ask-suggest">
      {SUGGESTIONS.map((s) => (
        <button key={s} type="button" onClick={() => ask(s)} disabled={busy}>
          {s}
        </button>
      ))}
    </div>
  );
}
