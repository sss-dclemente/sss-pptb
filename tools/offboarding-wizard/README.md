# Offboarding Wizard

A user is leaving. Inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com), pick them and get a complete inventory of what they hold — records per table, flows and classic processes, personal views and charts, queues, teams, security roles, field security profiles, connection references, connections, direct reports — then pick a successor, review a preview of the exact operations, apply them with progress and per-item results, and export a report you can hand to an auditor.

## What it does

- **Leaver** — search by name, domain name or email. Shows business unit, manager, enabled/disabled state, access mode and the number of direct reports.
- **Inventory** — one card per category with a count and a detail table. A category holding anything flagged opens by default and shows "n flagged"; open/closed state survives filtering and re-scans, and Expand all / Collapse all sit above the cards:
  - **Records owned per table.** Dataverse has no cross-table "what does this user own", so the tool reads the metadata for every user- and team-owned table and asks each one for a count. That is hundreds of requests: the tool says how many before it starts, runs them six at a time with a progress bar and a cancel button, and lists any table that rejects the owner filter as *not scanned* instead of failing the run. Narrow the scan with a name filter; afterwards, filter the scanned tables inside the records card. Tables that could not be scanned are counted in the scan summary and listed on demand ("show tables that could not be scanned"). The scan only ever returns tables where the leaver owns records.
  - **Flows and classic processes** — labelled by category (classic workflow, dialog, business rule, action, business process flow, modern flow). An **active modern flow** is flagged: that is the one that breaks silently when its owner is disabled.
  - **Personal views** and **personal charts**, **queues owned** and **queue memberships**, **team memberships** (owner teams, Entra group teams and the business unit default team called out), **security roles**, **field security profiles**, **connection references**, **connections**, **direct reports**.
- **What a reassignment really does** — the tool states the things that decide whether an offboarding actually worked, rather than leaving them to be discovered afterwards: if the environment has *share to previous owner on assign* enabled, every reassigned record is shared straight back to the leaver with full rights, and the plan says so; reassigning a record deactivates any workflow or business rule active on it; a cloud flow's owner can only be changed for solution-aware flows, the leaver stays a co-owner, and licensing takes up to seven days to follow.
- **Security roles across business units** — roles are business-unit scoped, so the leaver's role cannot simply be handed to a successor in another business unit. The tool resolves the equivalent role in the successor's own business unit and grants that one; a role with no equivalent there is skipped with that reason instead of failing at apply time. Anything the successor already holds — a role, a profile, a team — is skipped rather than planned as an operation that can only fail.
- **Plan & apply** — pick the successor, choose whether reassigned records go to them or to a team, and tick what to do per category: copy roles to the successor and/or remove them from the leaver, the same for field security profiles, remove the leaver from their teams and optionally add the successor. Then **Preview plan**: the environment (connection name and URL), the leaver, the successor and where records go; operation counts per kind of write; the warnings and the skips; and every call verbatim per category, the first 25 shown with "Show all" for the rest (`update account(…) {"ownerid@odata.bind":"/systemusers(…)"}`). The preview says plainly that the run cannot be undone from the tool and offers **Export plan (CSV)** first: every operation with the value it replaces. Nothing is written until you confirm.
- **Apply** — four writes at a time, with progress and a cancel button. Every operation gets its own row: ok, or the platform's error message. A failure never stops the run and is never silently retried.
- **Report** — inventory as JSON or CSV, apply results as JSON or CSV (both carry the exact call made and the previous owner or manager it replaced), plus the list of steps the tool deliberately leaves to a human.

What it never does: disable the leaver, change their access mode, or touch a licence. Those stay a deliberate manual step and are listed in the report.

For very large ownership moves (tens of thousands of records in one table), ToolBox already ships an **Ownership Mover**; this tool caps a plan at 5 000 operations and warns above 1 000.

## What this tool changes

Every write goes through the ToolBox `dataverseAPI` bridge (`update`, `associate`, `disassociate`), one call per record or membership, four at a time, and only after you confirm the preview on the **Plan & apply** tab. The confirmation names the environment (connection name and URL), the leaver, the successor and where records go, and counts the operations per kind of write. A plan is capped at 5 000 operations, and records at 500 per table by default (up to 5 000).

**Dataverse writes** (each only for the categories and options you tick):

