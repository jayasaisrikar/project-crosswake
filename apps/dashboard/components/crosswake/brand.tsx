import { cn } from '@/lib/utils';

/** Crosswake mark: the interlocking wake-and-cross icon. */
export function BrandMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={cn('brand-mark', className)} src="/brand/logo-mark.png" alt="" width={512} height={512} />
  );
}
export function Brand({ className, href = '/' }: { className?: string; href?: string }) {
  return (
    <a className={cn('brand', className)} href={href} aria-label="Crosswake home">
      <BrandMark />
      <span className="brand-word" aria-hidden="true">
        CROSSW<span className="brand-accent">A</span>KE
      </span>
    </a>
  );
}
export function Status({good=false,label,waiting=false}:{good?:boolean;label:string;waiting?:boolean}) {
  return <span className="state-label" data-state={good?'good':waiting?'waiting':'neutral'}><span className="status-dot" aria-hidden />{label}</span>;
}
