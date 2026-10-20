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

export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of body.split(/\n{2,}/)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const heading = /^(#{2,4})\s+(.*)$/.exec(chunk.split('\n')[0]!);
    if (heading && chunk.split('\n').length === 1) {
      blocks.push({
        kind: heading[1]!.length === 2 ? 'h2' : 'h3',
        text: heading[2]!.trim(),
      });
      continue;
    }
    const lines = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.every((line) => /^[-*]\s+/.test(line)) && lines.length) {
      blocks.push({
        kind: 'ul',
        items: lines.map((line) => line.replace(/^[-*]\s+/, '')),
      });
      continue;
    }
    if (lines.every((line) => /^\d+[.)]\s+/.test(line)) && lines.length) {
      blocks.push({
        kind: 'ol',
        items: lines.map((line) => line.replace(/^\d+[.)]\s+/, '')),
      });
      continue;
    }
    blocks.push({
      kind: 'p',
      text: lines
        .map((line) => line.replace(/^>\s?/, ''))
        .join(' ')
        .trim(),
    });
  }
  return blocks.filter((block) => block.kind !== 'p' || block.text.length > 0);
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

export function ArticleBody({ body }: { body: string }) {
  const blocks = parseBlocks(body);
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
                <li key={i}>{inline(item, `u${index}-${i}`)}</li>
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
