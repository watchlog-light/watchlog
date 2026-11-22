// SPDX-License-Identifier: AGPL-3.0-only
// The dashboard's theme (ADR-228): the user's choice (System, Light or Dark) and the theme it
// resolves to. It sets `data-theme` on <html> (tokens.css's light block keys on it), follows
// the computer's setting live while the choice is System, and keeps the choice in this
// browser (`watchlog.theme`) and on the user, whose saved value wins when the session loads.
// index.html's inline script sets the same attribute before the first paint.
import { computed, ref, watch, type Ref } from 'vue';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const THEME_KEY = 'watchlog.theme';

const isChoice = (v: unknown): v is ThemeChoice =>
  typeof v === 'string' && (THEME_CHOICES as readonly string[]).includes(v);

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isChoice(v) ? v : 'system';
  } catch {
    return 'system';
  }
}
function store(c: ThemeChoice) {
  try {
    localStorage.setItem(THEME_KEY, c);
  } catch {
    // Private windows: the choice lasts for this visit (and is on the user).
  }
}

const query =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

const choice = ref<ThemeChoice>(stored());
const systemDark = ref(query ? query.matches : true);
const resolved = computed<ResolvedTheme>(() =>
  choice.value === 'system' ? (systemDark.value ? 'dark' : 'light') : choice.value,
);

const onSystemChange = (e: MediaQueryListEvent) => (systemDark.value = e.matches);
let listening = false;
/** The computer's setting is followed only while the choice is System. */
function listen(on: boolean) {
  if (!query || on === listening) return;
  if (on) query.addEventListener('change', onSystemChange);
  else query.removeEventListener('change', onSystemChange);
  listening = on;
  if (on) systemDark.value = query.matches;
}

watch(choice, (c) => listen(c === 'system'), { immediate: true });
watch(
  resolved,
  (t) => {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = t;
  },
  { immediate: true },
);

/** Picks a theme here (and in this browser); saving it on the user is the caller's. */
function setChoice(c: ThemeChoice) {
  if (!isChoice(c)) return;
  choice.value = c;
  store(c);
}

export function useTheme(): {
  choice: Ref<ThemeChoice>;
  resolved: Ref<ResolvedTheme>;
  setChoice: (c: ThemeChoice) => void;
} {
  return { choice, resolved, setChoice };
}
