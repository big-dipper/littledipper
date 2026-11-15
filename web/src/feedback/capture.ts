/**
 * A picture of what the owner is looking at, for feedback. Drawn from the page (html-to-image), not a real
 * screenshot, so there's no permission prompt; cropped to the visible part of the page. The feedback panel itself
 * is left out (anything marked data-feedback-widget).
 *
 * Private by default: before anything leaves the browser, the page's content is blurred on the image itself:
 * names, numbers, dates and every other value. Headings, buttons, labels and navigation stay sharp, so whoever
 * reads the feedback can still see where things are; anything marked data-private is blurred regardless. The owner
 * can choose to send it unblurred.
 */
import { toPng } from 'html-to-image';

/** Text that says where you are, not what's yours: kept sharp. Everything else with text in the main area is blurred. */
const KEEP = 'h1, h2, h3, .btn, label, th, nav, [role="tab"], [role="switch"], .kicker, .card-meta-label, [data-feedback-keep]';

function blurRects(root: Element): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    // Anything marked data-private (your name, address, Node ID) is always blurred, buttons included.
    if (!el || (el.closest(KEEP) && !el.closest('[data-private]')) || el.closest('[data-feedback-widget]')) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) rects.push(r);
  }
  // Form fields show values without text nodes.
  for (const el of root.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select, img')) {
    if (!el.closest('[data-feedback-widget]')) rects.push(el.getBoundingClientRect());
  }
  return rects;
}

function load(src: string) {
  return new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
}

/** The visible part of the page as a PNG data URL, at up to 2× for sharpness. */
export async function captureScreen(opts: { blur: boolean }): Promise<string> {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  // The page itself, and anything outside it marked data-private (the owner's name, address and Node ID in the sidebar).
  const roots = [document.querySelector('main') ?? document.body, ...[...document.querySelectorAll('[data-private]')].filter((e) => !e.closest('main'))];
  const rects = opts.blur ? roots.flatMap(blurRects) : [];
  // Icons paint with CSS variables (fill="var(--icon-fill)"), which the drawn copy can't resolve: pin the real colours
  // for the moment of capture, then put things back.
  const pinned = [...document.querySelectorAll<SVGElement>('svg [fill^="var("], svg [stroke^="var("]')].map((el) => {
    const was = el.getAttribute('style');
    const cs = getComputedStyle(el);
    el.style.fill = cs.fill; el.style.stroke = cs.stroke;
    return () => (was === null ? el.removeAttribute('style') : el.setAttribute('style', was));
  });
  let drawn: string;
  try {
    drawn = await toPng(document.body, {
      pixelRatio: ratio, cacheBust: true,
      filter: (node) => !(node instanceof Element && node.closest?.('[data-feedback-widget]')),
    });
  } finally { pinned.forEach((undo) => undo()); }
  const full = await load(drawn);
  const w = Math.round(window.innerWidth * ratio), h = Math.round(window.innerHeight * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(full, Math.round(window.scrollX * ratio), Math.round(window.scrollY * ratio), w, h, 0, 0, w, h);
  if (rects.length) {
    // Blur each value where it sits: redraw that patch through a blur filter, padded so no edge of a letter survives.
    const sharp = document.createElement('canvas');
    sharp.width = w; sharp.height = h;
    sharp.getContext('2d')!.drawImage(canvas, 0, 0);
    ctx.save();
    ctx.filter = `blur(${Math.round(7 * ratio)}px)`;
    for (const r of rects) {
      const pad = 4 * ratio;
      const x = Math.max(0, r.left * ratio - pad), y = Math.max(0, r.top * ratio - pad);
      const rw = Math.min(w - x, r.width * ratio + 2 * pad), rh = Math.min(h - y, r.height * ratio + 2 * pad);
      if (rw <= 0 || rh <= 0) continue;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, rw, rh); ctx.clip();
      ctx.drawImage(sharp, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
  return canvas.toDataURL('image/png');
}

/** Bytes a data URL decodes to, roughly, so the panel can keep big screenshots in check. */
export const dataUrlBytes = (d: string) => Math.round((d.length - d.indexOf(',') - 1) * 0.75);
