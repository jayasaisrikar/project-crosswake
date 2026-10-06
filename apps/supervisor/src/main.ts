import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createResearchRuntime } from '../../../packages/research-runtime/src/runtime.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((x) => x !== '--'),
  options: {
    session: { type: 'string', default: 'default' },
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    'protocol-dir': { type: 'string', default: 'research/frozen' },
    mode: { type: 'string' },
    status: { type: 'boolean', default: false },
    protocol: { type: 'string' },
  },
});
if (!process.env.RESEARCH_MODEL)
  throw new Error(
    'Set RESEARCH_MODEL=provider/model and its provider API key for interactive research. Deterministic experiments use pnpm research:experiment without a model.',
  );
const runtime = await createResearchRuntime({
  dataDir: values['data-dir']!,
  protocolDir: values['protocol-dir']!,
  sessionId: values.session!,
  modelId: process.env.RESEARCH_MODEL,
});
const unsubscribe = runtime.session.subscribe((event) => {
  if (event.type === 'message_update' && event.event.type === 'text-delta')
    stdout.write(event.event.delta);
  if (event.type === 'tool_approval_required')
    stdout.write(
      `\nApproval pending: ${event.toolCallId}. Use /approve ID or /deny ID.\n`,
    );
  if (event.type === 'error')
    stdout.write(
      '\nResearch agent reported an error; inspect provider configuration and session state.\n',
    );
});
try {
  if (values.mode) await runtime.switchMode(values.mode);
  if (values.status) console.log(await runtime.status());
  else if (values.protocol)
    console.log(await runtime.runExperiment(values.protocol));
  else {
    console.log(
      'Crosswake Research Supervisor. /mode investigate|experiment|review, /status, /run PROTOCOL_ID, /quit. Threads persist; interrupted runs are not automatically resumed.',
    );
    const input = createInterface({ input: stdin, output: stdout });
    try {
      for (;;) {
        let line: string;
        try {
          line = (
            await input.question(`\n[${runtime.session.mode.get()}] > `)
          ).trim();
        } catch {
          break;
        }
        if (line === '/quit') break;
        if (!line) continue;
        try {
          if (line.startsWith('/mode '))
            await runtime.switchMode(line.slice(6));
          else if (line === '/status') console.log(await runtime.status());
          else if (line.startsWith('/run '))
            console.log(await runtime.runExperiment(line.slice(5)));
          else if (line.startsWith('/approve ') || line.startsWith('/deny '))
            await runtime.session.respondToToolApproval({
              toolCallId: line.split(' ')[1]!,
              decision: line.startsWith('/approve ') ? 'approve' : 'decline',
            });
          else if (line.startsWith('/')) console.log('Unknown command.');
          else await runtime.session.sendMessage({ content: line });
        } catch (error) {
          console.error(String(error));
        }
      }
    } finally {
      input.close();
    }
  }
} finally {
  unsubscribe();
  await runtime.close();
}
