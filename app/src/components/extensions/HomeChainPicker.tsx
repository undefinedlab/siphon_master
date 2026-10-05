'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './HomeChainPicker.css';
import { listHomeChainOptions, type HomeChainOption } from '@/lib/chains/homeChains';
import {
  CHAIN_LOGO,
  chainLogoIdForHomeChainId,
  type ChainLogoId,
} from '@/lib/chains/chainLogos';

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (option: HomeChainOption) => void;
};

function ChainLogo({ id }: { id: ChainLogoId }) {
  const { src, alt } = CHAIN_LOGO[id];
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static brand marks (svg/png mix)
    <img src={src} alt={alt} className="hcp-logo-img" width={42} height={42} decoding="async" />
  );
}

function featureClass(feature: string): string {
  const key = feature.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  return `hcp-feature hcp-feature--${key}`;
}

function ChainCard({
  option,
  onSelect,
}: {
  option: HomeChainOption;
  onSelect: (option: HomeChainOption) => void;
}) {
  const disabled = option.kind === 'soon';
  const logo = chainLogoIdForHomeChainId(option.id);
  return (
    <button
      type="button"
      className={`hcp-card hcp-card--${logo}${disabled ? ' is-soon' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onSelect(option);
      }}
    >
      <span className="hcp-card-glow" aria-hidden />
      {option.tag ? <span className="hcp-card-tag">{option.tag}</span> : null}
      <span className="hcp-card-logo">
        <ChainLogo id={logo} />
      </span>
      <span className="hcp-card-copy">
        <span className="hcp-card-name">{option.label}</span>
        <span className="hcp-features">
          {option.features.map((feature) => (
            <span key={feature} className={featureClass(feature)}>
              {feature}
            </span>
          ))}
        </span>
      </span>
      <span className="hcp-card-foot">
        {disabled ? <span className="hcp-soon">Soon</span> : <span className="hcp-wallet">{option.walletHint}</span>}
      </span>
    </button>
  );
}

/**
 * First-connect home-chain picker — glass marquee of chain cards.
 */
const AUTO_SCROLL_PX_PER_SEC = 40;
const DRAG_CLICK_SLOP_PX = 6;

export default function HomeChainPicker({ open, onClose, onSelect }: Props) {
  const [paused, setPaused] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // Drives the marquee from JS so it can be dragged and wheel-scrolled: auto-scroll while idle,
  // follow the pointer while dragging, wrap at half the (duplicated) track so it loops seamlessly.
  useEffect(() => {
    if (!open) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const track = trackRef.current;
      const dt = (now - last) / 1000;
      last = now;
      if (track) {
        if (!pausedRef.current && !drag.current) offset.current += AUTO_SCROLL_PX_PER_SEC * dt;
        const half = track.scrollWidth / 2;
        if (half > 0) offset.current = ((offset.current % half) + half) % half;
        track.style.transform = `translateX(${-offset.current}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { x: e.clientX, start: offset.current, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > DRAG_CLICK_SLOP_PX) {
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (d.moved) offset.current = d.start - dx;
  };
  const endDrag = () => {
    // A drag must not also select the card it ended on.
    suppressClick.current = !!drag.current?.moved;
    drag.current = null;
  };

  const onSelectSafe = useCallback(
    (option: HomeChainOption) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      onSelect(option);
    },
    [onSelect],
  );

  if (!open) return null;
  const options = listHomeChainOptions();
  // Duplicate for seamless marquee loop.
  const loop = [...options, ...options];

  return (
    <div
      className="hcp-bg"
      role="dialog"
      aria-modal="true"
      aria-label="Choose your home chain"
      onClick={onClose}
    >
      <div className="hcp-shell" onClick={(e) => e.stopPropagation()}>
        <div className="hcp-orb hcp-orb--a" aria-hidden />
        <div className="hcp-orb hcp-orb--b" aria-hidden />

        <header className="hcp-head">
          <div>
            <h2 className="hcp-title">Where we land?</h2>
            <p className="hcp-sub">Choose the homebase for your Vault</p>
          </div>
          <button type="button" className="hcp-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 14 14" aria-hidden>
              <path
                d="M2.2 2.2l9.6 9.6M11.8 2.2L2.2 11.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div
          className={`hcp-marquee${paused ? ' is-paused' : ''}`}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => {
            setPaused(false);
            drag.current = null;
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={(e) => {
            offset.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          }}
        >
          <div className="hcp-marquee-fade hcp-marquee-fade--l" aria-hidden />
          <div className="hcp-marquee-fade hcp-marquee-fade--r" aria-hidden />
          <div className="hcp-marquee-track" ref={trackRef}>
            {loop.map((opt, i) => (
              <ChainCard key={`${opt.id}-${i}`} option={opt} onSelect={onSelectSafe} />
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
