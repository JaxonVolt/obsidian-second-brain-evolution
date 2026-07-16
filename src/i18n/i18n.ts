/* eslint-disable simple-import-sort/imports */
/**
 * i18n - Internationalization service for Claudian
 *
 * Provides translation functionality for all UI strings.
 * Supports 10 locales with English as the default fallback.
 */

import * as zhCN from './locales/zh-CN.json';
import type { Locale, TranslationKey } from './types';

const translations: Partial<Record<Locale, typeof zhCN>> = {
  'zh-CN': zhCN,
};

const DEFAULT_LOCALE: Locale = 'zh-CN';
let currentLocale: Locale = DEFAULT_LOCALE;

/**
 * Get a translation by key with optional parameters
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const dict = translations[currentLocale] ?? zhCN;

  const keys = key.split('.');
  let value: any = dict;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return key;
    }
  }

  if (typeof value !== 'string') {
    return key;
  }

  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, param) => {
      return params[param]?.toString() ?? `{${param}}`;
    });
  }

  return value;
}

/**
 * Set the current locale
 * @returns true if locale was set successfully, false if locale is invalid
 */
export function setLocale(locale: Locale): boolean {
  if (!translations[locale]) {
    return false;
  }
  currentLocale = locale;
  return true;
}

/**
 * Get the current locale
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Get all available locales
 */
export function getAvailableLocales(): Locale[] {
  return ['zh-CN'];
}

/**
 * Get display name for a locale
 */
export function getLocaleDisplayName(locale: Locale): string {
  return locale === 'zh-CN' ? '简体中文' : locale;
}

