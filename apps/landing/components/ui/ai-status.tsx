'use client';

// Adapted from rareui.com/components/aistatus: colours come from the site
// tokens (always dark) and a ResizeObserver stands in for react-use-measure.
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from 'motion/react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

export type AiStatusState =
  | 'thinking'
  | 'researching'
  | 'analyzing'
  | 'writing'
  | 'done'
  | 'error';

type StateConfig = {
  label: string | ((elapsed: string | undefined) => string);
  active: boolean;
};

const STATES: Record<AiStatusState, StateConfig> = {
  thinking: { label: 'Thinking', active: true },
  researching: { label: 'Researching', active: true },
  analyzing: { label: 'Analyzing', active: true },
  writing: { label: 'Writing', active: true },
  done: {
    label: (elapsed) => (elapsed ? `Worked for ${elapsed}` : 'Done'),
    active: false,
  },
  error: {
    label: (elapsed) => (elapsed ? `Failed after ${elapsed}` : 'Failed'),
    active: false,
  },
};

const MUTED = 'var(--ink-secondary)';

const PEN_PATH =
  'M3.78181 16.3092L3 21L7.69086 20.2182C8.50544 20.0825 9.25725 19.6956 9.84119 19.1116L20.4198 8.53288C21.1934 7.75922 21.1934 6.5049 20.4197 5.73126L18.2687 3.58024C17.495 2.80658 16.2406 2.80659 15.4669 3.58027L4.88841 14.159C4.30447 14.7429 3.91757 15.4947 3.78181 16.3092Z';
const SPARKLE_PATH = 'M11 5Q12 12 19 13Q12 14 11 21Q10 14 3 13Q10 12 11 5Z';
const TWINKLE_PATH = 'M18 2Q18.4 4.6 21 5Q18.4 5.4 18 8Q17.6 5.4 15 5Q17.6 4.6 18 2Z';
const WAVE_PATH =
  'M3 19C4.11 16.3 5.06 16.3 6.17 19C7.27 21.7 8.22 21.7 9.33 19C10.44 16.3 11.39 16.3 12.5 19';
// points along the wave at eased arc length, so the pen tip stays on the ink
const WAVE_X = [3, 3.05, 3.18, 3.42, 3.78, 4.42, 5.26, 5.83, 6.29, 6.84, 7.76, 8.67, 9.22, 9.68, 10.25, 11.09, 11.72, 12.09, 12.33, 12.46, 12.5];
const WAVE_Y = [19, 18.88, 18.58, 18.1, 17.51, 17, 17.36, 18.25, 19.29, 20.33, 21.02, 20.32, 19.27, 18.24, 17.35, 17, 17.52, 18.11, 18.6, 18.9, 19];
const WAVE_PROGRESS = [0, 0.007, 0.028, 0.061, 0.104, 0.156, 0.216, 0.282, 0.352, 0.425, 0.5, 0.575, 0.648, 0.718, 0.784, 0.844, 0.896, 0.939, 0.972, 0.993, 1];
const SCRIBBLE: Transition = {
  duration: 2.4,
  ease: 'linear',
  repeat: Infinity,
  times: [...WAVE_PROGRESS.map((_, i) => (i / (WAVE_PROGRESS.length - 1)) * 0.7), 0.85, 1],
};

const SWAP: Transition = { type: 'spring', duration: 0.5, bounce: 0.15 };
const ICON: Transition = { type: 'spring', duration: 0.55, bounce: 0.35 };
const INSTANT: Transition = { duration: 0 };
const LOOP = { repeat: Infinity, ease: 'easeInOut' } as const;
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const swapVariants: Variants = {
  enter: { y: 8, opacity: 0, filter: 'blur(4px)' },
  center: { y: 0, opacity: 1, filter: 'blur(0px)' },
  exit: { y: -8, opacity: 0, filter: 'blur(4px)' },
};
const iconVariants: Variants = {
  enter: { scale: 0.5, opacity: 0, rotate: -30, filter: 'blur(4px)' },
  center: { scale: 1, opacity: 1, rotate: 0, filter: 'blur(0px)' },
  exit: { scale: 0.5, opacity: 0, rotate: 30, filter: 'blur(4px)' },
};

