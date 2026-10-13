# Roadmap — sss-pptb (Power Platform ToolBox tools) · Q4 2026 → 2027
> Rascunho. Fontes: README, docs/*-PLAN.md, docs/BACKLOG.md, commits, npm (2026-10-13). **[inferido]** = conclusão minha.

## Estado atual
- 7 ferramentas publicadas no npm (`@simplesmoothsafe/pptb-*`), patch de revisão do marketplace a 2026-10-06:
  solution-xray 1.2.1 · envvar-matrix 1.6.1 · access-checker 1.2.2 · dependency-cleaner 1.5.2 · audit-matrix 0.2.2 · d365-apps 0.3.2 (repo já em 0.3.3) · offboarding-wizard 0.2.1.
- `tools/_shared/` (host adapter, debug log, tokens); testes live em Sandbox/Developer com screenshots reais.
- Cycles (Dependency Cleaner 1.4.0) construído mas **não verificado em ambiente live**.
- 0 issues reais abertas (só o digest semanal #51); 0 PRs. Último commit 2026-10-08 (vite 7.3.7, advisories).
- O mapa anterior listava só 4 ferramentas — há 7.

## Objetivos
1. Q4 2026: aprovação/listagem no marketplace PPTB e badge "Verified" (BACKLOG: após v1.0.0 e 10 MAU).
2. 2027: Solution XRay v1.1 (modo live + importjob viewer); ferramentas 0.x → 1.0.
3. Usar as ferramentas como funil para DocGen / consultoria **[inferido]**.

## Now (Q4 2026)
- **E1 Marketplace**: concluir passos do owner da revisão; publicar d365-apps 0.3.3.
- **E2 Verificação live**: Cycles e d365-apps (probe §5 do D365-APPS-PLAN não correu antes da publicação).
- **E3 Telemetria mínima de adoção** (downloads npm / MAU do PPTB) para chegar aos 10 MAU **[inferido]**.

## Next (Q1–Q2 2027)
- **E4 XRay v1.1 Live mode**: ExportSolution da ligação ativa, diff zip↔ambiente, MissingDependencies resolvidas.
- **E5 XRay v1.1 Post-import tab** (parser de `importjob.data`).
- **E6 1.0 de audit-matrix, d365-apps, offboarding-wizard**.
- **E7 Smaller items**: deploymentSettings.json scaffold, pesos de risco editáveis, settings persistidos.

## Later (H2 2027)
- **E8 Inter-tool invocation** (`pptb.config.json`) entre ferramentas SSS.
- **E9 "Audit Center"** a partir do audit-matrix.
- **E10 Ponte com dataverse-ops-mcp** (mesmos diagnósticos em UI e em MCP) **[inferido]**.

## Dependências
- Plataforma Power Platform ToolBox (`@pptb/types`, minAPI 1.2.0, regras de manifesto/CSP/nomeação).
- APIs Dataverse/PP (ExportSolution, RetrieveMissingDependencies).
- Site SSSWebsite para docs/marketing.

## Riscos
- Dependência de uma plataforma de terceiros (regras do marketplace mudam — já houve patch de naming).
- Ferramentas que escrevem (Dependency Cleaner remove componentes; offboarding) → risco reputacional se falharem em produção de clientes.
- Dispersão: 7 ferramentas mantidas por uma pessoa/agentes **[inferido]**.

## Perguntas para o Duarte
1. Estado da revisão do marketplace PPTB — falta algo do teu lado?
2. Estas ferramentas ficam gratuitas para sempre ou há plano pago/pro?
3. Prioridade: XRay live mode ou levar as 0.x a 1.0?
4. Queres métricas de uso? (respeitando a ausência de telemetria nas ferramentas)
