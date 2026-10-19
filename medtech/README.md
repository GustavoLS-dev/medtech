# MedTech

Frontend do TCC **MedTech**, um sistema de dispensação automática de medicamentos integrado ao Supabase e a um dispensador com ESP32.

Feito apenas com **HTML, CSS e JavaScript puro**. Não usa Vite, frameworks nem processo de build. A biblioteca oficial `@supabase/supabase-js` é carregada por CDN, com a versão fixada (2.45.4) e verificação de integridade (SRI).

> Projeto acadêmico. Não substitui a orientação de profissionais de saúde. Não use dados médicos reais nos testes.

---

## Situação atual: integração com o ESP32

| Item | Situação |
|---|---|
| Layout, identidade visual e responsividade | ✅ Pronto |
| Login, cadastro, confirmação de e-mail e recuperação de senha | ✅ Supabase Auth |
| Proteção das páginas privadas (verificação de sessão) | ✅ Pronto |
| Tabelas e políticas RLS no Supabase | ✅ [`../supabase/`](../supabase/LEIA-ME.md): execute o 01 e depois o 02 no SQL Editor |
| Organizador semanal: 7 compartimentos (servo 0 = segunda … 6 = domingo) × manhã/tarde/noite | ✅ Páginas Medicamentos e Programação |
| Automação ligada/desligada pelo site (sem terminal) | ✅ Página Programação |
| "Liberar agora" e atualização em tempo real | ✅ Página Hoje (requer `supabase/03` e firmware 2.1) |
| Vinculação e status do ESP32 | ✅ Página Dispositivo |
| Horários do dia, relatório diário e confirmação de retirada | ✅ Páginas Hoje e Relatório |
| Firmware com automação dos servos | ✅ [`../firmware/MedTechAutomacao`](../firmware/MedTechAutomacao/LEIA-ME.md), **sem teste físico registrado** |
| Sensor de liberação | ❌ Não existe no hardware atual |
| Bomba | ❌ Nunca acionada (sem especificação) |

O repositório (`tcc/`) tem três partes:

```
tcc/
├── medtech/      Site (publicado na Vercel com Root Directory = medtech)
├── supabase/     SQL do banco + LEIA-ME
├── firmware/     Firmware do ESP32 (secrets.h fica fora do Git)
└── tests/        Testes do banco e da lógica do site (npm test)
```

---

## Estrutura do site

```
medtech/
├── index.html              Login
├── cadastro.html           Criação de conta
├── confirmacao.html        Orientação após o cadastro / retorno do link do e-mail
├── recuperar-senha.html    Pedir o link de recuperação
├── redefinir-senha.html    Definir a nova senha (aberta pelo link do e-mail)
├── dashboard.html          Painel "Hoje"
├── medicamentos.html
├── programacao.html
├── historico.html
├── dispositivo.html
├── perfil.html
├── css/
│   ├── base.css            Variáveis (cores, fontes, espaçamentos), reset, tipografia
│   ├── layout.css          Sidebar, topo do celular, layout das telas de login
│   └── components.css      Botões, cards, formulários, badges, toasts, modais...
├── js/
│   ├── supabase-config.js  Cria o cliente Supabase (único lugar com URL e chave)
│   ├── auth.js             Cadastro, login, logout, senha e proteção das páginas
│   ├── icons.js            Ícones SVG
│   ├── ui.js               Componentes de interface reutilizáveis
│   ├── validation.js       Regras de validação dos formulários
│   ├── data.js             Acesso às tabelas e funções do banco; doses do dia
│   └── pages/              Um script por página
└── assets/                 Logo e favicon
```

A ordem dos dias e os períodos ficam em `DAYS` e `PERIODS`, no início de `js/data.js`. O compartimento de cada dia segue a mesma regra do firmware (`firmware/MedTechAutomacao/config.h`): segunda = servo 0 … domingo = servo 6.

### Ordem dos scripts

Não usamos `import`/`export`. Cada arquivo cria um objeto global (`SupabaseConfig`, `Icons`, `UI`, `Validation`), então a **ordem das tags `<script>` importa**:

