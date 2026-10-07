import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const proxyaddr = require("proxy-addr") as {
  (
    req: { connection: { remoteAddress: string }; headers: Record<string, string> },
    trust: string[],
  ): string;
  compile(subnets: string[]): (ip: string) => boolean;
};
const uri = require("fast-uri") as {
  normalize(value: string): string;
  equal(a: string, b: string): boolean;
};
const { Address4, Address6 } = require("ip-address") as typeof import("ip-address");

describe("production dependency advisory regressions", () => {
  it("does not trust spoofed forwarded IPs with a short mapped IPv6 subnet", () => {
    const trust = proxyaddr.compile(["::ffff:10.0.0.0/8"]);
    expect(trust("203.0.113.9")).toBe(false);
    expect(trust("::ffff:203.0.113.9")).toBe(false);
    expect(
      proxyaddr(
        {
          connection: { remoteAddress: "203.0.113.9" },
          headers: { "x-forwarded-for": "10.0.0.1" },
        },
        ["::ffff:10.0.0.0/8"],
      ),
    ).toBe("203.0.113.9");
    const valid = proxyaddr.compile(["::ffff:10.0.0.0/104"]);
    expect(valid("10.0.0.1")).toBe(true);
    expect(valid("203.0.113.9")).toBe(false);
  });

  it("normalizes percent-encoded hostname case consistently", () => {
    expect(uri.normalize("//%41.com")).toBe("//a.com");
    expect(uri.equal("//%4Detadata.internal/private", "//metadata.internal/private")).toBe(true);
    expect(uri.equal("//a.com/Private", "//a.com/private")).toBe(false);
  });

  it("recognizes the entire IPv6 link-local range and rejects cross-family subnets", () => {
    expect(new Address6("febf::1").isLinkLocal()).toBe(true);
    expect(new Address6("fec0::1").isLinkLocal()).toBe(false);
    expect(new Address6("::1").isInSubnet(new Address4("0.0.0.0/0"))).toBe(false);
    expect(new Address4("0.0.0.1").isInSubnet(new Address6("::/0"))).toBe(false);
  });
});
