# Acervo no GitHub Pages

O site reúne 30 capas de álbum em Cover Flow. A página roda no GitHub Pages e o Supabase guarda as fotos, suas posições e a função de envio.

## Publicar no GitHub Pages

Envie este código a um repositório do GitHub e selecione **Settings → Pages → Build and deployment → Source → GitHub Actions**. O workflow [pages.yml](.github/workflows/pages.yml) publica a branch `main` e também pode ser executado pelo botão **Run workflow**. Para outra branch, ajuste o workflow e as regras do ambiente `github-pages` no repositório.

A publicação usa links relativos e funciona no caminho `https://SEU-USUARIO.github.io/REPOSITORIO/`. O Pages define a visibilidade da página conforme as opções do repositório e do plano do GitHub.

## Configurar o Supabase

1. Execute [schema.sql](supabase/schema.sql) no **SQL Editor**. Para uma instalação do Acervo já migrada para os 30 álbuns, o esquema é o mesmo.
2. Configure o segredo `ACERVO_UPLOAD_TOKEN` para a função. Use o token já adotado ou gere um valor novo com `openssl rand -hex 32`.
3. Configure `GITHUB_PAGES_ORIGIN` com a origem exata da página, como `https://SEU-USUARIO.github.io`, sem a barra final e sem o caminho do repositório. Use a origem do domínio personalizado caso adote um.
4. Publique a função `acervo-images` com o Supabase CLI executando `supabase functions deploy acervo-images --project-ref SEU-PROJETO --use-api` na raiz deste código.
5. Abra o Acervo e selecione **Conectar Supabase** no rodapé. Informe a URL do projeto e a chave pública `publishable` ou `anon`. Para compartilhar a configuração com todos os navegadores, defina esses dois valores em [public/config.js](public/config.js) antes de publicar.

Ao tocar no **+** de uma capa vazia, escolha a foto e informe o token de envio quando solicitado. A função valida o token e usa a chave de serviço no servidor. O esquema disponibiliza leitura pública das imagens no Supabase.

Para conferir os arquivos estáticos localmente, execute `bash scripts/build-pages.sh` e sirva a pasta `dist`.
