export const workspaceUrl =
  process.env.NEXT_PUBLIC_WORKSPACE_URL?.match(/^https?:\/\//) &&
  !/localhost|127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_WORKSPACE_URL)
    ? process.env.NEXT_PUBLIC_WORKSPACE_URL
    : '/docs';
export const telegramUrl = process.env.NEXT_PUBLIC_TELEGRAM_URL?.match(
  /^https:\/\/t\.me\//,
)
  ? process.env.NEXT_PUBLIC_TELEGRAM_URL
  : undefined;
// Public, append-only signal logs (raw .jsonl), e.g. a public GitHub repo's raw URL.
export const signalLogBase = process.env.NEXT_PUBLIC_SIGNAL_LOG_BASE?.match(
  /^(https:\/\/|http:\/\/localhost[:/])/,
)
  ? process.env.NEXT_PUBLIC_SIGNAL_LOG_BASE.replace(/\/$/, '')
  : undefined;
// Browsable history of the same logs (e.g. the GitHub repo's commits page).
export const signalLogRepo = process.env.NEXT_PUBLIC_SIGNAL_LOG_REPO?.match(
  /^https:\/\//,
)
  ? process.env.NEXT_PUBLIC_SIGNAL_LOG_REPO
  : undefined;
export const signalLogs = [
  { file: 'trend-daily-v005.jsonl', label: 'v005 · Daily Trend' },
  { file: 'trend-daily-v006.jsonl', label: 'v006 · Wider universe' },
];
