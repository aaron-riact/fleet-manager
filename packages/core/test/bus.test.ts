import { describe, expect, test } from "bun:test";
import { assertValidFilter, matchTopic } from "../src/bus.js";

describe("matchTopic", () => {
  test("exact match", () => {
    expect(matchTopic("a/b/c", "a/b/c")).toBe(true);
    expect(matchTopic("a/b/c", "a/b/d")).toBe(false);
    expect(matchTopic("a/b", "a/b/c")).toBe(false);
  });

  test("'+' matches exactly one level", () => {
    expect(matchTopic("a/+/c", "a/b/c")).toBe(true);
    expect(matchTopic("+/+/+", "a/b/c")).toBe(true);
    expect(matchTopic("a/+", "a/b/c")).toBe(false);
  });

  test("'#' matches rest as final level", () => {
    expect(matchTopic("a/#", "a/b/c")).toBe(true);
    expect(matchTopic("#", "a/b/c")).toBe(true);
    expect(matchTopic("a/b/#", "a/b")).toBe(true);
  });
});

describe("assertValidFilter", () => {
  test("accepts valid filters", () => {
    expect(() => assertValidFilter("a/b/c")).not.toThrow();
    expect(() => assertValidFilter("a/+/c")).not.toThrow();
    expect(() => assertValidFilter("a/#")).not.toThrow();
    expect(() => assertValidFilter("#")).not.toThrow();
  });

  test("rejects misplaced wildcards", () => {
    expect(() => assertValidFilter("")).toThrow();
    expect(() => assertValidFilter("a/#/c")).toThrow();
    expect(() => assertValidFilter("a/b+c")).toThrow();
    expect(() => assertValidFilter("a/b#")).toThrow();
  });
});
