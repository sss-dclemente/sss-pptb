# CYCLES-PLAN — circular dependencies between unmanaged solutions, and a base solution to break them

Status: BUILT in Dependency Cleaner 1.4.0 (tab **Cycles**, `src/deps/cycles.ts`, `src/cycles-ui.ts`, `scripts/cycles-e2e.mjs`). UNVERIFIED against a live environment beyond what Diagnose and Slim already verified (`RetrieveRequiredComponents` through `queryData`, membership reads, `AddSolutionComponent` / `RemoveSolutionComponent` request shapes).

One-liner: pick the unmanaged solutions you ship from Dev and the **base solution** that is always installed first; the tab reads every dependency between them, finds the cycles that make no import order possible, and fixes them by moving the shared components into the base solution (or, per case, copying a component into the solution that needs it, or moving a dependent across). Required components that no selected solution carries go to the base solution too. Preview → backup → confirm, membership only, with an Undo.

Reuses Dependency Cleaner: `fetchComponents`, `retrieveRequired` (+ the session cache Diagnose fills), `resolveNames`, `removeRequest` / `addRequest`.

---

## The problem

Two unmanaged solutions, Sales and Service, each exported managed and imported into Test:

| Solution | Contains | Needs |
|---|---|---|
| Sales | form *Opportunity main* | column `svc_casecount` on opportunity, which only Service contains |
| Service | flow *Case escalation* | table `sls_territory`, which only Sales contains |

Import Sales first: missing dependency `svc_casecount`. Import Service first: missing `sls_territory`. Neither order works, and the maker portal shows it one failed import at a time. The usual way out is a **base** (core, common) solution that every other solution depends on and that is always imported first: `svc_casecount` and `sls_territory` move there, Sales and Service both import after it.

Dependencies are environment-wide facts (component A requires component B); solutions only decide *who carries* B. A dependency from a component of Si to a component carried by Sj, and by no solution installed before Si, is an edge Si → Sj ("Si after Sj"). A cycle in that graph is the deadlock.

## 0. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Home | Tab **Cycles** in SSS Dependency Cleaner | Same reads, names and writes as Diagnose and Slim; multi-solution membership was the only missing piece |
| D2 | Input | Two or more unmanaged solutions (checkbox list) and one **base solution**, unmanaged, chosen separately (may be one of the selected ones) | The base is the answer to "where do shared and orphan components go". The tool asks for it up front; without one, the fixes that need it are disabled and the cycles are report-only |
| D3 | Edge | Si → Sj when a component of Si requires a component that Sj contains and Si does not. A required component that the base contains is never an edge (base goes first). A required component contained by several selected solutions is an edge to each (any of them installed first would do) | Membership, not ownership: a component in both Si and Sj is carried by both exports |
| D4 | Out of scope | Required components whose base solution is managed (including platform ones under System): skipped, Diagnose handles them | Managed solutions are installed in the target independently |
| D5 | Orphans | A required component that is unmanaged (base solution Active) and contained by no selected solution and not by the base: **orphan**. Fix: add to the base solution | Those are the "unmanaged changes not needed in the other solutions" that still have to ship, else the export reports a missing dependency |
| D6 | Cycles | Strongly connected components (Tarjan) of the solution graph with more than one node. The import order is a topological sort of the condensation, base first; while a cycle exists there is none | Standard |
| D7 | Fixes, per (edge, required component) | **Add to base** (default when a base is set): `AddSolutionComponent(R, base)`; a table as a shell (`DoNotIncludeSubcomponents`), a subcomponent brings its table shell along. **Copy into Si**: `AddSolutionComponent(R, Si)`, Si becomes self-sufficient for R. **Move dependents to Sj**: `AddSolutionComponent(A, Sj)` + `RemoveSolutionComponent(A, Si)`, offered only when every dependent is a root row (a subcomponent under an all-assets table cannot leave alone). **No action** | Adding never removes anything from the solution that carried R: double ownership is allowed and the safe default; the optional tick **also remove from Sj** (root rows only) moves instead of copying |
| D8 | Simulation | The preview applies the chosen fixes to the in-memory membership and recomputes edges, cycles and the import order: "after these fixes: 0 cycles, order Base → Service → Sales". New edges a move would create are visible before anything is written | A fix that only moves the cycle elsewhere is caught before the write |
| D9 | Backup and undo | A `sss-dependency-cleaner-cycles-backup` file (environment url, every operation with its inverse: add ↔ remove with the previous root behaviour). **Undo…** loads it and runs the inverses in reverse order, in the same environment only | The Restore tab works per solution; a cycle fix touches several |
| D10 | Writes | Dev only; a failed operation marks its row and the batch continues; the analysis runs again after apply | As Slim |
| D11 | Not in v1 | Creating the base solution from the tab (needs a publisher), editing a form or flow to drop a reference, `dependencies` entity set reads (one query per 40 components instead of one `RetrieveRequiredComponents` per component) | Each is a separate, verifiable step |

