"use strict";

/**
 * DELTA Z-6: CI workflow must gate spend-core + check:vk (not only Jest pins).
 */
const fs = require("fs");
const path = require("path");

const CI_YML = path.resolve(__dirname, "../.github/workflows/ci.yml");

describe("DELTA OMEGA re-audit Z-6 (CI spend-core + check:vk gates)", () => {
  test("workflow runs cargo test -p spend-core", () => {
    const yml = fs.readFileSync(CI_YML, "utf8");
    expect(yml).toMatch(/cargo test -p spend-core/);
  });

  test("workflow runs npm run check:vk", () => {
    const yml = fs.readFileSync(CI_YML, "utf8");
    expect(yml).toMatch(/check:vk/);
  });
});
