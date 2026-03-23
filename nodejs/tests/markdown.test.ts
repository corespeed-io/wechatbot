import { describe, it, expect } from 'vitest'
import { stripMarkdown } from '../src/media/markdown.js'

describe('stripMarkdown', () => {
  it('strips headers', () => {
    expect(stripMarkdown('# Title')).toBe('Title')
    expect(stripMarkdown('## Subtitle')).toBe('Subtitle')
    expect(stripMarkdown('### H3')).toBe('H3')
  })

  it('strips bold and italic', () => {
    expect(stripMarkdown('**bold**')).toBe('bold')
    expect(stripMarkdown('*italic*')).toBe('italic')
    expect(stripMarkdown('***both***')).toBe('both')
    expect(stripMarkdown('__bold__')).toBe('bold')
    expect(stripMarkdown('_italic_')).toBe('italic')
  })

  it('strips inline code', () => {
    expect(stripMarkdown('use `console.log`')).toBe('use console.log')
  })

  it('strips code blocks', () => {
    const input = '```javascript\nconst x = 1\n```'
    expect(stripMarkdown(input)).toBe('const x = 1')
  })

  it('removes images', () => {
    expect(stripMarkdown('![alt](http://img.png)')).toBe('')
  })

  it('keeps link text, removes URL', () => {
    expect(stripMarkdown('[click here](http://example.com)')).toBe('click here')
  })

  it('strips blockquotes', () => {
    expect(stripMarkdown('> quoted text')).toBe('quoted text')
  })

  it('strips strikethrough', () => {
    expect(stripMarkdown('~~deleted~~')).toBe('deleted')
  })

  it('handles horizontal rules', () => {
    expect(stripMarkdown('---')).toBe('')
    expect(stripMarkdown('***')).toBe('')
  })

  it('strips HTML tags', () => {
    expect(stripMarkdown('<strong>bold</strong>')).toBe('bold')
  })

  it('handles complex mixed markdown', () => {
    const input = `# Hello

Here is **bold** and *italic* text.

\`\`\`python
print("hello")
\`\`\`

Check [this link](http://example.com) for more.`

    const result = stripMarkdown(input)
    expect(result).toContain('Hello')
    expect(result).toContain('bold')
    expect(result).toContain('italic')
    expect(result).toContain('print("hello")')
    expect(result).toContain('this link')
    expect(result).not.toContain('**')
    expect(result).not.toContain('```')
    expect(result).not.toContain('http://example.com')
  })

  it('collapses multiple blank lines', () => {
    expect(stripMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb')
  })

  it('converts unordered list markers', () => {
    expect(stripMarkdown('- item 1\n- item 2')).toBe('• item 1\n• item 2')
  })

  it('strips ordered list markers', () => {
    expect(stripMarkdown('1. first\n2. second')).toBe('first\nsecond')
  })
})
