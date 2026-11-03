# Impostor — jogo de palavras

## Jogar agora

**https://jogo-do-impostor-vpk2.onrender.com**

O plano free do Render hiberna após alguns minutos sem uso. A primeira visita depois disso pode demorar até ~50 segundos; durante uma partida ativa o servidor fica acordado.

Jogo multiplayer em que **um jogador é o impostor** e todos os outros recebem a mesma palavra secreta. Em cada volta, cada jogador dá **uma única palavra** relacionada ao tema. No fim, todos votam em segredo para descobrir quem estava blefando.

Feito para jogar cada um no seu celular, de casas diferentes, enquanto conversam por uma chamada de áudio (WhatsApp, Discord, Meet etc.). O app cuida das salas, papéis secretos, turnos e votação — **a chamada de voz é por fora**.

## Como jogar

1. Um jogador cria a sala e compartilha o **código de 5 letras** (ou o link do convite).
2. Os amigos entram com o código. De 3 a 12 jogadores.
3. O anfitrião escolhe quantas voltas de dicas quer (1 a 3) e inicia.
4. Cada jogador vê seu papel em segredo:
   - **Equipe:** vê a palavra secreta e a categoria.
   - **Impostor:** vê apenas a categoria e uma dica genérica.
5. Em cada volta, todos dão uma palavra, um por vez. Dá para **digitar** a palavra no app ou **falar no áudio** e tocar em “Já falei”.
6. Depois das voltas, cada jogador vota em segredo.
7. Se o mais votado for o impostor, **a equipe vence**. Se não, ou se houver empate, **o impostor vence**.
8. O anfitrião pode jogar novamente ou voltar ao lobby. O placar da série fica salvo.

## Rodar no computador

Pré-requisito: [Node.js](https://nodejs.org/) 18 ou superior (recomendado: LTS).

```bash
npm install
npm start
```

Abra **http://localhost:3000**.

Para testar com celulares na mesma rede Wi-Fi, o terminal mostra um endereço tipo:

```
Rede: http://192.168.0.10:3000
```

Abra esse endereço no celular (mesma rede). Se não abrir, libere o Node.js no firewall do Windows.

## Jogar com amigos em casas diferentes

O servidor precisa estar acessível pela internet. Duas opções:

### Opção 1 — Render (recomendado)

1. Crie um repositório no GitHub com esta pasta (sem `node_modules`).
2. No [Render](https://render.com/), clique em **New → Web Service** e conecte o repositório.
3. Use:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Depois do deploy, compartilhe a URL gerada.

O arquivo `render.yaml` já deixa a configuração pronta para Blueprint. O plano free do Render pode hibernar quando fica um tempo sem acesso — o primeiro carregamento depois disso pode demorar cerca de 30 segundos.

### Opção 2 — Cloudflare Tunnel (temporário)

Se o servidor vai rodar no seu computador e você só quer um link para a noite de jogo:

```bash
cloudflared tunnel --url http://localhost:3000
```

O `cloudflared` mostra uma URL pública temporária. O computador precisa ficar ligado e com `npm start` rodando. A URL muda cada vez que o túnel é aberto.

## Estrutura

```
server.js          Servidor Express + Socket.IO (salas, turnos, votos)
words.js           Palavras secretas, categorias e dicas genéricas
public/
  index.html       Interface do jogo
  styles.css       Estilo mobile-first
  app.js           Lógica do cliente e comunicação em tempo real
test/
  e2e.js           Teste do fluxo completo (4 jogadores)
  reconnect.js     Teste de reconexão e bloqueios de entrada
```

## Testes (desenvolvimento)

Com o servidor rodando em outra porta, por exemplo:

```powershell
$env:PORT=3102; node server.js
```

Em outro terminal:

```powershell
$env:URL="http://localhost:3102"; node test/e2e.js
$env:URL="http://localhost:3102"; node test/reconnect.js
```

## Observações

- As salas ficam em memória. Se o servidor reiniciar, as partidas em andamento são perdidas.
- O app não faz chamada de voz; combinem o áudio antes de começar.
- Cada jogador pode recarregar a página e voltar para a mesma partida enquanto a sala existir.
- Joguem com respeito: a graça está no blefe, não em estragar a rodada dos outros.
