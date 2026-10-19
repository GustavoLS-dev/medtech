-- Reproduz, num PostgreSQL local (PGlite), o que o Supabase oferece e o
-- script do MedTech usa: papéis da API, auth.users, auth.uid() e as
-- permissões padrão que o Supabase concede a tabelas e funções novas.
create role anon nologin noinherit;
create role authenticated nologin noinherit;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
