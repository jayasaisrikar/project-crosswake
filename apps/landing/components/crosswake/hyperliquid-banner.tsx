import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Hyperliquid mark, from hyperliquid.xyz. */
export function HyperliquidMark({ className }: { className?: string }) {
  return (
    <svg className={cn('hl-mark', className)} viewBox="0 44 155 120" aria-hidden="true">
      <path
        fill="currentColor"
        d="M152.75393,98.33694c0,49.53839-30.41458,65.4366-46.54323,51.38164-13.13338-11.52047-17.05043-35.94411-36.86579-38.47859-25.11487-2.99537-27.419,30.41426-44.00855,30.41426-19.35459,0-23.04117-27.87978-23.04117-42.39574,0-14.74629,4.14741-34.7921,20.50659-34.7921,19.12413,0,20.27625,28.80147,44.23899,27.18856,23.7324-1.61291,24.19319-31.56639,39.86116-44.23897,13.59385-11.29016,45.852.69123,45.852,50.92094Z"
      />
    </svg>
  );
}

/** Announcement pill for the Hyperliquid integration, shared by landing and docs. */
export function HyperliquidBanner({ className }: { className?: string }) {
  return (
    <Link className={cn('hl-banner', className)} href="/docs#hyperliquid">
      <span className="hl-banner-new">NEW</span>
      <HyperliquidMark />
      <span className="hl-banner-text">
        Hyperliquid integration <span>· in progress</span>
      </span>
      <ArrowUpRight size={14} aria-hidden="true" />
    </Link>
  );
}
