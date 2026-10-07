import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Crosswake · BTC-to-altcoin transmission research',
  description:
    'Local-first research system measuring how Bitcoin moves propagate into altcoins. Evidence first, execution disabled.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
