import { describe, expect, test } from "bun:test";
import { defaultActionLabel, runningAction } from "../src/actions.js";

describe("runningAction", () => {
  test("picks the latest active action, ignoring terminal ones", () => {
    expect(
      runningAction([
        { actionId: "a1", actionType: "pickTrolley", actionStatus: "FINISHED" },
        { actionId: "a2", actionType: "dropTrolley", actionStatus: "RUNNING" },
      ]),
    ).toMatchObject({ actionId: "a2" });
  });

  test("all terminal or absent means no running action", () => {
    expect(
      runningAction([
        { actionId: "a1", actionType: "pickTrolley", actionStatus: "FINISHED" },
        { actionId: "a2", actionType: "pickTrolley", actionStatus: "FAILED" },
      ]),
    ).toBeUndefined();
    expect(runningAction([])).toBeUndefined();
    expect(runningAction(undefined)).toBeUndefined();
  });
});

describe("defaultActionLabel", () => {
  test("humanizes camelCase without knowing the domain", () => {
    expect(defaultActionLabel("pickTrolley")).toBe("Pick trolley");
    expect(defaultActionLabel("cancelOrder")).toBe("Cancel order");
    expect(defaultActionLabel("noop")).toBe("Noop");
  });
});
