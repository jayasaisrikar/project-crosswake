'use client';
import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sparkles, X } from 'lucide-react';
import { Composer, Suggestions, Transcript, useAskChat } from './ask-chat';

export function AskWidget() {
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const path = usePathname();
  const chat = useAskChat();

  const dismiss = useCallback(() => {
    setOpen(false);
    if (window.location.hash === '#ask')
      history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
  }, []);

  const openPanel = useCallback(() => {
    setOpen(true);
    if (window.location.hash !== '#ask')
      history.replaceState(null, '', '#ask');
  }, []);

  // Links anywhere on the site point at #ask, so the widget follows the hash.
  useEffect(() => {
    const sync = () => setOpen(window.location.hash === '#ask');
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    // The phone sheet covers the screen, so the page behind it must not scroll.
    if (narrow) document.documentElement.style.overflowY = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.style.overflowY = '';
    };
  }, [open, narrow, dismiss]);

  // The dedicated page is the same conversation, so it does not need the launcher.
  if (path?.startsWith('/ask')) return null;

  return (
    <>
      {open && (
        <div
          className="ask-panel"
          id="ask-panel"
          role="dialog"
          aria-label="Ask Crosswake"
        >
          <div className="ask-panel-core">
            <header className="ask-head">
              <span className="ask-dot" aria-hidden="true" />
              <b>Ask Crosswake</b>
              <button
                type="button"
                className="ask-panel-close"
                onClick={dismiss}
                aria-label="Close"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <Transcript
              chat={chat}
              empty="Ask about the live record, or anything else. Questions about our data are answered from the data itself."
            />
            {chat.turns.length === 0 && <Suggestions chat={chat} />}
            <Composer chat={chat} />
            <p className="ask-foot">Read-only. Paper research, not advice.</p>
          </div>
        </div>
      )}
      <button
        type="button"
        className="ask-blob"
        onClick={open ? dismiss : openPanel}
        aria-expanded={open}
        aria-controls="ask-panel"
        aria-label={open ? 'Close the assistant' : 'Ask Crosswake'}
      >
        <span className="ask-blob-icon" aria-hidden="true">
          {open ? <X size={16} /> : <Sparkles size={16} />}
        </span>
        <span className="ask-blob-label">{open ? 'Close' : 'Ask'}</span>
      </button>
    </>
  );
}
