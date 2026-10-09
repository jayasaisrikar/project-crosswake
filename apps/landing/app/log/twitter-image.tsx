import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake public signal log';

export default function Image() {
  return ogImage({
    eyebrow: 'Public record',
    title: 'The signal log.',
    subtitle: 'Every signal, hash-chained. Edit one and every fingerprint after it breaks.',
  });
}
