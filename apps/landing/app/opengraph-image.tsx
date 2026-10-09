import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake: altcoin trend signals you can verify';

export default function Image() {
  return ogImage({
    eyebrow: 'Free altcoin signals on Telegram',
    title: 'Signals you can verify.',
    subtitle: 'Rules tested on unseen data. Every result published after fees, losses included.',
    stats: [['36', 'coins scanned daily'], ['243', 'trades on unseen data'], ['Every', 'loss posted']],
  });
}
