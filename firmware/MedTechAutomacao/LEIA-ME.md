# Firmware MedTechAutomacao (organizador semanal)

Este firmware automatiza o organizador: **7 compartimentos, um por dia** (servo 0 = segunda … servo 6 = domingo), cada um com **manhã, tarde e noite**. No horário de cada período, o compartimento do dia abre, fica aberto pelo tempo configurado no site (**padrão: 1 minuto**) e fecha sozinho. Depois disso, o ESP32 registra a liberação no site, e cada medicamento do período entra no relatório do dia.

Nada precisa ser digitado no terminal: a automação é ligada e desligada no site, na página **Programação**. O Monitor Serial serve só para diagnóstico.

**Liberar agora (versão 2.1):** na página **Hoje**, cada período ainda não tratado tem o botão **Liberar agora**. O pedido vai para o Supabase (vale por 2 minutos); o ESP32 o recebe na próxima consulta (a cada 15 s), abre o compartimento do dia, espera o tempo configurado, fecha e registra aquele período. No horário normal ele não abre de novo. O pedido funciona mesmo com a automação desligada, porque é um comando explícito do usuário; as demais proteções (relógio, agenda, PCA9685, duplicidade) continuam valendo. No Monitor Serial aparece como `[PEDIDO]` e no LCD como `Pedido do site`.

Com o `03` instalado, o site também se atualiza **em tempo real**: a cor do medicamento muda no momento em que o aparelho registra.

Os firmwares `MedTechComunicacao` e `MedTechCalibracao`, na Área de Trabalho, continuam intactos. Use o de calibração para medir as posições das portas.

**A bomba nunca é acionada.** O relé (GPIO 18) fica em HIGH desde a primeira linha do `setup()` e é reforçado a cada volta do `loop()`. Não existe comando nem função que o ligue.

## Como funciona

```
Site (Medicamentos + Programação) ──► Supabase ◄── ESP32 (consulta a cada 30 s)
                                                     │ relógio NTP (Brasília, UTC-3)
                                                     ▼
                                         PCA9685 ──► servo do dia
```

1. No site, cada medicamento recebe **dias** e **períodos**. Em **Programação** ficam os horários de manhã, tarde e noite, o tempo aberto e o botão da automação.
2. A cada 15 s, o ESP32 chama `medtech_device_agenda` e recebe um item por **dia + período** que tenha medicamento ativo, com o horário, o tempo aberto e o estado da automação. Ele não recebe o nome dos medicamentos.
3. A agenda válida fica guardada na flash. Sem internet, ela continua valendo por **até 24 h**.
4. A cada segundo, o aparelho verifica se algum horário venceu. Ao encontrar um:
   1. grava na flash que o horário está **em andamento**, antes de mover qualquer coisa;
   2. com internet, envia a tentativa ao servidor. O servidor recusa se o horário já foi tratado, se a automação foi desligada no site ou se não há mais medicamento naquele período. **Nesses casos, não abre**;
   3. abre em rampa (0° → 90°), espera o tempo configurado (60 s), fecha em rampa, segura a posição por 0,8 s e corta o sinal do canal;
   4. registra "acionamento realizado". O servidor marca **cada medicamento** daquele dia e período, e o site atualiza a página Hoje (a cada 15 s) e o Relatório.

### Políticas de segurança

| Situação | Comportamento |
|---|---|
| Mesmo horário duas vezes | Não acontece: a flash e o servidor guardam cada horário (dia + período). |
| Reinício durante um acionamento | O horário vira "falha" (`reinicio_durante_acionamento`), o compartimento é comandado direto para a posição fechada e **nunca reabre** por esse horário. |
| Horário atrasado (queda de energia, sem Wi-Fi no boot) | Até **10 min** de atraso: abre normalmente. Mais que isso: registra "não aberta (atraso)" e **não abre**. Horários com mais de 12 h são ignorados. Horários perdidos nunca são executados em sequência. |
| Automação desligada no site | Não abre. Horários anteriores ao momento em que ela foi ligada não contam como perdidos. |
| Sem Wi-Fi | Usa a última agenda por até 24 h. Depois disso, para de abrir até sincronizar de novo. Se a automação for desligada no site enquanto o aparelho está sem internet, ele só fica sabendo quando reconectar. |
| Relógio não sincronizado | Não abre nada. O ESP32 clássico não tem RTC com bateria: depois de ligar, ele precisa de internet uma vez para acertar a hora. |
| Relógio diferente do servidor (> 120 s) | Não abre nada até corrigir. |
| Resposta inválida do servidor | A resposta inteira é descartada e a agenda anterior continua em uso. |
| Chave trocada ou aparelho desvinculado (HTTP 401) | Apaga a agenda local e para de abrir. |
| Horário, período ou medicamento alterado no site | Vale na próxima consulta (até 30 s). Horários anteriores à alteração não são executados nem marcados como perdidos. |
| Falha de I²C (PCA9685 não responde) | Corta o sinal de todos os servos e registra "falha" (`falha_i2c`). |
| Servo travado | **Não é detectado:** o hardware não tem sensor de posição. Para limitar o esforço, o sinal do canal é cortado logo depois de fechar. |

