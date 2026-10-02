import { CONNECTION_REFERENCE, isActiveSolution, isBuiltinSolution } from "./componentTypes";
import { diffSolutions } from "./diff";
import type { SolutionInfo } from "./types";

export interface RiskFactor {
  id: string;
  label: string;
  points: number;
  max: number;
  evidence: string[];
  advice: string;
}

export type RiskBand = "Low" | "Medium" | "High" | "Critical";

export interface RiskReport {
  score: number;
  band: RiskBand;
  factors: RiskFactor[];
  baseline: string | null;
}

function cap(points: number, max: number): number {
  return Math.min(points, max);
}

function band(score: number): RiskBand {
  return score < 25 ? "Low" : score < 50 ? "Medium" : score < 75 ? "High" : "Critical";
}

function isCustom(schema: string | null, prefix: string): boolean {
  return !!schema && !!prefix && schema.toLowerCase().startsWith(prefix.toLowerCase() + "_");
}

/** Publisher-style prefix (xxx_) of any publisher: a custom component, not a system one. */
function hasPublisherPrefix(schema: string | null): boolean {
  return !!schema && /^[a-z0-9]+_/i.test(schema);
}

/**
 * Upgrade risk score: 0-100, sum of capped factors. Heuristic, not a verdict.
 * @param s solution being imported
 * @param baseline optional previous version (or the currently deployed export) of the same solution
 */
