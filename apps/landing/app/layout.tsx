import type { Metadata } from 'next';
import './globals.css';
import '../tokens.css';
import './redesign.css';
import './kinetic.css';

export const metadata: Metadata = {
  title: 'Crosswake · Crypto signals, grounded in evidence',
  description:
    'Clear crypto trend signals, transparent strategy research, and live paper tracking. Explore the rules and the evidence behind Crosswake.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
