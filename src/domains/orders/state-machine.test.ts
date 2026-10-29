import { describe, expect, it } from "vitest";
import { allEdges, isReleased, nextStatus } from "./state-machine";

describe("order state machine", () => {
  it("follows the escrow path", () => {
    expect(nextStatus("CREATED", "PAYMENT_SUCCEEDED")).toBe("PAID_HELD");
    expect(nextStatus("PAID_HELD", "SELLER_SHIPPED")).toBe("SHIPPED");
    expect(nextStatus("SHIPPED", "CARRIER_DELIVERED")).toBe("DELIVERED");
    expect(nextStatus("DELIVERED", "AUTO_RELEASE")).toBe("AUTO_RELEASED");
  });

  it("releases on buyer confirmation, shipped or delivered", () => {
    expect(nextStatus("SHIPPED", "BUYER_CONFIRMED")).toBe("RELEASED");
    expect(nextStatus("DELIVERED", "BUYER_CONFIRMED")).toBe("RELEASED");
    expect(nextStatus("PAID_HELD", "BUYER_CONFIRMED")).toBeNull();
  });

  it("never auto-releases before delivery and never leaves a released order", () => {
    expect(nextStatus("SHIPPED", "AUTO_RELEASE")).toBeNull();
    for (const status of ["RELEASED", "AUTO_RELEASED", "RESOLVED_RELEASE", "RESOLVED_REFUND"] as const) {
      expect(allEdges().filter(([from]) => from === status)).toEqual([]);
    }
  });

  it("allows disputes only while funds are held", () => {
    expect(nextStatus("PAID_HELD", "DISPUTE_OPENED")).toBe("DISPUTED");
    expect(nextStatus("DELIVERED", "DISPUTE_OPENED")).toBe("DISPUTED");
    expect(nextStatus("RELEASED", "DISPUTE_OPENED")).toBeNull();
    expect(nextStatus("CREATED", "DISPUTE_OPENED")).toBeNull();
  });

  it("knows which statuses paid the seller", () => {
    expect(isReleased("RESOLVED_PARTIAL")).toBe(true);
    expect(isReleased("RESOLVED_REFUND")).toBe(false);
  });
});
