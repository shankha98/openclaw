import { describe, expect, it } from "vitest";
import { classifyOpenClawMemoryPath, inferOpenClawSearchTypes } from "./rice-smoke-utils.js";

describe("classifyOpenClawMemoryPath", () => {
  it("classifies rice storage and rice state paths", () => {
    expect(classifyOpenClawMemoryPath("rice:storage/123")).toBe("rice-storage");
    expect(classifyOpenClawMemoryPath("rice:state/abc")).toBe("rice-state");
  });

  it("classifies legacy markdown-like paths", () => {
    expect(classifyOpenClawMemoryPath("MEMORY.md")).toBe("legacy-md-path");
    expect(classifyOpenClawMemoryPath("memory/2026-02-10.md")).toBe("legacy-md-path");
  });

  it("classifies unknown paths", () => {
    expect(classifyOpenClawMemoryPath("custom/path")).toBe("unknown");
  });
});

describe("inferOpenClawSearchTypes", () => {
  it("summarizes memory types present in an OpenClaw memory_search result", () => {
    const summary = inferOpenClawSearchTypes([
      { path: "rice:storage/1" },
      { path: "MEMORY.md" },
      { path: "rice:state/2" },
    ]);

    expect(summary).toEqual({
      hasRiceStorage: true,
      hasRiceState: true,
      hasLegacyMdPath: true,
      onlyRiceStorage: false,
    });
  });

  it("marks storage-only results", () => {
    const summary = inferOpenClawSearchTypes([
      { path: "rice:storage/1" },
      { path: "rice:storage/2" },
    ]);

    expect(summary.onlyRiceStorage).toBe(true);
    expect(summary.hasRiceState).toBe(false);
    expect(summary.hasLegacyMdPath).toBe(false);
  });
});
