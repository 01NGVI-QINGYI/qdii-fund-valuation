/** 搜索框：联想、键盘导航、加入自选。 */

import { h, clear, $ } from '../dom.js';
import { api } from '../api.js';
import { addToWatch, inWatch } from '../store.js';

export function createSearch({ onAdd }) {
  const input = $('#search-input');
  const panel = $('#search-results');

  let results = [];
  let cursor = -1;
  let seq = 0;
  let timer = null;

  function close() {
    panel.hidden = true;
    cursor = -1;
    // 一并清空：否则隐藏的结果项还在 DOM 里，
    // 下一次搜索前的误点会命中上一轮的旧条目
    results = [];
    clear(panel);
  }

  function render() {
    clear(panel);
    if (!results.length) {
      panel.appendChild(h('div', { class: 'sr-empty' }, '没有匹配的基金'));
      panel.hidden = false;
      return;
    }
    results.forEach((r, i) => {
      const added = inWatch(r.code);
      const item = h('div', {
        class: `sr-item${i === cursor ? ' is-cursor' : ''}${added ? ' is-added' : ''}`,
        role: 'option',
        onclick: () => pick(r),
        onmouseenter: () => { cursor = i; paintCursor(); },
      }, [
        h('span', { class: 'sr-code' }, r.code),
        h('span', { class: 'sr-name' }, r.name || r.shortName || ''),
        h('span', { class: 'sr-meta' }, added ? '已添加' : (r.type || '')),
      ]);
      panel.appendChild(item);
    });
    panel.hidden = false;
  }

  function paintCursor() {
    [...panel.children].forEach((el, i) => {
      el.classList?.toggle('is-cursor', i === cursor);
    });
  }

  function pick(r) {
    if (!r) return;
    const res = addToWatch(r.code, r.name || r.shortName || '');
    close();
    input.value = '';
    onAdd(res.added ? `已添加 ${r.name || r.code}` : '该基金已在自选中');
  }

  async function run(q) {
    const my = ++seq;
    try {
      const data = await api.search(q);
      if (my !== seq) return;
      results = data.results || [];
      cursor = results.length ? 0 : -1;
      render();
    } catch {
      if (my !== seq) return;
      results = [];
      render();
    }
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (!q) return close();
    timer = setTimeout(() => run(q), 200);
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (panel.hidden) return;
      cursor = Math.min(cursor + 1, results.length - 1);
      paintCursor();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      paintCursor();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (!panel.hidden && results[cursor]) pick(results[cursor]);
      else if (/^\d{6}$/.test(input.value.trim())) {
        pick({ code: input.value.trim(), name: input.value.trim() });
      }
    } else if (ev.key === 'Escape') {
      input.value = '';
      close();
      input.blur();
    }
  });

  input.addEventListener('focus', () => {
    if (input.value.trim() && results.length) panel.hidden = false;
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#search')) close();
  });

  return {
    focus: () => input.focus(),
    isOpen: () => !panel.hidden,
    close,
  };
}
