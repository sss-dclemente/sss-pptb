# Lista de verificação — listagem no marketplace PPTB e badge Verified

> **2026-11-18 — quatro ferramentas removidas.** Access Checker, Dependency Cleaner, Offboarding Wizard e Audit Config Matrix saíram do repositório (limite de 3 ferramentas listadas para publisher novo, sobreposição no catálogo, caminhos de escrita nunca verificados em live, um só maintainer). Pacotes npm deprecados, não despublicados: as últimas versões publicadas continuam instaláveis. Owner: `npm deprecate` dos quatro e retirar as submissões pendentes de Access Checker, Dependency Cleaner e Audit Config Matrix (Offboarding Wizard nunca foi submetida). Ficam: Solution XRay, EnvVar & ConnRef Matrix, D365 Apps Matrix.

Estado lido do repositório a 2026-10-13. Nada nesta lista publica no npm nem submete ferramentas.

Fontes: [PPTB-NOTES.md](PPTB-NOTES.md) §§1, 7 e 13; [RELEASE.md](RELEASE.md); [SCREENSHOTS.md](SCREENSHOTS.md); [PORT-PLAN.md](PORT-PLAN.md); [BACKLOG.md](BACKLOG.md); `package.json`, README e `docs/img/` de cada ferramenta. `npm audit` corrido no mesmo dia sobre cada `package-lock.json`.

Legenda: **feito** · **parcial** · **em falta** · **owner** (passo fora do repositório: submissão, resposta à revisão, pedido do badge, métricas).

As três ferramentas mantidas: Solution XRay, EnvVar & ConnRef Matrix, D365 Apps Matrix.

## O que a plataforma exige

### Listagem

Intake, por [PPTB-NOTES.md](PPTB-NOTES.md) §7: `npm run build` → `pptb-validate` → publicar no npm com `--access public` → submeter em https://www.powerplatformtoolbox.com/submit-tool (nome npm e até 3 categorias) → verificações automáticas → revisão manual (48–72 h) → listada. O registo sincroniza a tag `latest` do npm todos os dias às 00:00 UTC, por comparação de strings.

O validador (`@pptb/validate` 1.0.2, «fonte única» do intake) exige no `package.json`, sem secção `pptb`:

| Campo | Regra |
|---|---|
| `name`, `version`, `displayName`, `description` | texto não vazio. A versão só precisa de ser ≥ 1.0.0 para o badge Verified |
| `license` | uma de `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `GPL-2.0`, `GPL-3.0`, `LGPL-3.0`, `ISC`, `AGPL-3.0-only` |
| `contributors` | lista não vazia de `{name, url?}` |
| `configurations.repository` | URL com HEAD alcançável |
| `configurations.readmeUrl` | URL alcançável cujo host não seja `github.com` — usar `raw.githubusercontent.com`. A página de manifesto diz que é opcional; o validador falha sem ela |
| `icon` | caminho POSIX relativo para um `.svg` dentro de `dist/`, sem `..`, sem URL. Ausente = aviso. `currentColor` para o ícone seguir o tema |
| `features.connections` | número exato 0–10 ou `{ min, max }`; exige `minAPI` 1.2.7. Não se combina com `multiConnection` / `connectionRequirement` (legados) |
| `configurations.iconUrl` | proibido |

`main` é `index.html` e resolve-se **dentro** de `dist/` ([PPTB-NOTES.md](PPTB-NOTES.md) §11). O build (`tools/_shared/check-dist.mjs`) recusa `dist/` sem `index.html` e `icon.svg`, com `type="module"`, com URL remota no HTML, com mais de um script, com `eval` / `new Function` ou com CSS remoto.

A página de publishing pede `npm shrinkwrap` (`finalize-package`). Este repositório **não** o volta a meter: um shrinkwrap publicado traz as `devDependencies` e um pacote de ~25 kB passava a instalar ~50 MB ([PORT-PLAN.md](PORT-PLAN.md), [RELEASE.md](RELEASE.md)). O `dist/` é autónomo e o validador não exige o shrinkwrap.

Categorias aceites (máximo 3): Comparisons, Data, Development, Diagrams, Documentation, Environments, Migration, Solutions, Troubleshooting, Users & Security.

Política do marketplace e de desenvolvimento assistido por IA, da ronda de revisão de 2026-10 ([RELEASE.md](RELEASE.md), [SCREENSHOTS.md](SCREENSHOTS.md)):

- `displayName` sem prefixo do publisher. Atribuição só em `contributors` e na secção `## Credits` do README.
- Secção `## What this tool changes` logo a seguir a *What it does*.
- Confirmações de escrita com o ambiente alvo e o âmbito, e ou uma cópia de segurança ou a frase de que a alteração não se desfaz a partir da ferramenta.
- Secção `## AI Assistance`. A frase pode dizer «reviewed, tested and maintained» só depois do teste por uma pessoa; até lá, «reviewed and maintained».
- Capturas de ecrã reais, da ferramenta dentro do ToolBox, não de mock-ups. Sintéticas foram rejeitadas. URLs absolutas `raw.githubusercontent.com` de `main`: a listagem lê o `readmeUrl`, não o tarball.
- Teste feito por uma pessoa, contra um ambiente real: tema claro e escuro, volumes realistas, caminhos de erro (permissões em falta, ligação expirada, resultados vazios). Linhas «UNVERIFIED» no README só saem depois desse teste.

