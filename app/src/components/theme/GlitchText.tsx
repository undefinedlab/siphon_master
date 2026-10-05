import { Fira_Mono } from "next/font/google";
import type { ElementType } from "react";
import GlitchShell from "./GlitchShell";

const firaMono = Fira_Mono({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

type GlitchTextProps<T extends ElementType = "span"> = {
  as?: T;
  children: string;
  className?: string;
};

export default function GlitchText<T extends ElementType = "span">({
  as,
  children,
  className = "",
}: GlitchTextProps<T>) {
  return (
    <GlitchShell as={as} className={`${firaMono.className} ${className}`.trim()}>
      {children}
    </GlitchShell>
  );
}
