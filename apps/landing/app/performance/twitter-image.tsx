import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake v005 performance on unseen data';

export default function Image() {
  return ogImage({
    eyebrow: 'v005 · unseen-data test',
    title: 'Performance, in full.',
    subtitle: 'Equity curve, drawdown and benchmarks. Every trade downloadable.',
    stats: [['+12.8%', 'total return'], ['−16.9%', 'max drawdown'], ['−53%', 'BTC drawdown, same period']],
  });
}
