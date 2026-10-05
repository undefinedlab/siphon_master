/** Monochrome partner marks for the landing awards marquee. */
export function PartnerLogo({
  partner,
  className,
}: {
  partner: string;
  className?: string;
}) {
  const common = {
    className,
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    "aria-hidden": true as const,
  };

  switch (partner) {
    case "ethglobal":
      return (
        <svg {...common}>
          <path
            d="M12 2.5L4.5 12 12 21.5 19.5 12 12 2.5Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M12 2.5V21.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "ethereum":
      return (
        <svg {...common}>
          <path
            d="M12 2L5.5 12.2 12 15.8l6.5-3.6L12 2Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M5.5 13.4L12 22l6.5-8.6L12 16.9 5.5 13.4Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "solana":
      return (
        <svg {...common}>
          <path
            d="M5 16.5h12.2l-2.4 2.4H2.6L5 16.5Z"
            fill="currentColor"
          />
          <path
            d="M5 11.1h12.2l-2.4 2.4H2.6L5 11.1Z"
            fill="currentColor"
            opacity="0.75"
          />
          <path
            d="M7.4 5.7H19.6L17.2 8.1H5L7.4 5.7Z"
            fill="currentColor"
            opacity="0.5"
          />
        </svg>
      );
    case "zama":
      return (
        <svg {...common}>
          <rect
            x="3.5"
            y="3.5"
            width="17"
            height="17"
            rx="3"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M8 8.5h8L8 15.5h8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "polkadot":
      return (
        <svg {...common}>
          <circle cx="12" cy="5.5" r="2.1" fill="currentColor" />
          <circle cx="17.2" cy="9" r="2.1" fill="currentColor" opacity="0.85" />
          <circle cx="17.2" cy="15" r="2.1" fill="currentColor" opacity="0.7" />
          <circle cx="12" cy="18.5" r="2.1" fill="currentColor" opacity="0.55" />
          <circle cx="6.8" cy="15" r="2.1" fill="currentColor" opacity="0.7" />
          <circle cx="6.8" cy="9" r="2.1" fill="currentColor" opacity="0.85" />
        </svg>
      );
    case "protocollabs":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="12" cy="12" r="3.2" fill="currentColor" />
          <path
            d="M12 3.8v2.4M12 17.8v2.4M3.8 12h2.4M17.8 12h2.4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case "edgecity":
      return (
        <svg {...common}>
          <path
            d="M4 18.5V9.2L12 4l8 5.2v9.3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M9 18.5V12h6v6.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "1inch":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M9.2 15.2V8.8h2.1c1.9 0 3.1 1 3.1 2.6 0 1.1-.5 1.9-1.4 2.3L15 15.2h-2.1l-1.6-1.8H11v1.8H9.2Zm2-4.6h.4c.7 0 1.1-.4 1.1-.9s-.4-.9-1.1-.9H11v1.8Z"
            fill="currentColor"
          />
        </svg>
      );
    case "circle":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
    case "worldcoin":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4 12h16" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "layerzero":
      return (
        <svg {...common}>
          <path
            d="M5 7.5h14M5 12h14M5 16.5h14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "chiliz":
      return (
        <svg {...common}>
          <path
            d="M12 3.5 19 8v8l-7 4.5L5 16V8l7-4.5Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      );
  }
}
