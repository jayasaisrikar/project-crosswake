import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
const sans = Geist({ subsets: ['latin'], variable: '--font-geist' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });
export const metadata: Metadata = {
  title: 'Crosswake · Research workbench',
  description: 'Local market evidence and BTC transmission research',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
