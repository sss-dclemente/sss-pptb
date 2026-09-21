# SSS Offboarding Wizard

A user is leaving. Inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com), pick them and get a complete inventory of what they hold — records per table, flows and classic processes, personal views and charts, queues, teams, security roles, field security profiles, connection references, connections, direct reports — then pick a successor, review a preview of the exact operations, apply them with progress and per-item results, and export a report you can hand to an auditor.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

- **Leaver** — search by name, domain name or email. Shows business unit, manager, enabled/disabled state, access mode and the number of direct reports.
- **Inventory** — one card per category with a count and a detail table:
  - **Records owned per table.** Dataverse has no cross-table "what does this user own", so the tool reads the metadata for every user- and team-owned table and asks each one for a count. That is hundreds of requests: the tool says how many before it starts, runs them six at a time with a progress bar and a cancel button, and lists any table that rejects the owner filter as *not scanned* instead of failing the run. Narrow the scan with a name filter, or hide the tables with no records.
  - **Flows and classic processes** — labelled by category (classic workflow, dialog, business rule, action, business process flow, modern flow). An **active modern flow** is flagged: that is the one that breaks silently when its owner is disabled.
  - **Personal views** and **personal charts**, **queues owned** and **queue memberships**, **team memberships** (owner teams and Entra group teams called out), **security roles**, **field security profiles**, **connection references**, **connections**, **direct reports**.
- **What a reassignment really does** — the tool states the things that decide whether an offboarding actually worked, rather than leaving them to be discovered afterwards: if the environment has *share to previous owner on assign* enabled, every reassigned record is shared straight back to the leaver with full rights, and the plan says so; reassigning a record deactivates any workflow or business rule active on it; a cloud flow's owner can only be changed for solution-aware flows, the leaver stays a co-owner, and licensing takes up to seven days to follow.
- **Security roles across business units** — roles are business-unit scoped, so the leaver's role cannot simply be handed to a successor in another business unit. The tool resolves the equivalent role in the successor's own business unit and grants that one; a role with no equivalent there is skipped with that reason instead of failing at apply time. Anything the successor already holds — a role, a profile, a team — is skipped rather than planned as an operation that can only fail.
- **Plan & apply** — pick the successor, choose whether reassigned records go to them or to a team, and tick what to do per category: copy roles to the successor and/or remove them from the leaver, the same for field security profiles, remove the leaver from their teams and optionally add the successor. Then **Preview plan**: operation counts per category, the warnings and the skips, and the first 25 calls verbatim (`update account(…) {"ownerid@odata.bind":"/systemusers(…)"}`). Nothing is written until you confirm.
- **Apply** — four writes at a time, with progress and a cancel button. Every operation gets its own row: ok, or the platform's error message. A failure never stops the run and is never silently retried.
- **Report** — inventory as JSON or CSV, apply results as JSON or CSV (both carry the exact call made), plus the list of steps the tool deliberately leaves to a human.

What it never does: disable the leaver, change their access mode, or touch a licence. Those stay a deliberate manual step and are listed in the report.

For very large ownership moves (tens of thousands of records in one table), ToolBox already ships an **Ownership Mover**; this tool caps a plan at 5 000 operations and warns above 1 000.

## Screenshots

Synthetic sample data. Replace with real captures before publishing.

![Inventory](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/offboarding-wizard/docs/img/inventory.png)

![Plan and apply](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/offboarding-wizard/docs/img/plan.png)

![Report, dark theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/offboarding-wizard/docs/img/report-dark.png)

## Install

**From the ToolBox marketplace** — search for "SSS Offboarding Wizard" once listed.

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
4. **Plan & apply** — pick the successor, set the options, preview, confirm.
5. **Report** — export both files and keep them: they name every operation and its result.

Notes:

- Ownership is moved by setting `ownerid` (`update` with `ownerid@odata.bind`), one record at a time, so every record gets its own ok/fail. Roles, field security profiles and team membership use `associate` / `disassociate`.
- **Owner teams**: removing the leaver from an owner team does not move the records that team owns — they stay with the team. The tool flags this instead of pretending otherwise.
- **Entra security and office group teams** are skipped: that membership is managed in Entra ID, not in Dataverse.
- **Connection references** change owner, but the connection behind them still belongs to the leaver; the successor has to re-authenticate it. The Power Apps portal cannot transfer a connection reference at all, so this is the only supported route. If the leaver's account is disabled, the connection becomes invalid for everyone sharing it — which is why the connections themselves are inventoried too.
- **Queue memberships** are inventory only in this version.
- Records per table are capped (default 500, configurable up to 5 000); a truncated table is named in the plan warnings. Dataverse counts saturate at 5 000 without saying so, so a table at that figure is reported as "5000 or more" rather than as an exact number.

## Privacy

All data stays between ToolBox and your Dataverse environment: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, bundles no remote code and sends nothing anywhere else. Exports are written to files you choose.
