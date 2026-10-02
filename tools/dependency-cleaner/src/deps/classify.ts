/** Cause classifier: dependent component type → likely reason and the fixes on offer. Plan §2. Pure. */
import { CT, typeName, type FixOption, type NamedComponent, type RequiredRef } from "./types";

/** Parse the editable filter ("msdyn, msdynce mspp") into lower-case entries. */
export function parseFilter(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

/**
 * D3: a required component is in scope when its owning solution's publisher prefix equals an entry,
 * or the solution unique name starts with one. With no known owner, fall back to the component name `<entry>_…`.
 */
export function matchesFilter(filter: string[], sol: { uniqueName: string; prefix: string } | null, componentName: string): boolean {
  const name = componentName.toLowerCase();
  return filter.some((f) => {
    if (sol) return sol.prefix.toLowerCase() === f || sol.uniqueName.toLowerCase().startsWith(f);
    return name.startsWith(`${f}_`);
  });
}

export interface DependentInfo extends NamedComponent {
  behavior: number | null;
  /** the root table row when the dependent is a subcomponent (or the table itself) */
  root: (NamedComponent & { behavior: number }) | null;
  /** the dependent itself belongs to a managed solution in scope */
  selfOwned?: boolean;
}

export interface Classified {
  cause: string;
  fixes: FixOption[];
}

const names = (req: RequiredRef[]): string => [...new Set(req.map((r) => r.name))].slice(0, 4).join(", ") + (req.length > 4 ? "…" : "");

export function classify(dep: DependentInfo, required: RequiredRef[], filter: string[], link: string): Classified {
  const report = (cause: string, note?: string): Classified => ({ cause, fixes: [{ kind: "report", label: "Report only: open in maker portal", link, note }] });
  const allAssetsRoot = dep.root && dep.root.behavior === 0 ? dep.root : null;
  const shell = (): FixOption | null =>
    allAssetsRoot
      ? { kind: "shell", label: `Convert table ${allAssetsRoot.name} to a shell (remove + add without subcomponents)`, root: allAssetsRoot }
      : null;
  const remove: FixOption = { kind: "remove", label: `Remove this ${typeName(dep.type).toLowerCase()} from the solution` };
  const isFiltered = matchesFilter(filter, null, dep.name);
  const out = (cause: string, ...fixes: (FixOption | null)[]): Classified => ({ cause, fixes: fixes.filter((f): f is FixOption => !!f) });

  const owner = required.find((r) => r.id === dep.id)?.solution?.uniqueName ?? "a managed solution";
  if (dep.selfOwned && dep.type === CT.Entity)
    return out(`Table ${dep.name} belongs to ${owner}. Shipping it, even as a shell, needs that solution in the target.`, remove, { kind: "report", label: "Report only: open in maker portal", link });
  if (dep.selfOwned) {
    return out(
      allAssetsRoot
        ? `${typeName(dep.type)} ${dep.name} belongs to ${owner} and came in with table ${allAssetsRoot.name}, which is in the solution with all assets.`
        : `${typeName(dep.type)} ${dep.name} belongs to ${owner} and is included directly.`,
      shell(),
      allAssetsRoot ? null : remove,
    );
  }
  switch (dep.type) {
    case CT.Entity:
      if (dep.behavior === 0)
        return out(`Table added with all assets: its columns, forms and views come along, including ones that need ${names(required)}.`, shell() ?? { kind: "shell", label: `Convert table ${dep.name} to a shell`, root: { ...dep, behavior: 0 } }, remove);
      return out(`The table itself requires ${names(required)}.`, remove, { kind: "report", label: "Report only: open in maker portal", link });
    case CT.Attribute:
      if (isFiltered)
        return out(
          allAssetsRoot ? `Column ${dep.name} comes with table ${allAssetsRoot.name}, which is in the solution with all assets.` : `Column ${dep.name} is included directly.`,
          shell(),
          allAssetsRoot ? null : remove,
        );
      return report(`Your column needs ${names(required)} (for example a lookup to that table). This is a real dependency: the target needs the app, or the column has to be changed by hand.`);
    case CT.Relationship:
    case CT.EntityRelationship:
      return report(`Relationship to ${names(required)}. This is a real dependency: the target needs the app, or the relationship has to be deleted by hand.`);
    case CT.Form:
      return out(
        `Form uses ${names(required)} (a field, subgrid, quick view or library).`,
        { kind: "edit-form", label: "Edit form: remove those fields (backup first)" },
        shell(),
        allAssetsRoot ? null : remove,
      );
    case CT.View:
      return out(
        `View uses ${names(required)} (a column, condition or link-entity).`,
        { kind: "edit-view", label: "Edit view: strip those columns and link-entities (backup first)" },
        shell(),
        allAssetsRoot ? null : remove,
      );
    default:
      return report(`${typeName(dep.type)} references ${names(required)}. Not edited automatically in v1.`, "Sitemap, app, ribbon, chart, process, web resource and plugin step references are fixed by hand.");
  }
}
