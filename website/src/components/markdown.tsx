'use client'

import { useEffect, useRef, useState } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-toml'

Prism.languages.diagram = {
  'box-drawing': /[┌┐└┘├┤┬┴┼─│═║╔╗╚╝╠╣╦╩╬╭╮╯╰┊┈╌┄╶╴╵╷]+/,
  'line-char': /[-_|<>→←↓↑▼▲►◄]+/,
  'label': /[^\s┌┐└┘├┤┬┴┼─│═║╔╗╚╝╠╣╦╩╬╭╮╯╰┊┈╌┄╶╴╵╷\-_|<>→←↓↑▼▲►◄]+/,
}

Prism.languages.mermaid = {
  keyword: /\b(sequenceDiagram|participant|Note|loop|alt|else|end|opt|rect|activate|deactivate)\b/,
  label: /\b(over|as|right of|left of)\b/,
  arrow: /[-]+>>?|-->>?|[-]+\)|--\)/,
  string: /"[^"]*"/,
  comment: /%%[^\n]*/,
  punctuation: /[;:]/,
}

/* ── Active TOC tracking ──────────────────────────────────────────── */

function useActiveTocId() {
  const [activeId, setActiveId] = useState('')
  useEffect(() => {
    const headings = document.querySelectorAll<HTMLElement>('h1[id]')
    if (headings.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible: string[] = []
        entries.forEach((e) => { if (e.isIntersecting && e.target.id) visible.push(e.target.id) })
        if (visible.length > 0) {
          const sorted = visible.sort((a, b) => {
            const elA = document.getElementById(a), elB = document.getElementById(b)
            if (!elA || !elB) return 0
            return elA.getBoundingClientRect().top - elB.getBoundingClientRect().top
          })
          setActiveId(sorted[sorted.length - 1])
        }
      },
      { rootMargin: '-80px 0px -75% 0px', threshold: 0 },
    )
    headings.forEach((h) => observer.observe(h))
    return () => observer.disconnect()
  }, [])
  return activeId
}

/* ── Page nav config ──────────────────────────────────────────────── */

const PAGE_NAV_EN = [
  { slug: undefined, label: 'Overview', icon: '📦' },
  { slug: 'protocol', label: 'Protocol', icon: '📡' },
  { slug: 'nodejs', label: 'Node.js', icon: '🟢' },
  { slug: 'python', label: 'Python', icon: '🐍' },
  { slug: 'golang', label: 'Go', icon: '🔵' },
  { slug: 'rust', label: 'Rust', icon: '🦀' },
  { slug: 'pi-agent', label: 'Pi Agent', icon: '🤖' },
] as const

const PAGE_NAV_ZH = [
  { slug: undefined, label: '概览', icon: '📦' },
  { slug: 'protocol', label: '协议', icon: '📡' },
  { slug: 'nodejs', label: 'Node.js', icon: '🟢' },
  { slug: 'python', label: 'Python', icon: '🐍' },
  { slug: 'golang', label: 'Go', icon: '🔵' },
  { slug: 'rust', label: 'Rust', icon: '🦀' },
  { slug: 'pi-agent', label: 'Pi Agent', icon: '🤖' },
] as const

const LOCALE_NAMES: Record<string, string> = { en: 'English', zh: '中文' }
const ALL_LOCALES = ['en', 'zh']

/* ══════════════════════════════════════════════════════════════════════
   Header — sticky top bar with logo + locale switcher
   ══════════════════════════════════════════════════════════════════════ */

