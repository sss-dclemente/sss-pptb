/** Solution model produced by parse.ts. Everything is derived from the zip only. */

export interface RootComponent {
  type: number;
  typeName: string;
  schemaName: string | null;
  id: string | null;
  /** 0 = include subcomponents, 1 = do not include subcomponents, 2 = include as shell only */
  behavior: number;
}

export interface DependencyRef {
  type: number;
  typeName: string;
  schemaName: string | null;
  id: string | null;
  displayName: string | null;
  /** Solution unique name as written by Dataverse, e.g. "OtherSolution (1.0.0.0)" or "System" */
  solution: string | null;
  /** Solution unique name with the trailing version stripped */
  solutionName: string | null;
  parentSchemaName: string | null;
}

export interface MissingDependency {
  required: DependencyRef;
  dependent: DependencyRef;
}

export interface AttributeInfo {
  name: string;
  type: string;
}

export interface EntityInfo {
  name: string;
  displayName: string;
  attributes: AttributeInfo[];
  forms: number;
  views: number;
  charts: number;
  hasRibbon: boolean;
}

export interface WorkflowInfo {
  id: string | null;
  name: string;
  /** 0 workflow, 1 dialog, 2 business rule, 3 action, 4 BPF, 5 modern flow, 6 desktop flow */
  category: number;
  categoryName: string;
  primaryEntity: string | null;
  /** Only for modern flows: connection reference logical names found in the flow JSON */
  connectionReferences: string[];
}

export interface RelationshipInfo {
  name: string;
  type: string;
  referencing: string | null;
  referenced: string | null;
}

export interface ConnectionReferenceInfo {
  logicalName: string;
  displayName: string | null;
  connector: string | null;
}

export interface EnvironmentVariableInfo {
  schemaName: string;
  displayName: string | null;
  type: string | null;
  hasDefault: boolean;
  hasValue: boolean;
}

export interface PluginStepInfo {
  name: string;
  pluginType: string | null;
  message: string | null;
  entity: string | null;
  stage: string | null;
}

export interface NamedItem {
  name: string;
  detail?: string;
}

export interface SolutionInfo {
  fileName: string;
  sizeBytes: number;
  fileCount: number;
  uniqueName: string;
  displayName: string;
  version: string;
  /** 0 unmanaged, 1 managed, 2 patch (managed) */
  managedFlag: number;
  managed: boolean;
  publisher: { uniqueName: string; displayName: string; prefix: string };
  rootComponents: RootComponent[];
  missingDependencies: MissingDependency[];
  entities: EntityInfo[];
  relationships: RelationshipInfo[];
  optionSets: NamedItem[];
  roles: NamedItem[];
  workflows: WorkflowInfo[];
  webResources: NamedItem[];
  appModules: NamedItem[];
  canvasApps: NamedItem[];
  connectionReferences: ConnectionReferenceInfo[];
  environmentVariables: EnvironmentVariableInfo[];
  pluginAssemblies: NamedItem[];
  pluginSteps: PluginStepInfo[];
  customControls: NamedItem[];
  fieldSecurityProfiles: NamedItem[];
  /** Any component collection under customizations.xml we did not model explicitly: element name -> count */
  otherCollections: Record<string, number>;
  warnings: string[];
}
