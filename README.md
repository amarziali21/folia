# Margine PDF

Editor PDF che gira interamente nel browser: i file non lasciano il computer di chi lo usa.

## Cosa fa

**Pagine**: miniature, riordino trascinando, rotazione, eliminazione, pagine vuote, unione di più PDF (anche trascinandoli in un punto preciso), estrazione e divisione in più file, ritaglio.

**Commenti**: testo libero, evidenziatore, sottolineato, barrato, penna, note, rettangoli, ellissi, linee, frecce, immagini e timbri, firma disegnata. Sono annotazioni PDF native, quindi restano modificabili in Acrobat e negli altri lettori. Quelle già presenti nel file diventano modificabili.

**Modifica del contenuto**:
- Testo della pagina: si fa clic su un blocco e lo si riscrive. Il testo originale viene rimosso dal file e sostituito con uno dei font standard PDF (Helvetica, Times o Courier, con grassetto e corsivo).
- Testo nuovo scritto nel contenuto della pagina.
- Immagini della pagina: si possono spostare, ridimensionare, sostituire ed eliminare.
- Redazione vera: per area, lungo il testo o con la ricerca, anche per email, telefono, IBAN, codice fiscale, partita IVA e date. Il contenuto coperto viene eliminato dal file al salvataggio.

**Documento**: intestazione e piè di pagina con numeri di pagina, data, nome del file e numerazione Bates; filigrana; collegamenti a pagine o indirizzi web; segnalibri (lettura, modifica, rientri); proprietà; protezione con password AES-256 e permessi; apertura di PDF protetti.

**Moduli**: compilazione dei campi AcroForm, che restano campi veri nel file salvato.

## Come funziona

| Componente | Ruolo | Licenza |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | Visualizzazione delle pagine | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | Scrittura del PDF: pagine, annotazioni, contenuti, moduli, segnalibri | MIT |
| [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js) | Lettura strutturata del testo, rimozione del testo e redazione, cifratura | AGPL-3.0 |

MuPDF gira in un Web Worker e viene caricato dalla cartella `vendor/mupdf-<versione>/`. Se non è disponibile, tutto il resto funziona e gli strumenti che ne hanno bisogno lo segnalano.

Ogni modifica è un oggetto JSON nello stato dell'editor (`src/state.js`). Annulla e Ripeti salvano istantanee di quello stato. Il file viene scritto solo al salvataggio (`src/export.js`):

1. Per ogni file di origine si applicano le modifiche al contenuto. Le immagini si modificano riscrivendo gli operatori della pagina (`src/content.js`), testo e redazioni passano da MuPDF, poi si aggiunge il contenuto nuovo.
2. Le pagine vengono copiate in un documento nuovo, così le pagine eliminate spariscono davvero.
3. Si scrivono i commenti, gli strumenti documento, i moduli, i segnalibri e le proprietà.
4. Se richiesta, si applica la cifratura.

## Sviluppo

```bash
npm ci
npm run build      # crea dist/
npm run serve      # http://127.0.0.1:8790/
npm run dev        # build continua + server
npx playwright install chromium
npm test           # test unitari ed end-to-end (salva gli screenshot in test-results/)
```

## Pubblicazione su Cloudflare Pages

Il workflow `.github/workflows/ci.yml` compila, esegue i test e pubblica:

- **main** va in produzione;
- gli altri rami e le pull request ricevono un'anteprima.

Servono due secret del repository (*Settings → Secrets and variables → Actions*):

- `CLOUDFLARE_API_TOKEN`: un token con il permesso *Account › Cloudflare Pages › Edit*;
- `CLOUDFLARE_ACCOUNT_ID`: l'ID dell'account Cloudflare.

Al primo deploy il workflow crea il progetto Pages `margine-pdf`. Finché i secret mancano, la pubblicazione viene saltata senza errori.

Il workflow `deps-snapshot.yml` copia i pacchetti npm usati dalla build nel ramo `dev-deps`. Serve solo ad ambienti di sviluppo senza accesso a npm e si può ignorare.

## Licenza

AGPL-3.0-or-later (vedi `LICENSE`), perché il progetto include MuPDF. Chi usa il sito pubblicato ha diritto al codice sorgente, che è questo repository.
