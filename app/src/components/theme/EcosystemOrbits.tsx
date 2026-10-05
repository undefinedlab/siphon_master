"use client";

import { useEffect, useRef } from "react";
import "./EcosystemOrbits.css";

interface EcosystemOrbitsProps {
  chains: string[];
  protocols: string[];
}

export default function EcosystemOrbits({ chains, protocols }: EcosystemOrbitsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const animationIdRef = useRef<number | null>(null);
  const angleRef = useRef(0);

  useEffect(() => {
    const animate = () => {
      // Slower animation speed
      angleRef.current += 0.001;
      
      if (containerRef.current) {
        const chainItems = containerRef.current.querySelectorAll('.orbit-item.chain');
        const protocolItems = containerRef.current.querySelectorAll('.orbit-item.protocol');
        
        // Get container dimensions for proper centering
        const container = containerRef.current.querySelector('.orbits-container') as HTMLElement;
        if (!container) return;
        
        const containerWidth = container.offsetWidth;
        // containerHeight removed - unused
        
        // The orbits are positioned at bottom: 0, so their bottom edge is at the bottom of container
        // Chain circle: 800px diameter, radius 400px, center is 400px up from bottom
        // Protocol circle: 1200px diameter, radius 600px, center is 600px up from bottom
        // Since we're showing top half (clip bottom 50%), visible area is containerHeight/2
        // Both circle centers are at the bottom of the visible area = containerHeight/2
        const chainRadius = 300;
        const protocolRadius = 450;
        const centerX = containerWidth / 2;
        // Circle centers moved lower - at 500px from top (slightly below visible area bottom)
        // This provides better framing for the visible half
        const centerY = 500;
        
        chainItems.forEach((item, index) => {
          const angle = angleRef.current + (index * (Math.PI * 2 / chains.length));
          // Calculate position on circle
          const x = centerX + Math.cos(angle) * chainRadius;
          const y = centerY + Math.sin(angle) * chainRadius;
          // Only show items in upper half (y <= centerY, which means sin(angle) <= 0)
          const isUpperHalf = y <= centerY;
          (item as HTMLElement).style.left = `${x}px`;
          (item as HTMLElement).style.top = `${y}px`;
          (item as HTMLElement).style.transform = 'translate(-50%, -50%)';
          (item as HTMLElement).style.opacity = isUpperHalf ? '1' : '0';
          (item as HTMLElement).style.pointerEvents = isUpperHalf ? 'auto' : 'none';
        });
        
        protocolItems.forEach((item, index) => {
          const angle = -angleRef.current + (index * (Math.PI * 2 / protocols.length));
          // Calculate position on circle
          const x = centerX + Math.cos(angle) * protocolRadius;
          const y = centerY + Math.sin(angle) * protocolRadius;
          // Only show items in upper half (y <= centerY, which means sin(angle) <= 0)
          const isUpperHalf = y <= centerY;
          (item as HTMLElement).style.left = `${x}px`;
          (item as HTMLElement).style.top = `${y}px`;
          (item as HTMLElement).style.transform = 'translate(-50%, -50%)';
          (item as HTMLElement).style.opacity = isUpperHalf ? '1' : '0';
          (item as HTMLElement).style.pointerEvents = isUpperHalf ? 'auto' : 'none';
        });
      }
      
      animationIdRef.current = requestAnimationFrame(animate);
    };
    
    animationIdRef.current = requestAnimationFrame(animate);
    
    return () => {
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
    };
  }, [chains.length, protocols.length]);

  return (
    <div ref={containerRef} className="ecosystem-orbits">
      <div className="orbits-container">
        {/* Chain orbit circle */}
        <div className="orbit orbit-chains"></div>
        {/* Chain items - positioned relative to container */}
        {chains.map((chain, index) => (
          <div key={chain} className="orbit-item chain" style={{ '--index': index } as React.CSSProperties}>
            <span className="orbit-label">{chain}</span>
          </div>
        ))}
        
        {/* Protocol orbit circle */}
        <div className="orbit orbit-protocols"></div>
        {/* Protocol items - positioned relative to container */}
        {protocols.map((protocol, index) => (
          <div key={protocol} className="orbit-item protocol" style={{ '--index': index } as React.CSSProperties}>
            <span className="orbit-label">{protocol}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

