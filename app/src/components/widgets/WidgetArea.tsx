"use client";

import { DashboardWidgetGrid } from "@/components/landing/DashboardWidgetGrid";

type WidgetAreaProps = {
  hideDashboardCollapse?: boolean;
};

export function WidgetArea({ hideDashboardCollapse = false }: WidgetAreaProps) {
  return <DashboardWidgetGrid hideCollapseControl={hideDashboardCollapse} />;
}
