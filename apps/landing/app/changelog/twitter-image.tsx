import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake changelog';

export default function Image() {
  return ogImage({
    eyebrow: 'Public record',
    title: 'Changelog.',
    subtitle: 'Every version, every result, dated. Failures included.',
    stats: [['7', 'strategy versions'], ['5', 'failed or retired'], ['2', 'live on paper']],
  });
}
