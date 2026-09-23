import JSZip from "jszip";
import { componentTypeName, CONNECTION_REFERENCE, CUSTOM_TYPE_MIN, ENV_VAR_TYPE, WORKFLOW_CATEGORY } from "./componentTypes";
import type {
  ConnectionReferenceInfo,
  DependencyRef,
  EntityInfo,
  EnvironmentVariableInfo,
  MissingDependency,
  PluginStepInfo,
  RelationshipInfo,
  RootComponent,
  SolutionInfo,
  WorkflowInfo,
} from "./types";

const KNOWN_COLLECTIONS = new Set([
  "Entities",
  "Roles",
  "Workflows",
  "FieldSecurityProfiles",
  "Templates",
  "EntityMaps",
  "EntityRelationships",
  "OrganizationSettings",
  "optionsets",
  "CustomControls",
  "SolutionPluginAssemblies",
  "SdkMessageProcessingSteps",
  "WebResources",
  "AppModules",
  "CanvasApps",
  "connectionreferences",
  "environmentvariabledefinitions",
  "Languages",
  "EntityDataProviders",
  "customapis",
]);

function text(el: Element | null | undefined, selector?: string): string | null {
  if (!el) return null;
  const node = selector ? el.querySelector(selector) : el;
  const t = node?.textContent?.trim();
  return t ? t : null;
}

function attr(el: Element | null | undefined, name: string): string | null {
  const v = el?.getAttribute(name);
  return v == null || v === "" ? null : v;
}

function children(el: Element | null | undefined, tag: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

function localizedName(el: Element | null | undefined, tag = "LocalizedNames"): string | null {
  const ln = el?.querySelector(`${tag} > LocalizedName`);
  return attr(ln, "description");
}

function stripVersion(solution: string | null): string | null {
  if (!solution) return null;
  return solution.replace(/\s*\([\d.]+\)\s*$/, "").trim() || null;
}

function parseXml(xml: string, label: string, warnings: string[]): Document | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    warnings.push(`${label}: XML parse error`);
    return null;
  }
  return doc;
}

function depRef(el: Element | null): DependencyRef {
  const type = Number(attr(el, "type") ?? 0);
  const solution = attr(el, "solution");
  return {
    type,
    typeName: componentTypeName(type),
    schemaName: attr(el, "schemaName"),
    id: attr(el, "id"),
    displayName: attr(el, "displayName"),
    solution,
    solutionName: stripVersion(solution),
    parentSchemaName: attr(el, "parentSchemaName"),
  };
}

function parseSolutionXml(doc: Document, info: SolutionInfo): void {
  const m = doc.querySelector("ImportExportXml > SolutionManifest");
  if (!m) {
    info.warnings.push("solution.xml: SolutionManifest not found");
    return;
  }
  info.uniqueName = text(m, ":scope > UniqueName") ?? info.uniqueName;
  info.displayName = localizedName(m) ?? info.uniqueName;
  info.version = text(m, ":scope > Version") ?? "";
  info.managedFlag = Number(text(m, ":scope > Managed") ?? "0");
  info.managed = info.managedFlag !== 0;

  const pub = m.querySelector(":scope > Publisher");
  info.publisher = {
    uniqueName: text(pub, ":scope > UniqueName") ?? "",
    displayName: localizedName(pub) ?? text(pub, ":scope > UniqueName") ?? "",
    prefix: text(pub, ":scope > CustomizationPrefix") ?? "",
  };

  info.rootComponents = children(m.querySelector(":scope > RootComponents"), "RootComponent").map((rc) => {
    const type = Number(attr(rc, "type") ?? 0);
    return {
      type,
      typeName: componentTypeName(type),
      schemaName: attr(rc, "schemaName"),
      id: attr(rc, "id"),
      behavior: Number(attr(rc, "behavior") ?? 0),
    } satisfies RootComponent;
  });

  info.missingDependencies = children(m.querySelector(":scope > MissingDependencies"), "MissingDependency").map(
    (md) =>
      ({
        required: depRef(md.querySelector(":scope > Required")),
        dependent: depRef(md.querySelector(":scope > Dependent")),
      }) satisfies MissingDependency,
  );
}

/** RibbonDiffXml wrapper elements that an export writes even when there is no ribbon customization. */
const RIBBON_CONTAINERS = new Set([
  "CustomActions",
  "Templates",
  "RibbonTemplates",
  "CommandDefinitions",
  "RuleDefinitions",
  "TabDisplayRules",
  "DisplayRules",
  "EnableRules",
  "LocLabels",
]);

