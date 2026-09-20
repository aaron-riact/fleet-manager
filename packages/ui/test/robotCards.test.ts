import { describe, expect, test } from "bun:test";
import { buildCards, filterCards, pruneStalePoses, summarizeCards } from "../src/RobotCards.js";

const pose = (serialNumber: string, x = 1, y = 2, driving = false) => ({
  manufacturer: "m",
  serialNumber,
  x,
  y,
  theta: 0,
  driving,
  laden: false,
  charging: false,
  positionInitialized: true,
  eStop: false,
  fieldViolation: false,
});

describe("buildCards", () => {
  test("joins pose, order progress, waits, and holdings", () => {
    const cards = buildCards(
      { b: pose("b"), a: pose("a", 1, 2, true) },
      [{ orderId: "o1", serial: "a", updateId: 1, nodes: [{ nodeId: "x", released: true }, { nodeId: "y", released: false }] }],
      { nodeLocks: [{ id: "x", owners: ["a"], waiters: [] }], edgeLocks: [] },
    );
    expect(cards.map((c) => c.serialNumber)).toEqual(["a", "b"]);
    expect(cards[0]).toMatchObject({ status: "driving", waitingOn: "y", holding: ["x"] });
    expect(cards[1]).toMatchObject({ status: "idle", holding: [] });
  });

  test("offline poses and empty inputs", () => {
    const cards = buildCards({ r: pose("r", Number.NaN, 0) }, [], undefined);
    expect(cards[0]?.status).toBe("offline");
    expect(buildCards({}, [], undefined)).toEqual([]);
  });
});

describe("fleet overview", () => {
  test("summarizeCards counts every status", () => {
    const cards = buildCards(
      { b: pose("b"), a: pose("a", 1, 2, true), r: pose("r", Number.NaN, 0) },
      [],
      undefined,
    );
    expect(summarizeCards(cards)).toEqual({ driving: 1, waiting: 0, charging: 0, idle: 1, offline: 1 });
    expect(summarizeCards([])).toEqual({ driving: 0, waiting: 0, charging: 0, idle: 0, offline: 0 });
  });

  test("charging and unlocalized cards", () => {
    const cards = buildCards(
      {
        c: { ...pose("c"), charging: true, batteryCharge: 78 },
        u: { ...pose("u"), positionInitialized: false },
      },
      [],
      undefined,
    );
    expect(cards.find((c) => c.serialNumber === "c")?.status).toBe("charging");
    expect(cards.find((c) => c.serialNumber === "u")?.status).toBe("offline");
    expect(summarizeCards(cards)).toMatchObject({ charging: 1, offline: 1 });
  });

  test("laden flag passes through to cards and map dots", () => {
    const cards = buildCards({ l: { ...pose("l"), laden: true } }, [], undefined);
    expect(cards[0]?.pose?.laden).toBe(true);
    expect(cards[0]?.status).toBe("idle");
  });

  test("pruneStalePoses drops silent and never-seen robots", () => {
    const poses = { a: pose("a"), b: pose("b"), ghost: pose("ghost") };
    const seenAt = { a: 1000, b: 1000 };
    const fresh = pruneStalePoses(poses, seenAt, 1000 + 29_999, 30_000);
    expect(Object.keys(fresh).sort()).toEqual(["a", "b"]);
    const aged = pruneStalePoses(poses, seenAt, 1000 + 30_000, 30_000);
    expect(aged).toEqual({});
  });

  test("filterCards selects one status, all passes through", () => {
    const cards = buildCards({ b: pose("b"), a: pose("a", 1, 2, true) }, [], undefined);
    expect(filterCards(cards, "all")).toBe(cards);
    expect(filterCards(cards, "driving").map((c) => c.serialNumber)).toEqual(["a"]);
    expect(filterCards(cards, "waiting")).toEqual([]);
  });
});
