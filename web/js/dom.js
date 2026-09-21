/** 极简 DOM 构建与局部更新工具。 */

/**
 * 创建元素。
 *   h('div', { class: 'x', onclick: fn }, [child, 'text'])
 */
export function h(tag, props = {}, children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  if (Array.isArray(children)) {
    for (const c of children) append(parent, c);
  } else if (children instanceof Node) {
    parent.appendChild(children);
  } else {
    parent.appendChild(document.createTextNode(String(children)));
  }
  return parent;
}

/** SVG 命名空间下的元素创建。 */
export function s(tag, props = {}, children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * 更新文本；若发生变化，顺带播放一次涨跌闪烁。
 * @param {HTMLElement} el
 * @param {string} next
 * @param {'up'|'down'|'flat'} [tone]
 */
export function setText(el, next, tone) {
  const prev = el.textContent;
  if (prev === next) return false;
  el.textContent = next;
  if (prev !== '' && tone && tone !== 'flat') {
    const cls = tone === 'up' ? 'flash-up' : 'flash-down';
    el.classList.remove('flash-up', 'flash-down');
    // 强制重排以重启动画
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 720);
  }
  return true;
}

/**
 * 更新依赖状态的 class：只有变化时才写，避免动画被打断。
 */
export function setClass(el, name, on) {
  if (on) el.classList.add(name);
  else el.classList.remove(name);
}

let toastTimer = null;
export function toast(message, ms = 2000) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, ms);
}

/** 把回调限制到每帧最多一次。 */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export function debounce(fn, ms = 220) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
