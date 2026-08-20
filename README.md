# Training Tracker

Piccolo server Node (nessuna dipendenza esterna: solo `http`, `crypto`, `fs`) che hosta il tracker
di allenamento `tracker.html` con:

- **stato condiviso**: le corse registrate finiscono in `state.json` sul server, non nel
  `localStorage` del browser, quindi sono le stesse da telefono, PC e tablet;
- **due modi di entrare**: senza login dal tailnet, con utente e password dall'URL pubblico;
- **due utenti con ruoli**: `admin` (scrive) e `readonly` (guarda e basta);
- **importazione automatica**: un endpoint per le corse dagli iOS Shortcuts e uno per gli export di
  Apple Health;
- **interfaccia bilingue** italiano/inglese, con la scelta ricordata nel browser.

Gira sul Raspberry Pi come servizio systemd. Setup e infrastruttura sono documentati nel repo
[Raspberry](https://github.com/Aimannnnnn/Raspberry): [hosting](https://github.com/Aimannnnnn/Raspberry/blob/main/docs/05-hosting-tracker.md)
e [accesso senza login](https://github.com/Aimannnnnn/Raspberry/blob/main/docs/15-un-solo-login.md).

## Avvio

```bash
node server.js
```

Al primo avvio, se non esiste `auth.json`, viene creato un login: imposta `AUTH_USERNAME` /
`AUTH_PASSWORD` per scegliere le credenziali, oppure lascia generare una password casuale, scritta
una volta sola in `CREDENTIALS.txt` (da leggere, salvare altrove e cancellare).

| Variabile | Default | A cosa serve |
|---|---|---|
| `PORT` | `8787` | porta con login, quella esposta a internet |
| `TAILNET_PORT` | `8788` | porta senza login, da esporre **solo** sul tailnet |
| `TAILNET_USERS` | vuoto | indirizzi ammessi da quella porta; vuoto = chiunque sia nel tailnet |
| `TRACKER_HTML` | — | percorso dell'HTML da servire, se non quello del repo |

Per il file HTML: se esiste `~/Desktop/valencia-marathon-tracker.html` usa quello (comodo per
editarlo e vedere subito le modifiche), altrimenti la copia `tracker.html` del repo.

## Le due porte

```
internet ──Funnel──────────> :8787   utente e password
tailnet  ──tailscale serve─> :8788   nessun login
```

Sulla `8788` non si chiede nulla perché **Tailscale ha già autenticato il dispositivo** prima che la
richiesta parta, e aggiunge alla richiesta l'header `Tailscale-User-Login` con l'identità di chi la
sta facendo. Chiedere anche una password sarebbe una seconda serratura su una porta già chiusa a
chiave.

**Perché due porte separate e non un controllo dentro la stessa.** La `8787` riceve anche traffico
da internet, e lì quell'header non vale niente: chiunque può spedirlo inventandoselo. Tenendo
l'identità confinata a una porta pubblicata *esclusivamente* con `tailscale serve`, ci arriva solo
ciò che Tailscale ha già verificato. Verificato in entrambe le direzioni: dal tailnet la pagina si
apre sbloccata, mentre sulla porta pubblica un header falsificato riceve `302` sulla pagina e `401`
sulle scritture.

## API

| Endpoint | |
|---|---|
| `POST /api/login`, `POST /api/logout` | sessione a cookie per la porta pubblica |
| `GET`/`POST /api/state` | lettura e scrittura dello stato; la scrittura è negata ai `readonly` |
| `POST /api/log-run` | registra una corsa; autenticato con `X-Log-Key`, usato dagli iOS Shortcuts |
| `POST /api/health` | riceve gli export di Apple Health (app *Health Auto Export*), stessa chiave |

`log-run` e `health` usano una chiave dedicata e non la sessione del browser, perché li chiama
un'automazione che non fa login: la chiave sta in `auth.json` come `logKey`. **Se `auth.json` viene
rigenerato, quella chiave cambia e gli Shortcuts smettono di funzionare** — va copiato, non
ricreato, quando si sposta il server.

## Sicurezza

Uso personale, sessioni in memoria (un riavvio del server le invalida e si rifà il login).
`state.json`, `auth.json`, `CREDENTIALS.txt`, `health/` e i file effimeri non sono versionati (vedi
`.gitignore`): contengono dati personali.

Per cambiare le credenziali: cancella `auth.json` e riavvia — ricordandoti che così **cambia anche
`logKey`**.
