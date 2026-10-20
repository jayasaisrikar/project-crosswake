import type { ReactNode } from 'react';

type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] };

const inline = (text: string, key: string): ReactNode[] =>
  text
    .split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
    .filter((part) => part !== '')
    .map((part, index) => {
      const id = `${key}-${index}`;
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={id}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('`') && part.endsWith('`'))
        return <code key={id}>{part.slice(1, -1)}</code>;
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
        return <em key={id}>{part.slice(1, -1)}</em>;
      return part;
    });

// A short leading "Label:" in a list item reads as a term, so it is set in bold.
const labelled = (item: string) =>
  item.replace(/^([A-Z][^:*`]{0,40}):\s+/, '**$1:** ');

// Line-based: a heading or list may sit directly under the previous line, with no blank line between.
export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    const text = para.join(' ').trim();
    if (text) blocks.push({ kind: 'p', text });
    para = [];
  };
  const pushItem = (kind: 'ul' | 'ol', item: string) => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === kind) last.items.push(item);
    else blocks.push({ kind, items: [item] });
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: heading[1]!.length === 2 ? 'h2' : 'h3',
        text: heading[2]!.trim(),
      });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      pushItem('ul', bullet[1]!);
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flush();
      pushItem('ol', numbered[1]!);
      continue;
    }
    para.push(line.replace(/^>\s?/, ''));
  }
  flush();
  return blocks;
}

export function headings(body: string) {
  return parseBlocks(body)
    .filter((block): block is { kind: 'h2'; text: string } => block.kind === 'h2')
    .map((block) => block.text);
}

export const slugifyHeading = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const plain = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

// `lede` is the description already shown under the title; an opening paragraph that repeats it is dropped.
export function ArticleBody({ body, lede }: { body: string; lede?: string }) {
  const parsed = parseBlocks(body);
  const first = parsed[0];
  const blocks =
    lede && first?.kind === 'p' && plain(first.text) === plain(lede)
      ? parsed.slice(1)
      : parsed;
  return (
    <div className="rs-article-body">
      {blocks.map((block, index) => {
        if (block.kind === 'h2')
          return (
            <h2 key={index} id={slugifyHeading(block.text)}>
              {inline(block.text, `h${index}`)}
            </h2>
          );
        if (block.kind === 'h3')
          return <h3 key={index}>{inline(block.text, `h${index}`)}</h3>;
        if (block.kind === 'ul')
          return (
            <ul key={index}>
              {block.items.map((item, i) => (
                <li key={i}>{inline(labelled(item), `u${index}-${i}`)}</li>
              ))}
            </ul>
          );
        if (block.kind === 'ol')
          return (
            <ol key={index}>
              {block.items.map((item, i) => (
                <li key={i}>{inline(item, `o${index}-${i}`)}</li>
              ))}
            </ol>
          );
        return <p key={index}>{inline(block.text, `p${index}`)}</p>;
      })}
    </div>
  );
}
