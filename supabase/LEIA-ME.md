# Banco do MedTech (Supabase)

O Supabase é o backend inteiro do MedTech: autenticação, banco de dados, regras de acesso (RLS) e as funções que o ESP32 chama. Não há outro servidor.

Arquivos, executados **nesta ordem**:

1. [01-medtech-dispensador.sql](01-medtech-dispensador.sql): tabelas, RLS, vinculação do aparelho.
2. [02-organizador-semanal.sql](02-organizador-semanal.sql): organizador por dia × manhã/tarde/noite, configuração do dispensador (horários, tempo aberto, automação) e as funções do firmware 2.0 (`medtech_device_agenda` e `medtech_device_slot_report`). Ele não apaga dados nem as funções do 01.

3. [03-liberar-agora-e-tempo-real.sql](03-liberar-agora-e-tempo-real.sql): botão "Liberar agora" (tabela `dispense_requests` e função `medtech_request_dispense`), agenda com pedidos para o firmware 2.1 e atualização em tempo real (Supabase Realtime) das tabelas do site.

Se você já executou o 01 e o 02, **execute só o 03**. Se executou só o 01, execute o 02 e depois o 03, do mesmo jeito descrito abaixo. Os dois podem ser executados de novo sem perder dados. Se rodar o 01 de novo, rode o 02 logo depois.

## Instalar (uma vez)

1. Abra o painel do Supabase no projeto **amympuatlgqutzbaimfz**, o mesmo de `medtech/js/supabase-config.js`.
2. **SQL Editor → New query**.
3. Copie todo o conteúdo de `01-medtech-dispensador.sql`, cole e clique em **Run**.
   - Resultado esperado: `Success. No rows returned`.
   - O Supabase pode avisar sobre "operações destrutivas" por causa dos comandos `drop policy if exists` e `drop trigger if exists`. Eles só recriam as regras: **nenhum dado é apagado**.
4. Confira em **Table Editor** se existem `devices`, `medications`, `doses` e `device_events`, todas com o selo **RLS enabled**.

O script pode ser executado de novo para aplicar correções, sem perder dados.

Antes de rodar no projeto real, você pode testar o script no computador. Na pasta `tcc`, execute:

```bash
npm install
npm test
```

Os testes usam um PostgreSQL local (PGlite) e não acessam o seu projeto.

## Tabelas

| Tabela | Conteúdo | O site pode |
|---|---|---|
| `medications` | Medicamento, compartimento (1 a 8), horários, dias da semana, ativo/pausado | ler, criar, alterar e excluir os próprios |
| `devices` | Um dispensador por conta. A chave fica só como hash SHA-256 | ler, menos o hash; vincular e desvincular só pelas funções |
| `doses` | Uma linha por horário tratado pelo aparelho: `attempt`, `actuated`, `failed` ou `missed`, mais a confirmação do usuário | ler; confirmar a retirada com `medtech_confirm_dose` |
| `device_events` | Tudo o que o aparelho enviou (boot, erros, tentativas e resultados) | ler |

Visitantes sem login (`anon`) não leem nenhuma tabela.

## Funções

| Função | Quem chama | O que faz |
|---|---|---|
| `medtech_pair_device(p_token)` | site (logado) | Vincula ou troca a chave do aparelho. Invalida a chave anterior. |
| `medtech_unpair_device()` | site (logado) | Remove o vínculo. O histórico é mantido. |
| `medtech_confirm_dose(p_dose_id)` | site (logado) | Marca "retirada confirmada" numa dose com acionamento realizado. |
| `medtech_confirm_slot(p_scheduled_for, p_period)` (02) | site (logado) | Confirma a retirada de todos os medicamentos de um horário. |
| `medtech_device_agenda(p_token, p_firmware)` (02) | ESP32 2.0 | Atualiza `last_seen_at` e devolve um item por dia + período com medicamento, mais o tempo aberto e a automação. Não envia nomes. |
| `medtech_device_slot_report(p_token, p_event_uid, p_event_type, p_period, p_scheduled_for, ...)` (02) | ESP32 2.0 | Registra eventos por horário e cria uma dose para cada medicamento do período. Recusa a tentativa se a automação estiver desligada ou se não houver medicamento. É idempotente. |
| `medtech_device_sync` / `medtech_device_report` (01) | ESP32 1.0 | Versão anterior (um medicamento por compartimento). Continuam no banco, mas o firmware 2.0 não as usa. |

A tabela `dispenser_settings` (02) guarda, por conta, os horários de manhã, tarde e noite, o tempo aberto (5 a 300 s, padrão 60) e se a automação está ligada. O site lê e altera só a da própria conta.

O ESP32 usa a chave **publicável** no cabeçalho `apikey` e envia o token do aparelho no corpo JSON. Nunca use a chave `service_role` ou `sb_secret_` no site ou no firmware.

### Proteções no servidor

- O token precisa ter 64 caracteres hexadecimais e corresponder a um hash cadastrado. Caso contrário, a resposta é HTTP 401 (`Aparelho nao autorizado`).
- O medicamento informado num evento precisa ser do dono do aparelho.
- Só pode existir uma ocorrência por medicamento e horário. Uma segunda tentativa recebe `proceed: false` e o aparelho não abre a gaveta.
- O horário programado precisa ser um minuto cheio, de no máximo 7 dias atrás. O horário do evento não pode estar mais de 5 minutos no futuro.
- Limite de 30 eventos por minuto por aparelho (HTTP 429).
- Uma ocorrência finalizada (`actuated`, `failed` ou `missed`) não muda mais. Só a confirmação do usuário é acrescentada.

Uma chamada HTTP nunca é tratada como prova de entrega. `actuated` só significa que o aparelho informou ter movido o servo.
