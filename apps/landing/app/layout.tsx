import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import '../tokens.css';
import './redesign.css';
import './kinetic.css';

export const metadata: Metadata = {
  title: 'Crosswake · Crypto signals, grounded in evidence',
  description:
    'Clear crypto trend signals, transparent strategy research, and live paper tracking. Explore the rules and the evidence behind Crosswake.',
};

const sans = Geist({ subsets: ['latin'], variable: '--font-geist' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