Debug → *Install from npm* falha no host com `ERR_FILE_NOT_FOUND` ([PPTB-NOTES.md](PPTB-NOTES.md) §11). A instalação pelo marketplace usa outro ramo e não fica bloqueada por esse defeito.

### Badge Verified

Pedido à parte, em My Tools → Get Verified, 1–2 semanas ([PPTB-NOTES.md](PPTB-NOTES.md) §7; [BACKLOG.md](BACKLOG.md): depois de v1.0.0 e 10 MAU). A governação nocturna revoga o badge por CVE novo, exceção CSP nova ou quebra da saúde de bugs.

| Requisito | Nota |
|---|---|
| README com captura ou GIF, mais instalar e executar | |
| Cada exceção CSP justificada | Exceção nova tira o badge de imediato. Objetivo deste repo: zero exceções |
| `npm audit` sem high nem critical | |
| Sem APIs deprecadas | Ver o prazo de 2027-01-31 abaixo |
| Tema claro e escuro | [PPTB-NOTES.md](PPTB-NOTES.md) §3 |
| Ícone SVG em `dist/` | |
| `version` ≥ 1.0.0 | O intake aceita 0.x; o badge não |
| Saúde de bugs | menos de 5 issues abertas; resposta em ≤ 10 dias |
| 2 de 3 métricas de uso | MAU ≥ 10, downloads ≥ 50, ≥ 1 review com nota ≥ 3. Dispensáveis |

### Prazo que esconde as ferramentas (2027-01-31)

A partir do Desktop 1.2.7, `features.connections` substitui `multiConnection` e `connectionRequirement` ([PPTB-NOTES.md](PPTB-NOTES.md) §13). Depois de 2027-01-31, quem continuar nos campos legados fica Deprecated e sai do marketplace. `connections` exige `minAPI` 1.2.7 e `@pptb/validate` ≥ 1.0.4. Desktop 1.2.7 estável desde 2026-10-12: fase B feita a 2026-10-26, as ferramentas usam `connections` + `minAPI` 1.2.7 e o adaptador em `tools/_shared` usa só `getConnections()`.

| Ferramenta | Hoje (legado) | `connections` a publicar |
|---|---|---|
| D365 Apps Matrix | none / required, com `enabledForPowerPlatformAPI` | `1` |
| Solution XRay | none / optional | `{ "min": 0, "max": 1 }` |
| EnvVar & ConnRef Matrix | optional / required | `{ "min": 1, "max": 2 }` |

Estado: **feito** (fase B, 2026-10-26).

## Estado por ferramenta

Versões no `package.json` de `main`. O npm indicado é o que [RELEASE.md](RELEASE.md) e o [roadmap](roadmap.md) registam como publicado a 2026-10-06 (o patch de revisão).

| | XRay | EnvVar | D365 Apps |
|---|---|---|---|
| Versão no repo | 1.2.1 | 1.6.1 | 0.3.3 |
| npm `latest` documentado | 1.2.1 | 1.6.1 | 0.3.2 |
| Manifesto (validador) | feito | feito | feito |
| `displayName` sem prefixo | feito | feito | feito |
| What this tool changes | feito | feito | feito |
| Credits + `contributors` | feito | feito | feito |
| Ícone SVG `currentColor` | feito | feito | feito |
| Zero `cspExceptions` | feito | feito | feito |
| Tema claro/escuro no código | feito | feito | feito |
| README: instalar e usar | feito | feito | feito |
| `## AI Assistance` | feito | feito | feito |
| Frase «tested» | em falta | em falta | feito |
| Capturas reais no README | parcial | em falta | feito |
| Par claro e escuro no README | em falta | em falta | feito |
| Teste por uma pessoa | em falta | em falta | parcial |
| Publicado no npm | feito | feito | parcial |
| `npm audit` high/critical | feito | feito | feito |
| `version` ≥ 1.0.0 | feito | feito | em falta |
| Submissão ao marketplace | owner | owner | feito |
| Revisão | — | — | owner |
| Métricas 2 de 3 | owner | owner | owner |
| Pedido Get Verified | owner | owner | owner |

