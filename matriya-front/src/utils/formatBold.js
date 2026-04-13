/**
 * Split text by **bold** markdown and return segments for rendering.
 * Use in components to render document/chat content with bold instead of literal **.
 * @param {string} text
 * @returns {{ type: 'text'|'bold', value: string }[]}
 */
export function formatBoldSegments(text) {
  if (typeof text !== 'string') return [{ type: 'text', value: String(text) }];
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'bold', value: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return parts.length ? parts : [{ type: 'text', value: text }];
}