export function SiteHeader({ locale, currentSlug }: { locale: string; currentSlug?: string }) {
  const otherLocale = locale === 'zh' ? 'en' : 'zh'
  const switchHref = currentSlug ? `/${otherLocale}/${currentSlug}` : `/${otherLocale}`

  return (
    <header style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50,
      height: '44px', display: 'flex', alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)', borderBottom: '1px solid var(--divider)',
    }}>
      <div style={{
        width: '550px', maxWidth: 'calc(100% - 2rem)', padding: '0 1rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        {/* Logo */}
        <a href={`/${locale}`} style={{
          fontFamily: 'var(--font-primary)', fontSize: '13px', fontWeight: 700,
          color: 'var(--text-primary)', textDecoration: 'none',
          letterSpacing: '-0.04px',
        }}>
          wechatbot
        </a>

        {/* Right: locale switcher */}
        <a href={switchHref} style={{
          fontFamily: 'var(--font-primary)', fontSize: '12px', fontWeight: 475,
          color: 'var(--text-secondary)', textDecoration: 'none',
          padding: '4px 10px', borderRadius: '6px',
          border: '1px solid var(--divider)', transition: 'all 0.15s ease',
        }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--text-secondary)'
            e.currentTarget.style.color = 'var(--text-primary)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--divider)'
            e.currentTarget.style.color = 'var(--text-secondary)'
          }}
        >
          {LOCALE_NAMES[otherLocale]}
        </a>
      </div>
    </header>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Sidebar TOC
   ══════════════════════════════════════════════════════════════════════ */

