/**
 * Dataverse solution component type codes (componenttype option set).
 * Source: Microsoft Learn "componenttype" values used in solution.xml RootComponent/@type.
 */
const NAMES: Record<number, string> = {
  1: "Entity",
  2: "Attribute",
  3: "Relationship",
  4: "Attribute Picklist Value",
  5: "Attribute Lookup Value",
  6: "View Attribute",
  7: "Localized Label",
  8: "Relationship Extra Condition",
  9: "Option Set",
  10: "Entity Relationship",
  11: "Entity Relationship Role",
  12: "Entity Relationship Relationships",
  13: "Managed Property",
  14: "Entity Key",
  16: "Privilege",
  17: "Privilege Object Type Code",
  18: "Index",
  20: "Security Role",
  21: "Role Privilege",
  22: "Display String",
  23: "Display String Map",
  24: "Form",
  25: "Organization",
  26: "Saved Query (View)",
  29: "Process (Workflow)",
  31: "Report",
  32: "Report Entity",
  33: "Report Category",
  34: "Report Visibility",
  35: "Attachment",
  36: "Email Template",
  37: "Contract Template",
  38: "KB Article Template",
  39: "Mail Merge Template",
  44: "Duplicate Rule",
  45: "Duplicate Rule Condition",
  46: "Entity Map",
  47: "Attribute Map",
  48: "Ribbon Command",
  49: "Ribbon Context Group",
  50: "Ribbon Customization",
  52: "Ribbon Rule",
  53: "Ribbon Tab To Command Map",
  55: "Ribbon Diff",
  59: "Saved Query Visualization (Chart)",
  60: "System Form",
  61: "Web Resource",
  62: "Site Map",
  63: "Connection Role",
  64: "Complex Control",
  65: "Hierarchy Rule",
  66: "Custom Control",
  68: "Custom Control Default Config",
  70: "Field Security Profile",
  71: "Field Permission",
  80: "Model-driven App",
  90: "Plugin Type",
  91: "Plugin Assembly",
  92: "SDK Message Processing Step",
  93: "SDK Message Processing Step Image",
  95: "Service Endpoint",
  150: "Routing Rule",
  151: "Routing Rule Item",
  152: "SLA",
  153: "SLA Item",
  154: "Convert Rule",
  155: "Convert Rule Item",
  161: "Mobile Offline Profile",
  162: "Mobile Offline Profile Item",
  165: "Similarity Rule",
  166: "Custom Control Resource",
  201: "SDK Message",
  202: "SDK Message Filter",
  203: "SDK Message Pair",
  204: "SDK Message Request",
  205: "SDK Message Request Field",
  206: "SDK Message Response",
  207: "SDK Message Response Field",
  208: "Import Map",
  210: "Web Wizard",
  300: "Canvas App",
  // Both 371 and 372 are "Connector" in the componenttype option set. Connection references, custom APIs etc. have
  // org-specific codes (>= 10000) that differ per environment; see inferCustomTypeNames in parse.ts.
  371: "Connector",
  372: "Connector",
  380: "Environment Variable Definition",
  381: "Environment Variable Value",
  400: "AI Project Type",
  401: "AI Project",
  402: "AI Configuration",
  430: "Entity Analytics Config",
  431: "Attribute Image Config",
  432: "Entity Image Config",
};

/** First org-specific component type code: these map to tables that differ per environment. */
export const CUSTOM_TYPE_MIN = 10000;

export function componentTypeName(type: number): string {
  return NAMES[type] ?? (type >= CUSTOM_TYPE_MIN ? `Custom component (type ${type})` : `Component type ${type}`);
}

/** Label used when zip content reveals the table behind an org-specific type code. */
export const CONNECTION_REFERENCE = "Connection Reference";

export const WORKFLOW_CATEGORY: Record<number, string> = {
  0: "Classic workflow",
  1: "Dialog",
  2: "Business rule",
  3: "Action",
  4: "Business process flow",
  5: "Cloud flow",
  6: "Desktop flow",
  7: "AI flow",
};

export const ENV_VAR_TYPE: Record<string, string> = {
  "100000000": "String",
  "100000001": "Number",
  "100000002": "Boolean",
  "100000003": "JSON",
  "100000004": "Data source",
  "100000005": "Secret",
};

/**
 * Solutions that are always present in an environment; never an install-order dependency.
 * "Active" is deliberately NOT here: a MissingDependency on solution "Active" means the component exists only as an
 * unmanaged customization in the source environment and is not in the export, so the import fails. See isActiveSolution.
 */
export const BUILTIN_SOLUTIONS = new Set(["System", "Basic", "Default"]);

/** Required component lives only in the source environment's unmanaged (Active) layer. */
export function isActiveSolution(name: string | null): boolean {
  return name === "Active";
}

export function isBuiltinSolution(name: string | null): boolean {
  if (!name) return true;
  if (BUILTIN_SOLUTIONS.has(name)) return true;
  return /^msdyn|^msdynce|^msft|^Microsoft|^msfp|^ms_|^PowerApps|^Dynamics365|^Crm|^Field_?Service|^msdyusd/i.test(name);
}
