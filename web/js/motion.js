/** 轻量交互动效：只动画透明度和位移，不等待动画再提交用户操作。 */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const running = new WeakMap();
const modalRuns = new WeakMap();
const returnFocus = new WeakMap();
const trapped = new WeakSet();

export const prefersReducedMotion = () => reducedMotion.matches;

export function cancelMotion(element) {
  running.get(element)?.cancel();
  running.delete(element);
}

export function playMotion(element, frames, options = {}) {
  if (!element) return Promise.resolve(false);
  cancelMotion(element);
  if (reducedMotion.matches || !element.animate) return Promise.resolve(true);
  const animation = element.animate(frames, {
    duration: 220,
    easing: 'cubic-bezier(.2,.7,.2,1)',
    ...options,
  });
  running.set(element, animation);
  return animation.finished.then(() => true, () => false).finally(() => {
    if (running.get(element) === animation) running.delete(element);
  });
}

export function reveal(element, options) {
  return playMotion(element, [
    { opacity: 0, transform: 'translateY(7px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], options);
}

/** 同一个选中底板在标签间滑动；尺寸跟随实际按钮和响应式布局。 */
export function createSegmentMotion(segment) {
  const update = (selected = segment.querySelector('.is-on')) => {
    if (!selected) return;
    segment.style.setProperty('--seg-x', `${selected.offsetLeft}px`);
    segment.style.setProperty('--seg-width', `${selected.offsetWidth}px`);
    segment.style.setProperty('--seg-height', `${selected.offsetHeight}px`);
    for (const button of segment.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button === selected));
    }
  };
  segment.classList.add('seg-motion');
  update();
  requestAnimationFrame(() => segment.classList.add('seg-ready'));
  if (window.ResizeObserver) new ResizeObserver(() => update()).observe(segment);
  else window.addEventListener('resize', () => update());
  return update;
}

export function showModal(modal, focusTarget) {
  const wasHidden = modal.hidden;
  modalRuns.set(modal, (modalRuns.get(modal) || 0) + 1);
  if (wasHidden) returnFocus.set(modal, document.activeElement);
  modal.hidden = false;
  modal.inert = false;
  modal.classList.remove('is-closing');
  const card = modal.querySelector('.modal-card');
  playMotion(modal, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  playMotion(card, [
    { opacity: 0, transform: 'translateY(12px) scale(.98)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ], { duration: 280 });
  if (!trapped.has(modal)) {
    trapped.add(modal);
    modal.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const controls = [...card.querySelectorAll('button, input, select, a[href], [tabindex="0"]')]
        .filter((control) => !control.disabled && control.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    });
  }
  (focusTarget || card.querySelector('button'))?.focus({ preventScroll: true });
}

export async function hideModal(modal) {
  if (modal.hidden || modal.classList.contains('is-closing')) return;
  const run = (modalRuns.get(modal) || 0) + 1;
  modalRuns.set(modal, run);
  const shouldReturnFocus = modal.contains(document.activeElement);
  modal.inert = true;
  modal.classList.add('is-closing');
  const card = modal.querySelector('.modal-card');
  playMotion(card, [
    { opacity: 1, transform: 'translateY(0) scale(1)' },
    { opacity: 0, transform: 'translateY(7px) scale(.985)' },
  ], { duration: 160, easing: 'ease-in' });
  await playMotion(modal, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in' });
  if (modalRuns.get(modal) !== run) return;
  modal.hidden = true;
  modal.classList.remove('is-closing');
  if (shouldReturnFocus) returnFocus.get(modal)?.focus({ preventScroll: true });
}
