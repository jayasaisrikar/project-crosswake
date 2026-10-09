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
