# Desk Booking Monitor

Monitor locale per `https://deskbooking.reply.com/home`. Non conserva password o codici MFA: salva soltanto la sessione browser locale dopo che hai completato manualmente SSO e MFA.

## Installazione

```sh
npm install
npm run install-browser
cp config.example.json config.json
```

Il monitor seleziona la sede `IT-TO-N250` definita in `config.json` e usa i filtri predefiniti `All` della pagina Book a Desk. Controlla ogni 5 minuti, anche nel weekend. Dal lunedi al venerdi monitora la data corrente e i giorni rimanenti della settimana; nel weekend monitora il successivo lunedi-venerdi. I desk che corrispondono a `excludedDeskPatterns` non vengono contati ne notificati; per impostazione predefinita esclude la sala `3.U.46` e i desk `HD`.

## Uso

```sh
npm run login
npm run check
npm run watch
```

`login` apre Chromium e attende che tu finisca MFA. Premi Invio nel Terminale solo quando vedi `Book a Desk`: il comando verifica che la pagina sia disponibile prima di confermare il salvataggio della sessione. `check` esegue un singolo ciclo; `watch` esegue subito un ciclo e poi lo ripete ogni `checkIntervalMinutes` minuti.

`watch` continua anche se un controllo fallisce, incluso il primo: registra l'errore e riprova dopo `checkIntervalMinutes`, senza sovrapporre i cicli.

Se il browser rimane su Microsoft o Reply SSO, il monitor segnala una sessione scaduta o un login incompleto. Ferma `watch` con `Ctrl+C`, esegui `npm run login`, completa SSO e MFA e poi riavvia `npm run watch` (oppure `npm run check` per un singolo controllo). Il monitor e il login usano lo stesso profilo browser, quindi chiudi il monitor prima di rifare il login.

## Notifiche dei posti liberati

Il monitor invia solo notifiche Teams e non effettua prenotazioni. Ogni messaggio indica data, sede e desk diventati disponibili rispetto all'ultimo controllo salvato, con un link e il pulsante `Prenota un desk` per aprire il portale e prenotare personalmente.

Le disponibilita invariate non generano altre notifiche. Un desk scomparso e poi ricomparso viene notificato di nuovo. Per una data senza controlli precedenti, tutti i desk disponibili sono considerati nuovi.

Lo stato viene salvato dopo ogni giornata controllata. Se Teams non accetta la notifica, il controllo fallisce senza segnare quei posti come notificati: `watch` riprova nel ciclo successivo.

## Configurazione Teams

In Teams, nel canale desiderato, crea un workflow con trigger `When a Teams webhook request is received` oppure un Incoming Webhook. Copia l'URL generato in `config.json`:

```json
"teamsWebhookUrl": "https://..."
```

L'URL e un segreto: non condividerlo e non committarlo. Verifica l'invio con:

```sh
npm run test-teams
```

La cartella `browser-profile/`, `state.json` e `config.json` sono ignorati da Git e non devono essere condivisi.
