import { describe, expect, test } from "bun:test";
import { buildCards } from "../src/RobotCards.js";

const pose = (serialNumber: string, x = 1, y = 2, driving = false) => ({
  manufacturer: "m",
  serialNumber,
  x,
  y,
  theta: 0,
  driving,
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