`npm audit` a 2026-10-13: 0 info, 0 low, 0 moderate, 0 high, 0 critical em cada lockfile. Saúde de bugs, à data do roadmap: 0 issues reais abertas (o digest semanal não é um defeito de ferramenta). A regra dos 10 dias só se mede no marketplace, depois da listagem.

### Solution XRay — `@simplesmoothsafe/pptb-solution-xray` — 1.2.1

Categorias em [RELEASE.md](RELEASE.md): Solutions, Troubleshooting, Migration (como no catálogo, 2026-11-18). `minAPI` 1.0.20. Sem ligação.

- **feito** — manifesto, licença MIT, ícone, sem CSP, secções de escrita (não escreve em lado nenhum), AI Assistance («reviewed and maintained»), Install e Usage.
- **parcial** — README com `inventory-light.png` e `risk.png`, capturas reais no ToolBox com zips de amostra. Faltam `inventory-dark.png` e `install-order.png` ([SCREENSHOTS.md](SCREENSHOTS.md) §1).
- **em falta** — as caixas de teste real em [RELEASE.md](RELEASE.md) §1 continuam por preencher. Sem esse teste a frase da AI fica em «reviewed and maintained».
- **owner** — a ronda que devolveu «changes requested» não nomeia esta ferramenta, e o README ainda diz «once listed». Confirmar se a submissão já foi feita; se não, submeter. Badge Verified só depois das capturas em falta, do teste, e do pedido em My Tools (a versão já passa de 1.0.0).

### EnvVar & ConnRef Matrix — `@simplesmoothsafe/pptb-envvar-matrix` — 1.6.1

Categorias: Environments, Migration, Comparisons. `minAPI` 1.2.0. Ligações: `optional` / `required`.

- **feito** — manifesto e política de README (excepto capturas). Várias funções já estão no npm.
- **em falta** — não há secção Screenshots nem ficheiros em `tools/envvar-matrix/docs/img/`. A lista de [SCREENSHOTS.md](SCREENSHOTS.md) §2 (`envvars.png`, `preview.png`, `connrefs.png`, `snapshot-dark.png`) está por capturar. As caixas de teste real em [RELEASE.md](RELEASE.md) §2 estão por preencher; várias versões saíram antes dessa verificação.
- **owner** — igual ao XRay: submissão não está registada na ronda de revisão. Sem capturas e sem teste, não há pedido de Verified que se aguente, mesmo com versão ≥ 1.0.0.

### D365 Apps Matrix — `@simplesmoothsafe/pptb-d365-apps` — 0.3.3 no repo, 0.3.2 no npm

Categorias: Environments, Comparisons, Solutions ([RELEASE.md](RELEASE.md) §7). `minAPI` 1.2.6, `enabledForPowerPlatformAPI: true`. Uma ligação, obrigatória.

- **feito** — submetida. README com quatro capturas reais, incluindo `matrix-dark.png`. AI em «reviewed, tested and maintained». Teste de 2026-10-06: leitura, pré-visualização, uma atualização ponta a ponta (Storage Advisor Components 1.0.0.2 → 1.0.0.3), CSV, claro e escuro.
- **parcial** — o probe §5 de [D365-APPS-PLAN.md](D365-APPS-PLAN.md) não fechou antes da publicação: «update available» é derivado e não foi comparado com o PPAC. Por verificar: retry, primeira instalação, vários ambientes em paralelo, script `pac` por executar, relatório Unused (no ambiente de teste quase não mapeou pacotes). O repo está em 0.3.3 (correcção do lote de contagens); o npm documentado ficou em 0.3.2.
- **em falta** — versão 0.x. O badge Verified não aceita abaixo de 1.0.0. O roadmap (E6) deixa esse 1.0 para 2027.
- **owner** — publicar 0.3.3 (o registo só vê `latest`) e responder à revisão. O pedido de Verified espera pelo 1.0.0, pelas métricas e pelo fecho do que o README ainda marca como não verificado.

## O que falta, por ordem

1. **Owner, remoção (2026-11-18).** `npm deprecate` de access-checker, dependency-cleaner, offboarding-wizard e audit-matrix; retirar em powerplatformtoolbox.com as submissões pendentes de Access Checker, Dependency Cleaner e Audit Config Matrix.
2. **Owner, listagem.** D365 Apps (já revista): fechar o teste aberto, publicar 0.3.3, responder à revisão. Confirmar se XRay e EnvVar chegaram a ser submetidas; EnvVar não tem capturas, XRay não tem o par escuro nem a ordem de instalação.
3. **Verified, quando a listagem existir.** Versão ≥ 1.0.0 falta em D365 Apps (roadmap E6, 2027). XRay e EnvVar já em 1.x: o pedido em My Tools → Get Verified depende das capturas, do teste declarado e de 2 das 3 métricas — ou do pedido de dispensa. O backlog usa 10 MAU como marca.
