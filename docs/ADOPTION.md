# Adoção — downloads npm e MAU do PPTB

Registo mensal para o [roadmap](roadmap.md) E3 e para a issue #55. Serve para ver a distância ao badge Verified. Não publica ferramentas, não pede o badge e não acrescenta telemetria.

## O que se mede

O modelo de maturidade do PPTB pede **2 de 3** sinais de uso, dispensáveis numa ferramenta nova sem histórico ([PPTB-NOTES.md](PPTB-NOTES.md) §7; [listing-checklist.md](listing-checklist.md)):

| Sinal | Limiar | Onde se lê |
|---|---|---|
| MAU | ≥ 10 | catálogo público do PPTB, campo `tool_analytics.mau` |
| Downloads | ≥ 50 | o mesmo catálogo, `tool_analytics.downloads` (instalações no marketplace, acumuladas) |
| Avaliações | ≥ 1 com nota ≥ 3 | o catálogo só expõe um `rating`. `0` = sem avaliação visível e não conta. Uma nota ≥ 3 conta como esse sinal |

Os downloads npm são um segundo número, público e mensal. Contam pedidos de tarball (CI, mirrors, `npm pack` no intake do PPTB). Não são pessoas e não substituem o MAU.

## Privacidade

- Nenhuma ferramenta envia utilização, identificadores ou ambiente. Este registo não muda isso.
- Não há serviço novo, conta paga, chave, nem token. As duas fontes respondem a GET sem autenticação: `https://api.npmjs.org/downloads` e `https://www.powerplatformtoolbox.com/api/tools`.
- Guardam-se só totais já publicados: MAU, downloads, rating, estado de maturidade e a versão `latest` no npm. Não se copia o catálogo, nem nomes de quem instalou.
- Uma ferramenta ausente do catálogo fica «não listada». Isso não é MAU zero.
- A política do marketplace proíbe inflacionar downloads ou utilizadores activos. Não repetir instalações para fazer subir a tabela.

## Como rever em cada release

Antes de fechar a release (o passo está em [RELEASE.md](RELEASE.md), «After publish»):

```bash
node scripts/adoption-snapshot.mjs
node --test scripts/adoption-snapshot.test.mjs
```

Colar a secção impressa **no topo** de «Registo», por baixo deste cabeçalho. Não reescrever leituras antigas: o catálogo não tem histórico, por isso uma data passada relida mais tarde já não é a leitura dessa data. Os intervalos npm são calendário fechado no dia anterior à data do comando (`--date YYYY-MM-DD` fixa essa data).

Na revisão, comparar com a leitura anterior e anotar se alguma ferramenta listada passou a 2 de 3. O pedido de Verified continua a ser um passo do owner, fora deste ficheiro.

## Registo

### 2026-10-13

Leitura de contagens agregadas já públicas. Sem telemetria nas ferramentas. O npm fecha os totais no dia anterior (até 2026-10-12).

#### Marketplace PPTB

Catálogo público `GET https://www.powerplatformtoolbox.com/api/tools`. MAU, downloads e rating são os do marketplace. O badge Verified pede 2 de 3: MAU ≥ 10, downloads ≥ 50, pelo menos uma avaliação ≥ 3. O campo público `rating` é um número só; `0` significa que não há avaliação visível e não conta como review.

| Ferramenta | Estado | MAU | Downloads | Rating | Maturidade | Sinais |
|---|---|---:|---:|---:|---|---|
| Solution XRay | listada | 2 | 47 | 0 | unverified | 0/3 |
| EnvVar & ConnRef Matrix | listada | 1 | 55 | 0 | unverified | 1/3 (downloads) |
| Access Checker | não listada | — | — | — | — | — |
| Dependency Cleaner | não listada | — | — | — | — | — |
| D365 Apps Matrix | não listada | — | — | — | — | — |
| Offboarding Wizard | não listada | — | — | — | — | — |
| Audit Config Matrix | não listada | — | — | — | — | — |

- Solution XRay: 0/3 — MAU 2/10; downloads 47/50; rating 0 (limiar 3)
- EnvVar & ConnRef Matrix: 1/3 (downloads) — MAU 1/10; rating 0 (limiar 3)
- Ainda fora do catálogo: Access Checker, Dependency Cleaner, D365 Apps Matrix, Offboarding Wizard, Audit Config Matrix.

#### Downloads npm

API pública `https://api.npmjs.org/downloads`. Cada número conta um pedido de tarball, incluindo CI, mirrors e o `npm pack` do intake do PPTB. Não são pessoas e não entram no limiar de MAU. Não repetir instalações para fazer subir estes números.

| Pacote | npm latest | 2026-09 | 2026-10-01…2026-10-12 |
|---|---| ---: | ---: |
| `@simplesmoothsafe/pptb-solution-xray` | 1.2.1 | 970 | 451 |
| `@simplesmoothsafe/pptb-envvar-matrix` | 1.6.1 | 1752 | 494 |
| `@simplesmoothsafe/pptb-access-checker` | 1.2.2 | 1463 | 494 |
| `@simplesmoothsafe/pptb-dependency-cleaner` | 1.5.2 | 762 | 735 |
| `@simplesmoothsafe/pptb-d365-apps` | 0.3.2 | 0 | 834 |
| `@simplesmoothsafe/pptb-offboarding-wizard` | 0.2.1 | 0 | 367 |
| `@simplesmoothsafe/pptb-audit-matrix` | 0.2.2 | 0 | 320 |
| **Total** | | **4947** | **3695** |