/** True when RibbonDiffXml holds any element other than the (empty) container elements every export writes. */
function hasRibbonCustomization(ribbon: Element | null): boolean {
  if (!ribbon) return false;
  return Array.from(ribbon.getElementsByTagName("*")).some((e) => !RIBBON_CONTAINERS.has(e.tagName));
}

function parseEntity(el: Element): EntityInfo {
  const nameEl = el.querySelector(":scope > Name");
  const name = nameEl?.textContent?.trim() ?? "";
  const attributes = Array.from(el.querySelectorAll(":scope > EntityInfo > entity > attributes > attribute")).map((a) => ({
    name: attr(a, "PhysicalName") ?? text(a, ":scope > Name") ?? "",
    type: text(a, ":scope > Type") ?? "",
  }));
  return {
    name,
    displayName: attr(nameEl, "LocalizedName") ?? name,
    attributes,
    forms: el.querySelectorAll(":scope > FormXml > forms > systemform").length,
    views: el.querySelectorAll(":scope > SavedQueries > savedqueries > savedquery").length,
    charts: el.querySelectorAll(":scope > Visualizations > visualization").length,
    hasRibbon: hasRibbonCustomization(el.querySelector(":scope > RibbonDiffXml")),
  };
}

function parseWorkflow(el: Element): WorkflowInfo {
  const category = Number(text(el, ":scope > Category") ?? "0");
  return {
    id: attr(el, "WorkflowId"),
    name: attr(el, "Name") ?? "",
    category,
    categoryName: WORKFLOW_CATEGORY[category] ?? `Category ${category}`,
    primaryEntity: text(el, ":scope > PrimaryEntity"),
    connectionReferences: [],
  };
}

function parseEnvVar(e: Element): EnvironmentVariableInfo {
  const typeCode = text(e, ":scope > type");
  const dn = e.querySelector(":scope > displayname");
  return {
    schemaName: attr(e, "schemaname") ?? "",
    displayName: text(dn) ?? attr(dn, "default") ?? attr(dn?.querySelector(":scope > label"), "description"),
    type: typeCode ? (ENV_VAR_TYPE[typeCode] ?? typeCode) : null,
    hasDefault: !!text(e, ":scope > defaultvalue"),
    hasValue: !!text(e, ":scope > environmentvariablevalues > environmentvariablevalue > value"),
  };
}

/** environmentvariablevalues.json: { environmentvariablevalues: { environmentvariablevalue: {...} | [...] } } */
function envValuesFromJson(json: string): { schemaName: string | null; hasValue: boolean }[] {
  try {
    const obj = JSON.parse(json) as { environmentvariablevalues?: { environmentvariablevalue?: unknown } };
    const raw = obj.environmentvariablevalues?.environmentvariablevalue;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
    return list.map((v) => ({
      schemaName: typeof v["@schemaname"] === "string" ? (v["@schemaname"] as string) : null,
      hasValue: v.value != null && String(v.value) !== "",
    }));
  } catch {
    return [];
  }
}

/** Merge an env var into the list, deduping by schema name (case-insensitive). */
function mergeEnvVar(list: EnvironmentVariableInfo[], v: EnvironmentVariableInfo): void {
  const existing = list.find((x) => x.schemaName.toLowerCase() === v.schemaName.toLowerCase());
  if (!existing) {
    list.push(v);
    return;
  }
  existing.displayName ??= v.displayName;
  existing.type ??= v.type;
  existing.hasDefault ||= v.hasDefault;
  existing.hasValue ||= v.hasValue;
}

