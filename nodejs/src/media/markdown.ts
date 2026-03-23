/**
 * Convert markdown-formatted text to plain text for WeChat delivery.
 *
 * WeChat doesn't render markdown, so AI model responses need to be
 * stripped of markdown syntax before sending.
 *
 * Preserves newlines and content structure; strips formatting syntax.
 */
export function stripMarkdown(text: string): string {
  let result = text

  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => code.trim())

  // Inline code: strip backticks, keep content
  result = result.replace(/`([^`]+)`/g, '$1')

  // Images: remove entirely (we handle media separately)
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '')

  // Links: keep display text only [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Tables: remove separator rows, then clean pipes
  result = result.replace(/^\|[\s:|-]+\|$/gm, '')
  result = result.replace(/^\|(.+)\|$/gm, (_match, inner: string) =>
    inner
      .split('|')
      .map((cell) => cell.trim())
      .join('  '),
  )

  // Headers: strip # prefix
  result = result.replace(/^#{1,6}\s+/gm, '')

  // Horizontal rules (must be before bold/italic to avoid conflict with ***)
  result = result.replace(/^[-*_]{3,}\s*$/gm, '')

  // Bold/italic: strip markers
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
  result = result.replace(/\*\*(.+?)\*\*/g, '$1')
  result = result.replace(/\*(.+?)\*/g, '$1')
  result = result.replace(/___(.+?)___/g, '$1')
  result = result.replace(/__(.+?)__/g, '$1')
  result = result.replace(/_(.+?)_/g, '$1')

  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '$1')

  // Blockquotes: strip > prefix
  result = result.replace(/^>\s?/gm, '')

  // Unordered lists: strip bullet markers
  result = result.replace(/^[\s]*[-*+]\s+/gm, '• ')

  // Ordered lists: strip number markers
  result = result.replace(/^[\s]*\d+\.\s+/gm, '')

  // HTML tags: strip simple tags
  result = result.replace(/<[^>]+>/g, '')

  // Collapse multiple blank lines into at most two
  result = result.replace(/\n{3,}/g, '\n\n')

  return result.trim()
}
