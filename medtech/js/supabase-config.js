/* ==========================================================================
   MedTech — supabase-config.js
   Ponto ÚNICO onde o cliente Supabase é criado.

   ► O que colocar aqui:
     Painel do Supabase → Project Settings → API Keys →
     copie a chave "Publishable key" (sb_publishable_...) ou, em projetos
     antigos, a chave "anon public".

   ► NUNCA coloque aqui:
     a chave "secret" (sb_secret_...) nem a "service_role". Essas chaves
     ignoram as políticas de segurança (RLS) e dão acesso total ao banco.

   A chave publicável PODE aparecer no navegador: ela apenas identifica o
   projeto. Quem protege os dados é o login (Supabase Auth) somado às
   políticas RLS de cada tabela.

   Depende de: biblioteca @supabase/supabase-js carregada antes, via CDN.
   ========================================================================== */

const SUPABASE_URL = "https://amympuatlgqutzbaimfz.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_MS8ikSBd4GQq9FAOH4TAmA_EKBXa0KC";

const SupabaseConfig = (function () {
  let client = null;

  /** true quando a chave foi preenchida e a biblioteca carregou. */
  function isConfigured() {
    return (
      typeof SUPABASE_PUBLISHABLE_KEY === "string" &&
      SUPABASE_PUBLISHABLE_KEY.length > 20 &&
      SUPABASE_PUBLISHABLE_KEY.indexOf("COLE_AQUI") === -1
    );
  }

  function isLibraryLoaded() {
    return typeof window.supabase !== "undefined" && typeof window.supabase.createClient === "function";
  }

  /**
   * Devolve o cliente Supabase (criado uma única vez).
   * Retorna null se a chave ainda não foi configurada ou se o CDN falhou.
   */
  function getClient() {
    if (client) return client;

    if (!isLibraryLoaded()) {
      console.error("[MedTech] A biblioteca do Supabase não carregou. Verifique sua conexão com a internet.");
      return null;
    }
    if (!isConfigured()) {
      console.warn("[MedTech] Supabase ainda não configurado: preencha SUPABASE_PUBLISHABLE_KEY em js/supabase-config.js.");
      return null;
    }

    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,     // mantém a sessão ao recarregar a página
        autoRefreshToken: true,   // renova o token antes de expirar
        detectSessionInUrl: true  // lê o retorno dos links enviados por e-mail
      }
    });
    return client;
  }

  return {
    url: SUPABASE_URL,
    isConfigured: isConfigured,
    isLibraryLoaded: isLibraryLoaded,
    getClient: getClient
  };
})();
