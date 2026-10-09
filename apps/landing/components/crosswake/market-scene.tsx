'use client';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from 'motion/react';

/** A projected particle torus: genuine animated geometry, no video download. */
export function MarketScene() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0);
  const reduced = useReducedMotion();
  const { scrollY } = useScroll();
  const drift = useTransform(scrollY, [0, 1200], [0, 110]);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0,
      height = 0,
      frame = 0,
      last = 0,
      time = phase.current,
      visible = true;
    const pointer = { x: 0, y: 0 };
    const accent = getComputedStyle(element)
      .getPropertyValue('--signal')
      .trim();
    const ink = getComputedStyle(element).getPropertyValue('--ink').trim();
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const size = Math.min(width, height) * 0.35;
      for (let band = 0; band < 40; band++) {
        const v = (band / 40) * Math.PI * 2;
        for (let dot = 0; dot < 112; dot++) {
          const u = (dot / 112) * Math.PI * 2;
          const ripple = Math.sin(u * 3 + v * 2 + time * 0.7) * 0.1;
          const r = 1 + (0.34 + ripple) * Math.cos(v);
          const x = r * Math.cos(u + time * 0.075);
          const y = r * Math.sin(u + time * 0.075);
          const z = 0.34 * Math.sin(v) + Math.sin(u * 2 + time * 0.5) * 0.08;
          const angle = 0.9 + pointer.y * 0.12;
          const yy = y * Math.cos(angle) - z * Math.sin(angle);
          const zz = y * Math.sin(angle) + z * Math.cos(angle);
          const tilt = -0.42 + pointer.x * 0.12;
          const xx = x * Math.cos(tilt) - yy * Math.sin(tilt);
          const yyy = x * Math.sin(tilt) + yy * Math.cos(tilt);
          const perspective = 3 / (3 - zz);
          ctx.globalAlpha = 0.22 + ((zz + 1.4) / 2.8) * 0.65;
          ctx.fillStyle = band % 8 === 0 ? ink : accent;
          ctx.beginPath();
          ctx.arc(
            width * 0.5 + xx * size * perspective,
            height * 0.49 + yyy * size * perspective,
            Math.max(0.45, (zz + 1.8) * 0.63),
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => {
      frame = 0;
      if (!visible || document.hidden || paused || media.matches) return;
      if (now - last > 30) {
        time += Math.min(now - last, 50) / 1000;
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      draw();
      if (visible && !document.hidden && !paused && !media.matches)
        frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver((entries) => {
      const b = entries[0].contentRect;
      width = b.width;
      height = b.height;
      const ratio = Math.min(devicePixelRatio, 2);
      element.width = width * ratio;
      element.height = height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      restart();
    });
    resize.observe(element);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      restart();
    });
    observer.observe(element);
    const move = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      pointer.x = (event.clientX - rect.left) / rect.width - 0.5;
      pointer.y = (event.clientY - rect.top) / rect.height - 0.5;
    };
    element.addEventListener('pointermove', move);
    document.addEventListener('visibilitychange', restart);
    media.addEventListener('change', restart);
    return () => {
      phase.current = time;
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer.disconnect();
      element.removeEventListener('pointermove', move);
      document.removeEventListener('visibilitychange', restart);
      media.removeEventListener('change', restart);
    };
  }, [paused]);
  return (
    <motion.div className="market-scene" style={reduced ? {} : { y: drift }}>
      <div className="scene-halo" aria-hidden="true" />
      <canvas ref={canvas} aria-hidden="true" />
      <div className="scene-center" aria-hidden="true">
        <span>₿</span>
        <small>
          THE MARKET
          <br />
          NEVER STANDS STILL.
        </small>
      </div>
      <span className="scene-coordinate coordinate-top">
        BTC / THE STARTING POINT
      </span>
      <span className="scene-coordinate coordinate-bottom">
        OBSERVE → TEST → TRACK
      </span>
      <button
        className="scene-pause"
        onClick={() => setPaused(!paused)}
        aria-label={
          paused ? 'Play background animation' : 'Pause background animation'
        }
        aria-pressed={paused}
      >
        {paused ? <Play size={13} /> : <Pause size={13} />}
        <span>{paused ? 'Play motion' : 'Pause motion'}</span>
      </button>
    </motion.div>
  );
}
