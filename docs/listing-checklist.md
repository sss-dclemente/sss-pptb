# Lista de verificação — listagem no marketplace PPTB e badge Verified

Estado lido do repositório a 2026-10-13. Nada nesta lista publica no npm nem submete ferramentas.

Fontes: [PPTB-NOTES.md](PPTB-NOTES.md) §§1, 7 e 13; [RELEASE.md](RELEASE.md); [SCREENSHOTS.md](SCREENSHOTS.md); [PORT-PLAN.md](PORT-PLAN.md); [BACKLOG.md](BACKLOG.md); `package.json`, README e `docs/img/` de cada ferramenta. `npm audit` corrido no mesmo dia sobre cada `package-lock.json`.

Legenda: **feito** · **parcial** · **em falta** · **owner** (passo fora do repositório: submissão, resposta à revisão, pedido do badge, métricas).

As sete ferramentas: Solution XRay, EnvVar & ConnRef Matrix, Access Checker, Dependency Cleaner, D365 Apps Matrix, Offboarding Wizard, Audit Config Matrix.

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
| 2 de 3 métricas de uso | MAU ≥ 10, downloads ≥ 50, ≥ 1 review com nota ≥ 3. Dispensáveis. Leitura pública, sem telemetria, em [ADOPTION.md](ADOPTION.md) |

### Prazo que esconde as ferramentas (2027-01-31)

A partir do Desktop 1.2.7, `features.connections` substitui `multiConnection` e `connectionRequirement` ([PPTB-NOTES.md](PPTB-NOTES.md) §13). Depois de 2027-01-31, quem continuar nos campos legados fica Deprecated e sai do marketplace. `connections` exige `minAPI` 1.2.7 e `@pptb/validate` ≥ 1.0.4. Desktop 1.2.7 estável desde 2026-10-12: fase B feita a 2026-10-26, as 7 ferramentas usam `connections` + `minAPI` 1.2.7 e o adaptador em `tools/_shared` usa só `getConnections()`.

| Ferramenta | Hoje (legado) | `connections` a publicar |
|---|---|---|
| Access Checker | none / required | `1` |
| Offboarding Wizard | none / required | `1` |
| D365 Apps Matrix | none / required, com `enabledForPowerPlatformAPI` | `1` |
| Solution XRay | none / optional | `{ "min": 0, "max": 1 }` |
| Audit Config Matrix | optional / required | `{ "min": 1, "max": 2 }` |
| Dependency Cleaner | optional / required | `{ "min": 1, "max": 2 }` |
| EnvVar & ConnRef Matrix | optional / required | `{ "min": 1, "max": 2 }` |

Estado nas sete: **em falta**, de propósito, até o Desktop 1.2.7 estável.

## Estado por ferramenta

Versões no `package.json` de `main`. O npm indicado é o que [RELEASE.md](RELEASE.md) e o [roadmap](roadmap.md) registam como publicado a 2026-10-06 (o patch de revisão).

| | XRay | EnvVar | Access | Dep. Cleaner | D365 Apps | Offboarding | Audit |
|---|---|---|---|---|---|---|---|
| Versão no repo | 1.2.1 | 1.6.1 | 1.2.2 | 1.5.2 | 0.3.3 | 0.2.1 | 0.2.2 |
| npm `latest` documentado | 1.2.1 | 1.6.1 | 1.2.2 | 1.5.2 | 0.3.2 | 0.2.1 | 0.2.2 |
| Manifesto (validador) | feito | feito | feito | feito | feito | feito | feito |
| `displayName` sem prefixo | feito | feito | feito | feito | feito | feito | feito |
| What this tool changes | feito | feito | feito | feito | feito | feito | feito |
| Credits + `contributors` | feito | feito | feito | feito | feito | feito | feito |
| Ícone SVG `currentColor` | feito | feito | feito | feito | feito | feito | feito |
| Zero `cspExceptions` | feito | feito | feito | feito | feito | feito | feito |
| Tema claro/escuro no código | feito | feito | feito | feito | feito | feito | feito |
| README: instalar e usar | feito | feito | feito | feito | feito | feito | feito |
| `## AI Assistance` | feito | feito | feito | feito | feito | feito | feito |
| Frase «tested» | em falta | em falta | feito | em falta | feito | em falta | feito |
| Capturas reais no README | parcial | em falta | parcial | em falta | feito | em falta | feito |
| Par claro e escuro no README | em falta | em falta | feito | em falta | feito | em falta | feito |
| Teste por uma pessoa | em falta | em falta | parcial | parcial | parcial | parcial | parcial |
| Publicado no npm | feito | feito | feito | feito | parcial | feito | feito |
| `npm audit` high/critical | feito | feito | feito | feito | feito | feito | feito |
| `version` ≥ 1.0.0 | feito | feito | feito | feito | em falta | em falta | em falta |
| Submissão ao marketplace | owner | owner | feito | feito | feito | owner | feito |
| Revisão | — | — | owner | owner | owner | — | owner |
| Métricas 2 de 3 | owner | owner | owner | owner | owner | owner | owner |
| Pedido Get Verified | owner | owner | owner | owner | owner | owner | owner |

