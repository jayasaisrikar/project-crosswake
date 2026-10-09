'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { Brand } from './brand';
import { telegramUrl } from '@/lib/site';
const links = [
  ['how', 'How it works'],
  ['signals', 'Signals'],
  ['approach', 'Strategy'],
  ['research', 'Results'],
] as const;
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [section, setSection] = useState('');
  const path = usePathname();
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => e.isIntersecting && setSection(e.target.id)),
      { rootMargin: '-45% 0px -50% 0px' },
    );
    links.forEach(([id]) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => {
      window.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, []);
  const close = () => setOpen(false);
  const cta = telegramUrl ?? '/#signals';
  return (
    <header
      className={`cw-header${scrolled ? ' is-scrolled' : ''}${open ? ' is-open' : ''}`}
    >
      <Brand />
      <nav aria-label="Main navigation" className="cw-nav">
        {links.map(([id, label]) => (
          <Link
            key={id}
            href={`/#${id}`}
            onClick={close}
            data-active={path === '/' && section === id ? '' : undefined}
          >
            {label}
          </Link>
        ))}
        <Link
          href="/log"
          aria-current={path.startsWith('/log') ? 'page' : undefined}
          onClick={close}
        >
          Signal log
        </Link>
        <Link
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
export function SiteFooter(){return <footer className="cw-footer"><div className="cw-footer-top"><Brand/><p>Clear signals.<br/>Public results.</p><div><Link href="/log">Signal log ↗</Link><Link href="/docs">Documentation ↗</Link><Link href="/docs/strategies">Strategy catalog ↗</Link><Link href="/docs/validation">Research standards ↗</Link></div></div><div className="cw-footer-bottom"><span>© {new Date().getFullYear()} Crosswake</span><span>Research software. Paper signals only.</span><a href="#main">Back to top ↑</a></div></footer>}