```
supabase-js (CDN) → supabase-config.js → icons.js → ui.js → auth.js → validation.js → data.js → pages/xxx.js
```

---

## Como executar

As páginas precisam ser abertas por um **servidor HTTP local**. Não use `file://`: a autenticação e os redirecionamentos dos e-mails dependem de um endereço `http://`.

### Opção recomendada: Live Server (VS Code / Antigravity)

1. Instale a extensão **Live Server** (Ritwick Dey).
2. Abra a pasta `tcc` no editor. O arquivo `tcc/.vscode/settings.json` já define:
   - raiz do servidor: `/medtech`
   - porta: `5500`
   - host: `127.0.0.1`
3. Clique em **Go Live**, na barra inferior.
4. O site abre em **http://127.0.0.1:5500/index.html**.

> Se a porta 5500 estiver ocupada, o Live Server pode escolher outra. Veja o endereço real na barra do navegador e use esse endereço no Supabase.

> **Atenção:** `http://127.0.0.1:5500` e `http://localhost:5500` são endereços **diferentes** para o navegador. Cada um guarda a sua própria sessão. Escolha um deles e use sempre o mesmo, inclusive no painel do Supabase.

### Alternativa com Node.js

```bash
cd medtech
npx serve -l 5500
```

---

## Configuração do Supabase

### 1. Chave publicável

Edite `js/supabase-config.js` e substitua `COLE_AQUI_SUA_CHAVE_PUBLICAVEL` pela chave do projeto:

> Painel do Supabase → **Project Settings → API Keys** → *Publishable key* (`sb_publishable_...`). Em projetos antigos, use a chave **anon public**.

**Nunca** coloque no frontend a chave *secret* (`sb_secret_...`), a `service_role` ou qualquer `SUPABASE_SECRET_KEY`. Essas chaves ignoram as regras de segurança e dão acesso total ao banco.

#### Por que a chave publicável pode ficar visível?

Tudo o que o navegador recebe pode ser visto por qualquer pessoa (F12). A chave publicável apenas **identifica o projeto**; ela não dá acesso livre aos dados. Quem protege os dados é a combinação de:

1. **Supabase Auth**: cada pessoa entra com a própria conta.
2. **RLS (Row Level Security)**: políticas no banco que permitem que cada usuário leia e altere **somente as próprias linhas**.

Sem RLS, qualquer pessoa com a chave publicável poderia ler as tabelas. As tabelas e políticas estão em `../supabase/01-medtech-dispensador.sql`. O passo a passo para instalar fica em [`../supabase/LEIA-ME.md`](../supabase/LEIA-ME.md). Enquanto o SQL não for executado, as páginas mostram "Banco ainda não instalado".

### 2. URLs de redirecionamento (obrigatório)

No painel: **Authentication → URL Configuration**

- **Site URL:** `http://127.0.0.1:5500`
- **Redirect URLs:** adicione
  - `http://127.0.0.1:5500/confirmacao.html`
  - `http://127.0.0.1:5500/redefinir-senha.html`