export function TableOfContents({
  items, locale, currentSlug,
}: {
  items: Array<{ label: string; href: string }>
  locale?: string; currentSlug?: string
}) {
  const activeId = useActiveTocId()
  const currentLocale = locale ?? 'en'
  const pageNav = currentLocale === 'zh' ? PAGE_NAV_ZH : PAGE_NAV_EN

  return (
    <aside className='fixed top-[56px] hidden lg:block'
      style={{ left: 'max(1rem, calc((100vw - 550px) / 2 - 220px))', width: '148px' }}
    >
      <nav>
        {/* Page nav */}
        {pageNav.map((page) => {
          const isActive = page.slug === currentSlug
          const href = page.slug ? `/${currentLocale}/${page.slug}` : `/${currentLocale}`
          return (
            <a key={page.slug ?? 'home'} href={href} className='block no-underline'
              style={{
                fontSize: '12px', fontWeight: isActive ? 600 : 475, lineHeight: '16px',
                letterSpacing: '-0.04px', padding: '4px 0',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontFamily: 'var(--font-primary)', transition: 'color 0.15s ease',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = 'var(--text-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
            >
              {page.icon} {page.label}
            </a>
          )
        })}

        {/* Section TOC divider */}
        {items.length > 0 && (
          <div style={{ height: '1px', background: 'var(--divider)', margin: '10px 0 8px' }} />
        )}

        {/* Section TOC */}
        {items.map((item) => {
          const isActive = `#${activeId}` === item.href
          const color = isActive ? 'var(--text-primary)' : 'var(--text-secondary)'
          return (
            <a key={item.href} href={item.href} className='block no-underline'
              style={{
                fontSize: '11px', fontWeight: 475, lineHeight: '14px', letterSpacing: '-0.04px',
                padding: '3px 0', color, fontFamily: 'var(--font-primary)', transition: 'color 0.15s ease',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.color = 'var(--text-hover)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = color }}
            >
              {item.label}
            </a>
          )
        })}
      </nav>
    </aside>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Typography
   ══════════════════════════════════════════════════════════════════════ */

export function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h1 id={id} className='scroll-mt-[5.25rem]' style={{
      fontFamily: 'var(--font-primary)', fontSize: '14px', fontWeight: 560,
      lineHeight: '20px', letterSpacing: '-0.09px', color: 'var(--text-primary)',
      margin: 0, padding: 0, display: 'flex', alignItems: 'center', gap: '12px',
      paddingTop: '24px', paddingBottom: '24px',
    }}>
      <span style={{ whiteSpace: 'nowrap' }}>{children}</span>
      <span style={{ flex: 1, height: '1px', background: 'var(--divider)' }} />
    </h1>
  )
}

export function P({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`editorial-prose ${className}`} style={{
      fontFamily: 'var(--font-primary)', fontSize: '14px', fontWeight: 475,
      lineHeight: '22px', letterSpacing: '-0.09px', color: 'var(--text-primary)', opacity: 0.82, margin: 0,
    }}>{children}</p>
  )
}

export function Caption({ children }: { children: React.ReactNode }) {
  return <p style={{
    fontFamily: 'var(--font-primary)', fontSize: '12px', fontWeight: 475,
    textAlign: 'center', lineHeight: '20px', letterSpacing: '-0.09px',
    color: 'var(--text-secondary)', margin: 0,
  }}>{children}</p>
}

export function A({ href, children }: { href: string; children: React.ReactNode }) {
  const isAnchor = href.startsWith('#')
  return <a href={href} target={isAnchor ? undefined : '_blank'}
    rel={isAnchor ? undefined : 'noopener noreferrer'}
    style={{ color: 'var(--link-accent, #0969da)', fontWeight: 600, textDecoration: 'none' }}
    onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
    onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}
  >{children}</a>
}

export function Code({ children }: { children: React.ReactNode }) {
  return <code className='inline-code'>{children}</code>
}

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (<><SectionHeading id={id}>{title}</SectionHeading>{children}</>)
}

export function OL({ children }: { children: React.ReactNode }) {
  return <ol className='m-0 pl-5' style={{
    fontFamily: 'var(--font-primary)', fontSize: '14px', fontWeight: 475,
    lineHeight: '20px', letterSpacing: '-0.09px', color: 'var(--text-primary)', listStyleType: 'decimal',
  }}>{children}</ol>
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className='m-0 pl-5' style={{
    fontFamily: 'var(--font-primary)', fontSize: '14px', fontWeight: 475,
    lineHeight: '20px', letterSpacing: '-0.09px', color: 'var(--text-primary)', listStyleType: 'disc',
  }}>{children}</ul>
}

export function Li({ children }: { children: React.ReactNode }) {
  return <li style={{ padding: '0 0 8px 12px' }}>{children}</li>
}

/* ══════════════════════════════════════════════════════════════════════
   CodeBlock
   ══════════════════════════════════════════════════════════════════════ */

export function CodeBlock({
  children, lang = 'jsx', lineHeight = '1.85', showLineNumbers = true,
}: { children: string; lang?: string; lineHeight?: string; showLineNumbers?: boolean }) {
  const codeRef = useRef<HTMLElement>(null)
  const content = typeof children === 'string' ? children : String(children)
  const lines = content.split('\n')
  useEffect(() => { if (codeRef.current && lang) Prism.highlightElement(codeRef.current) }, [content, lang])

  return (
    <figure className='m-0 bleed'>
      <div className='relative'>
        <pre className='overflow-x-auto' style={{ borderRadius: '8px', margin: 0, padding: 0 }}>
          <div className='flex' style={{
            padding: '12px 8px 8px', fontFamily: 'var(--font-code)', fontSize: '12px',
            fontWeight: 400, lineHeight, letterSpacing: 'normal', color: 'var(--text-primary)', tabSize: 2,
          }}>
            {showLineNumbers && (
              <span className='select-none shrink-0' aria-hidden='true' style={{
                color: 'var(--code-line-nr)', textAlign: 'right', paddingRight: '20px', width: '36px', userSelect: 'none',
              }}>
                {lines.map((_, i) => <span key={i} className='block'>{i + 1}</span>)}
              </span>
            )}
            <code ref={codeRef} className={lang ? `language-${lang}` : undefined}
              style={{ whiteSpace: 'pre', background: 'none', padding: 0, lineHeight }}
            >{content}</code>
          </div>
        </pre>
      </div>
    </figure>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   ComparisonTable
   ══════════════════════════════════════════════════════════════════════ */

export function ComparisonTable({ title, headers, rows }: {
  title?: string; headers: [string, string, string]; rows: Array<[string, string, string]>
}) {
  if (!headers || !rows) return null
  const cs = { padding: '4.8px 12px 4.8px 0', fontSize: '11px', fontWeight: 500,
    fontFamily: 'var(--font-code)', color: 'var(--text-primary)', borderBottom: '1px solid var(--page-border)' }
  return (
    <div className='w-full max-w-full overflow-x-auto' style={{ padding: '8px 0' }}>
      {title && <div style={{ fontFamily: 'var(--font-primary)', fontSize: '11px', fontWeight: 400,
        color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em', padding: '0 0 6px' }}>{title}</div>}
      <table className='w-full' style={{ borderSpacing: 0, borderCollapse: 'collapse' }}>
        <thead><tr>{headers.map((h) => <th key={h} className='text-left' style={{
          ...cs, fontWeight: 400, fontFamily: 'var(--font-primary)', color: 'var(--text-muted)'
        } as React.CSSProperties}>{h}</th>)}</tr></thead>
        <tbody>{rows.map(([f, t, u]) => <tr key={f}>
          <td style={{ ...cs, whiteSpace: 'nowrap' } as React.CSSProperties}>{f}</td>
          <td style={{ ...cs, whiteSpace: 'nowrap' } as React.CSSProperties}>{t}</td>
          <td style={cs as React.CSSProperties}>{u}</td>
        </tr>)}</tbody>
      </table>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   NavCard + NavGrid (homepage)
   ══════════════════════════════════════════════════════════════════════ */

export function NavCard({ href, icon, title, description }: {
  href: string; icon: string; title: string; description: string
}) {
  return (
    <a href={href} className='block no-underline' style={{
      border: '1px solid var(--page-border)', borderRadius: '8px', padding: '16px 20px',
      transition: 'border-color 0.15s ease, background 0.15s ease',
    }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--text-secondary)'; e.currentTarget.style.background = 'var(--code-bg)' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--page-border)'; e.currentTarget.style.background = 'transparent' }}
    >
      <div style={{ fontSize: '20px', marginBottom: '8px' }}>{icon}</div>
      <div style={{ fontFamily: 'var(--font-primary)', fontSize: '14px', fontWeight: 600,
        color: 'var(--text-primary)', marginBottom: '4px' }}>{title}</div>
      <div style={{ fontFamily: 'var(--font-primary)', fontSize: '12px', fontWeight: 475,
        color: 'var(--text-secondary)', lineHeight: '18px' }}>{description}</div>
    </a>
  )
}

export function NavGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', padding: '4px 0' }}>{children}</div>
}

/* ══════════════════════════════════════════════════════════════════════
   Mermaid-style sequence diagram (rendered as styled ASCII)
   ══════════════════════════════════════════════════════════════════════ */

export function SequenceDiagram({ children }: { children: string }) {
  return <CodeBlock lang="mermaid" lineHeight="1.6" showLineNumbers={false}>{children}</CodeBlock>
}

/* ══════════════════════════════════════════════════════════════════════
   DemoVideo — hero video player
   ══════════════════════════════════════════════════════════════════════ */

export function DemoVideo({ src, caption }: { src: string; caption?: string }) {
  return (
    <figure className='m-0 bleed' style={{ padding: '4px 0' }}>
      <video
        src={src}
        controls
        playsInline
        muted
        autoPlay
        loop
        preload='metadata'
        style={{
          width: '100%',
          borderRadius: '8px',
          border: '1px solid var(--divider)',
          background: '#000',
        }}
      />
      {caption && <Caption>{caption}</Caption>}
    </figure>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   EditorialPage — shell with header + sidebar + content
   ══════════════════════════════════════════════════════════════════════ */

export function EditorialPage({
  toc, logo, locale, currentSlug, children,
}: {
  toc: Array<{ label: string; href: string }>; logo?: string
  locale?: string; currentSlug?: string; children: React.ReactNode
}) {
  return (
    <div className='editorial-page relative min-h-screen overflow-x-hidden' style={{
      background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'var(--font-primary)',
      WebkitFontSmoothing: 'antialiased', textRendering: 'optimizeLegibility',
    }}>
      <SiteHeader locale={locale ?? 'en'} currentSlug={currentSlug} />
      <TableOfContents items={toc} locale={locale} currentSlug={currentSlug} />
      <div className='mx-auto' style={{ width: '550px', maxWidth: 'calc(100% - 2rem)', padding: '0 1rem 6rem' }}>
        <div style={{ height: '56px' }} />
        <article className='editorial-article flex flex-col gap-[32px]'>{children}</article>
      </div>
    </div>
  )
}