function parseCustomizationsXml(doc: Document, info: SolutionInfo): void {
  const root = doc.querySelector("ImportExportXml");
  if (!root) {
    info.warnings.push("customizations.xml: ImportExportXml root not found");
    return;
  }

  info.entities = children(root.querySelector(":scope > Entities"), "Entity").map(parseEntity);

  info.relationships = children(root.querySelector(":scope > EntityRelationships"), "EntityRelationship").map(
    (r) =>
      ({
        name: attr(r, "Name") ?? "",
        type: text(r, ":scope > EntityRelationshipType") ?? "",
        referencing: text(r, ":scope > ReferencingEntityName"),
        referenced: text(r, ":scope > ReferencedEntityName"),
      }) satisfies RelationshipInfo,
  );

  info.optionSets = children(root.querySelector(":scope > optionsets"), "optionset").map((o) => ({
    name: attr(o, "Name") ?? "",
    detail: attr(o, "localizedName") ?? undefined,
  }));

  info.roles = children(root.querySelector(":scope > Roles"), "Role").map((r) => ({
    name: attr(r, "name") ?? "",
    detail: attr(r, "id") ?? undefined,
  }));

  info.workflows = children(root.querySelector(":scope > Workflows"), "Workflow").map(parseWorkflow);

  info.webResources = children(root.querySelector(":scope > WebResources"), "WebResource").map((w) => ({
    name: text(w, ":scope > Name") ?? "",
    detail: text(w, ":scope > WebResourceType") ?? undefined,
  }));

  info.appModules = children(root.querySelector(":scope > AppModules"), "AppModule").map((a) => ({
    name: text(a, ":scope > UniqueName") ?? "",
    detail: localizedName(a) ?? undefined,
  }));

  info.canvasApps = children(root.querySelector(":scope > CanvasApps"), "CanvasApp").map((c) => ({
    name: text(c, ":scope > Name") ?? "",
    detail: text(c, ":scope > DisplayName") ?? undefined,
  }));

  info.connectionReferences = children(root.querySelector(":scope > connectionreferences"), "connectionreference").map(
    (c) =>
      ({
        logicalName: attr(c, "connectionreferencelogicalname") ?? "",
        displayName: text(c, ":scope > connectionreferencedisplayname"),
        connector: text(c, ":scope > connectorid")?.split("/").pop() ?? null,
      }) satisfies ConnectionReferenceInfo,
  );

  for (const e of children(root.querySelector(":scope > environmentvariabledefinitions"), "environmentvariabledefinition")) {
    mergeEnvVar(info.environmentVariables, parseEnvVar(e));
  }

  info.pluginAssemblies = children(root.querySelector(":scope > SolutionPluginAssemblies"), "PluginAssembly").map((p) => ({
    name: (attr(p, "FullName") ?? "").split(",")[0],
    detail: attr(p, "FullName") ?? undefined,
  }));

  info.pluginSteps = children(root.querySelector(":scope > SdkMessageProcessingSteps"), "SdkMessageProcessingStep").map(
    (s) =>
      ({
        name: attr(s, "Name") ?? "",
        pluginType: attr(s, "PluginTypeName"),
        message: text(s, ":scope > SdkMessageId"),
        entity: text(s, ":scope > PrimaryEntity") ?? attr(s, "PrimaryEntityName"),
        stage: text(s, ":scope > Stage"),
      }) satisfies PluginStepInfo,
  );

  info.customControls = children(root.querySelector(":scope > CustomControls"), "CustomControl").map((c) => ({
    name: text(c, ":scope > Name") ?? "",
  }));

  info.fieldSecurityProfiles = children(root.querySelector(":scope > FieldSecurityProfiles"), "FieldSecurityProfile").map(
    (f) => ({ name: attr(f, "name") ?? "" }),
  );

  for (const child of Array.from(root.children)) {
    if (KNOWN_COLLECTIONS.has(child.tagName)) continue;
    const n = child.children.length;
    if (n > 0) info.otherCollections[child.tagName] = n;
  }
}

/** Cloud flow JSON: pull connection reference logical names from properties.connectionReferences. */
function parseFlowJson(json: string): string[] {
  try {
    const obj = JSON.parse(json) as { properties?: { connectionReferences?: Record<string, { connection?: { connectionReferenceLogicalName?: string } }> } };
    const refs = obj.properties?.connectionReferences ?? {};
    return Object.values(refs)
      .map((r) => r.connection?.connectionReferenceLogicalName)
      .filter((v): v is string => !!v);
  } catch {
    return [];
  }
}

export function emptySolution(fileName: string, sizeBytes: number): SolutionInfo {
  return {
    fileName,
    sizeBytes,
    fileCount: 0,
    uniqueName: fileName.replace(/\.zip$/i, ""),
    displayName: fileName,
    version: "",
    managedFlag: 0,
    managed: false,
    publisher: { uniqueName: "", displayName: "", prefix: "" },
    rootComponents: [],
    missingDependencies: [],
    entities: [],
    relationships: [],
    optionSets: [],
    roles: [],
    workflows: [],
    webResources: [],
    appModules: [],
    canvasApps: [],
    connectionReferences: [],
    environmentVariables: [],
    pluginAssemblies: [],
    pluginSteps: [],
    customControls: [],
    fieldSecurityProfiles: [],
    otherCollections: {},
    warnings: [],
  };
}