## 1. Data

| Need | Call | Notes |
|---|---|---|
| Membership of each selected solution and the base | `fetchComponents(api, solutionId)` | key `type:objectId` → set of solutions containing it |
| Required components | `retrieveRequired(api, objectId, type)` per member of each selected solution, 4 in flight, progress + cancel; cached per environment and session, shared with Diagnose | Rows: `requiredcomponentobjectid`, `requiredcomponenttype`, `requiredcomponentparentid`, `requiredcomponentbasesolutionid` |
| Who created the required | `requiredcomponentbasesolutionid` → `fetchSolutions` list: managed → D4; Active (`fd140aae-4df4-11dd-bd17-0019b9312238`) or unmanaged → ours | Unknown base solution id → treated as unmanaged (an edge or an orphan), never silently skipped |
| Names | `resolveNames` for dependents (parent = root row's table) and requireds (parent = `requiredcomponentparentid`) | |

## 2. Analysis

1. For each selected solution Si and each member A: for each required R of A:
   - R in Si → internal, ignore.
   - R's base solution managed → ignore (D4), counted.
   - R in base → satisfied by the base, counted.
   - R in other selected solutions {Sj…} → edge Si → Sj for each, carrying the pair (A, R).
   - else → orphan (A needs R, nobody ships it).
2. Graph over the selected solutions; SCCs; cycles = SCCs of size ≥ 2; import order = topological order of the condensation, base first; solutions outside every cycle keep their place.
3. Per edge, pairs grouped by R: one fix row per (edge, R) listing the dependents.

## 3. Operations

```
add to base:        AddSolutionComponent R → base       (table: DoNotIncludeSubcomponents=true)   [+ RemoveSolutionComponent R from Sj when "also remove" is ticked and R is a root row there]
copy into Si:       AddSolutionComponent R → Si
move dependents:    AddSolutionComponent A → Sj  (same root behaviour as in Si), then RemoveSolutionComponent A from Si
orphan:             AddSolutionComponent R → base
```

Identical operations run once. Order: adds first, removes last (a component never leaves before it exists elsewhere).

## 4. Probe (first real run, Debug log on)

- [ ] Two sandbox solutions with a known cycle (a form in A bound to a column only B contains; a flow in B using a table only A contains) and an empty base solution.
- [ ] Analyze: one cycle A ⇄ B with exactly those two pairs; the orphan list is empty or names real missing pieces.
- [ ] Preview with both fixes "Add to base": simulation says 0 cycles, order Base → A → B (or B → A); the ops are two `AddSolutionComponent` into the base.
- [ ] Apply: ok; Analyzed again: 0 cycles; the maker portal shows the column (with its table shell) and the table shell in the base solution.
- [ ] Undo from the backup removes them again.
- [ ] Export both solutions managed and import into a target in the computed order: no missing dependencies.
