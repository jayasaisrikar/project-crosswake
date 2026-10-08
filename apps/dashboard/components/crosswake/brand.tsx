import { cn } from '@/lib/utils';

export function Brand({ className, href = '/' }: {className?:string;href?:string}) {
  return <a className={cn('brand', className)} href={href} aria-label="Crosswake home">
    <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M3 22L11 14L17 20L28 9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 14L10 7L17 14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" opacity=".35" />
    </svg>crosswake<span className="text-primary">.</span>
  </a>;
}
export function Status({good=false,label,waiting=false}:{good?:boolean;label:string;waiting?:boolean}) {
  return <span className="state-label" data-state={good?'good':waiting?'waiting':'neutral'}><span className="status-dot" aria-hidden />{label}</span>;
}
