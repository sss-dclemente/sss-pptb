/** Diagnosis model. See docs/DEPENDENCY-CLEANER-PLAN.md §2. */

export type Target = "primary" | "secondary";
export type Row = Record<string, unknown>;

export const CT = {
  Entity: 1,
  Attribute: 2,
  Relationship: 3,
  OptionSet: 9,
  EntityRelationship: 10,
  View: 26,
  Workflow: 29,
  Chart: 59,
  Form: 60,
  WebResource: 61,
  SiteMap: 62,
  AppModule: 80,
  PluginStep: 92,
} as const;

const TYPE_NAMES: Record<number, string> = {
  1: "Table",
  2: "Column",
  3: "Relationship",
  9: "Choice",
  10: "Relationship",
  14: "Key",
  20: "Security role",
  24: "Form",
  26: "View",
  29: "Process",
  31: "Report",
  36: "Email template",
  48: "Ribbon command",
  50: "Ribbon",
  55: "Ribbon diff",
  59: "Chart",
  60: "Form",
  61: "Web resource",
  62: "Site map",
  63: "Connection role",
  65: "Hierarchy rule",
  66: "Custom control",
  70: "Field security profile",
  80: "Model-driven app",
  90: "Plugin type",
  91: "Plugin assembly",
  92: "Plugin step",
  300: "Canvas app",
  371: "Connector",
  372: "Connection reference",
  380: "Environment variable",
};
export const typeName = (t: number): string => TYPE_NAMES[t] ?? `Type ${t}`;

export interface SolutionInfo {
  id: string;
  uniqueName: string;
  friendlyName: string;
  version: string;
  isManaged: boolean;
  publisherId: string | null;
  /** publisher customization prefix, lower case ("" when unknown) */
  prefix: string;
}

export interface Component {
  /** solutioncomponent row id */
  rowId: string;
  objectId: string;
  type: number;
  /** 0 include subcomponents, 1 do not include, 2 shell. null for subcomponent rows */
  behavior: number | null;
  /** solutioncomponent id of the root row, null for a root */
  rootRowId: string | null;
  /** resolved for display (logical name, form or view name); the id when unresolved */
  name?: string;
  table?: string;
}

/** A named component, resolved for display. */
export interface NamedComponent {
  type: number;
  id: string;
  name: string;
  /** owning table logical name for columns, forms, views */
  table?: string;
}

export interface RequiredSolution {
  uniqueName: string;
  friendlyName: string;
  prefix: string;
  isManaged: boolean;
}

export interface RequiredRef extends NamedComponent {
  /** solution that owns the required component (base layer) */
  solution: RequiredSolution | null;
  /** every managed solution the component was found in */
  solutions: string[];
}

export type FixKind = "shell" | "remove" | "edit-form" | "edit-view" | "report";

export interface FixOption {
  kind: FixKind;
  label: string;
  /** for "shell": the root table component this fix converts */
  root?: NamedComponent & { behavior: number };
  /** for "report": deep link to open the component in the maker portal */
  link?: string;
  note?: string;
}

export type FindingStatus = "blocker" | "safe";

export interface Finding {
  /** stable key: dependent type + id */
  key: string;
  /** selfOwned: the dependent itself belongs to a managed solution in scope (pulled in by "all assets") */
  dependent: NamedComponent & { rootBehavior: number | null; rootTable?: string; selfOwned?: boolean };
  required: RequiredRef[];
  cause: string;
  fixes: FixOption[];
  status: FindingStatus;
}

export interface Diagnosis {
  solution: SolutionInfo;
  environment: { name: string; url: string; environment: string };
  target: { name: string; url: string } | null;
  filter: string[];
  components: Component[];
  findings: Finding[];
  /** components whose RetrieveRequiredComponents call failed */
  errors: { component: string; error: string }[];
  takenAt: string;
}

export const DEFAULT_FILTER = ["msdyn", "msdynce", "mspp"];
