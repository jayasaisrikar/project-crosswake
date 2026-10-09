import Link from 'next/link';
import {
  ArrowUpRight,
  BatteryFull,
  Check,
  ChevronLeft,
  MoreVertical,
  Send,
  Signal,
  Wifi,
} from 'lucide-react';
import { telegramUrl } from '@/lib/site';

// Messages mirror the real Telegram cards sent by apps/trend and the 4h digest;
// prices and results here are demo values.
const messages = [
  {
    time: '00:05',
    tone: 'buy',
    body: (
      <>
        🟢 <b>BUY SOL</b> · spot · daily
        <br />
        <br />▸ <b>Entry</b> <code>~182.40</code> (today&apos;s open)
        <br />▸ <b>Exit</b> daily close below the 10-day low
        <br />
        <br />
        <b>Why</b> 20-day breakout with BTC in an uptrend
        <br />
        <i>v005 · paper signal, not advice</i>
      </>
    ),
  },
  {
    time: '00:05',
    tone: 'win',
    body: (
      <>
        ✅ <b>SELL TIA</b> · spot
        <br />
        <br />▸ <b>Exit</b> <code>~6.84</code> (today&apos;s open)
        <br />▸ <b>Result</b> <code>+18.6%</code>
        <br />▸ <b>Reason</b> close below 10-day low
        <br />
        <i>v005 · paper result</i>
      </>
    ),
  },
  {
    time: '08:05',
    body: (
      <>
        <b>📊 Market update · 4h</b>
        <br />
        BTC holds above its 100-day average, so the daily trend filter stays{' '}
        <b>on</b>. Strongest 4h momentum: SOL, INJ, LINK.
      </>
    ),
  },
];

const perks = [
  'Buy and sell signals the moment a daily candle closes',
  'Entry, exit rule and the reason, in one short card',
  'Market updates on 10 major coins every 4 hours',
  'Every result posted, losses included',
];

export function TelegramFeed() {
  const href = telegramUrl ?? '/docs/signals';
  return (
    <section id="signals" className="cw-section cw-tg" data-reveal>
      <div className="cw-tg-copy">
        <span className="cw-tg-eyebrow">
          <Send size={14} aria-hidden="true" /> Free Telegram channel
        </span>
        <h2>
          Signals, straight
          <br />
          <span>to your phone.</span>
        </h2>
        <p>
          Join the channel and every Crosswake signal arrives as a clear card:
          what to buy, where to get in, and the rule that gets you out.
        </p>
        <ul data-stagger>
          {perks.map((p) => (
            <li key={p}>
              <Check size={16} aria-hidden="true" /> {p}
            </li>
          ))}
        </ul>
        <div className="cw-actions">
          <Link className="cw-button" href={href}>
            {telegramUrl ? 'Join the Telegram channel' : 'See how signals work'}
            <ArrowUpRight size={18} />
          </Link>
        </div>
      </div>
      <figure
        className="tg-phone"
        aria-label="Example Telegram channel messages with demo data"
      >
        <div className="tg-screen">
          <div className="tg-status" aria-hidden="true">
            <span>9:41</span>
            <i className="tg-notch" />
            <span className="tg-status-icons">
              <Signal size={13} />
              <Wifi size={13} />
              <BatteryFull size={16} />
            </span>
          </div>
          <div className="tg-head">
            <ChevronLeft size={22} aria-hidden="true" />
            <span className="tg-avatar" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/logo-mark.png" alt="" />
            </span>
            <div className="tg-title">
              <b>Crosswake Signals</b>
              <small>channel · demo messages</small>
            </div>
            <MoreVertical size={18} aria-hidden="true" />
          </div>
          <div className="tg-chat" data-stagger>
            <span className="tg-date">Today</span>
            {messages.map((m, i) => (
              <div key={i} className={`tg-post${m.tone ? ` is-${m.tone}` : ''}`}>
                <span className="tg-post-from">Crosswake Signals</span>
                <p>{m.body}</p>
                <span className="tg-meta">
                  {m.time}
                </span>
              </div>
            ))}
          </div>
          <div className="tg-join" aria-hidden="true">
            <span>Join Channel</span>
          </div>
          <i className="tg-home" aria-hidden="true" />
        </div>
      </figure>
    </section>
  );
}
