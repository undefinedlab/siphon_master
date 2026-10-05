import { expect, test } from "bun:test";
import { POSTMAN_TICK_MS, busDepartureMs, busEtaText, countdown } from "../v3/aspBusV3";

test("the bus leaves one epoch after the last publish, plus up to one postman tick", () => {
  expect(busDepartureMs(1_000, 300)).toBe(1_300_000 + POSTMAN_TICK_MS);
});

test("the target is fixed, so the countdown actually counts down", () => {
  const target = busDepartureMs(1_000, 300); // 1_360_000
  expect(busEtaText(target, target - 125_000)).toBe("next compliance bus in 2:05");
  expect(busEtaText(target, target - 5_000)).toBe("next compliance bus in 0:05");
});

test("past the target the epoch gate is open — boarding now, not a stuck 1:00", () => {
  expect(busEtaText(busDepartureMs(0, 300), 10_000_000)).toMatch(/boarding/);
});

test("unknown hub state says so instead of inventing a time", () => {
  expect(busEtaText(null)).toMatch(/up to ~6 min/);
});

test("countdown formats m:ss and never goes negative", () => {
  expect(countdown(65_000, 0)).toBe("1:05");
  expect(countdown(0, 5_000)).toBe("0:00");
});
