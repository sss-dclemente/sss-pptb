import type { SolutionInfo } from "./types";

export interface InventoryGroup {
  key: string;
  label: string;
  count: number;
  items: { name: string; detail?: string }[];
}

export interface Inventory {
  summary: { label: string; value: string }[];
  groups: InventoryGroup[];
  rootComponentsByType: { type: number; typeName: string; count: number }[];
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function managedLabel(flag: number): string {
  return flag === 2 ? "Managed (patch)" : flag === 1 ? "Managed" : "Unmanaged";
}

export function buildInventory(s: SolutionInfo): Inventory {
  const totalAttributes = s.entities.reduce((n, e) => n + e.attributes.length, 0);
  const totalForms = s.entities.reduce((n, e) => n + e.forms, 0);
  const totalViews = s.entities.reduce((n, e) => n + e.views, 0);

  const groups: InventoryGroup[] = [
    {
      key: "entities",
      label: "Tables",
      count: s.entities.length,
      items: s.entities.map((e) => ({
        name: e.name,
        detail: `${e.displayName} · ${e.attributes.length} columns · ${e.forms} forms · ${e.views} views${e.charts ? ` · ${e.charts} charts` : ""}${e.hasRibbon ? " · ribbon" : ""}`,
      })),
    },
    {
      key: "relationships",
      label: "Relationships",
      count: s.relationships.length,
      items: s.relationships.map((r) => ({ name: r.name, detail: `${r.type} · ${r.referencing ?? "?"} → ${r.referenced ?? "?"}` })),
    },
    { key: "optionSets", label: "Global choices", count: s.optionSets.length, items: s.optionSets },
    {
      key: "workflows",
      label: "Processes & flows",
      count: s.workflows.length,
      items: s.workflows.map((w) => ({
        name: w.name,
        detail: `${w.categoryName}${w.primaryEntity ? ` · ${w.primaryEntity}` : ""}${w.connectionReferences.length ? ` · refs: ${w.connectionReferences.join(", ")}` : ""}`,
      })),
    },
    { key: "appModules", label: "Model-driven apps", count: s.appModules.length, items: s.appModules },
    { key: "canvasApps", label: "Canvas apps", count: s.canvasApps.length, items: s.canvasApps },
    { key: "webResources", label: "Web resources", count: s.webResources.length, items: s.webResources.map((w) => ({ name: w.name, detail: w.detail ? `type ${w.detail}` : undefined })) },
    { key: "roles", label: "Security roles", count: s.roles.length, items: s.roles.map((r) => ({ name: r.name })) },
    { key: "fieldSecurityProfiles", label: "Column security profiles", count: s.fieldSecurityProfiles.length, items: s.fieldSecurityProfiles },
    {
      key: "connectionReferences",
      label: "Connection references",
      count: s.connectionReferences.length,
      items: s.connectionReferences.map((c) => ({ name: c.logicalName, detail: `${c.displayName ?? ""}${c.connector ? ` · ${c.connector}` : ""}` })),
    },
    {
      key: "environmentVariables",
      label: "Environment variables",
      count: s.environmentVariables.length,
      items: s.environmentVariables.map((e) => ({
        name: e.schemaName,
        detail: `${e.type ?? "?"} · default: ${e.hasDefault ? "yes" : "no"} · value: ${e.hasValue ? "yes" : "no"}`,
      })),
    },
    { key: "pluginAssemblies", label: "Plugin assemblies", count: s.pluginAssemblies.length, items: s.pluginAssemblies.map((p) => ({ name: p.name, detail: p.detail })) },
    {
      key: "pluginSteps",
      label: "Plugin steps",
      count: s.pluginSteps.length,
      items: s.pluginSteps.map((p) => ({ name: p.name, detail: [p.message, p.entity, p.stage ? `stage ${p.stage}` : null].filter(Boolean).join(" · ") })),
    },
    { key: "customControls", label: "Custom controls (PCF)", count: s.customControls.length, items: s.customControls },
    ...Object.entries(s.otherCollections).map(([k, n]) => ({ key: `other:${k}`, label: k, count: n, items: [] })),
  ];

  const byType = new Map<number, { type: number; typeName: string; count: number }>();
  for (const rc of s.rootComponents) {
    const cur = byType.get(rc.type) ?? { type: rc.type, typeName: rc.typeName, count: 0 };
    cur.count++;
    byType.set(rc.type, cur);
  }

  return {
    summary: [
      { label: "Unique name", value: s.uniqueName },
      { label: "Version", value: s.version || "—" },
      { label: "Type", value: managedLabel(s.managedFlag) },
      { label: "Publisher", value: `${s.publisher.displayName || s.publisher.uniqueName || "—"} (${s.publisher.prefix || "no prefix"})` },
      { label: "Root components", value: String(s.rootComponents.length) },
      { label: "Missing dependencies", value: String(s.missingDependencies.length) },
      { label: "Tables / columns", value: `${s.entities.length} / ${totalAttributes}` },
      { label: "Forms / views", value: `${totalForms} / ${totalViews}` },
      { label: "Zip", value: `${s.fileCount} files · ${fmtBytes(s.sizeBytes)}` },
    ],
    groups: groups.filter((g) => g.count > 0),
    rootComponentsByType: Array.from(byType.values()).sort((a, b) => b.count - a.count),
  };
}
