# Changelog

## 1.0.0

Claude Codex é um aplicativo nativo para macOS 26 ou posterior, com binário universal para Apple Silicon e Intel. Reúne o uso das contas Codex em uma instalação separada do Claude Code.

- Instalação separada a partir do Claude oficial, com configuração e dados próprios, preservando o aplicativo original.
- Gestão de contas, cotas, renovações, créditos extras e resets na barra de menus.
- Prioridade automática ou conta fixa, com mudança na próxima inferência de cada conversa e preservação das respostas já iniciadas.
- Catálogo fixo de GPT-6.1 Sol, GPT-6 Luna e GPT-6 Astra, com Normal/Fast e Ultrafast quando suportado pelo modelo e anunciado pela conta.
- Atualização do menu ao abrir a instalação separada, com nomes GPT e controles nativos de esforço.
- Créditos extras com autorização explícita e admissão somente depois do esgotamento confirmado das cotas centrais de assinatura de todas as contas.
- Reset manual com confirmação e reset automático por conta a 5% ou menos de cota restante. Consumo de créditos e reset automático começam desativados.
- Recibos persistentes de reset e verificação de tentativas incertas com o mesmo identificador.
- Migração de históricos e contexto locais compatíveis, com origens preservadas e relatório de arquivos, avisos e destinos. Claude Code usa o formato de importação nativo; Chat e Cowork locais ficam em formato portátil.
- Idioma automático pelas preferências do macOS, com inglês, português, espanhol, francês, alemão e italiano.
- Serviço local preparado automaticamente, runtime incluído e restauração da conexão quando necessária.
- Consulta diária de atualizações, instalação automática opcional e validação de assinatura do feed e do ZIP. A instalação aguarda as operações locais em andamento.

O controle de créditos atua sobre novas chamadas; uma chamada já aceita pode ultrapassar a cota conforme as regras da OpenAI. Uso em outros clientes fica fora desse controle. Resets dependem da elegibilidade da conta e não garantem a restauração integral de todas as janelas.

Os pacotes da pipeline atual têm assinatura ad hoc e não são notarizados pela Apple. A assinatura das atualizações é independente e consta nos metadados de distribuição.
