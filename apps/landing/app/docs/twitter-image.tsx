import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake documentation';

export default function Image() {
  return ogImage({
    eyebrow: 'Documentation',
    title: 'How Crosswake works.',
    subtitle: 'The strategy, reading a signal, validation and market updates.',
  });
}