## Instalar

1. **Arduino IDE** com o pacote **esp32 (Espressif)**: a compilação foi verificada com a versão 3.3.12, placa *ESP32 Dev Module*.
2. Bibliotecas: **ArduinoJson 7** (verificada com a 7.4.3) e **LiquidCrystal** (1.0.7, já vem com a IDE). Não é preciso nenhuma biblioteca de servo.
3. Em **Ferramentas → Core Debug Level**, deixe **None**.

## Configurar

1. Copie `secrets.example.h` para `secrets.h` e preencha o Wi-Fi (2,4 GHz), a chave publicável e a chave do aparelho (gerada no site, em **Dispositivo → Gerar chave do ESP32**). O `secrets.h` é ignorado pelo Git e **nunca deve ser enviado** a ninguém, nem aparecer em prints.
2. Em `config.h`, confira a tabela `COMPARTIMENTOS`, na ordem **segunda … domingo**: canal do PCA9685 e ângulos **fechado/aberto**. Os valores atuais (canais 0 a 6, 0° e 90°) são **provisórios**. Meça cada porta com o firmware de calibração antes de usar com medicamentos.
3. Os horários dos períodos, o tempo aberto e a automação ficam no **site**, não no firmware.

Se algum valor de `COMPARTIMENTOS` for inválido (canal repetido, canal maior que 7, ângulo fora de 0 a 180), o firmware **não compila**.

## Comandos do Monitor Serial (diagnóstico, 115200 baud)

| Comando | Ação |
|---|---|
| `AJUDA` | Lista os comandos. |
| `STATUS` | Wi-Fi, relógio, automação, PCA9685, fila, agenda da semana e próximo horário. |
| `TESTE n` | Abre o compartimento do dia `n` (1 = segunda … 7 = domingo), espera o tempo configurado e fecha. Não registra dose. |
| `PARAR` | Corta o sinal de todos os servos. **A porta pode ficar aberta:** apoie o mecanismo. |
| `SINCRONIZAR` | Antecipa a consulta ao servidor. |

## Passo a passo 1: comunicação e servo manual (bomba desconectada)

1. Com tudo desligado, **desconecte a bomba** e deixe só o servo da **segunda-feira** (canal 0) conectado.
2. Grave o firmware e abra o Monitor Serial. O esperado é:

   ```
   [MedTech] medtech-auto-2.0.0. Bomba sempre desligada.
   [PCA] PCA9685 pronto; todos os canais sem sinal.
   [MedTech] Automacao DESLIGADA no site (ultima agenda salva). Digite AJUDA para os comandos.
   [WiFi] Conectando; credenciais omitidas.
   [WiFi] Conectado.
   [API] medtech_device_agenda: HTTP 200
   [AGENDA] 0 horario(s) na semana; automacao DESLIGADA no site; gaveta aberta por 60 s.
   ```

   LCD: `MedTech / Iniciando` → `MedTech / Conectando WiFi` → `Sistema conect. / Auto DESLIGADA`.
3. Ligue a alimentação dos servos e digite `TESTE 1`:

   ```
   [SERVO] Abrindo compartimento Seg (canal 0, 0 -> 90 graus).
   [CMD] Teste do compartimento 1 iniciado.
   [SERVO] Aberto; fecha em 60 s.
   [SERVO] Fechando compartimento Seg.
   [SERVO] Compartimento Seg fechado; PWM desligado. (teste, sem registro)
   ```

   LCD: `Abrindo gaveta / Teste manual` → `Gaveta aberta / Seg fecha em 60s` → `Fechando gaveta / Seg` → `Gaveta fechada / Teste concluido`.
4. Se forçar ou não abrir o suficiente, digite `PARAR`, ajuste os ângulos em `config.h` e grave de novo. Repita com `TESTE 2` … `TESTE 7`, um servo por vez.

## Passo a passo 2: automação pelo site

1. Em **Medicamentos**, cadastre um item de teste (use só objetos de teste, nunca medicamentos) com o **dia de hoje** e o período **Tarde**, por exemplo.
2. Em **Programação**, ajuste o horário da **Tarde** para **3 minutos à frente** e salve. Depois clique em **Ligar automação**.
3. Em até 30 s, o Monitor Serial mostra:

   ```
   [API] medtech_device_agenda: HTTP 200
   [AGENDA] 1 horario(s) na semana; automacao LIGADA no site; gaveta aberta por 60 s.
     Seg Tarde 14:03  servo 0  1 medicamento(s)
   ```

   LCD: `Agenda atualiz. / 1 horario(s)` e depois `Sistema conect. / Prox Seg 14:03 T`.
