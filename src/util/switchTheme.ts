import { getGlobal } from '../global';

import type { AppTheme, Theme } from '../global/types';

import { IS_TELEGRAM_APP } from '../config';
import { requestMeasure } from '../lib/fasterdom/fasterdom';
import cssColorToHex from './cssColorToHex';
import { getTelegramApp, getTelegramAppAsync, isInsideTelegram } from './telegram';

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
let currentTheme: Theme;
const appThemeChangeListeners = new Set<NoneToVoidFunction>();

export default function switchTheme(theme: Theme) {
  currentTheme = theme;

  setThemeValue();
  setStatusBarStyle();
  setThemeColor();
  notifyAppThemeChange();
}

function setThemeValue() {
  const isDarkTheme = resolveAppTheme(currentTheme) === 'dark';

  document.documentElement.classList.toggle('theme-dark', isDarkTheme);
}

export function resolveAppTheme(theme: Theme): AppTheme {
  if (theme !== 'system') return theme;

  const telegramApp = getTelegramApp();
  if (IS_TELEGRAM_APP && isInsideTelegram() && telegramApp?.colorScheme) {
    return telegramApp.colorScheme;
  }

  return prefersDark.matches ? 'dark' : 'light';
}

export function subscribeToAppThemeChange(listener: NoneToVoidFunction) {
  appThemeChangeListeners.add(listener);

  return () => {
    appThemeChangeListeners.delete(listener);
  };
}

function notifyAppThemeChange() {
  appThemeChangeListeners.forEach((listener) => listener());
}

function handlePrefersColorSchemeChange() {
  if (currentTheme !== 'system') return;

  setThemeValue();
  setStatusBarStyle();
  setThemeColor();
  notifyAppThemeChange();
}

function setThemeColor() {
  requestMeasure(() => {
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-background-second');

    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', color);
  });
}

export function setStatusBarStyle() {
  if (!IS_TELEGRAM_APP) return;

  requestMeasure(() => {
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-background-second');
    if (!color) return;

    const hexColor = cssColorToHex(color) as `#${string}`;

    getTelegramApp()?.setHeaderColor(hexColor);
    getTelegramApp()?.setBackgroundColor(hexColor);
    getTelegramApp()?.setBottomBarColor(hexColor);
  });
}

prefersDark.addEventListener('change', handlePrefersColorSchemeChange);

if (IS_TELEGRAM_APP) {
  void getTelegramAppAsync().then((telegramApp) => {
    telegramApp!.onEvent('themeChanged', onThemeChanged);
  });
}

export function unsubscribeOnTelegramThemeChange() {
  getTelegramApp()?.offEvent('themeChanged', onThemeChanged);
}

function onThemeChanged() {
  if (getGlobal().settings.theme === 'system') {
    handlePrefersColorSchemeChange();
  }
}
