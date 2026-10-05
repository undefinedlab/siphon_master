/** Semi-circular gauge (0–100), theme-aware neutral scale */
export function FearGreedGauge({
  value = 79,
  label,
}: {
  value?: number;
  label?: string;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  const angle = (clamped / 100) * 180;
  const derivedLabel =
    clamped >= 75
      ? "Extreme Greed"
      : clamped >= 55
        ? "Greed"
        : clamped >= 45
          ? "Neutral"
          : clamped >= 25
            ? "Fear"
            : "Extreme Fear";
  const displayLabel = label ?? derivedLabel;

  return (
    <div className="fear-greed-gauge">
      <div className="fear-greed-gauge__canvas">
        <svg
          viewBox="0 0 200 92"
          preserveAspectRatio="xMidYMid meet"
          className="fear-greed-gauge__svg"
          aria-hidden
        >
          <defs>
            <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--gauge-grad-start, #d1d5da)" />
              <stop offset="50%" stopColor="var(--gauge-grad-mid, #6b7280)" />
              <stop offset="100%" stopColor="var(--gauge-grad-end, #1f2328)" />
            </linearGradient>
          </defs>
          <path
            d="M 20 90 A 80 80 0 0 1 180 90"
            fill="none"
            stroke="var(--gauge-track, #e6eaef)"
            strokeWidth="12"
            strokeLinecap="round"
          />
          <path
            d="M 20 90 A 80 80 0 0 1 180 90"
            fill="none"
            stroke="url(#gaugeGrad)"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${(angle / 180) * 251} 251`}
          />
          {/* Number sits above status — room so they don't collide when CSS scales type */}
          <text
            x="100"
            y="56"
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="26"
            className="fear-greed-gauge__value"
          >
            {clamped}
          </text>
          <text
            x="100"
            y="86"
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="10"
            className="fear-greed-gauge__label"
          >
            {displayLabel}
          </text>
        </svg>
      </div>
    </div>
  );
}
