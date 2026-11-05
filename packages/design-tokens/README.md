# @watchlog/design-tokens

Design tokens shared by `web/` and `site/` (SPEC §11, ADR-011).

- `tokens.css`: CSS custom properties from SPEC §11.1. This is the only file that contains colour values.
- `theme.css`: Tailwind v4 `@theme` that maps utilities (`bg-surface-1`, `text-text-muted`, `rounded-card`, `text-14` …) to the tokens. Tailwind's default palette is removed on purpose.
- `assets/`: brand logo (`logo.svg`, `logo.png`).

```css
@import 'tailwindcss';
@import '@watchlog/design-tokens/tokens.css';
@import '@watchlog/design-tokens/theme.css';
```
