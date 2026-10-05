import type { SimHighlightStatus } from "./useCanvasSimulation";

export function simHighlightClass(
  status?: SimHighlightStatus,
  shaking?: boolean,
  exiting?: boolean
): string {
  const parts: string[] = [];
  if (status) parts.push(`sim-${status}`);
  if (shaking) parts.push("sim-shake");
  if (exiting && status) parts.push("sim-leaving");
  return parts.join(" ");
}
