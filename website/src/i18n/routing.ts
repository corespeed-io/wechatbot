import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'zh'],
  defaultLocale: 'zh',
})

export const localeNames: Record<string, string> = {
  en: 'English',
  zh: '中文',
}
