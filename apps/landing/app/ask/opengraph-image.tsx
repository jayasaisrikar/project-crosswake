import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Ask the Crosswake record';

export default function Image() {
  return ogImage({
    eyebrow: 'Live record',
    title: 'Ask the record.',
    subtitle:
      'A read-only agent over our own running data. It reads, it never writes.',
    stats: [
      ['7', 'records it can read'],
      ['paper', 'only, no orders'],
      ['0', 'write paths'],
    ],
  });
}
