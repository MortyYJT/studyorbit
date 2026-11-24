import { Fragment, type ReactNode } from 'react';

/** Plain-text rendering: paragraphs, bullet and numbered lists, headings as bold lines. No HTML is interpreted. */
export function RichText({ text }: { text: string }) {
  const blocks = text.replace(/\*\*(.+?)\*\*/g, '$1').split(/\n{2,}/).map(block => block.split('\n').filter(line => line.trim()));
  return <>{blocks.map((lines, index) => {
    if (!lines.length) return null;
    const bullet = /^\s*[-*•]\s+/, numbered = /^\s*\d+[.)、]\s+/;
    if (lines.every(line => bullet.test(line))) return <ul key={index}>{lines.map((line, item) => <li key={item}>{line.replace(bullet, '')}</li>)}</ul>;
    if (lines.every(line => numbered.test(line))) return <ol key={index}>{lines.map((line, item) => <li key={item}>{line.replace(numbered, '')}</li>)}</ol>;
    const parts: ReactNode[] = [];
    lines.forEach((line, item) => {
      const heading = /^#{1,6}\s+/.test(line);
      parts.push(<Fragment key={item}>{item > 0 && <br />}{heading ? <strong>{line.replace(/^#{1,6}\s+/, '')}</strong> : line}</Fragment>);
    });
    return <p key={index}>{parts}</p>;
  })}</>;
}
