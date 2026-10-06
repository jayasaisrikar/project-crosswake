import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Crosswake · Research workbench',
  description: 'Local market evidence and BTC transmission research',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
