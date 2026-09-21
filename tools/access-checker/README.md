# SSS Access Checker

Why can (or can't) a user do X on a record? Pick a user, a table and optionally a record inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com) and get the verdict per access right together with the chain that produced it: security roles (direct and through teams), privilege depth, business unit position, ownership, shares and manager hierarchy. Plus the record's share list and the user's effective column security on the table.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

- **Check** — eight chips (Create, Read, Write, Delete, Append, AppendTo, Assign, Share) with the platform verdict: `RetrievePrincipalAccess` for a record, `RetrieveUserPrivileges` (effective depth) for a table-level check. Under them, one "why" line per right: the winning role and how it reaches the record (`Deep depth: record BU Sales is under Sales`), or why the best role falls short (`Local depth covers only Sales; record is in Root`), or the share that grants it. The tool's explanation is marked `agrees` / `platform says otherwise` against the platform verdict and never overrides it.
- **Roles** — every role the user holds, how (direct or via which team, with the team type) and its depth for each right on the chosen table, straight from `RetrieveRolePrivilegesRole`.
- **Ownership & business unit** — owner, owning BU, user BU and the relation between them (owns, same BU, child BU, outside subtree).
- **Shares** — all principals the record is shared with (`RetrieveSharedPrincipalsAndAccess`), their rights, and whether each share affects the checked user (directly or through one of their teams).
- **Column security** — secured columns of the table × effective Read / Update / Create for the user, naming the field security profile that grants each, held directly or through a team. System Administrator is called out as bypassing column security.
- **Hierarchy** — when hierarchy security is on and the user is above the record owner in the manager chain, the possible extra access is noted, not asserted.
- **Export** — JSON of the whole check, CSV of shares and of column security.

Read-only: the tool never changes roles, shares or profiles.

## Screenshots

Synthetic sample data. Replace with real captures before publishing.

![Record check](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/access-checker/docs/img/check.png)

![Column security, dark theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/access-checker/docs/img/columns-dark.png)

## Install

**From the ToolBox marketplace** — search for "SSS Access Checker" once listed.

**From npm (ToolBox Debug menu)** — Settings → enable *Show Debug Menu* → Debug → *Install from npm* → `@simplesmoothsafe/pptb-access-checker`.

**From source**

```bash
cd tools/access-checker
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/access-checker` folder.

## Usage

1. Pick a primary connection in ToolBox. The tool needs one connection and reads with the rights of that connection's user.
2. **User** — type part of a name, domain name or email and pick from the list. Application users are excluded.
3. **Table** — user, team, BU or organization-owned tables; intersect and private tables are hidden.
4. **Record** (optional) — paste a GUID or search by the table's primary name. Leave empty for a table-level check.
5. **Check**. Switch tabs for shares and column security of the same user / table / record.

Notes:

- The explanation covers roles, teams (owner, access, Entra group teams as returned by team membership), privilege depth, BU chain, ownership, explicit shares and manager hierarchy. Access-team templates, inherited privileges from a team in another BU (approximated against the team's BU) and position hierarchy are not modelled: when the platform says otherwise, the platform is right.
- The hierarchy hint reads `ishierarchicalsecuritymodelenabled` from the organization row; if the attribute is not readable the hint is skipped and a note says so.
- Depth codes: Basic (user), Local (BU), Deep (BU and children), Global (organization).

## Privacy

All data stays between ToolBox and your Dataverse environment: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, and sends nothing anywhere else. Exports are written to files you choose.
