import { pageMeta } from '@/lib/seo';
import Link from 'next/link';
import { SimplePage } from '@/components/crosswake/simple-page';

export const metadata = pageMeta({
  title: 'Commitments',
  description:
    'What Crosswake promises — no edited signals, every loss posted, no pumps — and how to check each promise yourself.',
  path: '/commitments',
});

const commitments: { title: string; body: string; check: React.ReactNode }[] = [
  {
    title: 'Every signal stays up',
    body: 'We never edit or delete a signal after it is posted, winners or losers.',
    check: (
      <>
        Telegram marks edited posts. Every signal is also written to the{' '}
        <Link href="/log">signal log</Link>, where changing any past entry breaks every fingerprint after it.
      </>
    ),
  },
  {
    title: 'Every loss is posted',
    body: 'Each trade gets a SELL card with its result after fees, including the losing ones.',
    check: <>Count the BUY cards and the SELL cards. Every position that opens is closed in public.</>,
  },
  {
    title: 'Rules are frozen before testing',
    body: 'A strategy’s rules and pass/fail bar are fixed before it sees test data. Changing a rule creates a new version; old results are never rewritten.',
    check: (
      <>
        Each version and its result is dated in the <Link href="/changelog">changelog</Link>.
      </>
    ),
  },
  {
    title: 'Failures stay public',
    body: 'Strategies that fail are kept on the record, never quietly retuned and relaunched under a new name.',
    check: (
      <>
        Five of seven versions so far have failed or been retired. They are all listed in the{' '}
        <Link href="/changelog">changelog</Link>.
      </>
    ),
  },
  {
    title: 'Costs are always counted',
    body: 'Every published result includes modelled fees and slippage, and we test what happens when fills come late.',
    check: (
      <>
        Download the trades from the <Link href="/performance">performance page</Link> and recompute the numbers.
      </>
    ),
  },
  {
    title: 'No promised returns',
    body: 'We never claim guaranteed profits, win rates or targets. We publish the uncertainty alongside every result.',
    check: <>Every result on this site shows its confidence interval or sample size next to it.</>,
  },
  {
    title: 'No pumps, no paid shilling',
    body: 'We never coordinate buying, accept payment to feature a coin, or post signals for coins we have been paid to promote.',
    check: <>Every signal comes from the published strategy rules and appears in the signal log with the rule that triggered it.</>,
  },
  {
    title: 'Paid tiers announced in advance',
    body: 'The channel is free. If a paid tier, referral link or sponsorship is ever added, it will be announced at least 30 days ahead, here and on Telegram.',
    check: <>This page and the changelog are where that announcement will appear first.</>,
  },
];

export default function Page() {
  return (
    <SimplePage
      eyebrow="Our promises"
      title="Commitments."
      lead="Trust should not depend on taking our word for it. Each promise below comes with a way to check it yourself."
    >
      <ol className="cm-list">
        {commitments.map((c, i) => (
          <li key={c.title}>
            <span className="cm-num">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <h2>{c.title}</h2>
              <p>{c.body}</p>
              <p className="cm-check">
                <b>How to check</b> {c.check}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p className="sl-quiet">Last updated 9 October 2026. Changes to this page are recorded in the changelog.</p>
    </SimplePage>
  );
}