- **Ownership reassignment of records** — `update <table>(id)` setting `ownerid` to the successor or to a team you pick, for records the leaver owns in the tables you tick. Dataverse runs this as an Assign, so each relationship's Assign cascade rule applies: related child records can change owner with their parent, and those are not counted in the plan or listed in the exports. Reassigning a record deactivates workflows and business rules active on it. If the environment has *share to previous owner on assign* on, Dataverse shares every reassigned record back to the leaver (the tool reads that setting and warns; it never changes it).
- **Ownership reassignment of other items the leaver owns** — flows and classic processes (`workflow`), personal views (`userquery`), personal charts (`userqueryvisualization`), queues, connection references and connections: `update` setting `ownerid` to the successor user. A cloud flow's previous owner stays a co-owner.
- **Direct reports** — `update systemuser(id)` setting the manager (`parentsystemuserid`) to the successor, for users whose manager is the leaver.
- **Security roles** — grant to the successor (`associate`, `systemuserroles_association`; the equivalent role in the successor's business unit when it differs) and, optionally, remove from the leaver (`disassociate`). Grant is on by default, removal off.
- **Field security profiles** — the same, with `systemuserprofiles_association`.
- **Team membership** — remove the leaver from their owner and access teams (`disassociate`, `teammembership_association`; on by default) and, optionally, add the successor (`associate`). Entra group teams and the business unit default team are never touched.

**Way back.** No backup is taken in Dataverse and a run cannot be undone from this tool: Dataverse has no undo for an owner change, a removed role or a removed team membership. The preview's **Export plan (CSV)**, before anything is written, and the results JSON/CSV on the Report tab list every operation with the value it replaces (previous owner of each record and item, previous manager of each direct report, roles, profiles and team memberships removed from the leaver). Reverting means reassigning and re-granting from that list by hand. Cascaded child records and shares created by *share to previous owner on assign* are not in that list.

**Files** — inventory (JSON, CSV), plan (CSV), apply results (JSON, CSV) and the debug log, written only where you choose in the ToolBox save dialog.

**Browser storage** — `localStorage` keeps the *Show empty categories* switch and the debug log switch for this tool, per viewer.

**Nothing else.** The tool never disables the leaver, changes their access mode, touches licences, deletes a record, changes organization settings, re-authenticates a connection or changes Entra ID group membership, and it never writes queue memberships (inventory only).

## Install

**From the ToolBox marketplace** — search for "Offboarding Wizard" once listed.

**From npm (ToolBox Debug menu)** — Settings → enable *Show Debug Menu* → Debug → *Install from npm* → `@simplesmoothsafe/pptb-offboarding-wizard`.

**From source**

```bash
cd tools/offboarding-wizard
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/offboarding-wizard` folder.

## Usage

1. Pick a primary connection in ToolBox. The tool reads and writes with the rights of that connection's user: reassigning records needs the Assign privilege on those tables, and changing roles or team membership needs the matching privileges.
2. **Leaver** — search and pick. Every category is read immediately; the record scan is separate because of its cost.
3. **Inventory** — run the scan if you need the records, then tick the categories to include.
4. **Plan & apply** — pick the successor, set the options, preview, export the plan if you want the way back, confirm.
5. **Report** — export both files and keep them: they name every operation and its result.

Notes:

- Ownership is moved by setting `ownerid` (`update` with `ownerid@odata.bind`), one record at a time, so every record gets its own ok/fail. Roles, field security profiles and team membership use `associate` / `disassociate`.
- **Owner teams**: removing the leaver from an owner team does not move the records that team owns — they stay with the team. The tool flags this instead of pretending otherwise.
- **Entra security and office group teams** are skipped: that membership is managed in Entra ID, not in Dataverse.
- **Business unit default team**: every user is a member of their business unit's default team and Dataverse refuses to remove them from it. It is listed and flagged in the inventory, and skipped by the plan with that reason.
- **Connection references** change owner, but the connection behind them still belongs to the leaver; the successor has to re-authenticate it. The Power Apps portal cannot transfer a connection reference at all, so this is the only supported route. If the leaver's account is disabled, the connection becomes invalid for everyone sharing it — which is why the connections themselves are inventoried too.
- **Queue memberships** are inventory only in this version.
- Records per table are capped (default 500, configurable up to 5 000); a truncated table is named in the plan warnings. Dataverse counts saturate at 5 000 without saying so, so a table at that figure is reported as "5000 or more" rather than as an exact number.

## Debug log

For troubleshooting, tick **Debug log** in the footer, reproduce the problem, then **Save log**: a `offboarding-wizard-debug-<timestamp>.txt` file with every ToolBox, Dataverse and Power Platform API call the tool made (the exact query or request, the response or error, timing), notifications, connection events and uncaught errors. The switch is remembered for this tool; `?debug=1` also turns it on. Off, nothing is recorded.

The file is written only where you save it. Secrets (keys named like password, secret, token, authorization) are redacted, and long strings, arrays and binary payloads are truncated, but responses still contain record data such as names and ids: review the file before you share it.

## Privacy

All data stays between ToolBox and your Dataverse environment: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, bundles no remote code and sends nothing anywhere else. Exports are written to files you choose.

## AI Assistance

Substantial parts of this tool's code and documentation were generated with Claude Code (Anthropic) and reviewed and maintained by the contributors listed in `package.json`. Real-environment testing status is stated in this README where a feature has not yet been verified.

## Credits

Built and maintained by Duarte Clemente ([Simple Smooth Safe](https://simplesmoothsafe.com)).
