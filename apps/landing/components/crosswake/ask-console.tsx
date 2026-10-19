'use client';
import { Composer, Suggestions, Transcript, useAskChat } from './ask-chat';

export function AskConsole() {
  const chat = useAskChat();
  return (
    <section className="ask is-page" id="ask">
      <div className="ask-intro" data-reveal>
        <span className="ask-eyebrow">Live record</span>
        <h1 className="ask-title">
          Ask the record
          <span className="ask-stop">.</span>
        </h1>
        <p className="ask-lead">
          Ask anything. When the question is about our own running data, the
          answer is read from it and shows what it read.
        </p>
        <ul className="ask-can">
          <li>
            <b>Reads</b> collector health, every live strategy state, the signal
            log, the market snapshot, the frozen rules and what we have posted
            publicly.
          </li>
          <li>
            <b>Answers anything else</b> from general knowledge, and is clear
            about which is which. It never invents a Crosswake figure.
          </li>
          <li>
            <b>Cannot</b> trade, edit a file, change a strategy or give advice.
            It has no write path at all.
          </li>
        </ul>
        <Suggestions chat={chat} />
        <p className="ask-fine">
          Answers about the record are paper-trading research, not financial
          advice. Free to use, rate limited.
        </p>
      </div>

      <div className="ask-bezel" data-reveal>
        <div className="ask-core">
          <header className="ask-head">
            <span className="ask-dot" aria-hidden="true" />
            <b>Crosswake</b>
            <span className="ask-model">reads the live record</span>
          </header>
          <Transcript
            chat={chat}
            empty="Ask anything about what Crosswake is running right now, or about crypto and the research behind it. Any answer that comes from our data lists what it read."
          />
          <Composer chat={chat} />
          <p className="ask-foot">
            Read-only, so nothing it does can change a position or a file. It
            reads the record on our own server and stores nothing you ask.
          </p>
        </div>
      </div>
    </section>
  );
}
