export interface Notice {
  kind: 'signal' | 'paper_exit' | 'analysis';
  id: string;
  /** When the underlying decision or exit happened. */
  at: number;
  text: string;
}
export interface Sink {
  readonly name: string;
  send(notice: Notice): Promise<void>;
}
export interface Delivery {
  sink: string;
  id: string;
  kind: Notice['kind'];
  ok: boolean;
  /** Decision-to-delivery delay; the end-user reaction time is measured separately. */
  latencyMs: number;
  error?: string;
}
type Fetch = typeof fetch;

/**
 * Telegram Bot API sink. Disabled unless explicitly enabled; errors never
 * include the bot token, which is part of the request URL.
 */
export class TelegramSink implements Sink {
  readonly name = 'telegram';
  constructor(
    private token: string,
    private chatId: string,
    private fetcher: Fetch = fetch,
    private baseUrl = 'https://api.telegram.org',
  ) {
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token))
      throw new Error('TELEGRAM_BOT_TOKEN has an invalid shape');
    if (!/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId))
      throw new Error('TELEGRAM_CHAT_ID must be a numeric ID or @channel');
  }
  async send(notice: Notice) {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.baseUrl}/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: notice.text.slice(0, 4000),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch (error) {
      throw new Error(
        `Telegram request failed: ${(error as Error).name ?? 'error'}`,
      );
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!response.ok || !body?.ok)
      throw new Error(
        `Telegram rejected the message: HTTP ${response.status}${body?.description ? ` ${body.description.slice(0, 120)}` : ''}`,
      );
  }
}

export interface ChannelStatus {
  name: string;
  enabled: boolean;
  detail: string;
}
/** Builds optional sinks from the environment. The dashboard feed is always on and needs no sink. */
export function sinksFromEnv(
  env: Record<string, string | undefined>,
  fetcher: Fetch = fetch,
): { sinks: Sink[]; channels: ChannelStatus[] } {
  const channels: ChannelStatus[] = [
    { name: 'dashboard', enabled: true, detail: 'Local signal feed' },
  ];
  const sinks: Sink[] = [];
  if (env.TELEGRAM_ENABLED === 'true') {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
      throw new Error(
        'TELEGRAM_ENABLED=true needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
      );
    sinks.push(
      new TelegramSink(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, fetcher),
    );
    channels.push({ name: 'telegram', enabled: true, detail: 'Bot delivery' });
  } else
    channels.push({
      name: 'telegram',
      enabled: false,
      detail: 'Future option; set TELEGRAM_ENABLED=true to turn on',
    });
  return { sinks, channels };
}

/** Sends to every sink independently; one failing channel never blocks the others or the engine. */
export async function deliver(
  sinks: Sink[],
  notice: Notice,
  now: () => number = Date.now,
): Promise<Delivery[]> {
  return Promise.all(
    sinks.map(async (sink) => {
      try {
        await sink.send(notice);
        return {
          sink: sink.name,
          id: notice.id,
          kind: notice.kind,
          ok: true,
          latencyMs: now() - notice.at,
        };
      } catch (error) {
        return {
          sink: sink.name,
          id: notice.id,
          kind: notice.kind,
          ok: false,
          latencyMs: now() - notice.at,
          error: String((error as Error).message ?? error).slice(0, 200),
        };
      }
    }),
  );
}
