# TelaLink

Compartilhamento de tela entre dispositivos, direto pelo navegador. Um aparelho compartilha a tela (ou a câmera) e recebe um código de 9 dígitos; os outros digitam o código, pedem acesso e assistem em tempo real.

- **Sem instalar nada** em quem assiste: funciona no navegador do computador, tablet ou celular.
- **Só entra quem você permitir**: cada pedido de acesso precisa ser aceito por quem está compartilhando, que também pode remover alguém a qualquer momento.
- **A imagem vai direto de um aparelho para o outro** (WebRTC, criptografado). O servidor só ajuda os dois a se encontrarem.
- **Controle remoto** (computador com Windows): quem compartilha pode entregar o mouse e o teclado a quem está assistindo, e tirar quando quiser.
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

## Controle remoto

Funciona quando o computador a ser controlado é um **Windows 10 ou 11 com o TelaLink rodando nele**. Um site sozinho não consegue mexer no mouse e no teclado; quem faz isso é um pequeno ajudante que o servidor compila e inicia sozinho na primeira vez (fica na pasta `.telalink`).

1. No Windows, rode `npm start`. O terminal mostra um link com chave, parecido com `http://localhost:3000/#chave=3f9a…`.
2. Abra **esse link** no navegador do próprio Windows e clique em **Compartilhar tela**, escolhendo a **tela inteira**.
3. Depois de permitir a entrada de alguém, clique em **Dar controle** ao lado do nome da pessoa.
4. No outro aparelho, o mouse (ou o toque) e o teclado sobre a imagem passam a valer no Windows. No celular, o botão **Teclado** abre o teclado para digitar.

Para parar, clique em **Tirar controle**, **Remover** ou **Encerrar**.

Cuidados e limites:

- **Não passe o link com chave para ninguém.** É ele que prova que a página foi aberta por quem está na frente do computador; a chave muda toda vez que o servidor é iniciado. Para os outros aparelhos, passe só o código ou o botão **Copiar link**.
- Dar o controle é dar acesso total ao computador para aquela pessoa. Só entregue a quem você confia.
- Com mais de um monitor, compartilhe o principal — é nele que o mouse remoto se move.
- Janelas abertas "como administrador", a tela de bloqueio e os avisos de permissão do Windows não aceitam o controle remoto.
- Para as teclas baterem, os dois aparelhos devem usar o mesmo tipo de teclado (por exemplo, ABNT2 nos dois).
- Atalhos que o navegador reserva (Ctrl+W, Alt+Tab, tecla Windows) só são enviados no Chrome/Edge em **Tela cheia**.

## Código fixo e entrada sem pedir permissão

Cada computador tem um **código fixo**, sorteado na primeira vez e guardado em `telalink.config.json` na pasta do projeto. Ele aparece no terminal toda vez que o servidor inicia.

Para entrar direto, sem ninguém clicar em **Permitir**, grave uma senha (8 caracteres ou mais) naquele computador:

```bash
npm run senha SUA-SENHA
npm start
```

A partir daí, quem digitar o código e a senha entra direto e já recebe o controle (no Windows, compartilhando a tela inteira). Para escolher também o código: `npm run senha SUA-SENHA 123456789`.

O código fixo e a senha só valem na página aberta pelo **link com chave** do terminal. No Windows, o `npm start` já abre o navegador nesse link.

Cuidados:

- Com a senha gravada, **código + senha dão acesso total ao computador**. Use uma senha longa, que você não usa em outro lugar. Vinte senhas erradas seguidas travam a entrada por senha até o servidor ser reiniciado.
- O arquivo guarda a senha em texto simples e não vai para o GitHub (está no `.gitignore`).
- O computador ainda precisa estar com o servidor rodando e com **Compartilhar tela** já clicado: o navegador não deixa iniciar o compartilhamento sem alguém clicar na frente dele.

## Usando pela internet

Para funcionar fora da sua rede, hospede o projeto em qualquer serviço que rode Node.js (comando de build `npm install`, comando de início `npm start`; a porta vem da variável `PORT`). O serviço precisa entregar a página por **HTTPS** — os navegadores só deixam compartilhar a tela em `https://` ou em `http://localhost`.

O controle remoto não funciona com o servidor hospedado fora: para controlar um computador, o TelaLink precisa estar rodando nele.

Algumas redes (4G/5G e redes corporativas, principalmente) bloqueiam a ligação direta entre os aparelhos. Nesse caso é preciso um servidor TURN, que você configura na variável `ICE_SERVERS`:

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:seu-servidor:3478","username":"usuario","credential":"senha"}]' npm start
```

## Limites

- **Controle remoto só de computadores com Windows.** Chromebook, Mac, Linux e celulares podem controlar, mas não ser controlados.
- **Celulares não compartilham a própria tela** (os navegadores de celular não permitem), mas podem compartilhar a câmera e assistir normalmente.

## Testes

```bash
npm test
```
