import { describe, expect, test } from "bun:test";
import { shellColumns, touchStyle } from "../src/responsive.js";

describe("responsive layout decisions", () => {
  test("shell stacks below the breakpoint", () => {
    expect(shellColumns(false)).toBe("minmax(0, 1fr) 320px");
    expect(shellColumns(true)).toBe("minmax(0, 1fr)");
  });

  test("touch sizing only applies when narrow", () => {
    expect(touchStyle(false)).toEqual({});
    expect(touchStyle(true)).toMatchObject({ minHeight: 44 });
  });
});