Os links dos e-mails voltam para o endereço em que o site está aberto (`SITE_URL = window.location.origin`, no início de `js/auth.js`). Não é preciso alterar o código ao trocar de porta ou publicar o site; basta cadastrar os novos endereços no painel (veja [Publicação na Vercel](#publicação-na-vercel)).

Se um endereço não estiver na lista, o Supabase ignora o redirecionamento e manda o usuário para a **Site URL**.

### 3. Confirmação de e-mail

Em **Authentication → Sign In / Providers → Email**, mantenha **Confirm email** ativado.

O serviço de e-mail padrão do Supabase serve apenas para testes:

- envia poucos e-mails por hora (o limite aparece em **Authentication → Rate Limits**);
- só entrega para endereços de **membros da equipe** do projeto (em **Organization → Team**).

Para cadastrar outras pessoas, configure um SMTP próprio em **Authentication → Emails → SMTP Settings**.

### Publicação na Vercel

O site é estático, então não há build.

1. Na Vercel, importe o repositório `GustavoLS-dev/medtech`.
2. **Root Directory:** `medtech`.
3. **Framework Preset:** *Other*. Deixe *Build Command* e *Output Directory* vazios.
4. Depois do primeiro deploy, no Supabase (**Authentication → URL Configuration**):
   - **Site URL:** o endereço da Vercel (ex.: `https://medtech-xxx.vercel.app`);
   - **Redirect URLs:** mantenha os de `127.0.0.1:5500` e adicione
     - `https://medtech-xxx.vercel.app/confirmacao.html`
     - `https://medtech-xxx.vercel.app/redefinir-senha.html`
5. Para pessoas fora da equipe do projeto conseguirem se cadastrar, configure um SMTP próprio (veja o item 3).

### Sobre `.env`

O navegador **não lê arquivos `.env`** sem ferramentas de build. Por isso este projeto não usa `.env` nem variáveis `VITE_*`: a única configuração do frontend é a chave publicável em `js/supabase-config.js`, que pode ser pública. O `.gitignore` já bloqueia arquivos `.env` caso eles sejam usados no futuro (por exemplo, numa função de servidor).

---

## Como a autenticação funciona

| Ação | Função do Supabase | Onde |
|---|---|---|
| Cadastro | `auth.signUp` com `emailRedirectTo` e `full_name` | `cadastro.js` → `Auth.signUp` |
| Reenviar confirmação | `auth.resend({ type: "signup" })` | `confirmacao.js` |
| Login | `auth.signInWithPassword` | `login.js` → `Auth.signIn` |
| Logout | `auth.signOut` | botão "Sair" (`ui.js` → `Auth`) |
| Pedir link de senha | `auth.resetPasswordForEmail` com `redirectTo` | `recuperar-senha.js` |
| Salvar nova senha | `auth.updateUser({ password })` | `redefinir-senha.js` |
| Proteger página | `auth.getSession` + `auth.getUser` | `auth.js` (páginas com `data-private`) |

Regras de segurança aplicadas:

- **Nenhuma senha é guardada pelo nosso código.** A sessão (tokens) é salva pela própria biblioteca do Supabase.
- **A URL nunca prova nada sozinha.** Ao voltar de um link de e-mail, a página confere a sessão com `getUser()`, que consulta o servidor. Um token falso colocado na URL ou no navegador é recusado.
- **Páginas privadas ficam ocultas** (`is-checking-session`) até a sessão ser confirmada. Sem sessão, o usuário vai para o login. Sem conexão, aparece um aviso e o conteúdo continua oculto.
- **Sem redirecionamento aberto:** o parâmetro `?voltar=` só aceita as páginas privadas do próprio site.
- **Recuperação sem revelar contas:** a mensagem após pedir o link é sempre a mesma.
- **Controle de frequência:** 60 segundos entre envios de e-mail, além dos limites do próprio Supabase (erro 429).

## Estados de uma dose

A interface separa o que o dispositivo **informou** do que **realmente aconteceu**. Os textos ficam em `UI.DOSE_STATES` (`js/ui.js`):

| Estado | Significado |
|---|---|
| Pendente | O horário ainda não chegou. |
| Tentativa registrada | O dispositivo começou o acionamento, mas ainda não informou o resultado. |
| Acionamento realizado | O dispositivo informou que abriu e fechou a gaveta. Isso não prova que o medicamento foi retirado. |
| Retirada confirmada | O usuário tocou em "Retirei" no site (confirmação manual). |
| Liberação por sensor | Exige sensor. O hardware atual não tem, então este estado ainda não é usado. |
| Falha | O dispositivo informou um erro ou reiniciou durante o acionamento. |
| Não aberta (atraso) | O horário passou da tolerância de 10 min (ex.: sem energia). A gaveta não foi aberta. |
| Sem registro | O horário passou e o dispositivo não enviou nada. |

---

## Acessibilidade

- Link "Pular para o conteúdo" e foco visível em todos os elementos.
- Rótulos (`label`) em todos os campos, mensagens de erro ligadas por `aria-describedby`.
- Menu do celular fechado com `Esc`; quando está fechado, os itens não recebem foco.
- Animações desativadas para quem ativa "reduzir movimento" no sistema.
