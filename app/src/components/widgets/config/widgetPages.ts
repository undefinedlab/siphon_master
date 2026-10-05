import { gridSpanForLayout, type PlacedWidget } from "./grid";

export type WidgetGridSpec = { cols: number; rows: number };

export const DESKTOP_WIDGET_GRID: WidgetGridSpec = { cols: 6, rows: 3 };
export const MOBILE_WIDGET_GRID: WidgetGridSpec = { cols: 2, rows: 2 };

export type PaginatedWidget = PlacedWidget & {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
};

export type PaginatedPage = {
  widgets: PaginatedWidget[];
  rowsUsed: number;
};

function createOccupancy(cols: number, rows: number): boolean[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
}

function canPlace(
  grid: boolean[][],
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number,
  cols: number,
  rows: number,
): boolean {
  if (col + colSpan > cols || row + rowSpan > rows) return false;
  for (let r = row; r < row + rowSpan; r++) {
    for (let c = col; c < col + colSpan; c++) {
      if (grid[r][c]) return false;
    }
  }
  return true;
}

function markPlace(
  grid: boolean[][],
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number,
) {
  for (let r = row; r < row + rowSpan; r++) {
    for (let c = col; c < col + colSpan; c++) {
      grid[r][c] = true;
    }
  }
}

function findPlacement(
  grid: boolean[][],
  colSpan: number,
  rowSpan: number,
  cols: number,
  rows: number,
): { col: number; row: number } | null {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (canPlace(grid, col, row, colSpan, rowSpan, cols, rows)) {
        return { col, row };
      }
    }
  }
  return null;
}

function rowsUsedFor(widgets: PaginatedWidget[]): number {
  if (widgets.length === 0) return 0;
  return Math.max(...widgets.map((w) => w.row + w.rowSpan));
}

function finalizePage(widgets: PaginatedWidget[], spec: WidgetGridSpec): PaginatedPage {
  return { widgets, rowsUsed: rowsUsedFor(widgets) || spec.rows };
}

/**
 * Pack widgets into fixed-size dashboard pages.
 * Scans all remaining widgets on each page so smaller tiles later in the list
 * can fill gaps left by larger ones (e.g. news + swap on the same mobile page).
 */
export function paginateWidgets(
  placed: PlacedWidget[],
  spec: WidgetGridSpec,
): PaginatedPage[] {
  const remaining = [...placed];
  const pages: PaginatedPage[] = [];

  while (remaining.length > 0) {
    const current: PaginatedWidget[] = [];
    const grid = createOccupancy(spec.cols, spec.rows);
    let placedOnPage = true;

    while (placedOnPage) {
      placedOnPage = false;
      for (let i = 0; i < remaining.length; i++) {
        const widget = remaining[i];
        const { col: colSpan, row: rowSpan } = gridSpanForLayout(widget.size, spec);
        const placement = findPlacement(grid, colSpan, rowSpan, spec.cols, spec.rows);
        if (!placement) continue;

        markPlace(grid, placement.col, placement.row, colSpan, rowSpan);
        current.push({
          ...widget,
          col: placement.col,
          row: placement.row,
          colSpan,
          rowSpan,
        });
        remaining.splice(i, 1);
        placedOnPage = true;
        break;
      }
    }

    if (current.length === 0) {
      const widget = remaining.shift()!;
      const { col: colSpan, row: rowSpan } = gridSpanForLayout(widget.size, spec);
      current.push({
        ...widget,
        col: 0,
        row: 0,
        colSpan,
        rowSpan: Math.min(rowSpan, spec.rows),
      });
    }

    pages.push(finalizePage(current, spec));
  }

  return pages.length > 0 ? pages : [{ widgets: [], rowsUsed: spec.rows }];
}

export function pageCountForWidgets(placed: PlacedWidget[], spec: WidgetGridSpec): number {
  return paginateWidgets(placed, spec).length;
}
