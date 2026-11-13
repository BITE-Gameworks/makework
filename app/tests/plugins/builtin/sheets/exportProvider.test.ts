import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbookSheet } from "../../../../src/plugins/builtin/sheets/data";
import { calendarValues, svg } from "../../../../src/plugins/builtin/sheets/exportProvider";

const sheet: WorkbookSheet = {
  id: 4, channel_id: 2, name: "Calendar", color: "", locked: false, z: 1, rows: null, cols: null,
  mode: "calendar", calendar: { month: "2024-01", firstWeekday: 1, itemsPerDay: 4 },
  frozen_rows: 0, frozen_cols: 0, col_widths: {}, row_heights: {}, rules: [],
  cells: [{ id: 1, sheet_id: 4, row: 19_723 * 4, col: 0, value: "Release", style: {}, author_id: 1, updated_at: "" }],
};

describe("Sheets calendar export", () => {
  afterEach(() => vi.useRealTimers());
  it("shows the current month, starts weeks on the configured day and reads the calendar's date-mapped cells", () => {
    // The saved month (a month someone paged to once) isn't what the export shows; the month it is now is.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    const matrix = calendarValues({ ...sheet, calendar: { ...sheet.calendar, month: "2023-06" } }, [sheet]);
    expect(matrix[0]).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(matrix[1][0]).toBe("1 · Release");
  });
});

describe("sheet image export", () => {
  it("wraps long cell text inside its column and makes the row tall enough", () => {
    const image = svg([["A long note that does not fit in one cell", "x"]], () => 128, () => 28);
    expect(image.match(/<tspan/g)!.length).toBeGreaterThan(2);
    const [, height] = image.match(/height="(\d+)"/)!;
    expect(Number(height)).toBeGreaterThan(28);
    expect(image).toContain('width="256"');
  });
});
