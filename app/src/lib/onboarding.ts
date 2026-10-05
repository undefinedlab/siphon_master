const STORAGE_KEY = "siphon-onboarding-complete";

export function hasCompletedOnboarding(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return true;
  }
}

export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // ignore quota / private mode
  }
}

const NODE_TOUR_STORAGE_KEY = "siphon-seen-node-tour";

/** The node-canvas explainer is deferred: shown the first time the user actually opens it, not upfront. */
export function hasSeenNodeTour(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(NODE_TOUR_STORAGE_KEY) === "true";
  } catch {
    return true;
  }
}

export function markNodeTourSeen(): void {
  try {
    localStorage.setItem(NODE_TOUR_STORAGE_KEY, "true");
  } catch {
    // ignore quota / private mode
  }
}
