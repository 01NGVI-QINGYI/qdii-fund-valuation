/** 选基面板：内置基金池 + 星标增删自选。 */

import { h, s, clear, setText, setClass, toast } from '../dom.js';
import { FUND_CATALOG, CATALOG_FIXES } from '../catalog.js';
import { inWatch, addToWatch, removeFromWatch, resetWatch } from '../store.js';

function starButton(code, name, onToggle) {
  const btn = h('button', {
    class: 'star',
    type: 'button',
    onclick: (ev) => {
      ev.stopPropagation();
      onToggle(code, name, btn);
    },
  }, s('svg', { viewBox: '0 0 16 16' }, [
    s('path', { d: 'M8 2.2l1.75 3.7 3.95.53-2.9 2.77.72 3.98L8 11.28 4.48 13.2l.72-3.98-2.9-2.77 3.95-.53z' }),
  ]));
  paintStar(btn, inWatch(code));
  return btn;
}

function paintStar(btn, on) {
  setClass(btn, 'is-on', on);
  btn.title = on ? '已加入自选，点击移出' : '点击加入自选';
  btn.setAttribute('aria-label', on ? '移出自选' : '加入自选');
}

export function createPicker({ onChanged }) {
  const modal = document.getElementById('picker');
  const listEl = document.getElementById('picker-list');
  const countEl = document.getElementById('picker-count');
  const searchEl = document.getElementById('picker-search');

  let filter = '';

  const toggle = (code, name, btn) => {
    if (inWatch(code)) {
      removeFromWatch(code);
      paintStar(btn, false);
      toast(`已移出 ${name || code}`);
    } else {
      addToWatch(code, name || '');
      paintStar(btn, true);
      toast(`已加入 ${name || code}`);
    }
    updateCount();
    onChanged?.();
  };

  function updateCount() {
    const total = FUND_CATALOG.reduce((n, f) => n + f.classes.length, 0);
    const on = FUND_CATALOG.reduce(
      (n, f) => n + f.classes.filter((c) => inWatch(c.code)).length,
      0,
    );
    setText(countEl, `${on} / ${total}`, null);
  }

  function render() {
    clear(listEl);
    const q = filter.trim().toLowerCase();

    for (const fund of FUND_CATALOG) {
      const hit = !q
        || fund.short.toLowerCase().includes(q)
        || fund.classes.some((c) => c.code.includes(q) || c.name.toLowerCase().includes(q));
      if (!hit) continue;

      const rows = fund.classes.map((c) => h('div', { class: 'pk-class' }, [
        h('span', { class: `pk-cls pk-${c.cls}` }, `${c.cls} 类`),
        h('span', { class: 'pk-code num' }, c.code),
        h('span', { class: 'pk-name' }, c.name),
        starButton(c.code, c.name, (code, name, btn) => toggle(code, name, btn)),
      ]));

      listEl.appendChild(h('div', { class: 'pk-fund' }, [
        h('div', { class: 'pk-head' }, [
          h('span', { class: 'pk-index num' }, String(fund.index).padStart(2, '0')),
          h('span', { class: 'pk-short' }, fund.short),
          fund.note
            ? h('span', { class: 'pk-fixed', title: `已按基金名称校正代码：${fund.note}` }, '已校正')
            : null,
        ]),
        ...rows,
      ]));
    }

    if (!listEl.children.length) {
      listEl.appendChild(h('div', { class: 'sr-empty' }, '没有匹配的基金'));
    }
    updateCount();
  }

  const open = () => {
    filter = '';
    searchEl.value = '';
    render();
    renderFixNote();
    modal.hidden = false;
    searchEl.focus();
  };
  const close = () => { modal.hidden = true; };

  searchEl.addEventListener('input', () => {
    filter = searchEl.value;
    render();
  });

  document.getElementById('picker-all').addEventListener('click', () => {
    let n = 0;
    for (const f of FUND_CATALOG) {
      for (const c of f.classes) {
        if (!inWatch(c.code)) { addToWatch(c.code, c.name); n++; }
      }
    }
    render();
    onChanged?.();
    toast(n ? `已加入 ${n} 只` : '全部已在自选中');
  });

  document.getElementById('picker-none').addEventListener('click', () => {
    resetWatch();
    render();
    onChanged?.();
    toast('已恢复默认预设');
  });

  document.getElementById('picker-close').addEventListener('click', close);
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modal.hidden) close();
  });

  /** 清单里有代码被校正过，首次打开时用一行说明交代清楚。 */
  function renderFixNote() {
    if (fixNoteShown || !CATALOG_FIXES.length) return;
    fixNoteShown = true;
    const box = document.getElementById('picker-fixnote');
    if (!box) return;
    box.hidden = false;
    clear(box);
    box.append(
      h('b', {}, `已校正 ${CATALOG_FIXES.length} 个代码`),
      h('span', {}, '原始清单里有几个代码指向的是别的基金，已按基金名称换成正确代码，点条目上的「已校正」可看原因。'),
    );
  }

  let fixNoteShown = false;

  return {
    open,
    close,
    isOpen: () => !modal.hidden,
    refresh: () => { if (!modal.hidden) render(); },
  };
}
