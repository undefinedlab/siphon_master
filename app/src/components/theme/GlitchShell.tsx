import type { ElementType, ReactNode } from "react";
import styles from "./glitchShell.module.css";

type GlitchShellProps<T extends ElementType = "div"> = {
  as?: T;
  children: ReactNode;
  className?: string;
};

export default function GlitchShell<T extends ElementType = "div">({
  as,
  children,
  className = "",
}: GlitchShellProps<T>) {
  const Tag = as ?? "div";

  return (
    <Tag className={`${styles.shell} ${className}`.trim()}>
      <span className={styles.layerMain}>{children}</span>
      <span className={styles.layerTop} aria-hidden>
        {children}
      </span>
      <span className={styles.layerBottom} aria-hidden>
        {children}
      </span>
    </Tag>
  );
}
