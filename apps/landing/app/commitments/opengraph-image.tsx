import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake commitments';

export default function Image() {
  return ogImage({
    eyebrow: 'Our promises',
    title: 'Commitments.',
    subtitle: 'Eight promises, each with a way to check it yourself.',
  });
}