export async function parseSolutionZip(data: Uint8Array | ArrayBuffer, fileName: string): Promise<SolutionInfo> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const info = emptySolution(fileName, bytes.byteLength);
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  info.fileCount = files.length;

  const find = (name: string) => files.find((f) => f.name.toLowerCase() === name.toLowerCase());

  const solutionXml = find("solution.xml");
  if (!solutionXml) {
    info.warnings.push("solution.xml not found: not a Dataverse solution zip?");
  } else {
    const doc = parseXml(await solutionXml.async("string"), "solution.xml", info.warnings);
    if (doc) parseSolutionXml(doc, info);
  }

  const customizationsXml = find("customizations.xml");
  if (!customizationsXml) {
    info.warnings.push("customizations.xml not found");
  } else {
    const doc = parseXml(await customizationsXml.async("string"), "customizations.xml", info.warnings);
    if (doc) parseCustomizationsXml(doc, info);
  }

  // Newer exports: environmentvariabledefinitions/<schemaname>/environmentvariabledefinition.xml (+ environmentvariablevalues.json)
  const envDefs = files.filter((f) => /^environmentvariabledefinitions\/[^/]+\/environmentvariabledefinition\.xml$/i.test(f.name));
  for (const ef of envDefs) {
    const folder = ef.name.slice(0, ef.name.lastIndexOf("/"));
    const doc = parseXml(await ef.async("string"), ef.name, info.warnings);
    const el = doc?.documentElement;
    if (!el || el.tagName !== "environmentvariabledefinition") continue;
    const v = parseEnvVar(el);
    if (!v.schemaName) v.schemaName = folder.split("/").pop() ?? "";
    const valuesJson = find(`${folder}/environmentvariablevalues.json`);
    if (valuesJson) {
      const values = envValuesFromJson(await valuesJson.async("string"));
      v.hasValue ||= values.some((x) => x.hasValue && (!x.schemaName || x.schemaName.toLowerCase() === v.schemaName.toLowerCase()));
    }
    mergeEnvVar(info.environmentVariables, v);
  }

  // Cloud flow definitions live in Workflows/<Name>-<GUID>.json
  const flowFiles = files.filter((f) => /^workflows\/.+\.json$/i.test(f.name));
  for (const ff of flowFiles) {
    const guid = ff.name.match(/-([0-9a-f-]{36})\.json$/i)?.[1]?.toLowerCase();
    const refs = parseFlowJson(await ff.async("string"));
    const wf = info.workflows.find((w) => w.id && w.id.replace(/[{}]/g, "").toLowerCase() === guid);
    if (wf) wf.connectionReferences = refs;
  }

  inferCustomTypeNames(info, files.map((f) => f.name));
  return info;
}

/**
 * Component type codes >= 10000 are org-specific (connection references, custom APIs, ... get a different code per
 * environment). Label a code when the zip content shows which table a root component of that code belongs to, then
 * apply the label to every component of that code in this solution (root components and missing dependencies).
 */
function inferCustomTypeNames(info: SolutionInfo, paths: string[]): void {
  const lower = (v: string | null) => (v ?? "").toLowerCase();
  const connRefs = new Set(info.connectionReferences.map((c) => c.logicalName.toLowerCase()));
  const folderNames = (re: RegExp) => new Set(paths.map((p) => p.match(re)?.[1]?.toLowerCase()).filter((v): v is string => !!v));
  const customApis = folderNames(/^customapis\/([^/]+)\//i);
  const requestParams = folderNames(/^customapis\/[^/]+\/customapirequestparameters\/([^/]+)\//i);
  const responseProps = folderNames(/^customapis\/[^/]+\/customapiresponseproperties\/([^/]+)\//i);

  const labels = new Map<number, string>();
  for (const rc of info.rootComponents) {
    if (rc.type < CUSTOM_TYPE_MIN || labels.has(rc.type) || !rc.schemaName) continue;
    const n = lower(rc.schemaName);
    const label = connRefs.has(n)
      ? CONNECTION_REFERENCE
      : customApis.has(n)
        ? "Custom API"
        : requestParams.has(n)
          ? "Custom API Request Parameter"
          : responseProps.has(n)
            ? "Custom API Response Property"
            : null;
    if (label) labels.set(rc.type, label);
  }
  if (!labels.size) return;
  const relabel = (x: { type: number; typeName: string }) => {
    const l = labels.get(x.type);
    if (l) x.typeName = l;
  };
  info.rootComponents.forEach(relabel);
  for (const md of info.missingDependencies) {
    relabel(md.required);
    relabel(md.dependent);
  }
}
