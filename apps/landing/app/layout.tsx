import type { Metadata, Viewport } from 'next';
import { siteDescription, siteName, siteUrl } from '@/lib/site';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import '../tokens.css';
import './redesign.css';
import './kinetic.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Crosswake · Altcoin trend signals you can verify',
    template: '%s · Crosswake',
  },
  description: siteDescription,
  applicationName: siteName,
  keywords: [
    'altcoin signals',
    'crypto trend following',
    'free crypto signals Telegram',
    'crypto trading signals track record',
    'Bitcoin trend filter',
    'backtested crypto strategy',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName,
    locale: 'en_GB',
    url: '/',
    title: 'Crosswake · Altcoin trend signals you can verify',
    description: siteDescription,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crosswake · Altcoin trend signals you can verify',
    description: siteDescription,
  },
  robots: { index: true, follow: true },
};
export const viewport: Viewport = { themeColor: '#0b0d0c', colorScheme: 'dark' };

const sans = Geist({ subsets: ['latin'], variable: '--font-geist' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
