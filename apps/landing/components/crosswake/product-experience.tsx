'use client';
import { useRef, useState } from 'react';
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from 'motion/react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { DashboardDemo, LabDemo, SignalLogDemo } from './demo-screens';
const chapters = [
  {
    title: 'The market, in view.',
    label: 'Observe',
    text: 'See whether the Bitcoin filter is on, which coins are close to a breakout, and how every open paper trade is doing, in one dashboard.',
    screen: DashboardDemo,
    caption: 'Market dashboard · BTC filter, watchlist and open paper trades',
    href: '/docs',
  },
  {
    title: 'A process you can inspect.',
    label: 'Validate',
    text: 'Every strategy is tested on data it has never seen before it sends a signal. Failed versions stay on the record next to the live ones.',
    screen: LabDemo,
    caption: 'Strategy lab · Unseen-data test and every version, failures included',
    href: '/docs/validation',
  },
  {
    title: 'Every call, accounted for.',
    label: 'Track',
    text: 'Each buy and sell posted to Telegram lands in the signal log with its rule and its result after fees. Losses stay on the page next to the wins.',
    screen: SignalLogDemo,
    caption: 'Signal log · Every Telegram signal with its outcome',
    href: '/docs/signals',
  },
];
export function ProductExperience() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [active, setActive] = useState(0);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end end'],
  });
  useMotionValueEvent(scrollYProgress, 'change', (v) =>
    setActive(Math.min(2, Math.floor(v * 3))),
  );
  const jump = (index: number) => {
    if (!ref.current) return;
    const top = ref.current.getBoundingClientRect().top + window.scrollY;
    const distance = ref.current.offsetHeight - window.innerHeight;
    window.scrollTo({
      top: top + (distance * (index + 0.2)) / 3,
      behavior: reduced ? 'instant' : 'smooth',
    });
  };
  return (
    <section ref={ref} className="product-journey" id="workspace">
      <div className="journey-sticky">
        <div className="journey-heading">
          <h2>
            Go beyond
            <br />
            <span>the signal.</span>
          </h2>
          <p>
            The actual workspace.
            <br />
            The entire reasoning.
          </p>
        </div>
        <div className="journey-layout">
          <div className="journey-copy">
            <div
              className="journey-tabs"
              role="group"
              aria-label="Product walkthrough"
            >
              {chapters.map((c, i) => (
                <button
                  key={c.label}
                  aria-pressed={active === i}
                  onClick={() => jump(i)}
                >
                  <span>0{i + 1}</span>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="journey-description">
              <span className="journey-count">0{active + 1} / 03</span>
              <h3>{chapters[active].title}</h3>
              <p>{chapters[active].text}</p>
              <Link className="cw-text-button" href={chapters[active].href}>
                Explore the details <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="journey-progress">
              <motion.i style={{ scaleX: scrollYProgress }} />
            </div>
          </div>
          <div className="journey-screens">
            {chapters.map((c, i) => (
              <figure
                key={c.label}
                className={
                  i === active ? 'journey-screen active' : 'journey-screen'
                }
                aria-hidden={i !== active}
              >
                <c.screen />
                <figcaption>{c.caption}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
      <div className="journey-mobile">
        {chapters.map((c) => (
          <article key={c.label}>
            <h3>{c.title}</h3>
            <p>{c.text}</p>
            <figure>
              <c.screen />
              <figcaption>{c.caption}</figcaption>
            </figure>
            <Link className="cw-text-button" href={c.href}>
              Explore the details <ArrowUpRight size={16} />
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
export function ProductEntrance() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'center center'],
  });
  const rotate = useTransform(scrollYProgress, [0, 1], [16, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.83, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [110, 0]);
  return (
    <section
      ref={ref}
      className="product-entrance"
      aria-label="Research workspace preview"
    >
      <div className="entrance-caption">
        <span>ONE DASHBOARD. EVERY SIGNAL ON THE RECORD.</span>
        <a href="#workspace">Take a closer look ↓</a>
      </div>
      <motion.figure style={reduced ? {} : { rotateX: rotate, scale, y }}>
        <DashboardDemo />
        <figcaption>
          <span>Crosswake / Market dashboard</span>
          <span>Shown with demo data</span>
        </figcaption>
      </motion.figure>
    </section>
  );
}
export function HeroParallax({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end start'],
  });
  const y = useTransform(scrollYProgress, [0, 1], [0, 160]);
  const opacity = useTransform(scrollYProgress, [0, 0.9], [1, 0.2]);
  return (
    <motion.div
      ref={ref}
      className="hero-parallax"
      style={reduced ? {} : { y, opacity }}
    >
      {children}
    </motion.div>
  );
}
