# Contas Codex

Aplicativo para a barra de menus do macOS que conecta contas do Codex a um perfil do Claude Desktop e permite acompanhar limites, escolher uma conta ou definir a ordem de uso automático.

O aplicativo também prepara perfis de provedor no Claude existente e instalações separadas, com diretórios próprios. Você pode usar somente o gerenciamento de contas se já tiver um perfil configurado.

## O que faz

- Mostra as contas conectadas, a disponibilidade de cada janela de uso e a data de renovação quando informada pelo serviço.
- Oferece modo **Automático**, que usa a primeira conta com cota confirmada na ordem escolhida, e **Conta fixa**, que usa apenas a selecionada.
- Permite mudar a prioridade, conectar contas pela autorização oficial da OpenAI e desconectá-las deste gerenciador.
- Mantém cada solicitação em andamento na conta em que começou. Uma troca afeta solicitações seguintes.
- Encaminha o histórico completo e os resultados de ferramentas, permitindo continuar a conversa ao mudar de conta.
- Disponibiliza GPT-6.1 Sol e GPT-6 Astra, nas modalidades normal e Fast, com seleção de esforço.
- Cria um perfil de gateway no Claude ou uma instalação separada a partir de um Claude oficial já instalado no Mac.

O catálogo de modelos é explícito e está em `Bridge/model-catalog.mjs`. Disponibilidade, limites e comportamento do serviço dependem da conta e podem mudar. Fast solicita `service_tier: priority`; o serviço upstream determina a disponibilidade e o consumo.

## Requisitos e instalação

- macOS 26 ou posterior.
- Xcode/Command Line Tools com SDK macOS 26 ou posterior para compilar.
- Node.js 22 ou posterior, npm e Python 3.12 ou posterior para preparar o build.
- Uma conta com acesso ao Codex. Claude Desktop instalado é necessário para criar uma instalação separada.

```sh
git clone https://github.com/reyhenrick/codex-accounts.git
cd codex-accounts
./build.sh
cp -R "build/Contas Codex.app" /Applications/
open "/Applications/Contas Codex.app"
```

O build baixa versões fixas de Node.js e CLIProxyAPI das fontes oficiais, verifica SHA-256, inclui as licenças e gera um aplicativo com assinatura local. O aplicativo compilado inclui seu runtime e não depende de Node/npm instalados para funcionar. Esta distribuição de código-fonte não oferece uma versão notarizada pela Apple.

`./build.sh arm64` prepara Apple Silicon; `./build.sh x86_64` prepara Intel. A validação de execução foi feita em Apple Silicon. A versão Intel não foi executada em hardware Intel.

## Primeiro uso

1. Abra **Contas Codex** e use **Preparar serviço**. O serviço é instalado no seu usuário e iniciado automaticamente nas próximas sessões.
2. Clique em **Conectar conta**, informe o e-mail e conclua a autorização no navegador. O gerenciador confirma que a autorização corresponde ao e-mail solicitado.
3. Repita para as demais contas. No menu de cada conta, escolha **Usar somente esta conta**, **Usar primeiro no automático** ou ajuste a ordem.
4. Se já usa o gateway deste aplicativo, continue usando seu perfil. Para preparar o Claude, abra **Opções do app → Configurar Claude…**.

**Perfil no Claude existente:** adiciona um perfil à pasta `configLibrary` do diretório 3P escolhido. O padrão é `~/Library/Application Support/Claude-3p`. Perfis separados podem usar outro diretório terminado em `-3p`. Ao selecionar o perfil na criação, o assistente também ativa o modo 3P no diretório escolhido, preservando as demais preferências; encerre e abra o Claude para carregá-lo. Os arquivos dos demais perfis são preservados. Políticas gerenciadas da sua organização podem prevalecer sobre a configuração local.

**Instalação separada:** selecione um `Claude.app` oficial instalado e dê um nome ao novo aplicativo. A assinatura da Anthropic é verificada antes e depois da cópia. O atalho é criado em `~/Applications`, e o runtime e os dados ficam em `~/Library/Application Support/Codex Accounts/Managed Claudes/<id>`. A cópia começa sem conversas, sessões ou credenciais do Claude original. O novo diretório do Claude Code recebe esforço `xhigh`, Workflows e Ultracode habilitados. O Claude original permanece preservado. O aplicativo novo não é aberto automaticamente. A cópia não é mantida atualizada pelo gerenciador.

