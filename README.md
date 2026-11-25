# Acervo no GitHub Pages

O Acervo reúne 30 capas de álbum em Cover Flow. A página roda no GitHub Pages. O Supabase guarda as fotos, suas posições, o vínculo entre cada variação e a capa, o autor, a categoria e o coração de cada imagem.

## Publicação

O workflow [pages.yml](.github/workflows/pages.yml) publica a branch `main` e também pode ser executado pelo botão **Run workflow**. A configuração em **Settings → Pages → Build and deployment → Source** é **GitHub Actions**.

## Configuração do Supabase

1. Aplique [schema.sql](supabase/schema.sql) ao projeto que recebe as fotos.
2. Configure na função o segredo `GITHUB_PAGES_ORIGIN` com a origem exata da página, como `https://sbsjonathan.github.io`.
3. Publique a função com `supabase functions deploy acervo-images --remote=SEU-PROJETO --use-api`.
4. Preencha [public/config.js](public/config.js) com a URL do projeto e uma chave pública `publishable` ou `anon`. O GitHub Actions publica essa configuração junto com a página.

Qualquer visitante pode preencher um álbum vazio, adicionar variações e editar os dados das imagens. Os corações são compartilhados entre os aparelhos. O banco protege a posição já preenchida e a função usa a chave de serviço do Supabase no servidor. O esquema disponibiliza leitura pública das fotos.

Toque no texto pequeno da capa para escolher o autor e no título grande para escolher a categoria. A opção **Outro** na lista de autores permite digitar um nome. Em álbuns vazios, as escolhas acompanham a foto enviada pelo **+**. Em álbuns com foto, cada alteração é salva automaticamente.

Deslize na horizontal para trocar de capa. Em uma capa com foto, deslize para cima ou toque na seta para abrir as variações. O **+** nessa janela permite escolher várias imagens do aparelho. Cada variação começa com o autor e a categoria da capa e pode ser editada individualmente. Deslize na vertical ou toque nas miniaturas para escolher uma imagem. A seta para baixo fecha a janela.

## Teste local

Execute `bash scripts/build-pages.sh` e sirva a pasta `dist`.
