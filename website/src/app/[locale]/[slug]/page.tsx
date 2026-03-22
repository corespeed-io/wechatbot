import fs from 'node:fs'
import path from 'node:path'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import matter from 'gray-matter'
import { MDXRemote } from 'next-mdx-remote/rsc'
import { routing } from 'wechatbot-website/src/i18n/routing'
import { EditorialPage } from 'wechatbot-website/src/components/markdown'
import { mdxComponents } from 'wechatbot-website/src/components/mdx-components'

const VALID_SLUGS = ['protocol', 'nodejs', 'python', 'golang', 'rust', 'pi-agent']

interface ContentFrontmatter {
  title: string
  description: string
  toc: Array<{ label: string; href: string }>
}

export function generateStaticParams() {
  const params: Array<{ locale: string; slug: string }> = []
  for (const locale of routing.locales) {
    for (const slug of VALID_SLUGS) {
      params.push({ locale, slug })
    }
  }
  return params
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>
}): Promise<Metadata> {
  const { locale, slug } = await params
  const result = loadContent(locale, slug)
  if (!result) return {}

  const { title, description } = result.data
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `https://wechatbot.corespeed.io/${locale}/${slug}`,
      siteName: 'WeChatBot',
      images: [
        {
          url: 'https://opengraph.githubassets.com/1/corespeed-io/wechatbot',
          width: 1200,
          height: 600,
          alt: title,
        },
      ],
      locale: locale === 'zh' ? 'zh_CN' : 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ['https://opengraph.githubassets.com/1/corespeed-io/wechatbot'],
    },
  }
}

function loadContent(locale: string, slug: string): { content: string; data: ContentFrontmatter } | null {
  if (!VALID_SLUGS.includes(slug)) return null

  const filePath = path.join(process.cwd(), 'content', locale, `${slug}.mdx`)
  if (!fs.existsSync(filePath)) {
    // Fallback to English
    const fallback = path.join(process.cwd(), 'content', 'en', `${slug}.mdx`)
    if (!fs.existsSync(fallback)) return null
    const raw = fs.readFileSync(fallback, 'utf-8')
    const { content, data } = matter(raw)
    return { content, data: data as ContentFrontmatter }
  }

  const raw = fs.readFileSync(filePath, 'utf-8')
  const { content, data } = matter(raw)
  return { content, data: data as ContentFrontmatter }
}

export default async function SlugPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>
}) {
  const { locale, slug } = await params

  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) notFound()
  if (!VALID_SLUGS.includes(slug)) notFound()

  const result = loadContent(locale, slug)
  if (!result) notFound()

  const { content, data } = result

  return (
    <EditorialPage toc={data.toc} logo='wechatbot' locale={locale} currentSlug={slug}>
      <MDXRemote source={content} components={mdxComponents} options={{ blockJS: false }} />
    </EditorialPage>
  )
}