`npm audit` a 2026-10-13: 0 info, 0 low, 0 moderate, 0 high, 0 critical em cada lockfile. Saúde de bugs, à data do roadmap: 0 issues reais abertas (o digest semanal não é um defeito de ferramenta). A regra dos 10 dias só se mede no marketplace, depois da listagem.

### Solution XRay — `@simplesmoothsafe/pptb-solution-xray` — 1.2.1

Categorias em [RELEASE.md](RELEASE.md): Solutions, Troubleshooting, Comparisons. `minAPI` 1.0.20. Sem ligação.

- **feito** — manifesto, licença MIT, ícone, sem CSP, secções de escrita (não escreve em lado nenhum), AI Assistance («reviewed and maintained»), Install e Usage.
- **parcial** — README com `inventory-light.png` e `risk.png`, capturas reais no ToolBox com zips de amostra. Faltam `inventory-dark.png` e `install-order.png` ([SCREENSHOTS.md](SCREENSHOTS.md) §1).
- **em falta** — as caixas de teste real em [RELEASE.md](RELEASE.md) §1 continuam por preencher. Sem esse teste a frase da AI fica em «reviewed and maintained».
- **owner** — a ronda que devolveu «changes requested» não nomeia esta ferramenta, e o README ainda diz «once listed». Confirmar se a submissão já foi feita; se não, submeter. Badge Verified só depois das capturas em falta, do teste, e do pedido em My Tools (a versão já passa de 1.0.0).

### EnvVar & ConnRef Matrix — `@simplesmoothsafe/pptb-envvar-matrix` — 1.6.1

Categorias: Environments, Migration, Comparisons. `minAPI` 1.2.0. Ligações: `optional` / `required`.

- **feito** — manifesto e política de README (excepto capturas). Várias funções já estão no npm.
- **em falta** — não há secção Screenshots nem ficheiros em `tools/envvar-matrix/docs/img/`. A lista de [SCREENSHOTS.md](SCREENSHOTS.md) §2 (`envvars.png`, `preview.png`, `connrefs.png`, `snapshot-dark.png`) está por capturar. As caixas de teste real em [RELEASE.md](RELEASE.md) §2 estão por preencher; várias versões saíram antes dessa verificação.
- **owner** — igual ao XRay: submissão não está registada na ronda de revisão. Sem capturas e sem teste, não há pedido de Verified que se aguente, mesmo com versão ≥ 1.0.0.

### Access Checker — `@simplesmoothsafe/pptb-access-checker` — 1.2.2

Categorias: Users & Security, Troubleshooting. `minAPI` 1.2.0. Uma ligação, obrigatória.

- **feito** — submetida. Patch de revisão no repo e no npm 1.2.2 (capturas reais, secção do que muda, AI a dizer «reviewed, tested and maintained»). `check.png` e `check-dark.png` no README. Versão ≥ 1.0.0. `npm audit` limpo.
- **parcial** — teste de 2026-10-06 no Sandbox PSA-DEV: pesquisa de utilizador, tabela sem papel e System Administrator, tabela da organização, Task e Note, um registo, exportações, claro e escuro. Por verificar no vivo: papéis directos misturados com papéis de equipa, profundidade entre unidades de negócio, partilhas, segurança de colunas, *Team privileges only*, hierarquia. Faltam `columns-dark.png` e, se houver dados, `shares.png`.
- **owner** — responder à revisão / reenviar quando essas caixas fecharem ([RELEASE.md](RELEASE.md), topo). Pedido do badge e métricas (2 de 3, dispensáveis; o backlog pede 10 MAU) ficam para depois da listagem.

### Dependency Cleaner — `@simplesmoothsafe/pptb-dependency-cleaner` — 1.5.2

Categorias: **não estão escritas** em [RELEASE.md](RELEASE.md). Escolher até 3 da lista oficial na submissão (ou na resposta à revisão, se o formulário já as tiver). `minAPI` 1.2.0. Ligações: `optional` / `required`.

- **feito** — submetida; npm 1.5.2 com o patch de revisão. Manifesto, zero CSP, versão ≥ 1.0.0, audit limpo. A frase da AI mantém-se em «reviewed and maintained», alinhada com as linhas UNVERIFIED que ainda estão no README.
- **parcial** — Slim verificado ao ler um ambiente live (1.3.0 → 1.3.1). Cycles (1.4.0, foi no 1.5.0) **não** foi verificado em live. Upgrade blockers e Failed import continuam UNVERIFIED no README. O apply do Slim 1.3.1 está por repetir.
- **em falta** — `diagnose.png`, `confirm.png`, `slim.png` e `cycles.png` estão em `tools/dependency-cleaner/docs/img/` e **não** entram no README, portanto o `readmeUrl` não os mostra. Nenhuma captura escura.
- **owner** — responder à revisão depois de ligar as capturas no README, de as completar com um tema escuro, e de fechar o teste live (Cycles incluído).

