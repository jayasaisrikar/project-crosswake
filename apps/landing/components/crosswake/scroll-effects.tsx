'use client';
import { useEffect } from 'react';
function countUp(el: HTMLElement) {
  const end = Number(el.dataset.count);
  const decimals = (el.dataset.count!.split('.')[1] ?? '').length;
  const prefix = el.dataset.prefix ?? '';
  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / 1400);
    const eased = 1 - Math.pow(1 - t, 4);
    el.textContent = prefix + (end * eased).toFixed(decimals);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export function ScrollEffects() {
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const nodes = document.querySelectorAll<HTMLElement>('[data-reveal]');
    const animations = new Set<Animation>();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          if (!media.matches) {
            const animation = entry.target.animate(
              [
                { opacity: 0, transform: 'translateY(64px)' },
                { opacity: 1, transform: 'translateY(0)' },
              ],
              { duration: 1000, easing: 'cubic-bezier(.16,1,.3,1)' },
            );
            animations.add(animation);
            animation.onfinish = () => animations.delete(animation);
          }
          const target = entry.target as HTMLElement;
          target.classList.add('is-in');
          if (!media.matches) {
            target
              .querySelectorAll<HTMLElement>('[data-count]')
              .forEach(countUp);
          }
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.08 },
    );
    nodes.forEach((node) => observer.observe(node));
    const change = () => {
      if (media.matches) {
        animations.forEach((a) => a.cancel());
        animations.clear();
      }
    };
    media.addEventListener('change', change);
    return () => {
      observer.disconnect();
      animations.forEach((a) => a.cancel());
      media.removeEventListener('change', change);
    };
  }, []);
  return null;
}
