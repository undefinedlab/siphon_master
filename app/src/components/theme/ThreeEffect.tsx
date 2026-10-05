"use client";

import { useEffect, useRef, useState } from "react";
import "./ThreeEffect.css";

// Declare THREE.js types
interface ThreeLibrary {
  [key: string]: unknown;
}

declare global {
  interface Window {
    THREE: ThreeLibrary;
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  decay: number;
  originalAlpha: number;
  life: number;
  time: number;
  startX: number;
  twinkleSpeed: number;
  twinkleAmount: number;
}

export default function ThreeEffect() {
  const containerRef = useRef<HTMLDivElement>(null);
  const particleCanvasRef = useRef<HTMLCanvasElement>(null);
  const scannerCanvasRef = useRef<HTMLCanvasElement>(null);
  const cardStreamRef = useRef<HTMLDivElement>(null);
  const cardLineRef = useRef<HTMLDivElement>(null);
  const [isHeroVisible, setIsHeroVisible] = useState(true);
  const heroSectionRef = useRef<HTMLElement | null>(null);
  
  const positionRef = useRef(0); // Will be initialized after cards are created
  const velocityRef = useRef(120);
  const animationIdRef = useRef<number | null>(null);
  const particleSystemRef = useRef<{ destroy?: () => void } | null>(null);
  const scannerRef = useRef<{ destroy?: () => void } | null>(null);
  const lastTimeRef = useRef(0);
  const particleInitAttemptedRef = useRef(false);

  useEffect(() => {
    
    // Use Intersection Observer to track hero section visibility
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Hero is visible if any part of it is in the viewport
          setIsHeroVisible(entry.isIntersecting || entry.boundingClientRect.bottom > 0);
        });
      },
      {
        threshold: 0,
        rootMargin: '0px'
      }
    );
    
    // Find and observe hero section
    const findAndObserveHero = () => {
      const heroSection = document.querySelector('.heroSection') as HTMLElement;
      if (heroSection) {
        heroSectionRef.current = heroSection;
        observer.observe(heroSection);
        return true;
      }
      return false;
    };
    
    // Try immediately and with delay
    if (!findAndObserveHero()) {
      const timer = setTimeout(() => {
        findAndObserveHero();
      }, 100);
      return () => {
        clearTimeout(timer);
        observer.disconnect();
      };
    }
    
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let isDisposed = false;
    // Load Three.js dynamically
    const loadThree = async () => {
      if (typeof window !== 'undefined' && !window.THREE) {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
        script.async = true;
        document.head.appendChild(script);
        
        await new Promise((resolve) => {
          script.onload = resolve;
        });
      }
    };

    loadThree().then(() => {
      if (isDisposed || particleInitAttemptedRef.current) return;
      if (typeof window !== 'undefined' && window.THREE && particleCanvasRef.current) {
        particleInitAttemptedRef.current = true;
        initParticleSystem();
      }
    });

    if (scannerCanvasRef.current) {
      initScanner();
    }

    if (cardLineRef.current) {
      populateCardLine();
      // Initialize position so cards start from right side, just before entering scanner
      // Use window.innerWidth to match scanner canvas coordinate system
      const isMobile = window.innerWidth <= 480;
      const containerWidth = window.innerWidth; // Match scanner canvas width
      const scannerContainerX = containerWidth / 2 + (isMobile ? 5 : 85);
      const initialOffset = isMobile 
        ? containerWidth - 100  // Start from right side, just before scanner on mobile
        : scannerContainerX + 100; // Start almost before scanner on desktop
      positionRef.current = initialOffset;
      if (cardLineRef.current) {
        cardLineRef.current.style.transform = `translateX(${initialOffset}px)`;
      }
      // Cards are non-interactive - no listeners needed
      animateCards();
      startPeriodicUpdates();
    }

    return () => {
      isDisposed = true;
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
      if (particleSystemRef.current) {
        particleSystemRef.current.destroy?.();
      }
      particleSystemRef.current = null;
      particleInitAttemptedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize scanner when canvas becomes available
  useEffect(() => {
    if (scannerCanvasRef.current && !scannerRef.current) {
      initScanner();
    }
    
    return () => {
      if (scannerRef.current) {
        scannerRef.current.destroy?.();
        scannerRef.current = null;
      }
    };
  }, []);

  const generateCode = (width: number, height: number): string => {
    const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
    const pick = (arr: string[]) => arr[randInt(0, arr.length - 1)];

    const header = [
      "// encrypted execution layer • homomorphic encryption",
      "/* zero-knowledge proof generation – private computation */",
      "const SCAN_WIDTH = 8;",
      "const FADE_ZONE = 35;",
      "const MAX_PARTICLES = 2500;",
      "const TRANSITION = 0.05;",
    ];

    const helpers = [
      "function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }",
      "function lerp(a, b, t) { return a + (b - a) * t; }",
      "const now = () => performance.now();",
      "function rng(min, max) { return Math.random() * (max - min) + min; }",
    ];

    const particleBlock = (idx: number) => [
      `class Particle${idx} {`,
      "  constructor(x, y, vx, vy, r, a) {",
      "    this.x = x; this.y = y;",
      "    this.vx = vx; this.vy = vy;",
      "    this.r = r; this.a = a;",
      "  }",
      "  step(dt) { this.x += this.vx * dt; this.y += this.vy * dt; }",
      "}",
    ];

    const scannerBlock = [
      "const scanner = {",
      "  x: Math.floor(window.innerWidth / 2),",
      "  width: SCAN_WIDTH,",
      "  glow: 3.5,",
      "};",
      "",
      "function drawParticle(ctx, p) {",
      "  ctx.globalAlpha = clamp(p.a, 0, 1);",
      "  ctx.drawImage(gradient, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);",
      "}",
    ];

    const loopBlock = [
      "function tick(t) {",
      "  // requestAnimationFrame(tick);",
      "  const dt = 0.016;",
      "  // update & render",
      "}",
    ];

    const misc = [
      "const state = { intensity: 1.2, particles: MAX_PARTICLES };",
      "const bounds = { w: window.innerWidth, h: 300 };",
      "const gradient = document.createElement('canvas');",
      "const ctx = gradient.getContext('2d');",
      "ctx.globalCompositeOperation = 'lighter';",
      "// ascii overlay is masked with a 3-phase gradient",
    ];

    const library: string[] = [];
    header.forEach((l) => library.push(l));
    helpers.forEach((l) => library.push(l));
    for (let b = 0; b < 3; b++) {
      particleBlock(b).forEach((l) => library.push(l));
    }
    scannerBlock.forEach((l) => library.push(l));
    loopBlock.forEach((l) => library.push(l));
    misc.forEach((l) => library.push(l));

    for (let i = 0; i < 40; i++) {
      const n1 = randInt(1, 9);
      const n2 = randInt(10, 99);
      library.push(`const v${i} = (${n1} + ${n2}) * 0.${randInt(1, 9)};`);
    }

    for (let i = 0; i < 20; i++) {
      library.push(`if (state.intensity > ${1 + (i % 3)}) { scanner.glow += 0.01; }`);
    }

    let flow = library.join(" ");
    flow = flow.replace(/\s+/g, " ").trim();
    const totalChars = width * height;

    while (flow.length < totalChars + width) {
      const extra = pick(library).replace(/\s+/g, " ").trim();
      flow += " " + extra;
    }

    let out = "";
    let offset = 0;
    for (let row = 0; row < height; row++) {
      let line = flow.slice(offset, offset + width);
      if (line.length < width) line = line + " ".repeat(width - line.length);
      out += line + (row < height - 1 ? "\n" : "");
      offset += width;
    }

    return out;
  };

  const calculateCodeDimensions = (cardWidth: number, cardHeight: number) => {
    const fontSize = 11;
    const lineHeight = 13;
    const charWidth = 6;
    const width = Math.floor(cardWidth / charWidth);
    const height = Math.floor(cardHeight / lineHeight);
    return { width, height, fontSize, lineHeight };
  };

  const strategies = [
    { 
      name: "Liquidity Sniping", 
      type: "STRATEGY",
      command: "openio snipe --token 0x... --amount 5ETH --gas-price",
      description: "Front-run new liquidity pools",
      badges: ["priority: high", "maxGas: 500000", "retries: 3"],
      color: "#ff6b6b",
      leftData: "12.4%",
      rightData: "HIGH",
      leftLabel: "APY",
      rightLabel: "RISK"
    },
    { 
      name: "MEV Protection", 
      type: "COMMAND",
      command: "openio protect --tx-hash 0x... --max-slippage",
      description: "Protect transactions from MEV attacks",
      badges: ["method: private-pool", "cost: 0.01ETH", "delay: 100ms"],
      color: "#ffd93d",
      leftData: "0.01ETH",
      rightData: "LOW",
      leftLabel: "COST",
      rightLabel: "RISK"
    },
    { 
      name: "Arbitrage", 
      type: "STRATEGY",
      command: "openio arbitrage --pair WETH/DAI --amount 5000",
      description: "Exploit price differences across exchanges",
      badges: ["minProfit: 0.5%", "timeout: 30s", "gasLimit: 300000"],
      color: "#6bcf7f",
      leftData: "35.2%",
      rightData: "MED",
      leftLabel: "APY",
      rightLabel: "RISK"
    },
    { 
      name: "DCA", 
      type: "STRATEGY",
      command: "openio dca --token BTC --interval 1h --amount 100",
      description: "Dollar cost averaging automation",
      badges: ["interval: 1h", "total: 10k", "slippage: 0.3%"],
      color: "#4d96ff",
      leftData: "8.7%",
      rightData: "LOW",
      leftLabel: "APY",
      rightLabel: "RISK"
    },
    { 
      name: "Yield Farming", 
      type: "STRATEGY",
      command: "openio farm --pool Compound --min-apy 25%",
      description: "Maximize token rewards from pools",
      badges: ["apy: 25-120%", "compound: auto", "risk: medium"],
      color: "#9b59b6",
      leftData: "68.5%",
      rightData: "MED",
      leftLabel: "APY",
      rightLabel: "RISK"
    },
    { 
      name: "Flash Loans", 
      type: "COMMAND",
      command: "openio flash --amount 100ETH --strategy arbitrage",
      description: "Instant capital leverage without collateral",
      badges: ["fee: 0.09%", "maxAmount: 1000ETH", "chains: 5"],
      color: "#e74c3c",
      leftData: "0.09%",
      rightData: "HIGH",
      leftLabel: "FEE",
      rightLabel: "RISK"
    },
    { 
      name: "Grid Trading", 
      type: "STRATEGY",
      command: "openio grid --range 1800-2200 --grids 20",
      description: "Automated range trading strategy",
      badges: ["grids: 20", "spread: 2%", "rebalance: auto"],
      color: "#3498db",
      leftData: "22.1%",
      rightData: "MED",
      leftLabel: "APY",
      rightLabel: "RISK"
    },
    { 
      name: "Liquidity Mining", 
      type: "STRATEGY",
      command: "openio mine --pool UniswapV3 --tick-range 0.05%",
      description: "Provide liquidity and earn fees",
      badges: ["fee: 0.05%", "apr: 18-85%", "impermanent: low"],
      color: "#1abc9c",
      leftData: "42.3%",
      rightData: "MED",
      leftLabel: "APR",
      rightLabel: "RISK"
    },
  ];

  const createCardWrapper = (index: number) => {
    const wrapper = document.createElement("div");
    wrapper.className = "card-wrapper";

    const normalCard = document.createElement("div");
    normalCard.className = "card card-normal";

    // Create strategy card with name
    const strategyCard = document.createElement("div");
    strategyCard.className = "card-image";
    strategyCard.style.width = "100%";
    strategyCard.style.height = "100%";
    strategyCard.style.background = "rgba(0, 0, 0, 0.65)";
    strategyCard.style.borderRadius = "15px";
    strategyCard.style.display = "flex";
    strategyCard.style.alignItems = "center";
    strategyCard.style.justifyContent = "center";
    strategyCard.style.position = "relative";
    strategyCard.style.overflow = "hidden";
    strategyCard.style.border = "1px solid rgba(255, 255, 255, 0.18)";
    strategyCard.style.backdropFilter = "blur(12px)";
    strategyCard.style.boxShadow = 
      "inset 0 1px 0 rgba(255, 255, 255, 0.1), " +
      "inset 0 -1px 0 rgba(0, 0, 0, 0.2), " +
      "0 2px 8px rgba(0, 0, 0, 0.3)";

    const strategy = strategies[index % strategies.length];
    
    // Strategy content container
    const strategyContent = document.createElement("div");
    strategyContent.className = "strategy-content";
    strategyContent.style.display = "flex";
    strategyContent.style.flexDirection = "column";
    strategyContent.style.justifyContent = "space-between";
    strategyContent.style.padding = "20px";
    strategyContent.style.height = "100%";
    strategyContent.style.boxSizing = "border-box";
    strategyContent.style.zIndex = "3";
    strategyContent.style.position = "relative";

    // Header section with type badge and stats
    const headerSection = document.createElement("div");
    headerSection.style.display = "flex";
    headerSection.style.justifyContent = "space-between";
    headerSection.style.alignItems = "flex-start";
    headerSection.style.marginBottom = "16px";

    // Type badge
    const typeBadge = document.createElement("div");
    typeBadge.className = "strategy-type-badge";
    typeBadge.textContent = strategy.type;
    typeBadge.style.display = "inline-block";
    typeBadge.style.padding = "3px 10px";
    typeBadge.style.borderRadius = "4px";
    typeBadge.style.fontSize = "8px";
    typeBadge.style.fontWeight = "700";
    typeBadge.style.textTransform = "uppercase";
    typeBadge.style.letterSpacing = "1.2px";
    typeBadge.style.color = "rgba(255, 255, 255, 0.7)";
    typeBadge.style.background = "rgba(255, 255, 255, 0.08)";
    typeBadge.style.border = "1px solid rgba(255, 255, 255, 0.12)";
    typeBadge.style.fontFamily = "'Courier New', monospace";

    // Stats on right side of header
    const headerStats = document.createElement("div");
    headerStats.style.display = "flex";
    headerStats.style.gap = "16px";
    headerStats.style.alignItems = "flex-start";

    // Left stat
    const leftStat = document.createElement("div");
    leftStat.style.display = "flex";
    leftStat.style.flexDirection = "column";
    leftStat.style.alignItems = "flex-end";
    
    const leftLabel = document.createElement("div");
    leftLabel.textContent = strategy.leftLabel;
    leftLabel.style.fontSize = "7px";
    leftLabel.style.color = "rgba(255, 255, 255, 0.4)";
    leftLabel.style.textTransform = "uppercase";
    leftLabel.style.letterSpacing = "1px";
    leftLabel.style.marginBottom = "3px";
    leftLabel.style.fontFamily = "'Courier New', monospace";
    
    const leftValue = document.createElement("div");
    leftValue.textContent = strategy.leftData;
    leftValue.style.fontSize = "14px";
    leftValue.style.fontWeight = "600";
    leftValue.style.color = "rgba(255, 255, 255, 0.95)";
    leftValue.style.fontFamily = "'Courier New', monospace";
    leftValue.style.lineHeight = "1.2";
    
    leftStat.appendChild(leftLabel);
    leftStat.appendChild(leftValue);

    // Right stat
    const rightStat = document.createElement("div");
    rightStat.style.display = "flex";
    rightStat.style.flexDirection = "column";
    rightStat.style.alignItems = "flex-end";
    
    const rightLabel = document.createElement("div");
    rightLabel.textContent = strategy.rightLabel;
    rightLabel.style.fontSize = "7px";
    rightLabel.style.color = "rgba(255, 255, 255, 0.4)";
    rightLabel.style.textTransform = "uppercase";
    rightLabel.style.letterSpacing = "1px";
    rightLabel.style.marginBottom = "3px";
    rightLabel.style.fontFamily = "'Courier New', monospace";
    
    const rightValue = document.createElement("div");
    rightValue.textContent = strategy.rightData;
    rightValue.style.fontSize = "14px";
    rightValue.style.fontWeight = "600";
    rightValue.style.color = "rgba(255, 255, 255, 0.95)";
    rightValue.style.fontFamily = "'Courier New', monospace";
    rightValue.style.lineHeight = "1.2";
    
    rightStat.appendChild(rightLabel);
    rightStat.appendChild(rightValue);

    headerStats.appendChild(leftStat);
    headerStats.appendChild(rightStat);
    headerSection.appendChild(typeBadge);
    headerSection.appendChild(headerStats);

    // Strategy name
    const strategyName = document.createElement("div");
    strategyName.className = "strategy-name";
    strategyName.textContent = strategy.name;
    strategyName.style.fontSize = "22px";
    strategyName.style.fontWeight = "600";
    strategyName.style.color = "white";
    strategyName.style.textShadow = "0 1px 3px rgba(0, 0, 0, 0.3)";
    strategyName.style.letterSpacing = "0.3px";
    strategyName.style.marginBottom = "14px";
    strategyName.style.lineHeight = "1.3";

    // Command input
    const commandInput = document.createElement("div");
    commandInput.className = "strategy-command";
    commandInput.style.display = "flex";
    commandInput.style.alignItems = "center";
    commandInput.style.marginBottom = "10px";
    commandInput.style.padding = "6px 10px";
    commandInput.style.background = "rgba(255, 255, 255, 0.05)";
    commandInput.style.borderRadius = "4px";
    commandInput.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    commandInput.style.fontFamily = "'Courier New', monospace";
    commandInput.style.fontSize = "10px";
    commandInput.style.overflow = "hidden";
    commandInput.style.textOverflow = "ellipsis";
    commandInput.style.whiteSpace = "nowrap";
    
    const commandBracket = document.createElement("span");
    commandBracket.textContent = "$";
    commandBracket.style.color = "rgba(255, 255, 255, 0.5)";
    commandBracket.style.marginRight = "6px";
    commandBracket.style.fontWeight = "bold";
    
    const commandText = document.createElement("span");
    commandText.textContent = strategy.command;
    commandText.style.color = "#ffffff";
    
    commandInput.appendChild(commandBracket);
    commandInput.appendChild(commandText);

    // Strategy description
    const strategyDesc = document.createElement("div");
    strategyDesc.className = "strategy-description";
    strategyDesc.textContent = strategy.description;
    strategyDesc.style.fontSize = "11px";
    strategyDesc.style.color = "#ffffff";
    strategyDesc.style.marginBottom = "auto";
    strategyDesc.style.marginTop = "6px";
    strategyDesc.style.lineHeight = "1.4";
    strategyDesc.style.letterSpacing = "0.2px";

    // Strategy badges
    const strategyBadges = document.createElement("div");
    strategyBadges.className = "strategy-badges";
    strategyBadges.style.display = "flex";
    strategyBadges.style.gap = "6px";
    strategyBadges.style.flexWrap = "wrap";
    strategyBadges.style.marginTop = "auto";
    strategyBadges.style.paddingTop = "14px";
    strategyBadges.style.borderTop = "1px solid rgba(255, 255, 255, 0.1)";

    strategy.badges.forEach((badge: string) => {
      const badgeEl = document.createElement("div");
      badgeEl.className = "strategy-badge";
      badgeEl.textContent = badge;
      badgeEl.style.display = "inline-block";
      badgeEl.style.padding = "3px 8px";
      badgeEl.style.borderRadius = "3px";
      badgeEl.style.fontSize = "9px";
      badgeEl.style.color = "rgba(255, 255, 255, 0.7)";
      badgeEl.style.background = "rgba(255, 255, 255, 0.06)";
      badgeEl.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      badgeEl.style.fontFamily = "'Courier New', monospace";
      badgeEl.style.letterSpacing = "0.3px";
      strategyBadges.appendChild(badgeEl);
    });

    strategyContent.appendChild(headerSection);
    strategyContent.appendChild(strategyName);
    strategyContent.appendChild(commandInput);
    strategyContent.appendChild(strategyDesc);
    strategyContent.appendChild(strategyBadges);
    strategyCard.appendChild(strategyContent);
    normalCard.appendChild(strategyCard);

    const asciiCard = document.createElement("div");
    asciiCard.className = "card card-ascii";

    const asciiContent = document.createElement("div");
    asciiContent.className = "ascii-content";

    const { width, height, fontSize, lineHeight } = calculateCodeDimensions(400, 260);
    asciiContent.style.fontSize = `${fontSize}px`;
    asciiContent.style.lineHeight = `${lineHeight}px`;
    asciiContent.textContent = generateCode(width, height);

    asciiCard.appendChild(asciiContent);
    wrapper.appendChild(normalCard);
    wrapper.appendChild(asciiCard);

    return wrapper;
  };

  const populateCardLine = () => {
    if (!cardLineRef.current) return;
    cardLineRef.current.innerHTML = "";
    const cardsCount = 30;
    // Create multiple sets of cards for seamless infinite scrolling
    // We'll create 3 sets: one visible, one coming, one going
    const setsCount = 3;
    for (let set = 0; set < setsCount; set++) {
      for (let i = 0; i < cardsCount; i++) {
        const cardWrapper = createCardWrapper(i);
        cardLineRef.current.appendChild(cardWrapper);
      }
    }
  };

  // Helper function to get scanner position relative to card-stream container
  // Returns position in pixels from the left edge of the card-stream
  // Must match the scanner canvas lightBarX position exactly
  const getScannerContainerX = () => {
    const isMobile = window.innerWidth <= 480;
    // Both scanner canvas and card-stream are 100vw wide and positioned absolutely
    // Scanner canvas draws at: window.innerWidth / 2 + offset (in canvas coords 0 to window.innerWidth)
    // Card-stream also uses full window width, so positions align directly
    // Return the same value as lightBarX in the scanner canvas
    return window.innerWidth / 2 + (isMobile ? 5 : 85);
  };

  const updateCardClipping = () => {
    // Calculate based on transform positions, not viewport coordinates
    // This prevents jumps when scrolling or tab switching
    if (!cardLineRef.current) return;
    
    const isMobile = window.innerWidth <= 480;
    const scannerWidth = isMobile ? 6 : 8;
    const scannerContainerX = getScannerContainerX();
    const scannerLeft = scannerContainerX - scannerWidth / 2;
    const scannerRight = scannerContainerX + scannerWidth / 2;
    let anyScanningActive = false;

    // Use positionRef directly - it's always up to date and handles looping
    const cardLineX = positionRef.current;

    // Card dimensions
    const cardWidth = 400;
    const cardGap = 60;
    const cardTotalWidth = cardWidth + cardGap;

    document.querySelectorAll(".card-wrapper").forEach((wrapper, index) => {
      // Calculate card position based on transform, not getBoundingClientRect
      // positionRef already handles looping, so we just add the card offset
      const cardStartX = cardLineX + (index * cardTotalWidth);
      const cardEndX = cardStartX + cardWidth;
      
      const normalCard = wrapper.querySelector(".card-normal");
      const asciiCard = wrapper.querySelector(".card-ascii");

      if (cardStartX < scannerRight && cardEndX > scannerLeft) {
        anyScanningActive = true;
        // Use scanner center for alignment - shift both layers to align with the visual scanner bar
        const scannerCenterX = scannerContainerX - cardStartX;
        // Shift both layers to the right to align with scanner bar center
        const alignmentOffset = 15; // Shift both layers 15px to the right
        const adjustedCenterX = scannerCenterX + alignmentOffset;
        
        const normalClipRight = Math.min(100, Math.max(0, (adjustedCenterX / cardWidth) * 100));
        const asciiClipLeft = Math.min(100, Math.max(0, (adjustedCenterX / cardWidth) * 100));

        if (normalCard instanceof HTMLElement) {
          normalCard.style.setProperty("--clip-right", `${normalClipRight}%`);
        }
        if (asciiCard instanceof HTMLElement) {
          asciiCard.style.setProperty("--clip-left", `${asciiClipLeft}%`);
        }

        // Add scan effect animation when card first enters scanner
        const scannerIntersectLeft = Math.max(scannerLeft - cardStartX, 0);
        if (!wrapper.hasAttribute("data-scanned") && scannerIntersectLeft > 0) {
          wrapper.setAttribute("data-scanned", "true");
          const scanEffect = document.createElement("div");
          scanEffect.className = "scan-effect";
          wrapper.appendChild(scanEffect);
          setTimeout(() => {
            if (scanEffect.parentNode) {
              scanEffect.parentNode.removeChild(scanEffect);
            }
          }, 600);
        }
      } else {
        // Cards remain the same after scanning - no opacity changes
        if (cardEndX < scannerLeft) {
          // Card is to the left of scanner - fully revealed
          if (normalCard instanceof HTMLElement) {
            normalCard.style.setProperty("--clip-right", "100%");
          }
          if (asciiCard instanceof HTMLElement) {
            asciiCard.style.setProperty("--clip-left", "100%");
          }
        } else if (cardStartX > scannerRight) {
          // Card is to the right of scanner - fully hidden
          if (normalCard instanceof HTMLElement) {
            normalCard.style.setProperty("--clip-right", "0%");
          }
          if (asciiCard instanceof HTMLElement) {
            asciiCard.style.setProperty("--clip-left", "0%");
          }
        }
        wrapper.removeAttribute("data-scanned");
      }
    });

    // Notify scanner about scanning state
    interface WindowWithScanner {
      setScannerScanning?: (active: boolean) => void;
    }
    const windowWithScanner = window as Window & WindowWithScanner;
    if (typeof window !== 'undefined' && windowWithScanner.setScannerScanning) {
      windowWithScanner.setScannerScanning(anyScanningActive);
    }
  };

  const updateAsciiContent = () => {
    document.querySelectorAll(".ascii-content").forEach((content) => {
      if (Math.random() < 0.15) {
        const { width, height } = calculateCodeDimensions(420, 260);
        content.textContent = generateCode(width, height);
      }
    });
  };

  const startPeriodicUpdates = () => {
    // Update ASCII content periodically
    setInterval(() => {
      updateAsciiContent();
    }, 200);

    // Continuous clipping updates for smooth scanning
    const updateClipping = () => {
      updateCardClipping();
      requestAnimationFrame(updateClipping);
    };
    updateClipping();
  };

  // Cards are non-interactive - removed all drag/scroll listeners

  const animateCards = () => {
    const animate = () => {
      const currentTime = performance.now();
      let deltaTime = (currentTime - lastTimeRef.current) / 1000;
      
      // Clamp delta time to prevent catch-up when tab becomes active again
      // Max 1/30 second (33ms) to prevent large jumps
      const maxDeltaTime = 1 / 30;
      if (deltaTime > maxDeltaTime) {
        deltaTime = maxDeltaTime;
      }
      
      lastTimeRef.current = currentTime;

      if (true) { // Always animate cards
        if (velocityRef.current > 30) {
          velocityRef.current *= 0.95;
        } else {
          velocityRef.current = Math.max(30, velocityRef.current);
        }

        positionRef.current += velocityRef.current * -1 * deltaTime; // Always move left

        // Use window.innerWidth to match scanner canvas coordinate system
        const containerWidth = window.innerWidth;
        const singleSetWidth = (400 + 60) * 30; // card width + gap * count for one set
        const isMobile = window.innerWidth <= 480;
        const scannerContainerX = containerWidth / 2 + (isMobile ? 5 : 85);
        const initialOffset = isMobile 
          ? containerWidth - 100  // Start from right side, just before scanner on mobile
          : scannerContainerX + 100; // Start almost before scanner on desktop

        // Seamless infinite loop: when one set moves completely off screen, reset to show next set
        if (positionRef.current < -singleSetWidth) {
          // Move position forward by one set width to seamlessly continue
          positionRef.current += singleSetWidth;
        } else if (positionRef.current > containerWidth + singleSetWidth) {
          positionRef.current = -singleSetWidth + initialOffset;
        }

        if (cardLineRef.current) {
          cardLineRef.current.style.transform = `translateX(${positionRef.current}px)`;
        }

        updateCardClipping();
      }

      animationIdRef.current = requestAnimationFrame(animate);
    };

    lastTimeRef.current = performance.now();
    animate();
  };

  const initParticleSystem = () => {
    if (!window.THREE || !particleCanvasRef.current) return;

    const THREE = window.THREE;
    const hasWebGLSupport = (() => {
      const testCanvas = document.createElement("canvas");
      return !!(
        window.WebGLRenderingContext &&
        (testCanvas.getContext("webgl") || testCanvas.getContext("experimental-webgl"))
      );
    })();
    if (!hasWebGLSupport) {
      return;
    }

    if (particleSystemRef.current) {
      particleSystemRef.current.destroy?.();
      particleSystemRef.current = null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SceneClass = THREE.Scene as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CameraClass = THREE.OrthographicCamera as any;
    const scene = new SceneClass();
    const camera = new CameraClass(
      -window.innerWidth / 2,
      window.innerWidth / 2,
      125,
      -125,
      1,
      1000
    );
    camera.position.z = 100;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RendererClass = THREE.WebGLRenderer as any;
    let renderer: any;
    try {
      renderer = new RendererClass({
        canvas: particleCanvasRef.current,
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
        failIfMajorPerformanceCaveat: false,
      });
    } catch (error) {
      console.warn("ThreeEffect: failed to create WebGL renderer", error);
      return;
    }
    renderer.setSize(window.innerWidth, 250);
    renderer.setClearColor(0x000000, 0);

    const particleCount = 400;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const GeometryClass = THREE.BufferGeometry as any;
    const geometry = new GeometryClass();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const sizes = new Float32Array(particleCount);
    const velocities = new Float32Array(particleCount);

    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const half = canvas.width / 2;
    const hue = 217;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0.025, "#fff");
    gradient.addColorStop(0.1, `hsl(${hue}, 61%, 33%)`);
    gradient.addColorStop(0.25, `hsl(${hue}, 64%, 6%)`);
    gradient.addColorStop(1, "transparent");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.fill();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TextureClass = THREE.CanvasTexture as any;
    const texture = new TextureClass(canvas);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * window.innerWidth * 2;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 250;
      positions[i * 3 + 2] = 0;
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 1;
      colors[i * 3 + 2] = 1;
      const orbitRadius = Math.random() * 200 + 100;
      sizes[i] = (Math.random() * (orbitRadius - 60) + 60) / 8;
      velocities[i] = Math.random() * 60 + 30;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BufferAttributeClass = THREE.BufferAttribute as any;
    geometry.setAttribute("position", new BufferAttributeClass(positions, 3));
    geometry.setAttribute("color", new BufferAttributeClass(colors, 3));
    geometry.setAttribute("size", new BufferAttributeClass(sizes, 1));

    const alphas = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      alphas[i] = (Math.random() * 8 + 2) / 10;
    }
    geometry.setAttribute("alpha", new BufferAttributeClass(alphas, 1));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MaterialClass = THREE.ShaderMaterial as any;
    const material = new MaterialClass({
      uniforms: {
        pointTexture: { value: texture },
        size: { value: 15.0 },
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        varying vec3 vColor;
        uniform float size;
        void main() {
          vAlpha = alpha;
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D pointTexture;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          gl_FragColor = vec4(vColor, vAlpha) * texture2D(pointTexture, gl_PointCoord);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PointsClass = THREE.Points as any;
    const particles = new PointsClass(geometry, material);
    scene.add(particles);

    const animate = () => {
      requestAnimationFrame(animate);
      if (particles) {
        const positions = particles.geometry.attributes.position.array as Float32Array;
        const alphas = particles.geometry.attributes.alpha.array as Float32Array;
        const time = Date.now() * 0.001;

        for (let i = 0; i < particleCount; i++) {
          positions[i * 3] += velocities[i] * 0.016;
          if (positions[i * 3] > window.innerWidth / 2 + 100) {
            positions[i * 3] = -window.innerWidth / 2 - 100;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 250;
          }
          positions[i * 3 + 1] += Math.sin(time + i * 0.1) * 0.5;

          const twinkle = Math.floor(Math.random() * 10);
          if (twinkle === 1 && alphas[i] > 0) {
            alphas[i] -= 0.05;
          } else if (twinkle === 2 && alphas[i] < 1) {
            alphas[i] += 0.05;
          }
          alphas[i] = Math.max(0, Math.min(1, alphas[i]));
        }

        particles.geometry.attributes.position.needsUpdate = true;
        particles.geometry.attributes.alpha.needsUpdate = true;
      }
      renderer.render(scene, camera);
    };

    animate();

    particleSystemRef.current = {
      destroy: () => {
        renderer.dispose();
        scene.remove(particles);
        particles.geometry.dispose();
        particles.material.dispose();
      },
    };
  };

  const initScanner = () => {
    if (!scannerCanvasRef.current) return;

    const canvas = scannerCanvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = window.innerWidth;
    const h = 300;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const particles: Particle[] = [];
    let count = 0;
    const maxParticles = 800;
    let intensity = 0.8;
    const isMobile = w <= 480;
    // Initialize lightBarX - will be updated by updateLightBarPosition
    let lightBarX = isMobile 
      ? w / 2 + 20  // 20px to the right of center on mobile
      : w / 2 + 85; // 85px to the right of center on desktop
    const lightBarWidth = 3;
    let fadeZone = 60;
    let scanningActive = false;
    let currentGlowIntensity = 1;

    const gradientCanvas = document.createElement("canvas");
    const gradientCtx = gradientCanvas.getContext("2d");
    if (!gradientCtx) return;

    gradientCanvas.width = 16;
    gradientCanvas.height = 16;
    const half = gradientCanvas.width / 2;
    const gradient = gradientCtx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(0.3, "rgba(196, 181, 253, 0.8)");
    gradient.addColorStop(0.7, "rgba(139, 92, 246, 0.4)");
    gradient.addColorStop(1, "transparent");
    gradientCtx.fillStyle = gradient;
    gradientCtx.beginPath();
    gradientCtx.arc(half, half, half, 0, Math.PI * 2);
    gradientCtx.fill();

    const createParticle = (): Particle => {
      const intensityRatio = intensity / 0.8;
      const speedMultiplier = 1 + (intensityRatio - 1) * 1.2;
      const sizeMultiplier = 1 + (intensityRatio - 1) * 0.7;

      return {
        x: lightBarX + (Math.random() - 0.5) * lightBarWidth,
        y: Math.random() * h,
        vx: (Math.random() * 0.8 + 0.2) * speedMultiplier,
        vy: (Math.random() - 0.5) * 0.3 * speedMultiplier,
        radius: (Math.random() * 0.6 + 0.4) * sizeMultiplier,
        alpha: Math.random() * 0.4 + 0.6,
        decay: Math.random() * 0.02 + 0.005 * (2 - intensityRatio * 0.5),
        originalAlpha: 0,
        life: 1.0,
        time: 0,
        startX: 0,
        twinkleSpeed: (Math.random() * 0.06 + 0.02) * speedMultiplier,
        twinkleAmount: Math.random() * 0.15 + 0.1,
      };
    };

    for (let i = 0; i < maxParticles; i++) {
      const particle: Particle = createParticle();
      particle.originalAlpha = particle.alpha;
      particle.startX = particle.x;
      count++;
      particles[count] = particle;
    }

    const updateParticle = (particle: Particle) => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.time++;
      particle.alpha = particle.originalAlpha * particle.life + Math.sin(particle.time * particle.twinkleSpeed) * particle.twinkleAmount;
      particle.life -= particle.decay;

      if (particle.x > w + 10 || particle.life <= 0) {
        particle.x = lightBarX + (Math.random() - 0.5) * lightBarWidth;
        particle.y = Math.random() * h;
        particle.vx = Math.random() * 0.8 + 0.2;
        particle.vy = (Math.random() - 0.5) * 0.3;
        particle.alpha = Math.random() * 0.4 + 0.6;
        particle.originalAlpha = particle.alpha;
        particle.life = 1.0;
        particle.time = 0;
        particle.startX = particle.x;
      }
    };

    const drawParticle = (particle: Particle) => {
      if (particle.life <= 0) return;
      let fadeAlpha = 1;
      if (particle.y < fadeZone) {
        fadeAlpha = particle.y / fadeZone;
      } else if (particle.y > h - fadeZone) {
        fadeAlpha = (h - particle.y) / fadeZone;
      }
      fadeAlpha = Math.max(0, Math.min(1, fadeAlpha));
      ctx.globalAlpha = particle.alpha * fadeAlpha;
      ctx.drawImage(gradientCanvas, particle.x - particle.radius, particle.y - particle.radius, particle.radius * 2, particle.radius * 2);
    };

    const drawLightBar = () => {
      const verticalGradient = ctx.createLinearGradient(0, 0, 0, h);
      verticalGradient.addColorStop(0, "rgba(255, 255, 255, 0)");
      verticalGradient.addColorStop(fadeZone / h, "rgba(255, 255, 255, 1)");
      verticalGradient.addColorStop(1 - fadeZone / h, "rgba(255, 255, 255, 1)");
      verticalGradient.addColorStop(1, "rgba(255, 255, 255, 0)");

      ctx.globalCompositeOperation = "lighter";

      const targetGlowIntensity = scanningActive ? 3.5 : 1;
      if (!currentGlowIntensity) currentGlowIntensity = 1;
      currentGlowIntensity += (targetGlowIntensity - currentGlowIntensity) * 0.05;

      const glowIntensity = currentGlowIntensity;
      const lineWidth = lightBarWidth;
      const glow1Alpha = scanningActive ? 1.0 : 0.8;
      const glow2Alpha = scanningActive ? 0.8 : 0.6;
      const glow3Alpha = scanningActive ? 0.6 : 0.4;

      // Core gradient
      const coreGradient = ctx.createLinearGradient(lightBarX - lineWidth / 2, 0, lightBarX + lineWidth / 2, 0);
      coreGradient.addColorStop(0, "rgba(255, 255, 255, 0)");
      coreGradient.addColorStop(0.3, `rgba(255, 255, 255, ${0.9 * glowIntensity})`);
      coreGradient.addColorStop(0.5, `rgba(255, 255, 255, ${1 * glowIntensity})`);
      coreGradient.addColorStop(0.7, `rgba(255, 255, 255, ${0.9 * glowIntensity})`);
      coreGradient.addColorStop(1, "rgba(255, 255, 255, 0)");

      ctx.globalAlpha = 1;
      ctx.fillStyle = coreGradient;
      ctx.beginPath();
      const radius = 15;
      const x = lightBarX - lineWidth / 2;
      const y = 0;
      const width = lineWidth;
      const height = h;
      if (ctx.roundRect) {
        ctx.roundRect(x, y, width, height, radius);
      } else {
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
      }
      ctx.fill();

      // Glow layer 1
      const glow1Gradient = ctx.createLinearGradient(lightBarX - lineWidth * 2, 0, lightBarX + lineWidth * 2, 0);
      glow1Gradient.addColorStop(0, "rgba(139, 92, 246, 0)");
      glow1Gradient.addColorStop(0.5, `rgba(196, 181, 253, ${0.8 * glowIntensity})`);
      glow1Gradient.addColorStop(1, "rgba(139, 92, 246, 0)");

      ctx.globalAlpha = glow1Alpha;
      ctx.fillStyle = glow1Gradient;
      ctx.beginPath();
      const glow1Radius = 25;
      if (ctx.roundRect) {
        ctx.roundRect(lightBarX - lineWidth * 2, 0, lineWidth * 4, h, glow1Radius);
      } else {
        const gx = lightBarX - lineWidth * 2;
        const gw = lineWidth * 4;
        ctx.moveTo(gx + glow1Radius, 0);
        ctx.lineTo(gx + gw - glow1Radius, 0);
        ctx.quadraticCurveTo(gx + gw, 0, gx + gw, glow1Radius);
        ctx.lineTo(gx + gw, h - glow1Radius);
        ctx.quadraticCurveTo(gx + gw, h, gx + gw - glow1Radius, h);
        ctx.lineTo(gx + glow1Radius, h);
        ctx.quadraticCurveTo(gx, h, gx, h - glow1Radius);
        ctx.lineTo(gx, glow1Radius);
        ctx.quadraticCurveTo(gx, 0, gx + glow1Radius, 0);
        ctx.closePath();
      }
      ctx.fill();

      // Glow layer 2
      const glow2Gradient = ctx.createLinearGradient(lightBarX - lineWidth * 4, 0, lightBarX + lineWidth * 4, 0);
      glow2Gradient.addColorStop(0, "rgba(139, 92, 246, 0)");
      glow2Gradient.addColorStop(0.5, `rgba(139, 92, 246, ${0.4 * glowIntensity})`);
      glow2Gradient.addColorStop(1, "rgba(139, 92, 246, 0)");

      ctx.globalAlpha = glow2Alpha;
      ctx.fillStyle = glow2Gradient;
      ctx.beginPath();
      const glow2Radius = 35;
      if (ctx.roundRect) {
        ctx.roundRect(lightBarX - lineWidth * 4, 0, lineWidth * 8, h, glow2Radius);
      } else {
        const gx = lightBarX - lineWidth * 4;
        const gw = lineWidth * 8;
        ctx.moveTo(gx + glow2Radius, 0);
        ctx.lineTo(gx + gw - glow2Radius, 0);
        ctx.quadraticCurveTo(gx + gw, 0, gx + gw, glow2Radius);
        ctx.lineTo(gx + gw, h - glow2Radius);
        ctx.quadraticCurveTo(gx + gw, h, gx + gw - glow2Radius, h);
        ctx.lineTo(gx + glow2Radius, h);
        ctx.quadraticCurveTo(gx, h, gx, h - glow2Radius);
        ctx.lineTo(gx, glow2Radius);
        ctx.quadraticCurveTo(gx, 0, gx + glow2Radius, 0);
        ctx.closePath();
      }
      ctx.fill();

      // Glow layer 3 (only when scanning)
      if (scanningActive) {
        const glow3Gradient = ctx.createLinearGradient(lightBarX - lineWidth * 8, 0, lightBarX + lineWidth * 8, 0);
        glow3Gradient.addColorStop(0, "rgba(139, 92, 246, 0)");
        glow3Gradient.addColorStop(0.5, "rgba(139, 92, 246, 0.2)");
        glow3Gradient.addColorStop(1, "rgba(139, 92, 246, 0)");

        ctx.globalAlpha = glow3Alpha;
        ctx.fillStyle = glow3Gradient;
        ctx.beginPath();
        const glow3Radius = 45;
        if (ctx.roundRect) {
          ctx.roundRect(lightBarX - lineWidth * 8, 0, lineWidth * 16, h, glow3Radius);
        } else {
          const gx = lightBarX - lineWidth * 8;
          const gw = lineWidth * 16;
          ctx.moveTo(gx + glow3Radius, 0);
          ctx.lineTo(gx + gw - glow3Radius, 0);
          ctx.quadraticCurveTo(gx + gw, 0, gx + gw, glow3Radius);
          ctx.lineTo(gx + gw, h - glow3Radius);
          ctx.quadraticCurveTo(gx + gw, h, gx + gw - glow3Radius, h);
          ctx.lineTo(gx + glow3Radius, h);
          ctx.quadraticCurveTo(gx, h, gx, h - glow3Radius);
          ctx.lineTo(gx, glow3Radius);
          ctx.quadraticCurveTo(gx, 0, gx + glow3Radius, 0);
          ctx.closePath();
        }
        ctx.fill();
      }

      ctx.globalCompositeOperation = "destination-in";
      ctx.globalAlpha = 1;
      ctx.fillStyle = verticalGradient;
      ctx.fillRect(0, 0, w, h);
    };

    const render = () => {
      const targetIntensity = scanningActive ? 1.8 : 0.8;
      const targetMaxParticles = scanningActive ? 2500 : 800;
      const targetFadeZone = scanningActive ? 35 : 60;
      
      intensity += (targetIntensity - intensity) * 0.05;
      fadeZone += (targetFadeZone - fadeZone) * 0.05;

      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      drawLightBar();
      ctx.globalCompositeOperation = "lighter";

      for (let i = 1; i <= count; i++) {
        const particle = particles[i];
        if (particle) {
          updateParticle(particle);
          drawParticle(particle);
        }
      }

      const currentMaxParticles = Math.floor(targetMaxParticles);
      const currentIntensity = intensity;

      if (Math.random() < currentIntensity && count < currentMaxParticles) {
        const particle: Particle = createParticle();
        particle.originalAlpha = particle.alpha;
        particle.startX = particle.x;
        count++;
        particles[count] = particle;
      }

      const intensityRatio = intensity / 0.8;

      if (intensityRatio > 1.1 && Math.random() < (intensityRatio - 1.0) * 1.2) {
        const particle: Particle = createParticle();
        particle.originalAlpha = particle.alpha;
        particle.startX = particle.x;
        count++;
        particles[count] = particle;
      }

      if (intensityRatio > 1.3 && Math.random() < (intensityRatio - 1.3) * 1.4) {
        const particle: Particle = createParticle();
        particle.originalAlpha = particle.alpha;
        particle.startX = particle.x;
        count++;
        particles[count] = particle;
      }

      if (intensityRatio > 1.5 && Math.random() < (intensityRatio - 1.5) * 1.8) {
        const particle: Particle = createParticle();
        particle.originalAlpha = particle.alpha;
        particle.startX = particle.x;
        count++;
        particles[count] = particle;
      }

      if (intensityRatio > 2.0 && Math.random() < (intensityRatio - 2.0) * 2.0) {
        const particle: Particle = createParticle();
        particle.originalAlpha = particle.alpha;
        particle.startX = particle.x;
        count++;
        particles[count] = particle;
      }

      if (count > currentMaxParticles + 200) {
        const excessCount = Math.min(15, count - currentMaxParticles);
        for (let i = 0; i < excessCount; i++) {
          delete particles[count - i];
        }
        count -= excessCount;
      }
    };

    const animate = () => {
      render();
      requestAnimationFrame(animate);
    };

    // Check for scanning - use same transform-based calculation
    const checkScanning = () => {
      if (!cardLineRef.current) {
        requestAnimationFrame(checkScanning);
        return;
      }
      
      const isMobile = window.innerWidth <= 480;
      const scannerWidth = isMobile ? 6 : 8;
      const scannerContainerX = getScannerContainerX();
      const scannerLeft = scannerContainerX - scannerWidth / 2;
      const scannerRight = scannerContainerX + scannerWidth / 2;

      // Use positionRef directly
      const cardLineX = positionRef.current;

      const cardWidth = 400;
      const cardGap = 60;
      const cardTotalWidth = cardWidth + cardGap;

      let anyScanning = false;
      document.querySelectorAll(".card-wrapper").forEach((wrapper, index) => {
        const cardStartX = cardLineX + (index * cardTotalWidth);
        const cardEndX = cardStartX + cardWidth;
        if (cardStartX < scannerRight && cardEndX > scannerLeft) {
          anyScanning = true;
        }
      });

      scanningActive = anyScanning;
      requestAnimationFrame(checkScanning);
    };

    animate();
    checkScanning();

    // Handle window resize and scroll
    // Note: lightBarX should be in canvas coordinates (0 to w), not viewport coordinates
    // The canvas is positioned absolutely within the container, so we use container width
    const updateLightBarPosition = () => {
      w = window.innerWidth;
      const isMobile = w <= 480;
      // Use canvas-relative coordinates (0 to w), not viewport coordinates
      // Reduced mobile offset from 20 to 5
      lightBarX = isMobile 
        ? w / 2 + 5  // 5px to the right of center on mobile (reduced from 20)
        : w / 2 + 85; // 85px to the right of center on desktop
    };
    
    // Initialize position
    updateLightBarPosition();
    
    const handleResize = () => {
      w = window.innerWidth;
      updateLightBarPosition();
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    
    // No need to update on scroll - canvas is absolutely positioned and moves with container
    // The lightBarX is in canvas coordinates, not viewport coordinates

    window.addEventListener("resize", handleResize);

    // Expose setScannerScanning function
    interface WindowWithScanner {
      setScannerScanning?: (active: boolean) => void;
    }
    const windowWithScanner = window as Window & WindowWithScanner;
    if (typeof window !== 'undefined') {
      windowWithScanner.setScannerScanning = (active: boolean) => {
        scanningActive = active;
      };
    }

    scannerRef.current = {
      destroy: () => {
        window.removeEventListener("resize", handleResize);
        if (typeof window !== 'undefined') {
          delete windowWithScanner.setScannerScanning;
        }
      },
    };
  };

  return (
    <div className="three-effect-container">
      <div className="container" ref={containerRef}>
        <canvas id="particleCanvas" ref={particleCanvasRef}></canvas>
        <canvas 
          id="scannerCanvas" 
          ref={scannerCanvasRef} 
          style={{ display: 'block', opacity: isHeroVisible ? 1 : 0, transition: 'opacity 0.3s' }}
        ></canvas>
        <div className="scanner" style={{ opacity: isHeroVisible ? 1 : 0, transition: 'opacity 0.3s' }}></div>

        <div className="card-stream" ref={cardStreamRef}>
          <div className="card-line" ref={cardLineRef}></div>
        </div>
      </div>
    </div>
  );
}

