'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, Menu, X } from 'lucide-react';
import { Brand } from './brand';
import { telegramUrl } from '@/lib/site';

// Grouped navigation: the bar stays at three items however many pages are added.
const groups = [
  {
    label: 'Product',
    items: [
      { href: '/#how', section: 'how', title: 'How it works', note: 'From market scan to signal' },
      { href: '/#signals', section: 'signals', title: 'Telegram signals', note: 'What lands in the channel' },
      { href: '/#approach', section: 'approach', title: 'Strategy', note: 'The idea behind the rules' },
    ],
  },
  {
    label: 'Proof',
    items: [
      { href: '/performance', title: 'Performance', note: 'Equity, drawdown, benchmarks' },
      { href: '/log', title: 'Signal log', note: 'Every signal, tamper-evident' },
      { href: '/docs/validation', title: 'Validation', note: 'How a strategy earns its place' },
      { href: '/commitments', title: 'Commitments', note: 'Our promises, and how to check them' },
      { href: '/changelog', title: 'Changelog', note: 'Every version and result, dated' },
    ],
  },
] as const;
const sections = groups.flatMap((g) => g.items.flatMap((i) => ('section' in i ? [i.section] : [])));

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [section, setSection] = useState('');
  const path = usePathname();
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setSection(e.target.id)),
      { rootMargin: '-45% 0px -50% 0px' },
    );
    sections.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      observer.disconnect();
    };
  }, []);
  const close = () => {
    setOpen(false);
    setMenu(null);
  };
  const isActive = (item: (typeof groups)[number]['items'][number]) =>
    'section' in item ? path === '/' && section === item.section : path.startsWith(item.href);
  const cta = telegramUrl ?? '/#signals';
  return (
    <header className={`cw-header${scrolled ? ' is-scrolled' : ''}${open ? ' is-open' : ''}`}>
      <Brand />
      <nav aria-label="Main navigation" className="cw-nav" ref={navRef}>
        {groups.map((g) => {
          const expanded = menu === g.label;
          return (
            <div
              key={g.label}
              className={`cw-nav-group${expanded ? ' is-open' : ''}`}
              onPointerEnter={(e) => e.pointerType === 'mouse' && setMenu(g.label)}
              onPointerLeave={(e) => e.pointerType === 'mouse' && setMenu(null)}
            >
              <button
                type="button"
                className="cw-nav-trigger"
                aria-expanded={expanded}
                data-active={g.items.some(isActive) ? '' : undefined}
                onClick={() => setMenu(expanded ? null : g.label)}
              >
                {g.label} <ChevronDown size={14} aria-hidden="true" />
              </button>
              <div className="cw-nav-menu">
                <span className="cw-nav-menu-label">{g.label}</span>
                {g.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={close}
                    aria-current={isActive(item) ? 'page' : undefined}
                  >
                    <b>{item.title}</b>
                    <small>{item.note}</small>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
        <Link
          className="cw-nav-link"
          href="/docs"
          aria-current={path.startsWith('/docs') ? 'page' : undefined}
          onClick={close}
        >
          Docs
        </Link>
      </nav>
      <div className="cw-nav-end">
        <span className="cw-live-pill">
          <i aria-hidden="true" /> Paper tracking live
        </span>
        <Link className="cw-nav-action" href={cta}>
          {telegramUrl ? 'Join Telegram' : 'Get signals'}
          <ArrowUpRight size={15} />
        </Link>
      </div>
      <button
        className="cw-menu"
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <X /> : <Menu />}
      </button>
    </header>
  );
}
export function SiteFooter(){return <footer className="cw-footer"><div className="cw-footer-top"><Brand/><p>Clear signals.<br/>Public results.</p><div><Link href="/performance">Performance ↗</Link><Link href="/commitments">Commitments ↗</Link><Link href="/changelog">Changelog ↗</Link><Link href="/log">Signal log ↗</Link><Link href="/docs">Documentation ↗</Link><Link href="/docs/strategies">Strategy catalog ↗</Link><Link href="/docs/validation">Research standards ↗</Link></div></div><div className="cw-footer-bottom"><span>© {new Date().getFullYear()} Crosswake</span><span>Research software. Paper signals only.</span><a href="#main">Back to top ↑</a></div></footer>}