### D365 Apps Matrix — `@simplesmoothsafe/pptb-d365-apps` — 0.3.3 no repo, 0.3.2 no npm

Categorias: **não estão escritas** em [RELEASE.md](RELEASE.md). `minAPI` 1.2.6, `enabledForPowerPlatformAPI: true`. Uma ligação, obrigatória.

- **feito** — submetida. README com quatro capturas reais, incluindo `matrix-dark.png`. AI em «reviewed, tested and maintained». Teste de 2026-10-06: leitura, pré-visualização, uma atualização ponta a ponta (Storage Advisor Components 1.0.0.2 → 1.0.0.3), CSV, claro e escuro.
- **parcial** — o probe §5 de [D365-APPS-PLAN.md](D365-APPS-PLAN.md) não fechou antes da publicação: «update available» é derivado e não foi comparado com o PPAC. Por verificar: retry, primeira instalação, vários ambientes em paralelo, script `pac` por executar, relatório Unused (no ambiente de teste quase não mapeou pacotes). O repo está em 0.3.3 (correcção do lote de contagens); o npm documentado ficou em 0.3.2.
- **em falta** — versão 0.x. O badge Verified não aceita abaixo de 1.0.0. O roadmap (E6) deixa esse 1.0 para 2027.
- **owner** — publicar 0.3.3 (o registo só vê `latest`) e responder à revisão. O pedido de Verified espera pelo 1.0.0, pelas métricas e pelo fecho do que o README ainda marca como não verificado.

### Offboarding Wizard — `@simplesmoothsafe/pptb-offboarding-wizard` — 0.2.1

Categorias: Users & Security, Data. `minAPI` 1.2.0. Uma ligação, obrigatória. Escreve propriedade e membros: o primeiro plano aplicado é num sandbox.

- **feito** — manifesto, secção do que muda (o pré-visualizar nomeia o ambiente e diz que não há undo na ferramenta), AI em «reviewed and maintained», Install e Usage.
- **parcial** — a 2026-09-21 foi carregada contra um ambiente real, só leitura. Nenhum plano foi aplicado ([RELEASE.md](RELEASE.md) §5).
- **em falta** — sem capturas (`inventory.png`, `plan.png`, `report-dark.png`). Versão 0.2.1, abaixo de 1.0.0.
- **owner** — submissão não está na ronda «changes requested». Testar as escritas, capturar, e só então subir a 1.0 e pedir o badge. O roadmap (E6) agenda esse 1.0 para o primeiro semestre de 2027.

### Audit Config Matrix — `@simplesmoothsafe/pptb-audit-matrix` — 0.2.2

Categorias: Users & Security, Comparisons, Solutions. `minAPI` 1.2.0. Ligações: `optional` / `required`.

- **feito** — submetida; npm 0.2.2. As cinco capturas de [SCREENSHOTS.md](SCREENSHOTS.md) §5 estão no README, com `org-dark.png`. AI em «reviewed, tested and maintained». A 2026-10-06, no PSA-DEV: matriz, bloqueados, snapshot, colunas, organização, plano, apply de uma tabela e de uma coluna, reversão pela cópia de segurança, exportações.
- **parcial** — por verificar: uma escrita que o ambiente recusa (deve ficar como linha falhada), o script PowerShell por correr, e uma segunda ligação live (o diff testado foi contra snapshot).
- **em falta** — versão 0.2.2. Bloqueia o badge até ao 1.0 (roadmap E6).
- **owner** — responder à revisão. Get Verified depois do 1.0.0 e das métricas.

## O que falta, por ordem

1. **Owner, listagem.** Nas quatro já revistas (Access Checker, Dependency Cleaner, D365 Apps, Audit Matrix): fechar o teste que ainda está aberto, pôr as capturas em falta no README de `main`, e responder à revisão. Na Dependency Cleaner, referenciar no README as quatro imagens que já estão em `docs/img/`. Publicar D365 Apps 0.3.3.
2. **Owner, as outras três.** Confirmar se XRay, EnvVar e Offboarding chegaram a ser submetidas. EnvVar e Offboarding não têm capturas. XRay não tem o par escuro nem a ordem de instalação. Offboarding não tem o caminho de escrita testado.
3. **Verified, quando a listagem existir.** Versão ≥ 1.0.0 falta em Audit Matrix, D365 Apps e Offboarding (roadmap E6, 2027). Nas quatro que já estão em 1.x, o pedido em My Tools → Get Verified ainda depende das capturas, do teste declarado e de 2 das 3 métricas — ou do pedido de dispensa. O backlog usa 10 MAU como marca. A leitura de 2026-10-13 em [ADOPTION.md](ADOPTION.md) tem duas ferramentas no catálogo (XRay 2 MAU, EnvVar 1 MAU e 55 downloads) e cinco ainda por listar; nenhuma chega a 2 de 3.
4. **Antes de 2027-01-31.** Migrar as sete para `features.connections` quando o Desktop 1.2.7 estiver estável. Até lá ficam nos campos legados, com o adaptador partilhado a preferir a API nova se o host a tiver.
