# Claude Codex

**Codex dentro do Claude Code.**

Aplicativo nativo para a barra de menus do macOS que prepara uma instalação separada do Claude e conecta suas contas do Codex. A interface reúne limites de assinatura, créditos extras, resets e a ordem de uso das contas.

Esta árvore prepara a candidata **1.0.0, build 2**. Os pacotes e o feed de atualização desta candidata ainda não foram publicados. O código-fonte está em [reyhenrick/codex-accounts](https://github.com/reyhenrick/codex-accounts).

## O que faz

- Cria uma instalação separada a partir de um `Claude.app` oficial instalado, com aplicativo de abertura, configuração e dados próprios.
- Conecta contas pela autorização oficial da OpenAI e mostra cotas, renovações, créditos e resets informados pelo serviço.
- Oferece **Automático**, com prioridade definida por você, e **Conta fixa**, que usa somente a conta selecionada.
- Aplica mudanças de conta na próxima inferência de cada conversa, inclusive na próxima iteração após uma ferramenta. Uma resposta já iniciada continua na conta original.
- Permite autorizar créditos extras depois do esgotamento confirmado das cotas de assinatura de todas as contas.
- Oferece reset manual com confirmação e reset automático por conta ao chegar a 5% ou menos de cota restante.
- Migra dados locais compatíveis para a nova instalação, preservando os originais e produzindo um relatório do que foi copiado ou ignorado.
- Usa o primeiro idioma compatível das preferências do macOS: inglês, português, espanhol, francês, alemão ou italiano. Variantes regionais são reconhecidas; o idioma de fallback é inglês.

A gestão acontece na interface nativa. A conexão de conta abre a autorização oficial da OpenAI no navegador.

O catálogo fixo em [Bridge/model-catalog.mjs](Bridge/model-catalog.mjs) oferece GPT-6.1 Sol, GPT-6 Luna e GPT-6 Astra. Sol e Astra têm variantes Normal, Fast e Ultrafast; Luna tem Normal e Fast. O bridge consulta as capacidades autenticadas de cada conta e só encaminha uma variante a contas que a anunciam. Normal solicita `service_tier: default`, Fast solicita `priority`, e Ultrafast solicita `ultrafast`. A disponibilidade e o consumo efetivos pertencem ao serviço OpenAI; solicitar Fast não garante uma prioridade efetivamente aplicada pelo fornecedor. Novos modelos entram por atualizações do aplicativo.

A instalação prepara esforço `xhigh`, Workflows e Ultracode no Claude Code. O launcher atualiza os nomes GPT e as velocidades disponíveis antes de abrir uma instância separada nova. Uma instância já aberta é apenas trazida para frente: reabra-a para atualizar o menu de modelos após mudar as contas ou seus acessos. A escolha de conta no gerenciador vale para a próxima solicitação, sem depender dessa reabertura. Uma opção antiga sem acesso confirmado é recusada, sem troca silenciosa de velocidade. A consulta local de capacidades usa cache de até 60 segundos, invalidado na reconexão; a disponibilidade ainda pode mudar no fornecedor depois da consulta.

## Requisitos e build

Para usar o aplicativo:

- macOS 26 ou posterior, em Apple Silicon ou Intel.
- Uma conta com acesso ao Codex.
- Um `Claude.app` oficial instalado para criar a instalação separada.

Para compilar o código-fonte:

- Xcode ou Command Line Tools com SDK macOS 26 ou posterior.
- Node.js 22 ou posterior e npm.
- Python 3.12 ou posterior, disponível como `python3`.

```sh
git clone https://github.com/reyhenrick/codex-accounts.git
cd codex-accounts
./build.sh
```

`./build.sh` não recebe argumentos: gera sempre um aplicativo universal com `arm64` e `x86_64`. O build baixa as versões fixadas em [dependencies.json](dependencies.json), verifica SHA-256, inclui Node.js, CLIProxyAPI, Sparkle e suas licenças e valida o pacote resultante.

O resultado fica em `build/Claude Codex.app`. Copie o aplicativo para `/Applications` ou `~/Applications` pelo Finder e abra-o de lá. O aplicativo distribuído inclui seu runtime e funciona sem Node.js, npm ou Python instalados pelo usuário.

A pipeline atual produz assinatura ad hoc e não realiza notarização pela Apple. Essa condição, as arquiteturas e os hashes dos pacotes são registrados nos metadados de distribuição. A assinatura das atualizações é descrita abaixo.

## Primeiro uso

1. Abra **Claude Codex**. O aplicativo prepara a conexão local automaticamente; **Restaurar conexão** aparece quando há falha de conexão.
2. Clique em **Conectar conta**, informe o email e conclua a autorização oficial no navegador. O gerenciador confere se a identidade autorizada corresponde à solicitada.
3. Conecte as outras contas que deseja usar. Escolha o modo de consumo e ajuste a ordem nas opções de cada conta.
4. Abra **Opções do app → Nova instalação do Claude…**, selecione o aplicativo oficial e informe o nome da nova instalação.
5. Escolha se deseja migrar dados compatíveis. Confira a pasta do Claude original e, quando necessário, indique também a pasta do Claude Code.
6. Crie a instalação, confira o resultado e abra o novo aplicativo pelo Finder quando quiser começar.

O aplicativo de abertura é criado em `~/Applications`. A cópia do Claude, os dados e a configuração ficam em `~/Library/Application Support/Codex Accounts/Managed Claudes/<id>`. A assinatura da Anthropic é verificada antes e depois da cópia. O aplicativo original permanece preservado.

O fluxo de preparação cria uma instalação nova, com destinos próprios. Um nome ou destino existente é recusado para preservar seus arquivos. A cópia do Claude não é atualizada pelo mecanismo de atualização do Claude Codex.

## Migração de dados locais

Feche o Claude de origem antes de iniciar a migração. A pasta de dados inicial é `~/Library/Application Support/Claude`; selecione a pasta correspondente se usa outro perfil. O campo opcional do Claude Code permite escolher explicitamente a origem, como `~/.claude` ou a pasta de uma instalação separada.

Quando esse campo fica vazio, o migrador tenta identificar a pasta do Claude Code a partir do perfil selecionado, de seus metadados ou dos diretórios associados. Para as pastas padrão do Claude, `~/.claude` é uma origem possível. Se não houver uma correspondência segura e única, a criação pede a seleção explícita.

A migração trata os dados conforme o formato disponível:

- **Claude Code:** transcrições locais válidas e seus índices são preparados no formato de importação nativo do Claude. Sessões de terminal também podem ser importadas quando a transcrição contém os dados necessários. Históricos auxiliares ficam em formato portátil. Os diretórios de trabalho continuam apontando para os projetos originais; os arquivos desses projetos não são copiados.
- **Chat e Cowork locais:** históricos com corpo local disponível são preservados em `portable-history`, com metadados e anexos compatíveis. Esses arquivos servem como histórico portátil; não constituem sessões nativas retomáveis.
- **Instruções e contexto:** arquivos de instruções, skills, agentes, regras, comandos, memórias e preferências compatíveis são copiados. Memórias com múltiplos escopos ou projetos podem ficar na área portátil, conforme o relatório.
- **Integrações:** definições compatíveis de MCP podem ser preservadas sem credenciais. Pacotes de plugins precisam ser reinstalados. Hooks, permissões e outras configurações executáveis não são ativados pela migração.
- **Autenticação e nuvem:** arquivos de autenticação, tokens OAuth, cookies e chaves privadas ficam fora da importação. Contas e integrações precisam de nova autorização. Histórico que existe apenas na nuvem não fica disponível sem uma origem local compatível; o aplicativo não baixa conversas remotas nem importa automaticamente uma exportação genérica.

A migração escreve apenas nos destinos novos. Arquivos ilegíveis, formatos incompatíveis, origens ambíguas e itens excluídos são registrados. O botão **Mostrar relatório da migração** abre o manifesto com contagens, avisos, arquivos e destinos. Consulte-o antes de considerar uma migração completa. Uma falha descarta os arquivos preparados para aquela instalação e preserva a origem.

## Limites, créditos e troca de conta

Antes de admitir uma inferência, o serviço consulta o uso. Uma cota desconhecida ou uma consulta inválida impede o uso daquela conta. No modo automático, as assinaturas seguem a ordem escolhida. No modo fixo, o gerenciador não passa para outra conta.

A troca vale para a próxima chamada ao modelo de cada conversa. Ela pode ocorrer após uma ferramenta, ainda durante a resposta à mesma mensagem. A chamada em andamento termina na conta em que começou. O serviço encaminha o histórico e os resultados de ferramentas necessários à continuação; não transfere uma resposta parcialmente recebida.

No automático, uma falha elegível de autorização ou limite recebida antes do início da resposta permite tentar a próxima conta. Depois do início do stream, a resposta não é repetida em outra conta.

**Usar créditos extras começa desativado.** Ao ativar, você autoriza novas chamadas com créditos somente depois de confirmar o esgotamento das cotas centrais de assinatura de todas as contas. Limite adicional de outro modelo, erro de autorização ou indisponibilidade de consulta não substitui essa confirmação. A regra global também vale no modo fixo; nesse modo, somente a conta selecionada pode gastar créditos. Saldo desconhecido, zero e créditos ilimitados têm estados distintos, e os valores são apresentados em créditos, não em dinheiro.

Esse controle regula a admissão de novas chamadas. Uma chamada já aceita pode atravessar a cota, e a OpenAI pode debitar créditos conforme as regras da conta. Outro cliente pode consumir a mesma conta entre a consulta e a inferência. O gerenciador não oferece garantia de bloqueio de todo gasto upstream e não controla chamadas feitas fora dele. Ele não compra créditos nem altera a assinatura.

## Resets

A interface diferencia resets **disponíveis** dos **aplicáveis agora**, quando o serviço informa ambas as quantidades. Ter um reset disponível não significa que ele possa ser usado naquele momento. A elegibilidade é consultada novamente na aplicação.

O reset manual exige confirmação e usa um reset da conta quando a OpenAI aceita a operação. O resultado e a verificação dos limites aparecem junto da conta. Um reset não implica promessa de restauração integral de todas as janelas.

O reset automático começa desativado em cada conta. Ao habilitá-lo, você autoriza o uso de um reset disponível quando uma cota central de assinatura chegar a **5% ou menos** de saldo restante e a conta estiver elegível. Se a condição já estiver presente, a ativação pode aplicar o reset imediatamente. A autorização permanece até ser desativada.

Cada tentativa é registrada com um identificador persistente. Se a resposta ficar incerta, **Verificar tentativa** retoma a operação registrada com o mesmo identificador. A interface conserva o estado pendente ou incerto e não desconta resets de forma otimista.

## Atualizações do aplicativo

O atualizador funciona quando o Claude Codex está em `/Applications` ou `~/Applications`. As consultas automáticas estão habilitadas por padrão, com intervalo diário. **Instalar atualizações automaticamente** começa desativado e pode ser habilitado nas opções do app; também há uma ação para buscar atualizações manualmente.

Antes de instalar, o aplicativo prepara o serviço para concluir chamadas ao modelo, resets, autorizações e alterações de conta já em andamento. A instalação aguarda a liberação dessas operações. A recuperação do serviço faz parte do fluxo de atualização.

O feed configurado aponta para o `appcast.xml` das [releases do projeto](https://github.com/reyhenrick/codex-accounts/releases). A candidata desta árvore ainda não tem uma publicação correspondente. Configurar o endereço não torna uma atualização disponível.

O app exige assinaturas Ed25519 válidas no feed e no ZIP antes da extração. A chave pública integra o aplicativo; a chave privada de publicação permanece no Keychain do mantenedor. A assinatura de atualização autentica os artefatos e é registrada separadamente da assinatura Apple e da notarização.

## Dados locais e privacidade

- As credenciais OAuth são geridas pelo CLIProxyAPI em `~/Library/Application Support/Claude Codex Bridge/pool/auth`.
- O diretório privado usa permissão `0700`; credenciais, chaves locais, preferências de consumo e recibos de reset usam arquivos privados.
- A interface recebe identidade da conta, plano, limites e estados. Tokens OAuth e a chave de gerenciamento não são enviados à interface.
- O gateway escuta somente em `127.0.0.1:18765`; o serviço interno usa `127.0.0.1:18768` e exige uma chave aleatória. As ações locais conferem host, origem e cabeçalho de ação.
- O gateway atende aplicativos locais do mesmo usuário. Não é uma fronteira de isolamento contra outro processo local malicioso; não deve ser exposto em uma interface pública ou túnel.
- Corpos de solicitações e respostas, prompts e tokens não são registrados pelo serviço. Não há telemetria própria. O atualizador também desativa o envio de perfil do sistema.
- Autorizações, consultas de uso, resets e inferências acessam os serviços correspondentes da OpenAI. Mensagens e resultados de ferramentas são encaminhados pela conta selecionada.
- Desconectar uma conta remove sua credencial deste gerenciador, preservando a assinatura e as conexões de outros aplicativos.

O repositório não inclui o aplicativo da Anthropic, credenciais, contas pessoais ou históricos reais.

## Desenvolvimento e verificação

Execute a partir da raiz do repositório:

```sh
npm --prefix Bridge ci --ignore-scripts
npm --prefix Bridge test
python3 Scripts/check-localizations.py
mkdir -p build/tests
xcrun swiftc -parse-as-library Sources/Localization.swift Tests/LocalizationTests.swift -o build/tests/localization-tests
build/tests/localization-tests Resources
xcrun swiftc -parse-as-library Sources/UpdatePolicy.swift Tests/UpdatePolicyTests.swift -o build/tests/update-policy-tests
build/tests/update-policy-tests
xcrun swiftc Launcher/ProfileCatalog.swift Tests/ProfileCatalogTests.swift -o build/tests/profile-catalog-tests
build/tests/profile-catalog-tests
xcrun swiftc Scripts/verify-update.swift -o build/tests/verify-update
xcrun swiftc -parse-as-library Tests/UpdateSignatureTests.swift -o build/tests/update-signature-tests
build/tests/update-signature-tests build/tests/verify-update
```

Os testes do bridge usam contas, credenciais e respostas sintéticas. Exercitam roteamento, cotas, créditos, resets, concorrência, streams, configuração e migração. As verificações de idioma conferem a paridade dos catálogos, chaves duplicadas, placeholders, referências estáticas no Swift e a seleção/fallback de idioma pelo Foundation. Os testes do atualizador cobrem a preparação do serviço e a validação criptográfica de artefatos sintéticos.

Esses testes locais não comprovam toda a interface do Claude, a retomada visual de cada histórico importado, a execução em hardware Intel ou um reset financeiro real. Build universal, testes de política, testes de assinatura, inspeção da interface e operações reais são evidências distintas.

### Empacotamento e assinatura local

```sh
./build.sh
./Scripts/package-release.sh
./Scripts/sign-release.sh
./Scripts/verify-release.sh --require-feed dist
```

`package-release.sh` gera `ClaudeCodex-macOS.dmg`, `ClaudeCodex-macOS.zip`, `release-metadata.json` e `SHA256SUMS.txt` em `dist/`. O pacote sem feed pode ser verificado com `./Scripts/verify-release.sh dist`.

`sign-release.sh` é uma operação local do mantenedor e exige a chave de atualização já provisionada no Keychain, na conta `com.henrick.codex-accounts.sparkle`. O gerador lê essa chave diretamente; o procedimento não exporta a chave privada. Ele assina o ZIP e o feed, incorpora as notas de [CHANGELOG.md](CHANGELOG.md) e verifica versões, URLs, assinaturas e hashes. Os scripts não publicam releases nem submetem o aplicativo à notarização da Apple.

### Organização

- `Sources/`: aplicativo AppKit/SwiftUI, localização e atualização.
- `Resources/`: catálogos de idioma e recursos distribuídos.
- `Launcher/`: abertura da instalação separada e processo do serviço.
- `Bridge/`: roteamento, contas, cotas, créditos, resets, preparação e migração local.
- `Scripts/`: dependências verificadas, ícone, idiomas, empacotamento e assinatura.
- `Tests/`: testes Foundation e políticas de atualização.
- `build/`, `dist/` e `.cache/`: saídas locais.

### Remoção

Antes de remover o aplicativo, desconecte nele as contas cujas credenciais locais deseja excluir. Desative o início de sessão do ícone nas opções do app e encerre-o. Para parar o serviço do seu usuário:

```sh
launchctl bootout "gui/$(id -u)/com.henrick.claude-codex-bridge"
```

Remova `~/Library/LaunchAgents/com.henrick.claude-codex-bridge.plist` e o aplicativo pelo Finder. As instalações separadas e os dados permanecem nos diretórios descritos acima até você decidir removê-los.

## Licença

MIT. Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Projeto independente, sem afiliação com OpenAI ou Anthropic.
