#pragma once
// Copie para secrets.h nesta pasta. Preencha somente no computador de gravacao.
// Nunca envie secrets.h ao Git ou em capturas de tela.
constexpr char WIFI_SSID[] = "PREENCHA_WIFI";
constexpr char WIFI_PASSWORD[] = "PREENCHA_SENHA";
// Base HTTPS do projeto MedTech, sem barra final. Nao e a URL do site.
constexpr char SUPABASE_URL[] = "https://amympuatlgqutzbaimfz.supabase.co";
// Somente publishable ou anon PUBLICA. Nunca service_role nem sb_secret_.
constexpr char SUPABASE_PUBLIC_KEY[] = "PREENCHA_CHAVE_PUBLICA";
// Chave de 64 caracteres gerada no site: Dispositivo > Gerar chave do ESP32.
constexpr char DEVICE_TOKEN[] = "PREENCHA_CHAVE_DISPOSITIVO";
// Certificado RAIZ PEM da cadeia TLS atual do seu host Supabase.
// GTS Root R4 original: certificado publico verificado na fonte oficial do Google.
// SHA-256: 71:CC:A5:39:1F:9E:79:4B:04:80:25:30:B3:63:E1:21:DA:8A:30:43:BB:26:66:2F:EA:4D:CA:7F:C9:51:A4:BD
// A raiz e publica; nao use certificado privado, folha do servidor ou setInsecure.
constexpr char ROOT_CA_PEM[] = R"CERT(-----BEGIN CERTIFICATE-----
MIICCjCCAZGgAwIBAgIQbkepyIuUtui7OyrYorLBmTAKBggqhkjOPQQDAzBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw
MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp
Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQA
IgNiAATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzu
hXyiQHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/l
xKvRHYqjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1Ud
DgQWBBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNnADBkAjBqUFJ0
CMRw3J5QdCHojXohw0+WbhXRIjVhLfoIN+4Zba3bssx9BzT1YBkstTTZbyACMANx
sbqjYAuG7ZoIapVon+Kz4ZNkfF6Tpt95LY2F45TPI11xzPKwTdb+mciUqXWi4w==
-----END CERTIFICATE-----
)CERT";
