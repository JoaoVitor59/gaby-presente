# TelaLink

Compartilhamento de tela entre dispositivos, direto pelo navegador. Um aparelho compartilha a tela (ou a câmera) e recebe um código de 9 dígitos; os outros digitam o código, pedem acesso e assistem em tempo real.

- **Sem instalar nada** em quem assiste: funciona no navegador do computador, tablet ou celular.
- **Só entra quem você permitir**: cada pedido de acesso precisa ser aceito por quem está compartilhando, que também pode remover alguém a qualquer momento.
- **A imagem vai direto de um aparelho para o outro** (WebRTC, criptografado). O servidor só ajuda os dois a se encontrarem.
- Até 10 pessoas assistindo ao mesmo compartilhamento, com som da aba/sistema quando o navegador oferece.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 18 ou mais novo.

```bash
npm install
npm start
```

Abra `http://localhost:3000` no computador que vai compartilhar. O terminal também mostra o endereço para os outros aparelhos da mesma rede (algo como `http://192.168.0.10:3000`).

## Como usar

1. No aparelho que vai mostrar a tela, clique em **Compartilhar tela** e escolha a tela, janela ou aba.
2. Passe o **código** (ou o link do botão **Copiar link**) para quem vai assistir.
3. No outro aparelho, digite o código em **Ver outro dispositivo** e clique em **Conectar**.
4. Volte ao primeiro aparelho e clique em **Permitir** no pedido que apareceu.

## Usando pela internet

Para funcionar fora da sua rede, hospede o projeto em qualquer serviço que rode Node.js (comando de build `npm install`, comando de início `npm start`; a porta vem da variável `PORT`). O serviço precisa entregar a página por **HTTPS** — os navegadores só deixam compartilhar a tela em `https://` ou em `http://localhost`.

Algumas redes (4G/5G e redes corporativas, principalmente) bloqueiam a ligação direta entre os aparelhos. Nesse caso é preciso um servidor TURN, que você configura na variável `ICE_SERVERS`:

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:seu-servidor:3478","username":"usuario","credential":"senha"}]' npm start
```

## Limites

- **É só visualização.** Um site não consegue mexer no mouse e no teclado de outro aparelho; controle remoto exigiria um programa instalado.
- **Celulares não compartilham a própria tela** (os navegadores de celular não permitem), mas podem compartilhar a câmera e assistir normalmente.

## Testes

```bash
npm test
```
