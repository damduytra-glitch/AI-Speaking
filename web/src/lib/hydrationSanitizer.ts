const EXTENSION_ATTRS = ['bis_skin_checked', 'bis_size', 'bis_id'] as const;

let activeObserver: MutationObserver | null = null;
let fallbackTimer: number | null = null;
let loadTimer: number | null = null;
let guardStopped = false;

function buildSelector(): string {
  return EXTENSION_ATTRS.map((attr) => `[${attr}]`).join(',');
}

function stripNodeAttrs(el: Element): void {
  for (const attr of EXTENSION_ATTRS) {
    if (el.hasAttribute(attr)) {
      el.removeAttribute(attr);
    }
  }
}

/**
 * Strip attributes injected onto SSR DOM nodes by browser extensions
 * (such as `bis_skin_checked="1"`) before React 19 hydrates.
 */
export function stripExtensionHydrationAttrs(): void {
  if (typeof document === 'undefined' || guardStopped) return;
  const nodes = document.querySelectorAll(buildSelector());
  for (let i = 0; i < nodes.length; i += 1) {
    stripNodeAttrs(nodes[i]);
  }
}

export function stopExtensionHydrationGuard(): void {
  guardStopped = true;
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }
  if (typeof window !== 'undefined') {
    if (fallbackTimer !== null) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (loadTimer !== null) {
      window.clearTimeout(loadTimer);
      loadTimer = null;
    }
  }
}

export function startPreHydrationExtensionGuard(): void {
  if (typeof document === 'undefined' || guardStopped) return;

  stripExtensionHydrationAttrs();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', stripExtensionHydrationAttrs, {
      once: true,
      capture: true,
    });
  }

  if (typeof MutationObserver === 'undefined' || activeObserver) return;

  let passCount = 0;
  const MAX_PASSES = 20;
  const selector = buildSelector();

  activeObserver = new MutationObserver((mutations) => {
    if (guardStopped) {
      stopExtensionHydrationGuard();
      return;
    }

    passCount += 1;
    if (passCount > MAX_PASSES) {
      stopExtensionHydrationGuard();
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof Element) {
        stripNodeAttrs(mutation.target);
      } else if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          stripNodeAttrs(node);
          const nested = node.querySelectorAll(selector);
          for (let i = 0; i < nested.length; i += 1) {
            stripNodeAttrs(nested[i]);
          }
        });
      }
    }
  });

  activeObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [...EXTENSION_ATTRS],
  });

  if (typeof window !== 'undefined') {
    const scheduleStopAfterLoad = () => {
      if (loadTimer !== null || guardStopped) return;
      loadTimer = window.setTimeout(stopExtensionHydrationGuard, 400);
    };

    if (document.readyState === 'complete') {
      scheduleStopAfterLoad();
    } else {
      window.addEventListener('load', scheduleStopAfterLoad, { once: true });
    }

    fallbackTimer = window.setTimeout(stopExtensionHydrationGuard, 2500);
  }
}
