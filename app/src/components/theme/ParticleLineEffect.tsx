"use client";

import { useEffect, useRef } from "react";
import "./ParticleLineEffect.css";

interface ThreeLibrary {
  [key: string]: unknown;
}

declare global {
  interface Window {
    THREE: ThreeLibrary;
  }
}

interface ParticleLineEffectProps {
  isActive: boolean;
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

export default function ParticleLineEffect({ isActive }: ParticleLineEffectProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationIdRef = useRef<number | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const intensityRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !canvasRef.current) return;

    // Load Three.js dynamically
    const loadThree = async () => {
      if (!window.THREE) {
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
      if (!window.THREE || !canvasRef.current || !containerRef.current) return;

      const THREE = window.THREE;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      
      const width = container.offsetWidth;
      const height = container.offsetHeight;
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scene = new (THREE as any).Scene();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const camera = new (THREE as any).OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 1, 1000);
      camera.position.z = 100;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renderer = new (THREE as any).WebGLRenderer({ 
        canvas, 
        alpha: true, 
        antialias: true 
      });
      renderer.setSize(width, height);
      renderer.setPixelRatio(window.devicePixelRatio);

      // Create particles along a horizontal line
      const particleCount = 150;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geometry = new (THREE as any).BufferGeometry();
      const positions = new Float32Array(particleCount * 3);
      const colors = new Float32Array(particleCount * 3);
      const sizes = new Float32Array(particleCount);

      const lineY = 0; // Center line
      const lineWidth = width * 0.8; // 80% of container width
      const lineStartX = -lineWidth / 2;

      for (let i = 0; i < particleCount; i++) {
        const i3 = i * 3;
        const progress = i / (particleCount - 1);
        
        // Position along the line
        positions[i3] = lineStartX + progress * lineWidth;
        positions[i3 + 1] = lineY + (Math.random() - 0.5) * 2; // Small vertical variation
        positions[i3 + 2] = 0;

        // Colors (white with slight variation)
        const brightness = 0.8 + Math.random() * 0.2;
        colors[i3] = brightness;
        colors[i3 + 1] = brightness;
        colors[i3 + 2] = brightness;

        // Sizes
        sizes[i] = 1 + Math.random() * 2;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      geometry.setAttribute('position', new (THREE as any).BufferAttribute(positions, 3));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      geometry.setAttribute('color', new (THREE as any).BufferAttribute(colors, 3));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      geometry.setAttribute('size', new (THREE as any).BufferAttribute(sizes, 1));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const material = new (THREE as any).ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          intensity: { value: 0 },
        },
        vertexShader: `
          attribute float size;
          varying vec3 vColor;
          uniform float time;
          uniform float intensity;
          
          void main() {
            vColor = color;
            vec3 pos = position;
            // Add subtle movement
            pos.y += sin(time * 2.0 + position.x * 0.01) * 3.0 * intensity;
            vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
            gl_PointSize = size * (300.0 / -mvPosition.z) * (0.5 + intensity * 0.5);
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          uniform float intensity;
          
          void main() {
            float dist = distance(gl_PointCoord, vec2(0.5));
            if (dist > 0.5) discard;
            
            float alpha = (1.0 - dist * 2.0) * (0.3 + intensity * 0.7);
            gl_FragColor = vec4(vColor, alpha);
          }
        `,
        transparent: true,
        vertexColors: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const particles = new (THREE as any).Points(geometry, material);
      scene.add(particles);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      particlesRef.current = [particles, material, scene, camera, renderer] as any;

      // Animation loop
      const animate = () => {
        animationIdRef.current = requestAnimationFrame(animate);
        
        const [particles, material] = particlesRef.current;
        if (!particles || !material) return;

        // Update intensity based on isActive prop
        const targetIntensity = isActive ? 1.0 : 0.3;
        intensityRef.current += (targetIntensity - intensityRef.current) * 0.1;
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (material as any).uniforms.time.value += 0.016;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (material as any).uniforms.intensity.value = intensityRef.current;
        
        // Rotate particles slightly for effect
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (particles as any).rotation.z += 0.001;
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (renderer as any).render(scene, camera);
      };

      animate();

      // Handle resize
      const handleResize = () => {
        const newWidth = container.offsetWidth;
        const newHeight = container.offsetHeight;
        
        camera.left = -newWidth / 2;
        camera.right = newWidth / 2;
        camera.top = newHeight / 2;
        camera.bottom = -newHeight / 2;
        camera.updateProjectionMatrix();
        
        renderer.setSize(newWidth, newHeight);
      };

      window.addEventListener('resize', handleResize);

      return () => {
        window.removeEventListener('resize', handleResize);
        if (animationIdRef.current) {
          cancelAnimationFrame(animationIdRef.current);
        }
        if (renderer) {
          renderer.dispose();
        }
        if (geometry) {
          geometry.dispose();
        }
        if (material) {
          material.dispose();
        }
      };
    });

    return () => {
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
    };
  }, [isActive]);

  return (
    <div ref={containerRef} className="particle-line-container">
      <canvas ref={canvasRef} className="particle-line-canvas"></canvas>
    </div>
  );
}

