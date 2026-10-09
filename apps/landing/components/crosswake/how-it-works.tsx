import { Activity, BellRing, LineChart } from 'lucide-react';

const steps = [
  {
    icon: Activity,
    title: 'We watch the market.',
    text: 'Crosswake scans 36 major coins after every daily close. Bitcoin sets the direction: when it is below its 100-day average, we stay out.',
  },
  {
    icon: BellRing,
    title: 'You get a clear signal.',
    text: 'When an altcoin breaks to a new 20-day high, a signal lands on Telegram and the dashboard: the coin, the entry and the exit rule.',
  },
  {
    icon: LineChart,
    title: 'Every trade is tracked.',
    text: 'Exits follow a 10-day low. Each result is recorded with fees and slippage, wins and losses alike, so you can judge the record yourself.',
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="cw-section cw-how" data-reveal>
      <div className="cw-section-heading">
        <h2>
          What you get.
          <br />
          <span>In three steps.</span>
        </h2>
        <p>
          No charts to stare at all day. Trades last days to weeks, so there is
          time to read the signal and decide.
        </p>
      </div>
      <div className="cw-how-grid">
        <ol className="cw-how-steps" data-stagger>
          {steps.map(({ icon: Icon, title, text }, i) => (
            <li key={title}>
              <span className="cw-how-index">0{i + 1}</span>
              <Icon size={20} aria-hidden="true" />
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
