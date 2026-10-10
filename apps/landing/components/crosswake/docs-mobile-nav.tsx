'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ChevronUp, X } from 'lucide-react';

type Props = {
  sections: { id: string; title: string }[];
  pages: { href: string; nav: string; current: boolean }[];
};
const RING = 2 * Math.PI * 11;
const pad = (n: number) => String(n).padStart(2, '0');

// Phone-only docs navigation: a pill in thumb reach shows the current section and reading
// progress, and opens a bottom sheet with this page's sections and every docs page.
export function DocsMobileNav({ sections, pages }: Props) {
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState(0);
  const [shown, setShown] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // Keep the current page's chip in view inside the horizontal rail.
    const rail = document.querySelector<HTMLElement>('.cw-docs-sidebar nav');
    const chip = rail?.querySelector<HTMLElement>('[aria-current]');
    if (rail && chip)
      rail.scrollLeft = chip.offsetLeft - (rail.clientWidth - chip.offsetWidth) / 2;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const article = document.getElementById('main');
      if (!article) return;
      const { top, height } = article.getBoundingClientRect();
      const span = height - window.innerHeight;
      setProgress(span > 0 ? Math.min(1, Math.max(0, -top / span)) : 1);
      setShown(window.scrollY > 260 && top + height > window.innerHeight * 0.75);
      let current = 0;
      sections.forEach((s, i) => {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 140) current = i;
      });
      setActive(current);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [sections]);
  const close = () => sheet.current?.close();
  return (
    <>
      <button
        type="button"
        className="cw-doc-pill"
        data-shown={shown ? '' : undefined}
        aria-haspopup="dialog"
        onClick={() => sheet.current?.showModal()}
      >
        <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
          <circle cx="14" cy="14" r="11" />
          <circle
            cx="14"
            cy="14"
            r="11"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - progress)}
          />
        </svg>
        <span className="cw-doc-pill-text">
          <small>
            {pad(active + 1)} / {pad(sections.length)} · On this page
          </small>
          <b>{sections[active]?.title}</b>
        </span>
        <ChevronUp size={18} aria-hidden="true" />
      </button>
      <dialog
        ref={sheet}
        className="cw-doc-sheet"
        aria-label="Docs navigation"
        onClick={(e) => e.target === sheet.current && close()}
      >
        <div className="cw-doc-sheet-body">
          <div className="cw-doc-sheet-head">
            <span>On this page</span>
            <button type="button" aria-label="Close" onClick={close}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <ol>
            {sections.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={i === active ? 'location' : undefined}
                  onClick={close}
                >
                  <i>{pad(i + 1)}</i>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
          <div className="cw-doc-sheet-head">
            <span>All docs</span>
          </div>
          <div className="cw-doc-sheet-pages">
            {pages.map((p, i) => (
              <Link
                key={p.href}
                href={p.href}
                aria-current={p.current ? 'page' : undefined}
                onClick={close}
              >
                <i>{pad(i + 1)}</i>
                {p.nav}
              </Link>
            ))}
          </div>
        </div>
      </dialog>
    </>
  );
}
