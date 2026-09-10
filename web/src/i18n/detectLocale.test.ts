import { describe, expect, it } from 'vitest';

import { detectLocale } from './index';

describe('detectLocale', () => {
  it('picks Simplified Chinese for the mainland and Singapore', () => {
    expect(detectLocale(['zh-CN'])).toBe('zh-Hans');
    expect(detectLocale(['zh'])).toBe('zh-Hans');
    expect(detectLocale(['zh-SG'])).toBe('zh-Hans');
  });

  it('picks Traditional Chinese for Taiwan, Hong Kong and Macau', () => {
    // Getting this backwards shows a Taiwanese reader simplified characters,
    // which is a worse outcome than showing them English.
    expect(detectLocale(['zh-TW'])).toBe('zh-Hant');
    expect(detectLocale(['zh-HK'])).toBe('zh-Hant');
    expect(detectLocale(['zh-MO'])).toBe('zh-Hant');
  });

  it('lets an explicit script subtag beat the region', () => {
    expect(detectLocale(['zh-Hant-HK'])).toBe('zh-Hant');
    expect(detectLocale(['zh-Hans-HK'])).toBe('zh-Hans');
    // A traditional-script tag with a mainland region is still traditional.
    expect(detectLocale(['zh-Hant-CN'])).toBe('zh-Hant');
  });

  it('is case- and separator-insensitive, as real browsers are not consistent', () => {
    expect(detectLocale(['ZH-tw'])).toBe('zh-Hant');
    expect(detectLocale(['zh_TW'])).toBe('zh-Hant');
    expect(detectLocale(['zh-HANT'])).toBe('zh-Hant');
  });

  it('takes the first language it recognises, in preference order', () => {
    expect(detectLocale(['fr-FR', 'zh-TW', 'en-US'])).toBe('zh-Hant');
    expect(detectLocale(['en-GB', 'zh-CN'])).toBe('en');
  });

  it('falls back to English for anything else', () => {
    expect(detectLocale(['de', 'fr'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('does not mistake an unrelated tag that merely starts with the letters', () => {
    // "zha" is Zhuang, not Chinese.
    expect(detectLocale(['zha'])).toBe('en');
  });
});