// the highlight sits mid gradient, so each sweep starts off the text
const SHIMMER = `linear-gradient(90deg, ${MUTED} 40%, var(--ink) 50%, ${MUTED} 60%)`;

export const formatElapsed = (seconds: number) =>
  seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry!.borderBoxSize[0]?.inlineSize ?? node.offsetWidth),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export type AiStatusProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  state?: AiStatusState;
  detail?: string;
  /** Seconds already worked; when absent an active status counts on its own. */
  elapsed?: number;
};

export function AiStatus({
  state = 'thinking',
  detail,
  elapsed,
  className,
  ...props
}: AiStatusProps) {
  const reduced = !!useReducedMotion();
  const config = STATES[state];
  const [counted, setCounted] = useState(0);
  const [wasActive, setWasActive] = useState(config.active);

  // a new run starts from zero; switching between working states keeps counting
  if (config.active !== wasActive) {
    setWasActive(config.active);
    if (config.active) setCounted(0);
  }

  useEffect(() => {
    if (!config.active || elapsed !== undefined) return;
    const start = Date.now();
    const id = window.setInterval(
      () => setCounted(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [config.active, elapsed]);

  const [measureRef, width] = useWidth<HTMLDivElement>();
  const swap = reduced ? INSTANT : SWAP;
  const seconds = elapsed ?? (config.active ? counted : undefined);
  const time = seconds !== undefined ? formatElapsed(Math.max(0, Math.floor(seconds))) : undefined;
  const text = typeof config.label === 'function' ? config.label(time) : config.label;

  return (
    <div
      data-slot="ai-status"
      data-state={state}
      role="status"
      className={cn('flex h-8 w-fit max-w-full items-center gap-2 text-[14px]', className)}
      {...props}
    >
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={state}
            aria-hidden
            variants={iconVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={reduced ? INSTANT : ICON}
            className="flex items-center justify-center"
          >
            <AiStatusIcon state={state} />
          </motion.span>
        </AnimatePresence>
      </span>

      {/* the row springs between widths, so the detail and timer glide instead of jumping */}
      <motion.div
        className="relative min-w-0 overflow-x-clip"
        initial={false}
        animate={{ width: width || 'auto' }}
        transition={swap}
      >
        <div ref={measureRef} className="flex w-max items-center gap-1.5 whitespace-nowrap">
          <span className="relative grid">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={text}
                variants={swapVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={swap}
                className="font-semibold"
                style={config.active ? undefined : { color: MUTED }}
              >
                {config.active ? <Shimmer reduced={reduced}>{text}</Shimmer> : text}
              </motion.span>
            </AnimatePresence>
          </span>
          <AnimatePresence initial={false} mode="popLayout">
            {detail && (
              <motion.span
                key={detail}
                variants={swapVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={swap}
                className="max-w-56 truncate font-medium opacity-70"
                style={{ color: MUTED }}
              >
                {detail}
              </motion.span>
            )}
          </AnimatePresence>
          {time && config.active && (
            <span aria-hidden className="font-medium tabular-nums opacity-70" style={{ color: MUTED }}>
              {time}
            </span>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export function AiStatusIcon({ state }: { state: AiStatusState }) {
  const reduced = !!useReducedMotion();
  const loop = (transition: Transition) => (reduced ? INSTANT : transition);
  const svg = { viewBox: '0 0 24 24', width: 18, height: 18, style: { color: MUTED } };

  switch (state) {
    case 'thinking':
      return (
        <svg {...svg} style={{ color: 'var(--signal)' }}>
          <motion.path
            d={SPARKLE_PATH}
            fill="currentColor"
            animate={reduced ? undefined : { rotate: [0, 90], scale: [1, 0.8, 1] }}
            transition={loop({ duration: 2.4, ...LOOP })}
          />
          <motion.path
            d={TWINKLE_PATH}
            fill="currentColor"
            animate={reduced ? undefined : { scale: [0.4, 1, 0.4], opacity: [0.3, 1, 0.3] }}
            transition={loop({ duration: 1.2, ...LOOP })}
          />
        </svg>
      );
    case 'researching':
      return (
        <svg {...svg}>
          <motion.g
            animate={reduced ? undefined : { x: [0, 2, 0, -2, 0], y: [-2, 0, 2, 0, -2] }}
            transition={loop({ duration: 2, repeat: Infinity, ease: 'linear' })}
          >
            <circle {...STROKE} cx={10.5} cy={10.5} r={5.5} strokeWidth={2.25} />
            <path {...STROKE} d="M14.75 14.75L19 19" strokeWidth={2.5} />
          </motion.g>
        </svg>
      );
    case 'analyzing':
      return (
        <svg {...svg}>
          {[6, 12, 18].map((x, i) => (
            <motion.line
              key={x}
              {...STROKE}
              x1={x}
              x2={x}
              y1={10}
              y2={19}
              strokeWidth={3}
              animate={reduced ? undefined : { y1: [15, 5, 15] }}
              transition={loop({ duration: 0.9, delay: i * 0.15, ...LOOP })}
            />
          ))}
        </svg>
      );
    case 'writing':
      return (
        <svg {...svg}>
          <g transform="translate(-1.2 -2)">
            <motion.path
              {...STROKE}
              d={WAVE_PATH}
              strokeWidth={2.25}
              style={{ pathSpacing: 2 }}
              initial={false}
              animate={
                reduced
                  ? { pathLength: 1 }
                  : { pathLength: [...WAVE_PROGRESS, 1, 1], opacity: [...WAVE_PROGRESS.map(() => 1), 1, 0] }
              }
              transition={loop(SCRIBBLE)}
            />
            <motion.g
              initial={false}
              animate={
                reduced
                  ? { x: WAVE_X.at(-1), y: WAVE_Y.at(-1) }
                  : { x: [...WAVE_X, WAVE_X.at(-1)!, WAVE_X[0]!], y: [...WAVE_Y, WAVE_Y.at(-1)!, WAVE_Y[0]!] }
              }
              transition={loop(SCRIBBLE)}
            >
              {/* puts the pen tip, not its corner, on the point being drawn */}
              <path d={PEN_PATH} fill="currentColor" transform="scale(0.66) translate(-3 -21)" />
            </motion.g>
          </g>
        </svg>
      );
    case 'done':
      return (
        <svg {...svg}>
          <motion.path
            {...STROKE}
            d="M5 12.5L10 17.5L19 7"
            strokeWidth={2.5}
            initial={{ pathLength: reduced ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={reduced ? INSTANT : { type: 'spring', duration: 0.6, bounce: 0, delay: 0.1 }}
          />
        </svg>
      );
    case 'error':
      return (
        <svg {...svg} style={{ color: '#ff6b5e' }}>
          <motion.path
            {...STROKE}
            d="M7 7L17 17M17 7L7 17"
            strokeWidth={2.5}
            animate={reduced ? undefined : { x: [0, -3, 3, -2, 2, 0] }}
            transition={{ duration: 0.45, delay: 0.1 }}
          />
        </svg>
      );
  }
}

function Shimmer({ reduced, children }: { reduced: boolean; children: React.ReactNode }) {
  if (reduced) return <span style={{ color: MUTED }}>{children}</span>;
  return (
    <motion.span
      className="bg-clip-text text-transparent"
      style={{ backgroundImage: SHIMMER, backgroundSize: '250% 100%' }}
      initial={{ backgroundPosition: '100% 0' }}
      animate={{ backgroundPosition: '0% 0' }}
      transition={{ duration: 1.6, ease: 'linear', repeat: Infinity }}
    >
      {children}
    </motion.span>
  );
}