4. No horário:

   ```
   [AGENDA] Seg Tarde 14:03 (1 medicamento(s)): iniciando.
   [API] medtech_device_slot_report: HTTP 200
   [SERVO] Abrindo compartimento Seg (canal 0, 0 -> 90 graus).
   [SERVO] Aberto; fecha em 60 s.
   [SERVO] Fechando compartimento Seg.
   [SERVO] Compartimento Seg fechado; PWM desligado. Registrando no site.
   [API] medtech_device_slot_report: HTTP 200
   ```

   LCD: `Horario program. / Seg - Tarde` → `Abrindo gaveta / Seg - Tarde` → `Gaveta aberta / Seg fecha em 60s` → `Fechando gaveta / Seg` → `Gaveta fechada / Registrando...`.
5. No site, a página **Hoje** mostra a Tarde como "Acionamento realizado", e o **Relatório** lista o medicamento no dia de hoje. O botão **Retirei** é opcional: ele registra que alguém pegou os medicamentos.

Os trechos acima mostram o que o código imprime. **Eles não são registros de um teste físico já realizado.**

## Limitações conhecidas

- **Sem sensor:** o sistema não sabe se a porta abriu, se o comprimido caiu nem se foi retirado. "Acionamento realizado" é o que o aparelho informou. "Retirada confirmada" é uma confirmação **manual**.
- **Um servo por dia:** manhã, tarde e noite abrem o **mesmo** compartimento do dia. A separação entre os períodos dentro da gaveta é física (divisórias) e não é controlada pelo firmware.
- **Ângulos provisórios:** 0° e 90° precisam ser calibrados. A faixa de pulsos 110 a 510 veio do programa original e não é um limite mecânico validado.
- **Servo travado não é detectado** (não há realimentação de posição nem medição de corrente).
- **Cortar o sinal** depois de fechar deixa o servo sem força: se a porta não se segura sozinha, ajuste `ASSENTAR_MS` ou a mecânica.
- **Sem RTC:** depois de uma queda de energia, sem internet, o aparelho não sabe a hora e não abre nada.
- **Horário de Brasília fixo (UTC-3):** se o horário de verão voltar, `FUSO_POSIX` em `config.h` e `SP_OFFSET` em `medtech/js/data.js` precisam mudar.
- **Relé no reset:** o software só controla o GPIO 18 depois que o `setup()` começa. Confirme na montagem o estado inativo do módulo durante o boot.
- **Bomba:** nenhuma dispensação de líquidos foi implementada.

## Checklist de testes

Marque somente o que foi **executado no hardware real**.

| # | Teste | Como verificar |
|---|---|---|
| 1 | Wi-Fi | `[WiFi] Conectado.` |
| 2 | Relógio | `STATUS` mostra "relogio sincronizado" e a hora certa. |
| 3 | Autenticação | `medtech_device_agenda: HTTP 200` e o site mostra "Comunicação recente". Com uma chave errada: HTTP 401 e LCD `Nao autorizado`. |
| 4 | Agenda | `STATUS` lista os dias e períodos iguais à grade da página Programação. |
| 5 | Sem medicamentos | `0 horario(s)`, LCD `Sem horarios` e nenhum movimento. |
| 6 | Servo manual | `TESTE 1` abre, espera 60 s e fecha. |
| 7 | Horário automático | Ver o passo a passo 2. |
| 8 | Sem repetição | Depois do horário, nenhum novo acionamento. No Relatório, cada medicamento aparece uma vez para aquele período. |
| 9 | Reinício | Reinicie (EN) depois do acionamento: não abre de novo. Reinicie **durante** o acionamento: o Relatório mostra "Falha" (reinício) e a gaveta é comandada para fechar. |
| 10 | Perda de conexão | Desligue o roteador antes de um horário: abre pela agenda local e registra ao reconectar. Desligue o ESP32 por mais de 10 min passando por um horário: aparece "Não aberta (atraso)" e não abre. |
| 11 | Alteração e cancelamento | Desligue a automação ou remova o período do medicamento antes do horário: depois de 30 s, não abre. Mude o horário da Tarde: vale o novo. |
| 12 | Relatório | "Tentativa registrada", "Acionamento realizado", "Retirada confirmada" (só depois de Retirei), "Falha" e "Não aberta (atraso)" aparecem separados por dia e período. |
| 13 | Bomba | Durante todos os testes, a bomba fica desconectada e o relé em repouso (GPIO 18 em HIGH). |
