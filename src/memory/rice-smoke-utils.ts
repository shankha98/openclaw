export type OpenClawMemoryPathType = "rice-storage" | "rice-state" | "legacy-md-path" | "unknown";

export function classifyOpenClawMemoryPath(path: string): OpenClawMemoryPathType {
  const trimmed = path.trim();
  if (trimmed.startsWith("rice:storage/")) {
    return "rice-storage";
  }
  if (trimmed.startsWith("rice:state/")) {
    return "rice-state";
  }
  if (trimmed.toLowerCase() === "memory.md" || trimmed.toLowerCase().startsWith("memory/")) {
    return "legacy-md-path";
  }
  return "unknown";
}

export function inferOpenClawSearchTypes(results: Array<{ path?: string | null }>): {
  hasRiceStorage: boolean;
  hasRiceState: boolean;
  hasLegacyMdPath: boolean;
  onlyRiceStorage: boolean;
} {
  let hasRiceStorage = false;
  let hasRiceState = false;
  let hasLegacyMdPath = false;

  for (const entry of results) {
    if (!entry.path) {
      continue;
    }
    const type = classifyOpenClawMemoryPath(entry.path);
    if (type === "rice-storage") {
      hasRiceStorage = true;
      continue;
    }
    if (type === "rice-state") {
      hasRiceState = true;
      continue;
    }
    if (type === "legacy-md-path") {
      hasLegacyMdPath = true;
    }
  }

  return {
    hasRiceStorage,
    hasRiceState,
    hasLegacyMdPath,
    onlyRiceStorage: hasRiceStorage && !hasRiceState && !hasLegacyMdPath,
  };
}
