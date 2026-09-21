import type { Matrix } from "./types";
import type { Plan } from "./write";

function csvCell(v: string | number | boolean | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells: (string | number | boolean | null | undefined)[]): string => cells.map(csvCell).join(",");

/** One row per table and per loaded column: table, column, primary flag, other flag, differs, locked. */
export function matrixCsv(m: Matrix): string {
  const primary = m.primary?.name ?? "primary";
  const other = m.other?.name ?? "";
  const out: string[] = [line(["level", "table", "column", "type", `${primary} audit`, other ? `${other} audit` : "other audit", "differs", "locked", "managed"])];
  for (const r of m.rows) {
    out.push(line(["table", r.logicalName, "", r.ownership, r.state, m.other ? r.otherState : "", r.differs, r.locked, r.isManaged]));
    for (const c of r.columns ?? [])
      out.push(line(["column", r.logicalName, c.logicalName, c.attributeType, c.state, m.other ? c.otherState : "", c.differs, c.locked, c.isManaged]));
  }
  return out.join("\n") + "\n";
}

export function planCsv(plan: Plan): string {
  const out: string[] = [line(["level", "table", "column", "current", "planned", "reason", "target environment", "target url"])];
  for (const i of plan.items)
    out.push(line([i.level, i.table, i.column ?? "", i.current ? "on" : "off", i.next ? "on" : "off", i.reason, plan.target.name, plan.target.url]));
  return out.join("\n") + "\n";
}

const psLit = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/**
 * The same plan as a PowerShell script against the Dataverse Web API, for people who would
 * rather run the change from a pipeline than from a tool. It performs the identical
 * retrieve-modify-PUT this tool performs, and is meant to be reviewed before it is run.
 */
export function planScript(plan: Plan): string {
  const rows = plan.items
    .map((i) => `  @{ Level = '${i.level}'; Table = ${psLit(i.table)}; Column = ${i.column ? psLit(i.column) : "$null"}; Audit = $${i.next ? "true" : "false"} }`)
    .join("\n");
  return `# SSS Audit Config Matrix - exported plan
# Target environment: ${plan.target.name} (${plan.target.environment}) ${plan.target.url}
# Generated: ${new Date().toISOString()}
#
# Sets table and column audit flags through the Dataverse Web API using the
# retrieve-modify-PUT pattern (the same calls the tool makes). Review before running.
# Token: az login, then  $t = (az account get-access-token --resource <env url> | ConvertFrom-Json).accessToken

param(
  [Parameter(Mandatory = $true)][string] $EnvironmentUrl = '${plan.target.url}',
  [Parameter(Mandatory = $true)][string] $AccessToken
)

$ErrorActionPreference = 'Stop'
$api = "$($EnvironmentUrl.TrimEnd('/'))/api/data/v9.2"
$headers = @{ Authorization = "Bearer $AccessToken"; 'OData-MaxVersion' = '4.0'; 'OData-Version' = '4.0'; 'MSCRM.MergeLabels' = 'true' }

$plan = @(
${rows}
)

foreach ($p in $plan) {
  if ($p.Level -eq 'table') {
    $url = "$api/EntityDefinitions(LogicalName='$($p.Table)')"
  } else {
    $url = "$api/EntityDefinitions(LogicalName='$($p.Table)')/Attributes(LogicalName='$($p.Column)')"
  }
  $def = Invoke-RestMethod -Method Get -Uri $url -Headers $headers
  if ($null -eq $def.IsAuditEnabled) { Write-Warning "no IsAuditEnabled on $url"; continue }
  if ($def.IsAuditEnabled.CanBeChanged -eq $false) { Write-Warning "locked: $url"; continue }
  $def.IsAuditEnabled.Value = $p.Audit
  $body = $def | Select-Object -Property * -ExcludeProperty '@odata.context', '@odata.etag'
  if ($body.'@odata.type') { $body.'@odata.type' = $body.'@odata.type'.TrimStart('#') }
  Invoke-RestMethod -Method Put -Uri $url -Headers ($headers + @{ 'Content-Type' = 'application/json' }) -Body ($body | ConvertTo-Json -Depth 30)
  Write-Host "ok: $url -> $($p.Audit)"
}

# Publish the touched tables
foreach ($t in ($plan | Select-Object -ExpandProperty Table -Unique)) {
  $xml = "<importexportxml><entities><entity>$t</entity></entities></importexportxml>"
  Invoke-RestMethod -Method Post -Uri "$api/PublishXml" -Headers ($headers + @{ 'Content-Type' = 'application/json' }) -Body (@{ ParameterXml = $xml } | ConvertTo-Json)
  Write-Host "published: $t"
}
`;
}

export function safeFileName(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "environment";
}