A configuração de perfis segue o [contrato de provedores do Claude Desktop](https://claude.com/docs/third-party/claude-desktop/configuration). O gateway usa os aliases de família que o cliente espera, mantendo os nomes reais dos modelos no seletor.

## Como os limites e as trocas funcionam

Antes de cada inferência, o serviço consulta o uso da conta. Uma consulta desconhecida ou inválida impede o uso daquela conta. Uma janela esgotada impede o uso, mesmo quando a resposta informa créditos adicionais. Limites adicionais informados pelo serviço são tratados de forma conservadora.

No modo automático, falhas de autorização ou limite recebidas antes do início da resposta permitem tentar a próxima conta. Após começar a devolver uma resposta, o serviço não a repete em outra conta. No modo fixo, não passa para outra conta.

Esta verificação reduz o uso após o esgotamento, mas não fornece uma garantia de gasto zero: uma solicitação pode cruzar o limite, ou outra sessão pode consumir a conta entre a consulta e a inferência. O app não compra créditos, não altera configurações de cobrança e não resgata resets. A decisão de cobrança permanece com o serviço upstream e com as configurações da conta.

## Dados locais e privacidade

- Credenciais OAuth são geridas pelo CLIProxyAPI em `~/Library/Application Support/Claude Codex Bridge/pool/auth`.
- O diretório privado usa permissão `0700`; credenciais, chaves locais e estado usam `0600`.
- O painel e o app recebem e-mails, plano, limites e estados; não recebem tokens OAuth ou chaves de gerenciamento.
- O gateway escuta somente em `127.0.0.1:18765`; o gerenciador interno usa `127.0.0.1:18768`.
- O serviço interno exige uma chave aleatória. O gateway é destinado aos aplicativos locais do mesmo usuário; ele não é uma fronteira contra outro processo local malicioso. Não o exponha em uma interface de rede ou túnel público.
- Alterações pelo painel exigem origem local e cabeçalho específico. Host, origem e tipo de conteúdo são conferidos.
- Corpos de solicitações/respostas, tokens e prompts não são registrados pelo serviço. Não há telemetria própria.
- A autorização e as consultas de uso acessam a OpenAI. As mensagens e ferramentas são encaminhadas ao serviço Codex pela conta selecionada.
- Desconectar remove a credencial deste gerenciador; não cancela a assinatura nem desconecta outros aplicativos.

Nenhum Claude.app, token, conta pessoal, histórico ou resultado de teste com dados reais faz parte deste repositório.

## Desenvolvimento e verificação

```sh
npm --prefix Bridge ci --ignore-scripts
npm --prefix Bridge test
./build.sh arm64
```

Os testes usam contas e respostas sintéticas. Cobrem cota esgotada/desconhecida, modo fixo, ordem, concorrência nas configurações, falha antes do stream, cancelamento de stream, autorização, remoção de conta, permissões locais e preservação dos perfis existentes.

A validação local adicional incluiu os quatro modelos, ida e volta de ferramenta, continuidade de histórico entre duas contas reais, salto de conta esgotada e um Workflow do runtime do Claude Code. A interface do gerenciador foi conferida no macOS. A criação de uma instalação separada foi verificada por arquivos e assinaturas, sem abrir a interface dessa cópia do Claude. A aparência do controle Ultracode no Claude Desktop não é validada por esses testes.

### Organização

- `Sources/`: aplicativo nativo AppKit/SwiftUI.
- `Launcher/`: lançador da instalação separada do Claude.
- `Bridge/`: roteamento, consulta de cotas, ciclo de autorização, painel alternativo e preparação local.
- `Scripts/`: dependências verificadas e ícone.
- `build/` e `.cache/`: saídas locais ignoradas pelo Git.

### Remoção

Saia do aplicativo. Para parar o serviço do seu usuário:

```sh
launchctl bootout "gui/$(id -u)/com.henrick.claude-codex-bridge"
```

Remova `~/Library/LaunchAgents/com.henrick.claude-codex-bridge.plist` e o aplicativo pelo Finder. As contas e instalações separadas permanecem nos diretórios indicados acima até você decidir removê-las. Antes de remover os dados, desconecte as contas pelo aplicativo se quiser excluir as credenciais locais. Para desativar o início de sessão do ícone, use a opção do próprio aplicativo.

## Licença

MIT. Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Projeto independente, sem afiliação com OpenAI ou Anthropic.
