/**
 * Nearest ancestor that actually scrolls.
 *
 * Views live inside `<main class="content">`, but Studio panes and popovers have
 * their own scrollers, so features that follow the scroll position (drag
 * auto-scroll, list windowing) must find the real one instead of assuming the
 * page.
 */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    const scrolls = /(auto|scroll|overlay)/.test(
      `${style.overflowY} ${style.overflow}`,
    );
    if (scrolls && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}
