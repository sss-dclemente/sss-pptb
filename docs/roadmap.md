# Roadmap — sss-pptb (Power Platform ToolBox tools) · Q4 2026 → 2027
> Rascunho. Fontes: README, docs/*-PLAN.md, docs/BACKLOG.md, commits, npm (2026-10-13). **[inferido]** = conclusão minha.

## Estado atual
> **2026-11-18 — decisão do owner: ficam 3 ferramentas** (solution-xray, envvar-matrix, d365-apps). access-checker, audit-matrix, dependency-cleaner e offboarding-wizard removidas do repo (limite de 3 ferramentas listadas para publisher novo, sobreposição no catálogo, escritas não verificadas, um maintainer). Pacotes npm deprecados, não despublicados: as últimas versões publicadas continuam instaláveis. Submissões pendentes de Access Checker, Dependency Cleaner e Audit Config Matrix a retirar no marketplace. O resto desta secção é o estado a 2026-10-13.

- 7 ferramentas publicadas no npm (`@simplesmoothsafe/pptb-*`), patch de revisão do marketplace a 2026-10-06:
  solution-xray 1.2.1 · envvar-matrix 1.6.1 · access-checker 1.2.2 · dependency-cleaner 1.5.2 · audit-matrix 0.2.2 · d365-apps 0.3.2 (repo já em 0.3.3) · offboarding-wizard 0.2.1.
- `tools/_shared/` (host adapter, debug log, tokens); testes live em Sandbox/Developer com screenshots reais.
- Cycles (Dependency Cleaner 1.4.0) construído mas **não verificado em ambiente live**.
- 0 issues reais abertas (só o digest semanal #51); 0 PRs. Último commit 2026-10-08 (vite 7.3.7, advisories).
- O mapa anterior listava só 4 ferramentas — há 7.

## Priority order
> Atualizado 2026-11-27 (run diária). Ids = [tracker](https://claude.ai/artifact/7stwLM9eQbuHoLLkY6L6ze). P0→P3 ganha ao calendário. Size: S ≤ ½ dia · M 1–2 dias · L ~1 semana · XL > 1 semana. **owner** = só o Duarte (ToolBox desktop, ambiente real, npm/marketplace).

| P | Id | Item | Area | Size | Quem | Estado |
|---|---|---|---|---|---|---|
| P0 | P0-1 | D365 Apps 1.0.0: responder à revisão "changes requested" (submetida, não listada) | Marketplace | S | owner | por fazer |
| P0 | P0-2 | D365 Apps: fechar probe §5 do [D365-APPS-PLAN.md](D365-APPS-PLAN.md) (debug log on; agente corrige `src/apps/api.ts`) | Quality | M | owner corre, agente corrige | por fazer |
| P0 | P0-3 | Confirmar `npm deprecate` ×4 e retirar submissões pendentes (Access Checker, Dependency Cleaner, Audit Config Matrix) | Marketplace | S | owner | por fazer |
| P0 | P0-4 | Rever e fazer merge do Dependabot #77 (3 dirs, 4 updates) | Quality | S | agente | em curso (#77 aberto) |
| P1 | P1-1 | EnvVar Matrix: capturas reais ([SCREENSHOTS.md](SCREENSHOTS.md) §2) + secção Screenshots | Listing | M | owner captura, agente liga | por fazer |
| P1 | P1-2 | EnvVar Matrix: teste por uma pessoa ([RELEASE.md](RELEASE.md) §2) | Quality | L | owner | por fazer |
| P1 | P1-3 | XRay: `inventory-dark.png` + `install-order.png` ([SCREENSHOTS.md](SCREENSHOTS.md) §1) | Listing | S | owner captura, agente liga | por fazer |
| P1 | P1-4 | XRay: teste real incl. live mode (`ExportSolution` shape) e Post-import ([RELEASE.md](RELEASE.md) §1) | Quality | M | owner corre, agente corrige | por fazer |
| P1 | P1-5 | Métricas de adoção sem telemetria (#57, draft desde 2026-10-13) | Growth | S | agente + owner | em curso (#57) |
| P1 | N1 | CI em PRs: build + check-dist + validate + e2e × 3 ferramentas (hoje só triage e digest) | CI | S | agente | por fazer |
| P1 | N2 | Gate `npm audit` high/critical no CI (último registo 2026-10-13; requisito Verified) | Security | S | agente | por fazer |
| P2 | P2-1 | Get Verified ×3 (ou pedir dispensa de métricas) | Marketplace | S | owner | gate: P0-1, P1-1…P1-5 |
| P2 | P2-2 | XRay live: `MissingDependencies` do zip → "falta mesmo aqui" (`RetrieveMissingDependencies` / `dependency`) | Features | M | agente | em curso (thread 2026-11-27) |
| P2 | P2-4a | XRay Compare: ignorar alterações só de versão em forms/views (hash do XML) | Features | M | agente | em curso (thread 2026-11-27) |
| P2 | P2-4b | XRay Inventory: triggers e conectores de `Workflows/*.json` (hoje só connection refs) | Features | S | agente | em curso (thread 2026-11-27) |
| P2 | P2-4c | XRay Inventory: tamanho das DLL de plug-in; listar `Templates`, `EntityMaps`, `EntityDataProviders` (hoje só contados) | Features | S | agente | em curso (thread 2026-11-27) |
| P2 | P2-4d | XRay Risk: pesos editáveis (`toolboxAPI.settings`) + popover "porquê" por fator | Features | M | agente | em curso (thread 2026-11-27) |
| P2 | N3 | Unit tests dos parsers XRay (`parse.ts`, `order.ts`, `importjob.ts`); só existe e2e | Tests | S | agente | por fazer |
| P2 | N4 | Fundir `docs/BACKLOG.md` no roadmap e apagar (desatualizado: "Not built", itens feitos) | Docs | S | agente | por fazer |
| P2 | P2-3 | Post LinkedIn + vídeo curto por release ("SSS ALM suite") | Growth | M | owner | por fazer |
| P3 | P3-1 | E8 Inter-tool invocation (`pptb.config.json`) | Features | L | agente | gate: fluxo real que o peça |
| P3 | P3-2 | E10 Mesmos diagnósticos via MCP (dataverse-ops-mcp) **[inferido]** | Features | XL | agente | gate: pedido de utilizador |
| P3 | P3-3 | 4.ª ferramenta quando o limite de 3 levantar | Catalog | XL | owner decide | gate: limite do publisher |
| P3 | P3-4 | Gratuito para sempre vs pro; funil DocGen/consultoria | Commercial | S | owner | por fazer |
| P3 | N5 | Apagar docs de plano obsoletos (PORT-PLAN, PP-API-SPIKE, USABILITY-AUDIT) | Docs | S | agente | por fazer |

Cortado: scaffold `deploymentSettings.json` no XRay — EnvVar Matrix já importa/exporta (`tools/envvar-matrix/src/matrix/settings.ts`).

### Done
- **Done on 2026-11-18**: E4 XRay live mode (#70, release #73) · E5 Post-import tab (#69, release #73) · E6 d365-apps 1.0.0 (#67) · npm 1.3.1 / 1.6.2 / 1.0.0 (#74, #76) · E1 publicar d365-apps (0.3.3 ultrapassado por 1.0.0, #76) · remoção de 4 ferramentas (#68).
- **Done (no `main`, sem PR próprio)**: Install order com versão mais alta em nomes duplicados (`tools/solution-xray/src/xray/order.ts`) · filtros/tab persistidos por viewer (`tools/_shared/view-state.ts`, localStorage).
- **Done on 2026-10-29**: `features.connections` + `minAPI` 1.2.7 em todas as ferramentas (#61) — prazo 2027-01-31 cumprido.

## Objetivos
1. Q4 2026: aprovação/listagem no marketplace PPTB e badge "Verified" (BACKLOG: após v1.0.0 e 10 MAU).
2. 2027: Solution XRay v1.1 (modo live + importjob viewer); ferramentas 0.x → 1.0.
3. Usar as ferramentas como funil para DocGen / consultoria **[inferido]**.

## Now (Q4 2026)
- **E1 Marketplace**: concluir passos do owner da revisão (P0-1, P0-3, P1-*, P2-1). ~~publicar d365-apps 0.3.3~~ (1.0.0 no npm 2026-11-18).
- **E2 Verificação live**: d365-apps (probe §5 do D365-APPS-PLAN não correu antes da publicação). ~~Cycles~~ (Dependency Cleaner removida 2026-11-18).
- **E3 Telemetria mínima de adoção** (downloads npm / MAU do PPTB) para chegar aos 10 MAU **[inferido]**.

## Next (Q1–Q2 2027)
- ~~**E4 XRay v1.1 Live mode**~~ — feito (XRay 1.3.0, #70/#73); falta P2-2 (MissingDependencies resolvidas).
- ~~**E5 XRay v1.1 Post-import tab**~~ — feito (#69/#73).
- ~~**E6 1.0 de d365-apps**~~ — feito (1.0.0, #67).
- **E7 Smaller items**: P2-4a…d na Priority order.

## Later (H2 2027)
- **E8 Inter-tool invocation** (`pptb.config.json`) entre ferramentas SSS.
- ~~**E9 "Audit Center"** a partir do audit-matrix~~ — cancelado, audit-matrix removida 2026-11-18.
- **E10 Ponte com dataverse-ops-mcp** (mesmos diagnósticos em UI e em MCP) **[inferido]**.

## Dependências
- Plataforma Power Platform ToolBox (`@pptb/types`, minAPI 1.2.0, regras de manifesto/CSP/nomeação).
- APIs Dataverse/PP (ExportSolution, RetrieveMissingDependencies).
- Site SSSWebsite para docs/marketing.

## Riscos
- Dependência de uma plataforma de terceiros (regras do marketplace mudam — já houve patch de naming).
- Ferramentas que escrevem → risco reputacional se falharem em produção de clientes. Mitigado a 2026-11-18: Dependency Cleaner e Offboarding removidas; ficam escritas em envvar-matrix e d365-apps.
- Dispersão: eram 7 ferramentas mantidas por uma pessoa/agentes; reduzido a 3 a 2026-11-18.

## Perguntas para o Duarte
1. Estado da revisão do marketplace PPTB — falta algo do teu lado?
2. Estas ferramentas ficam gratuitas para sempre ou há plano pago/pro?
3. Prioridade: XRay live mode ou levar as 0.x a 1.0?
4. Queres métricas de uso? (respeitando a ausência de telemetria nas ferramentas)
