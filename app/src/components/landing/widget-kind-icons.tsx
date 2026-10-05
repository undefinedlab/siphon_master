import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  ChartLine,
  Coins,
  Gauge,
  LayoutGrid,
  Newspaper,
  PieChart,
  Play,
  Target,
  TrendingUp,
  Volume2,
  Wallet,
} from "lucide-react";
import type { WidgetKind } from "@/components/widgets/config/grid";

export const WIDGET_KIND_ICONS: Record<WidgetKind, LucideIcon> = {
  "fear-greed": Gauge,
  "market-cap": TrendingUp,
  "market-volume": Volume2,
  dominance: PieChart,
  news: Newspaper,
  swap: ArrowLeftRight,
  runs: Play,
  predictions: Target,
  coins: Coins,
  opportunities: LayoutGrid,
  wallet: Wallet,
  chart: ChartLine,
};
