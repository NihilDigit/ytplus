declare const unsafeWindow: (Window & typeof globalThis) | undefined;

export function getPageWindow(): Window & typeof globalThis {
  if (typeof unsafeWindow !== "undefined" && unsafeWindow) {
    return unsafeWindow;
  }
  return window;
}

export interface ElementProps {
  id?: string;
  className?: string;
  text?: string;
  style?: Partial<CSSStyleDeclaration>;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  on?: {
    [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void;
  };
}

/**
 * Trusted-Types-safe DOM builder (never assigns raw innerHTML).
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElementProps,
  children?: Array<Node | string | null | undefined>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.id) node.id = props.id;
    if (props.className) node.className = props.className;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.style) {
      Object.assign(node.style, props.style);
    }
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        node.setAttribute(k, v);
      }
    }
    if (props.dataset) {
      for (const [k, v] of Object.entries(props.dataset)) {
        node.dataset[k] = v;
      }
    }
    if (props.on) {
      for (const [eventName, handler] of Object.entries(props.on)) {
        if (handler) {
          node.addEventListener(eventName, handler as EventListener);
        }
      }
    }
  }
  if (children) {
    for (const child of children) {
      if (child === null || child === undefined) continue;
      if (typeof child === "string") {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
  }
  return node;
}

export function clearChildren(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function upsertStyle(id: string, cssText: string): HTMLStyleElement {
  let styleEl = document.getElementById(id) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = id;
    (document.head || document.documentElement).appendChild(styleEl);
  }
  if (styleEl.textContent !== cssText) {
    styleEl.textContent = cssText;
  }
  return styleEl;
}

export function removeStyle(id: string): void {
  const existing = document.getElementById(id);
  if (existing) {
    existing.remove();
  }
}

export function formatTimeMs(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}
