const LOCK_DISTANCE = 7;
const SAMPLE_WINDOW = 100;
const PROJECTION_TIME = 200;
const MAX_COAST_DISTANCE = 8;
const CLICK_DELAY = 350;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createFlowMotion(viewport, { onPosition, onSettle, getStep }) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let position = 0;
  let gesture;
  let dragFrame = null;
  let animationFrame = null;
  let animationTarget = null;
  let suppressUntil = 0;

  function render(next) {
    position = next;
    onPosition(position);
  }

  function stopAnimation() {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    animationTarget = null;
  }

  function endGesture() {
    const previous = gesture;
    gesture = undefined;
    viewport.classList.remove('is-dragging');
    if (dragFrame !== null) cancelAnimationFrame(dragFrame);
    dragFrame = null;
    if (previous && viewport.hasPointerCapture?.(previous.pointerId)) {
      viewport.releasePointerCapture(previous.pointerId);
    }
    return previous;
  }

  function settle(target) {
    stopAnimation();
    render(target);
    onSettle(target);
  }

  function animateTo(target) {
    stopAnimation();
    const start = position;
    const distance = Math.abs(target - start);
    if (reduceMotion.matches || distance < 0.005) {
      settle(target);
      return;
    }

    animationTarget = target;
    const startedAt = performance.now();
    const duration = clamp(240 + (distance - 1) * 62, 150, 680);

    function animate(now) {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      if (progress === 1) {
        settle(target);
        return;
      }
      const eased = 1 - (1 - progress) ** 3;
      render(start + (target - start) * eased);
      animationFrame = requestAnimationFrame(animate);
    }

    animationFrame = requestAnimationFrame(animate);
  }

  function jumpTo(next) {
    endGesture();
    settle(Math.round(next));
  }

  function moveTo(next) {
    endGesture();
    animateTo(Math.round(next));
  }

  function moveBy(delta) {
    moveTo(Math.round(animationTarget ?? position) + delta);
  }

  function pointerDown(event) {
    if (gesture || event.isPrimary === false || event.button !== 0) return;
    const step = getStep();
    if (!Number.isFinite(step) || step <= 0) return;
    const interrupted = animationFrame !== null;
    stopAnimation();
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      step,
      start: position,
      interrupted,
      dragging: false,
      next: position,
      samples: [{ x: event.clientX, time: event.timeStamp }],
    };
  }

  function recordSample(point, event) {
    const time = event.timeStamp;
    const firstRecent = point.samples.findIndex(sample => time - sample.time <= SAMPLE_WINDOW);
    point.samples = firstRecent < 0 ? [] : point.samples.slice(firstRecent);
    point.samples.push({ x: event.clientX, time });
  }

  function pointerMove(event) {
    const point = gesture;
    if (!point || point.pointerId !== event.pointerId) return;
    const dx = event.clientX - point.x;
    const dy = event.clientY - point.y;
    if (!point.dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_DISTANCE) return;
      if (Math.abs(dx) <= Math.abs(dy)) {
        endGesture();
        if (point.interrupted) animateTo(Math.round(position));
        return;
      }
      point.dragging = true;
      viewport.classList.add('is-dragging');
      try {
        viewport.setPointerCapture?.(point.pointerId);
      } catch {
        // Moves and release are also observed on the window.
      }
    }

    recordSample(point, event);
    point.next = point.start - dx / point.step;
    if (dragFrame === null) {
      dragFrame = requestAnimationFrame(() => {
        dragFrame = null;
        render(point.next);
      });
    }
  }

  function releaseVelocity(point, event) {
    recordSample(point, event);
    const first = point.samples[0];
    const elapsed = event.timeStamp - first.time;
    if (elapsed < 8) return 0;
    return (first.x - event.clientX) / point.step / elapsed;
  }

  function pointerEnd(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = endGesture();
    if (point.dragging) {
      suppressUntil = performance.now() + CLICK_DELAY;
      if (event.type === 'pointercancel') {
        render(point.next);
        animateTo(Math.round(position));
        return;
      }
      render(point.start - (event.clientX - point.x) / point.step);
      const velocity = reduceMotion.matches ? 0 : releaseVelocity(point, event);
      const coast = clamp(velocity * PROJECTION_TIME, -MAX_COAST_DISTANCE, MAX_COAST_DISTANCE);
      animateTo(Math.round(position + coast));
    } else if (point.interrupted) {
      suppressUntil = performance.now() + CLICK_DELAY;
      animateTo(Math.round(position));
    }
  }

  viewport.addEventListener('pointerdown', pointerDown, { passive: true });
  viewport.addEventListener('dragstart', event => event.preventDefault());
  window.addEventListener('pointermove', pointerMove, { passive: true });
  window.addEventListener('pointerup', pointerEnd, { passive: true });
  window.addEventListener('pointercancel', pointerEnd, { passive: true });

  return {
    jumpTo,
    moveTo,
    moveBy,
    getPosition: () => position,
    shouldSuppressClick: () => Boolean(gesture?.dragging) || performance.now() < suppressUntil,
  };
}
