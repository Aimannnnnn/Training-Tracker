# Training Tracker

Piccolo server Node (senza dipendenze esterne) che hosta il tracker di allenamento
(`tracker.html`) con:

- **stato condiviso**: le corse registrate vengono salvate in `state.json` sul server,
  non solo nel `localStorage` del browser, così sono le stesse da telefono, PC, ecc.
- **login**: una singola coppia utente/password protegge sia la pagina che le API.
- **accesso da fuori casa** via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`), senza aprire porte sul router.

## Avvio locale

```bash
node server.js
```

Al primo avvio, se non esiste ancora `auth.json`, viene creato un login:

- imposta `AUTH_USERNAME` / `AUTH_PASSWORD` come variabili d'ambiente per scegliere tu le credenziali, **oppure**
- lascialo generare una password casuale: viene scritta una volta sola in `CREDENTIALS.txt` (da leggere, salvare altrove e poi cancellare).

Il server serve la pagina su `http://127.0.0.1:8787` (porta configurabile con `PORT`).

Per il file HTML da servire: se esiste `~/Desktop/valencia-marathon-tracker.html` lo
usa (utile per editarlo a mano e vedere le modifiche subito), altrimenti usa la
copia `tracker.html` inclusa nel repo. Puoi anche forzare un percorso con la
variabile `TRACKER_HTML`.

## Esporlo da fuori casa (Cloudflare Tunnel)

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

Lo script `start-tracker.ps1` avvia sia il server Node che il tunnel (se non sono
già attivi) e salva l'URL pubblico in `url.txt`.

## Sicurezza

Pensato per un solo utente/uso personale: un'unica sessione via cookie, nessuna
gestione multi-utente. `state.json`, `auth.json`, `CREDENTIALS.txt`, `url.txt` e
`tunnel.log` non vengono versionati (vedi `.gitignore`) perché contengono dati
personali o effimeri.

Per cambiare username/password: cancella `auth.json` e riavvia il server (con le
env var impostate, oppure lasciando generare una nuova password casuale).
