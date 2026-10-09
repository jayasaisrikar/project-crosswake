import { cn } from '@/lib/utils';

/** Crosswake mark: a rising trend line cutting across a fading counter-wake. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={cn('brand-mark', className)} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="cw-mark-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a1cf6b" />
          <stop offset="1" stopColor="#5a9a38" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#cw-mark-bg)" />
      <path d="M8 11.5L24 21" stroke="#0b1206" strokeOpacity=".32" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M8 22L14 16L18 19.5L24.5 12" stroke="#0b1206" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 11.5H25V17" stroke="#0b1206" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function Brand({ className, href = '/' }: { className?: string; href?: string }) {
  return (
    <a className={cn('brand', className)} href={href} aria-label="Crosswake home">
      <BrandMark />
      <span className="brand-word">Crosswake</span>
    </a>
  );
}
export function Status({good=false,label,waiting=false}:{good?:boolean;label:string;waiting?:boolean}) {
  return <span className="state-label" data-state={good?'good':waiting?'waiting':'neutral'}><span className="status-dot" aria-hidden />{label}</span>;
}
