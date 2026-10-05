"use client";

import { WidgetArea } from "@/components/widgets/WidgetArea";
import { useDashboardCustomize } from "@/components/landing/dashboard-customize-context";

export function BuildWidgetSection() {
  const { themeClassName } = useDashboardCustomize();

  return (
    <section className={`${themeClassName} w-full max-sm:px-0 sm:px-4 md:px-6`}>
      <WidgetArea hideDashboardCollapse />
    </section>
  );
}
