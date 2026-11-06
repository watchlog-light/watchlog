// SPDX-License-Identifier: AGPL-3.0-only
// Layout checks shared by the responsive suites of the site, the dashboard and the admin
// panel (each repository keeps its own copy of this file; keep them identical).
//
//   - no horizontal page scroll: the page is never wider than the viewport. Scrolling
//     inside an element (a code block, a table in its card) is allowed;
//   - text is never smaller than 12 px, except 11 px uppercase micro-labels (ADR-115);
//   - below 1024 px, touch targets are at least 44×44 px. Links inside running text are
//     exempt (WCAG 2.5.8 "inline"), and a checkbox or radio is measured by its label.
//     Content that scales with a zoom (a pinch-zoomable graph) can opt out with
//     data-layout-exempt="touch-target"; data-layout-exempt="none" opts back in.
import type { Page } from '@playwright/test';

export interface LayoutProblem {
  check: 'overflow' | 'text-size' | 'touch-target';
  detail: string;
}

/** Breakpoints every route is checked at. */
export const WIDTHS = [360, 390, 768, 1024, 1280] as const;
/** Viewports the screenshots are taken at. */
export const SHOTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

/** Viewport options for a width: phones and tablets get touch emulation. */
export const viewportFor = (width: number) => ({
  viewport: { width, height: width < 768 ? 844 : width < 1024 ? 1024 : 900 },
  hasTouch: width < 1024,
  isMobile: width < 768,
});

export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate(() => {
    const problems: { check: 'overflow' | 'text-size' | 'touch-target'; detail: string }[] = [];
    const vw = window.innerWidth;
    const describe = (el: Element) => {
      const h = el as HTMLElement;
      const id = h.id ? `#${h.id}` : '';
      const cls =
        typeof h.className === 'string' && h.className.trim()
          ? '.' + h.className.trim().split(/\s+/).slice(0, 3).join('.')
          : '';
      const text = (h.innerText || h.getAttribute('aria-label') || '').trim().slice(0, 40);
      return `<${el.tagName.toLowerCase()}${id}${cls}>${text ? ` "${text}"` : ''}`;
    };
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0)
        return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      // Inside a clipped 1 px box (sr-only): for screen readers, not for fingers.
      for (let p = el.parentElement; p; p = p.parentElement) {
        const b = p.getBoundingClientRect();
        if ((b.width <= 1 || b.height <= 1) && getComputedStyle(p).overflow !== 'visible')
          return false;
      }
      return true;
    };
    // 1. Horizontal page scroll: the document, and <main> where an app shell scrolls it
    // instead of the document.
    const scrollers: Element[] = [document.documentElement, ...document.querySelectorAll('main')];
    for (const root of scrollers) {
      const isDoc = root === document.documentElement;
      const width = isDoc ? vw : root.clientWidth;
      if (root.scrollWidth <= width + 1) continue;
      const edge = isDoc ? vw : root.getBoundingClientRect().left + root.clientWidth;
      const wide = [...root.querySelectorAll('*')]
        .filter((el) => visible(el))
        .filter((el) => {
          // Only content clipped by nothing between it and this scroller.
          for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== 'visible') return false;
          }
          return el.getBoundingClientRect().right > edge + 1;
        })
        .slice(0, 5)
        .map(describe);
      problems.push({
        check: 'overflow',
        detail: `${isDoc ? 'page' : '<main>'} is ${root.scrollWidth}px wide in ${width}px; wider: ${wide.join(', ') || '?'}`,
      });
    }

    // 2. Text size.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      if (!visible(el) || el.closest('svg, canvas, [aria-hidden="true"]')) continue;
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      const microLabel = Math.round(size) === 11 && s.textTransform === 'uppercase';
      if (size < 11.5 && !microLabel) {
        problems.push({ check: 'text-size', detail: `${size}px: ${describe(el)}` });
      }
    }

    // 3. Touch targets, below 1024 px.
    if (vw < 1024) {
      const targets = document.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"]',
      );
      for (const el of targets) {
        if (el.closest('[aria-hidden="true"], [inert]')) continue;
        if (
          el.closest('[data-layout-exempt]')?.getAttribute('data-layout-exempt') === 'touch-target'
        )
          continue;
        let box: Element = el;
        // A checkbox or radio is hit through its label (the input itself may be hidden).
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          box =
            el.closest('label') ??
            (el.id ? document.querySelector(`label[for="${el.id}"]`) : null) ??
            el;
        }
        if (!visible(box)) continue;
        // Links in running text are exempt.
        if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') {
          const parentText = (el.parentElement?.textContent ?? '').trim();
          if (parentText.length > (el.textContent ?? '').trim().length + 1) continue;
        }
        const r = box.getBoundingClientRect();
        // Off screen (inside a closed drawer or scrolled away horizontally): not tappable now.
        if (r.right <= 0 || r.left >= vw) continue;
        if (r.width < 43.5 || r.height < 43.5) {
          problems.push({
            check: 'touch-target',
            detail: `${Math.round(r.width)}×${Math.round(r.height)}: ${describe(el)}`,
          });
        }
      }
    }
    return problems;
  });
}

/** One readable failure message per page and width. */
export const report = (route: string, width: number, problems: LayoutProblem[]) =>
  `${route} at ${width}px:\n` + problems.map((p) => `  [${p.check}] ${p.detail}`).join('\n');
