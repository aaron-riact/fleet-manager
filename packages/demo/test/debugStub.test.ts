import { describe, expect, test } from "bun:test";
import { namespaceFilter } from "../src/debugStub.js";

// graferse now logs at two levels: `graferse` is one line per robot move,
// `graferse:walk` is the per-edge tree. The default must give the first
// without the second, or the console floods again.
describe("debug namespace matching", () => {
  test("an exact name does not enable its children", () => {
    const on = namespaceFilter("graferse");
    expect(on("graferse")).toBe(true);
    expect(on("graferse:walk")).toBe(false);
  });

  test("a trailing star enables the children too", () => {
    const on = namespaceFilter("graferse*");
    expect(on("graferse")).toBe(true);
    expect(on("graferse:walk")).toBe(true);
  });

  test("star enables everything", () => {
    const on = namespaceFilter("*");
    expect(on("graferse:walk")).toBe(true);
    expect(on("vda-5050:abc:MasterController")).toBe(true);
  });

  test("the vda shorthand matches the real prefix", () => {
    const on = namespaceFilter("vda");
    expect(on("vda-5050:abc:MasterController")).toBe(true);
    expect(on("graferse")).toBe(false);
  });

  test("a leading minus excludes", () => {
    const on = namespaceFilter("*,-vda");
    expect(on("graferse:walk")).toBe(true);
    expect(on("vda-5050:abc:MasterController")).toBe(false);
  });

  test("nothing matches an empty spec", () => {
    const on = namespaceFilter("");
    expect(on("graferse")).toBe(false);
  });
});
