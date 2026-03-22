import {
  P, A, Code, CodeBlock, Caption, Section, ComparisonTable,
  List, OL, Li, NavCard, NavGrid, SequenceDiagram, DemoVideo,
} from 'wechatbot-website/src/components/markdown'

export const mdxComponents = {
  p: P,
  a: ({ href, children }: { href?: string; children: React.ReactNode }) => <A href={href || '#'}>{children}</A>,
  pre: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const lang = className?.replace('language-', '')
    if (lang) return <CodeBlock lang={lang}>{String(children).replace(/\n$/, '')}</CodeBlock>
    return <Code>{children}</Code>
  },
  ul: List, ol: OL, li: Li,

  Section, CodeBlock, Caption, ComparisonTable, NavCard, NavGrid, SequenceDiagram, DemoVideo,
  P, A, Code, List, OL, Li,
}
