import { describe, it, expect } from "vitest";
import { firstBlock, str, num, bool } from "../../../src/parsers/extractors/helpers.js";

// ---------------------------------------------------------------------------
// Extractor Helper Function Tests
// ---------------------------------------------------------------------------

describe("extractor helpers", () => {
  // -----------------------------------------------------------------------
  // firstBlock
  // -----------------------------------------------------------------------
  describe("firstBlock", () => {
    it("should return the first element of a nested block array", () => {
      const block = { settings: [{ tier: "db-f1-micro" }] };
      const result = firstBlock(block, "settings");
      expect(result).toEqual({ tier: "db-f1-micro" });
    });

    it("should return empty object when key is missing", () => {
      const result = firstBlock({}, "missing_key");
      expect(result).toEqual({});
    });

    it("should return empty object when value is an empty array", () => {
      const result = firstBlock({ items: [] }, "items");
      expect(result).toEqual({});
    });

    it("should return empty object when value is not an array", () => {
      const result = firstBlock({ items: "not-array" }, "items");
      expect(result).toEqual({});
    });

    it("should return empty object when value is null", () => {
      const result = firstBlock({ items: null } as Record<string, unknown>, "items");
      expect(result).toEqual({});
    });

    it("should return only the first element when multiple exist", () => {
      const block = {
        rules: [
          { name: "first" },
          { name: "second" },
        ],
      };
      const result = firstBlock(block, "rules");
      expect(result).toEqual({ name: "first" });
    });
  });

  // -----------------------------------------------------------------------
  // str
  // -----------------------------------------------------------------------
  describe("str", () => {
    it("should return a non-empty string as-is", () => {
      expect(str("hello")).toBe("hello");
    });

    it("should return undefined for empty string", () => {
      expect(str("")).toBeUndefined();
    });

    it("should return undefined for number", () => {
      expect(str(42)).toBeUndefined();
    });

    it("should return undefined for boolean", () => {
      expect(str(true)).toBeUndefined();
    });

    it("should return undefined for null", () => {
      expect(str(null)).toBeUndefined();
    });

    it("should return undefined for undefined", () => {
      expect(str(undefined)).toBeUndefined();
    });

    it("should return undefined for object", () => {
      expect(str({})).toBeUndefined();
    });

    it("should return string with whitespace", () => {
      expect(str(" ")).toBe(" ");
    });
  });

  // -----------------------------------------------------------------------
  // num
  // -----------------------------------------------------------------------
  describe("num", () => {
    it("should return a number as-is", () => {
      expect(num(42)).toBe(42);
    });

    it("should return zero", () => {
      expect(num(0)).toBe(0);
    });

    it("should return negative numbers", () => {
      expect(num(-5)).toBe(-5);
    });

    it("should return floating point numbers", () => {
      expect(num(3.14)).toBe(3.14);
    });

    it("should parse numeric strings", () => {
      expect(num("100")).toBe(100);
    });

    it("should parse floating point strings", () => {
      expect(num("3.14")).toBe(3.14);
    });

    it("should return undefined for non-numeric strings", () => {
      expect(num("abc")).toBeUndefined();
    });

    it("should return 0 for empty string (Number('') === 0)", () => {
      expect(num("")).toBe(0);
    });

    it("should return undefined for null", () => {
      expect(num(null)).toBeUndefined();
    });

    it("should return undefined for undefined", () => {
      expect(num(undefined)).toBeUndefined();
    });

    it("should return undefined for boolean", () => {
      expect(num(true)).toBeUndefined();
    });

    it("should return undefined for object", () => {
      expect(num({})).toBeUndefined();
    });

    it("should parse string zero", () => {
      expect(num("0")).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // bool
  // -----------------------------------------------------------------------
  describe("bool", () => {
    it("should return true for boolean true", () => {
      expect(bool(true)).toBe(true);
    });

    it("should return false for boolean false", () => {
      expect(bool(false)).toBe(false);
    });

    it('should return true for string "true"', () => {
      expect(bool("true")).toBe(true);
    });

    it('should return false for string "false"', () => {
      expect(bool("false")).toBe(false);
    });

    it("should return undefined for other strings", () => {
      expect(bool("yes")).toBeUndefined();
    });

    it("should return undefined for numbers", () => {
      expect(bool(1)).toBeUndefined();
    });

    it("should return undefined for null", () => {
      expect(bool(null)).toBeUndefined();
    });

    it("should return undefined for undefined", () => {
      expect(bool(undefined)).toBeUndefined();
    });

    it("should return undefined for empty string", () => {
      expect(bool("")).toBeUndefined();
    });
  });
});
