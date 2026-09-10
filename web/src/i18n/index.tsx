import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { en } from './en';
import { zhHans } from './zh-Hans';
import { zhHant } from './zh-Hant';

export type Locale = 'en' | 'zh-Hans' | 'zh-Hant';

/** English is the source of truth; the other dictionaries must match its keys. */
export type TranslationKey = keyof typeof en;

export const LOCALES: Array<{ id: Locale; label: string; english: string }> = [
  { id: 'en', label: 'English', english: 'English' },
  { id: 'zh-Hans', label: '简体中文', english: 'Simplified Chinese' },
  { id: 'zh-Hant', label: '繁體中文', english: 'Traditional Chinese' }
];

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = {
  en,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant
};

const STORAGE_KEY = 'haro.locale';

/**
 * Work out which language to open in, from the browser's own preference list.
 *
 * Chinese is the case that needs care: `zh-TW`, `zh-HK` and `zh-MO` are
 * traditional, a bare `zh` or `zh-CN` is simplified, and a script subtag
 * (`zh-Hant-HK`) beats the region when both are present. Getting this wrong
 * shows a Taiwanese reader simplified characters, which is worse than showing
 * them English.
 */
export function detectLocale(languages: readonly string[]): Locale {
  for (const raw of languages) {
    const tag = raw.toLowerCase();
    if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) {
      if (tag.includes('hant')) return 'zh-Hant';
      if (tag.includes('hans')) return 'zh-Hans';
      // Region as a fallback signal when no script subtag is given.
      return /\b(tw|hk|mo)\b/.test(tag.replace(/[-_]/g, ' ')) ? 'zh-Hant' : 'zh-Hans';
    }
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale.id === value);
}

/** A stored choice wins over the browser's; neither is required. */
function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Private mode and blocked site data both throw here rather than returning
    // null, and neither is a reason to fail to render.
  }
  return detectLocale(navigator.languages ?? [navigator.language]);
}

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    // Screen readers, font selection and CJK line breaking all key off this.
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies to this tab; it just will not be remembered.
    }
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => {
      // Fall back through English rather than rendering a raw key: a missing
      // translation should read as untranslated, not as broken.
      const template = DICTIONARIES[locale][key] ?? en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match
      );
    },
    [locale]
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

/** The common case: just the translate function. */
export function useT(): Translate {
  return useI18n().t;
}

/**
 * A "2 hours ago" formatter bound to the current language.
 *
 * `Intl.RelativeTimeFormat` knows the grammar of every locale it supports, so
 * this needs no translated strings of its own and gets plurals, spacing and
 * word order right in languages nobody here speaks.
 */
export function useRelativeTime(): (value: string | number) => string {
  const { locale } = useI18n();
  return useMemo(() => {
    const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
    const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ['second', 60],
      ['minute', 60],
      ['hour', 24],
      ['day', 30],
      ['month', 12],
      ['year', Infinity]
    ];

    return (value: string | number) => {
      const time = typeof value === 'number' ? value : new Date(value).getTime();
      let delta = Math.round((time - Date.now()) / 1000);

      for (const [unit, span] of UNITS) {
        if (Math.abs(delta) < span) return formatter.format(delta, unit);
        delta = Math.round(delta / span);
      }
      return formatter.format(delta, 'year');
    };
  }, [locale]);
}

/**
 * Locale tag for `Intl` and `toLocaleDateString`.
 *
 * Our own ids are close but not identical to BCP-47 region tags, and dates
 * read better with a region than with a bare script.
 */
export function intlLocale(locale: Locale): string {
  return locale === 'zh-Hans' ? 'zh-CN' : locale === 'zh-Hant' ? 'zh-TW' : 'en';
}