export function scoreRisk(s: SolutionInfo, baseline?: SolutionInfo | null): RiskReport {
  const f: RiskFactor[] = [];
  const add = (factor: Omit<RiskFactor, "points"> & { points: number }) => {
    factor.points = cap(factor.points, factor.max);
    if (factor.points > 0) f.push(factor);
  };
  const prefix = s.publisher.prefix;

  // 1. Missing dependencies declared by the export
  const active = s.missingDependencies.filter((d) => isActiveSolution(d.required.solutionName));
  const external = s.missingDependencies.filter((d) => !isBuiltinSolution(d.required.solutionName) && !isActiveSolution(d.required.solutionName));
  const builtin = s.missingDependencies.filter((d) => isBuiltinSolution(d.required.solutionName)).length;
  add({
    id: "missing-deps-active",
    label: "Missing dependencies on unmanaged components (Active)",
    points: active.length * 15,
    max: 30,
    evidence: active.slice(0, 12).map((d) => `${d.required.typeName} ${d.required.schemaName ?? d.required.id ?? "?"}`),
    advice:
      "The required component exists only as unmanaged customization in the source environment; add it to the solution or a prerequisite solution. The import fails in any other environment until then.",
  });
  add({
    id: "missing-deps",
    label: "Missing dependencies on other solutions",
    points: external.length * 8,
    max: 30,
    evidence: external.slice(0, 12).map((d) => `${d.required.typeName} ${d.required.schemaName ?? d.required.id ?? "?"} from ${d.required.solution ?? "?"}`),
    advice: "Import the required solutions first, or add the missing components to this solution.",
  });
  add({
    id: "missing-deps-system",
    label: "Missing dependencies on System / first-party solutions",
    points: builtin * 2,
    max: 10,
    evidence: s.missingDependencies
      .filter((d) => isBuiltinSolution(d.required.solutionName))
      .slice(0, 8)
      .map((d) => `${d.required.typeName} ${d.required.schemaName ?? d.required.id ?? "?"} (${d.required.solution ?? "System"})`),
    advice: "Usually satisfied by the target environment; verify first-party app versions match.",
  });

  // 2. Unmanaged into a downstream environment
  if (!s.managed) {
    add({
      id: "unmanaged",
      label: "Unmanaged solution",
      points: 10,
      max: 10,
      evidence: ["Managed flag = 0"],
      advice: "Unmanaged imports cannot be cleanly uninstalled and leave active-layer customizations. Use managed for test/prod.",
    });
  }

  // 3. System tables included with all subcomponents
  const sysFull = s.rootComponents.filter((rc) => rc.type === 1 && rc.behavior === 0 && !!rc.schemaName && !hasPublisherPrefix(rc.schemaName));
  add({
    id: "system-tables-full",
    label: "System tables included with all subcomponents",
    points: sysFull.length * 5,
    max: 15,
    evidence: sysFull.map((rc) => rc.schemaName ?? "?"),
    advice: "Behavior 0 drags every form, view and column of the table. Prefer 'include selected components' (behavior 1/2) for system tables.",
  });

  // 4. Plugins
  add({
    id: "plugins",
    label: "Plugin assemblies and steps",
    points: (s.pluginAssemblies.length ? 5 : 0) + s.pluginSteps.length,
    max: 15,
    evidence: [...s.pluginAssemblies.map((p) => p.name), ...s.pluginSteps.slice(0, 6).map((p) => `step: ${p.name}`)],
    advice: "Assembly version bumps and step changes are a common upgrade failure point. Confirm assembly is registered in sandbox mode and steps are not orphaned.",
  });

  // 5. Cloud flows referencing connection references not shipped in the solution
  const shipped = new Set(s.connectionReferences.map((c) => c.logicalName.toLowerCase()));
  const orphanRefs = new Set<string>();
  for (const w of s.workflows) for (const r of w.connectionReferences) if (!shipped.has(r.toLowerCase())) orphanRefs.add(r);
  add({
    id: "flow-conn-refs",
    label: "Cloud flows using connection references not in this solution",
    points: orphanRefs.size * 5,
    max: 15,
    evidence: Array.from(orphanRefs),
    advice: "Import will prompt for connections or fail. Ship the connection references or provide a deployment settings file.",
  });
  const flows = s.workflows.filter((w) => w.category === 5);
  add({
    id: "flows",
    label: "Cloud flows in solution",
    points: flows.length,
    max: 8,
    evidence: flows.slice(0, 8).map((w) => w.name),
    advice: "Flows import turned off when connections are not bound; verify state after import.",
  });

  // 6. Environment variables without default or value
  const emptyVars = s.environmentVariables.filter((e) => !e.hasDefault && !e.hasValue);
  add({
    id: "env-vars",
    label: "Environment variables with no default and no value",
    points: emptyVars.length * 3,
    max: 12,
    evidence: emptyVars.map((e) => e.schemaName),
    advice: "Provide values in a deployment settings file or the import will prompt.",
  });

  // 7. Canvas apps
  add({
    id: "canvas",
    label: "Canvas apps",
    points: s.canvasApps.length * 3,
    max: 9,
    evidence: s.canvasApps.map((c) => c.name),
    advice: "Canvas app ownership and sharing are not carried by the solution; plan post-import sharing.",
  });

  // 8. Size
  add({
    id: "size",
    label: "Solution size",
    points: s.entities.length > 100 ? 10 : s.entities.length > 30 ? 5 : 0,
    max: 10,
    evidence: [`${s.entities.length} tables, ${s.rootComponents.length} root components`],
    advice: "Large solutions take longer to import and fail late. Consider splitting by area.",
  });

  // 9. Prefix hygiene (needs this solution's prefix to judge; an empty prefix flags nothing)
  // Connection references have org-specific type codes: detect them from the zip content (typeName inferred at parse).
  const prefixed = (rc: (typeof s.rootComponents)[number]) => [1, 2, 9, 61, 371, 372, 380].includes(rc.type) || rc.typeName === CONNECTION_REFERENCE;
  const foreign = prefix
    ? s.rootComponents.filter((rc) => rc.schemaName && prefixed(rc) && !isCustom(rc.schemaName, prefix) && hasPublisherPrefix(rc.schemaName))
    : [];
  add({
    id: "prefix",
    label: "Custom components with a different publisher prefix",
    points: foreign.length * 2,
    max: 10,
    evidence: foreign.slice(0, 10).map((rc) => `${rc.typeName} ${rc.schemaName}`),
    advice: "Components owned by another publisher in this solution indicate layering across publishers. Expect managed-layer conflicts.",
  });

  // 10. Baseline comparison
  if (baseline) {
    const d = diffSolutions(baseline, s);
    const removedTables = d.entries.filter((e) => e.category === "Table" && e.change === "removed");
    const removedColumns = d.entries.filter((e) => e.category === "Column" && e.change === "removed");
    const removedOther = d.entries.filter((e) => e.change === "removed" && e.category !== "Table" && e.category !== "Column" && e.category !== "Root component");
    add({
      id: "removed-tables",
      label: "Tables removed since baseline",
      points: removedTables.length * 15,
      max: 30,
      evidence: removedTables.map((e) => e.name),
      advice: "Managed upgrade deletes removed tables and their data. Confirm intent; use 'Stage for upgrade' and back up data.",
    });
    add({
      id: "removed-columns",
      label: "Columns removed since baseline",
      points: removedColumns.length * 5,
      max: 20,
      evidence: removedColumns.slice(0, 12).map((e) => e.name),
      advice: "Column data is dropped on managed upgrade. Verify no dependencies remain in the target.",
    });
    add({
      id: "removed-other",
      label: "Other components removed since baseline",
      points: removedOther.length * 2,
      max: 10,
      evidence: removedOther.slice(0, 12).map((e) => `${e.category}: ${e.name}`),
      advice: "Removed components are deleted on upgrade if nothing else depends on them; otherwise the import fails.",
    });
    if (d.versionOrder !== "upgrade") {
      const evidence = [`${baseline.version || "?"} → ${s.version || "?"}`];
      if (d.versionOrder === "downgrade") {
        add({
          id: "version",
          label: "Version lower than baseline",
          points: 10,
          max: 10,
          evidence,
          advice: "Dataverse rejects importing a managed solution with a lower version than the one installed. Unmanaged imports are not version-gated but overwrite newer customizations.",
        });
      } else if (d.versionOrder === "same") {
        add({
          id: "version",
          label: "Version not incremented",
          points: 3,
          max: 10,
          evidence,
          advice: "Same-version imports are allowed (applied as an update), but deployments cannot be told apart. Bump the version for traceability.",
        });
      } else {
        add({
          id: "version",
          label: "Version not comparable",
          points: 5,
          max: 10,
          evidence,
          advice: "One of the versions is missing or not numeric; confirm the target has a lower version than this import.",
        });
      }
    }
    if (baseline.managed !== s.managed) {
      add({
        id: "managed-flip",
        label: "Managed / unmanaged mismatch with baseline",
        points: 10,
        max: 10,
        evidence: [`${baseline.managed ? "managed" : "unmanaged"} → ${s.managed ? "managed" : "unmanaged"}`],
        advice: "Importing managed over unmanaged (or vice versa) with the same unique name is blocked or creates layering conflicts.",
      });
    }
  }

  const score = Math.min(100, f.reduce((n, x) => n + x.points, 0));
  return { score, band: band(score), factors: f.sort((x, y) => y.points - x.points), baseline: baseline ? `${baseline.uniqueName} ${baseline.version}` : null };
}
