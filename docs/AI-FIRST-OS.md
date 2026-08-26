# Un OS AI-first — note di design

> Documento di lavoro, 24 agosto 2026. Raccoglie l'esperimento mentale "e se Nefertari fosse
> l'OS predefinito della macchina", i vettori strutturali che mancano, la risposta al problema del
> contesto, e le task in ordine di costo.
>
> Non è un manifesto. Ogni proposta ha un meccanismo Linux concreto o una ragione precisa per cui il
> meccanismo non esiste. Dove una cosa esiste già (NixOS, OSTree, gVisor, systemd) si dice, invece di
> reinventarla.

---

## 1. La tesi, in una riga

Un OS per umani protegge la macchina dall'esterno. **Un OS per agenti deve anche proteggere il mondo
dal contesto**, perché il contesto di un agente è per costruzione una linea aperta verso terzi.

---

## 2. L'esperimento: accendo il PC e l'OS è fatto per agenti

**Al boot.** PID 1 resta systemd — reinventare init è il modo classico di morire, e CoreOS/NixOS
vincono *sopra* di esso. Ma il default target non è più il login manager: è `nefertari.target`.
Nessun getty, nessuna sessione utente. Nell'ordine: root immutabile (generazione OSTree/Nix), policy
di mediazione caricata, `agentd`.

**Il boot è un wake event come gli altri.** Ogni goal con lavoro aperto riceve il suo packet — *"eri
al passo 12 del piano Y, la macchina si è riavviata, il tree è al checkpoint Z"*. Non esiste
"avviare i programmi": esistono **goal che si risvegliano**.

**Cosa vede l'umano.** Non una scrivania: una **plancia**. Goal attivi, gate pendenti, delta
dall'ultimo sguardo. La shell interattiva resta, ma come strumento diagnostico — come oggi la console
seriale di un hypervisor — non come porta d'ingresso.

**Cosa sparisce.**
- *La sessione utente.* L'unità di esecuzione non è "utente loggato" ma "goal attivo". `/home` come
  concetto sparisce; al suo posto workspace per goal, ognuno con la sua timeline.
- *I dotfile e l'ambiente implicito.* L'ambiente di un goal è un manifest dichiarato, non
  l'accrescimento di `.bashrc`. Un agente non ha memoria: un ambiente implicito è un ambiente da
  ri-scoprire ogni volta, cioè tassa di orientamento pagata a ogni sessione.
- *Il package manager mutativo.* `apt install` muta stato globale condiviso. Con dipendenze per-goal e
  content-addressed (questo è Nix, esiste già) **"installare" diventa reversibile per costruzione**, e
  il gate umano su `apt-get` semplicemente evapora: uno switch di profilo non è irreversibile.
- *cron e syslog.* cron → wake bus. syslog testuale → journal tipizzato che alimenta il world-model.

**L'agente crasha.** Distinzione che l'OS classico non fa: il **brain** (loop + connessione API) può
morire; il **body state** (journal, timeline, goal card) è esterno per costruzione e non muore mai.
Crash = watchdog wake → nuovo brain, stesso goal, stesso packet. **Il crash smette di significare
amnesia**: è l'equivalente di riaprire gli occhi.

**Due agenti vogliono la stessa cosa.** Tre casi, tre risposte:
- *stesso tree* → non succede: ognuno nel suo fork, il conflitto si sposta da lock a merge. La
  contesa diventa review.
- *stessa risorsa host* (porta, device) → arbitraggio del broker con lease journalizzata.
- *stessa risorsa **esterna*** (stesso repo su cui pushare, stesso account Stripe) → **questo l'OS
  classico non lo copre proprio.** Serve un lease manager su URI esterni: `flock` per il mondo, non
  per i file.

**L'umano interviene.** Inversione strutturale: l'umano è ospite privilegiato, non proprietario della
sessione. Tre gesti — *pausa* (freeze della cgroup del goal, zero CPU, riprendibile), *ispezione*
(world + journal invece di `ps aux` e archeologia), *intervento diretto*. E il punto elegante:
l'intervento diretto passa dalla stessa fisica — **l'umano edita in un fork suo**, integrato via
promote come un teammate qualsiasi. Se invece bypassa (è root, può), `fanotify` rileva la scrittura
non mediata e la iscrive nel journal come *"mondo cambiato fuori dalla mediazione"*: l'agente al
prossimo wake lo **sa**, invece di lavorare su assunzioni marce.

**Spegnimento a metà lavoro.** Non è un evento eccezionale, è un freeze globale: i piani sono
transazionali, le cgroup si congelano, lo stato è già tutto su disco perché lo è *sempre*. Corollario:
**la macchina diventa bestiame, non animale domestico** — migrare un agente è `rsync` più boot
altrove. È il motivo per cui CRIU non serve e sarebbe l'astrazione sbagliata.

---

## 3. Il problema del contesto — e perché "illimitato" è l'obiettivo sbagliato

Un modello locale ha una finestra piccola. Anche una finestra enorme non risolve, e il motivo è
importante: **il contesto non è memoria gratis, è memoria su cui paghi l'affitto a ogni turno.** Ogni
token residente viene ri-spedito a ogni chiamata. Riempire un milione di token rende ogni turno
successivo costoso per sempre. Il problema non è la capienza, è la **residenza**.

Un OS questo problema lo ha già risolto, e non dando ai processi RAM illimitata: **dandogli memoria
virtuale.** Un processo indirizza uno spazio più grande della RAM fisica; quando tocca una pagina che
non c'è, il kernel la fa entrare. Il processo non chiama `swap_in()` e non sa niente.

La mappa è esatta:

| Memoria virtuale | Contesto virtuale |
|---|---|
| RAM fisica | la finestra di contesto: piccola, cara, ri-pagata ogni turno |
| Disco | journal + filesystem + working set: grande, durevole, gratis |
| Page table | tabella degli handle posseduta dall'OS |
| Page fault | l'agente dereferenzia un handle, l'OS inietta il contenuto |
| Eviction | l'OS toglie il corpo, lascia l'handle. **Non è perdita**: è ripaginabile |
| Cache coherence | *"la cosa che tieni è cambiata"* — già presente in `working_set` |

Tre differenze da RAG, e sono quelle che contano:

1. **Non lo gestisce l'agente.** In RAG l'agente decide di cercare, e a volte se ne dimentica. Qui è
   l'OS a decidere cosa è residente, come un processo non decide cosa sta in RAM. Si tolgono turni
   (tassa di round-trip) e si toglie il modo di fallire più comune.
2. **Gli handle sono identità stabili con una versione, non testo.** Un file non è "il testo del
   file" ma un riferimento versionato — quindi l'OS può dire *"quello che tieni è cambiato sotto"*.
   È coerenza di cache, e nessun sistema RAG ce l'ha.
3. **L'eviction è journalizzata e reversibile.** Cosa era residente al turno N è ricostruibile — ed è
   proprio ciò che rende possibile il checkpoint unificato (stato agente + stato mondo).

**E il pager è il modello locale.** È la cosa che può leggere 10 MB e decidere quali 2 KB contano,
**senza che quei 10 MB lascino la macchina**. Confine di egress e pager del contesto sono lo stesso
primitivo: qualcosa di locale che legge molto ed emette poco.

⚠️ **Ma non un server di chat.** Ollama, LM Studio e simili sono la forma sbagliata per un componente
OS: caricano il modello a richiesta e lo scaricano dopo il keep-alive (un cold start da secondi è
fatale per una guardia chiamata a *ogni* lettura), pagano HTTP e JSON per chiamata quando le chiamate
sono centinaia per run, **non danno controllo sullo scheduling** — non puoi dirgli "gira in
`SCHED_IDLE` dentro la finestra di inferenza e fatti preemptare quando arriva un tool call vero", che
è esattamente H1 — né sulla residenza in memoria. E sono un demone in più da installare: un OS che
chiede di installare prima un server di chat non è un OS.

**La forma giusta è inferenza embedded nel supervisor privilegiato in Rust** (§6): llama.cpp come
libreria, GGUF in mmap, modello residente, niente HTTP. Modelli da 0,5–2B quantizzati, ~700 MB in
mmap: per classificare *"è una credenziale"* o *"quali 2 KB contano"* non serve un 8B, e su CPU non
ruba la GPU a nessuno. Sta nello stesso componente che deve comunque essere Rust e privilegiato perché
possiede chiavi e policy — **chi decide cosa può uscire è chi tiene le chiavi**.

I driver HTTP costruiti il 24 agosto (`localmodel.mjs`: openai-compatible, ollama, llamacpp, http)
restano come **via di fuga e banco di prova**, non come default.

**Vincolo onesto:** la finestra vera è posseduta dal client (Claude Code, Hermes, il loop custom), non
da `agentd`. Nefertari non può fare eviction dalla finestra altrui. Ma può controllare **cosa
consegna**, che è lo stesso identico vincolo dell'egress e ha la stessa risposta: si governa il lato
ingresso. "Contesto virtuale" significa quindi: *l'OS non consegna mai più del budget, e consegna
handle invece di corpi*. Forma concreta dei tool: `fs_read` restituisce handle + riassunto quando il
corpo supera il budget; `expand(handle, regione)` fa il fault-in della parte che serve davvero.

---

## 3-bis. Computer use: lo schermo come seam, e il caso che rompe la tesi

Vedere lo schermo e agirci è la capacità che serve quando il lavoro non passa da un file o da un
comando — un pannello web senza API, un'app desktop, una dashboard. `gemma-gem` mostra la forma
funzionante: screenshot più albero DOM, un modello che decide, click e JavaScript come azioni.

Ma innestarlo qui non è "aggiungere un tool screenshot", perché **il computer use è il caso che rompe
la tesi di Nefertari**, ed è esattamente per questo che va risolto qui e non in un'estensione a parte.

**Il problema.** Tutto in Nefertari poggia su *snapshot prima, azione poi, rollback se serve*. Una
pagina web non è snapshottabile. Un click su "Elimina account" non ha un undo handle. Il filesystem è
reversibile per costruzione; **il mondo no**.

**La risposta è già in roadmap, sotto un altro nome.** È il caso robotico: dove il mondo non si può
snapshottare, si inverte il primitivo — si forka il *modello* del mondo, non il mondo, e si chiede al
broker **prima** di attuare. `preflight(azione) → {classe, gate?, undo_via?}`. **Computer use e
robotica sono lo stesso problema**, e il computer use è la metà software con cui si può iniziare
domani: stesso classificatore, stesso gate, stesso journal, e un dominio dove sbagliare costa un form
compilato male invece di un braccio meccanico.

**Cosa classifica il broker su un'azione di schermo.** Non l'azione in astratto ma il bersaglio: il
testo dell'elemento, il suo ruolo, l'host della pagina. Un click su un link è reversibile; un click su
un bottone il cui nome contiene *delete / pay / send / confirm* è irreversibile e va al gate umano
prima di partire. E — lezione già imparata altrove — vanno nominate **tutte le strade allo stesso
effetto**: un form si invia anche premendo Invio in un campo qualsiasi, quindi una regola che blocca
solo il bottone non blocca niente.

**Lo schermo è il flusso più sensibile che esista**, ed è qui che il tier locale (§3) smette di essere
un'opzione. Un sensore che manda pixel a un'API di terzi è invendibile a qualunque azienda; uno il cui
primo lettore è un modello **sulla macchina** è installabile. Il valore di `gemma-gem` come driver è
precisamente questo: il modello sta nel browser, quindi pagina e screenshot vengono classificati senza
uscire. E lo schermo è anche il caso peggiore per la residenza: un frame costa migliaia di token, e
tenerne dieci in finestra significa ri-pagarli a ogni turno — quindi il pager di §3 non è
un'ottimizzazione, è il solo modo di reggerlo.

**Forma concreta:** un seam `screen` con driver, come `enforce` e `localmodel`.

| Driver | Cosa |
|---|---|
| `cdp` | Chrome DevTools Protocol / Playwright — headless o browser vero |
| `extension` | ponte con un'estensione stile `gemma-gem`, modello in-browser |
| `native` | schermo dell'host (X11/Wayland/Windows) per le app desktop |
| `screenpipe` | cattura continua guidata da eventi OS, screenshot + albero di accessibilità |
| `null` | nessuno schermo — default |

Il seam consuma l'albero di accessibilità **prima** dei pixel: è strutturato, è cento volte più
economico in token, ed è l'unico modo di scrivere una policy su un elemento invece che su una regione
di immagine. I pixel servono come ripiego, non come formato primario.

## 4. I vettori strutturali che mancavano

**4.1 Identità e segreti — il più grave.** Nell'OS classico credenziale = file leggibile dallo UID
(`~/.ssh`, token in env). Ma ogni byte che entra nel contesto **viene spedito a terzi al turno
successivo**: un segreto nel prompt è esfiltrato per architettura, non per attacco. Quindi il segreto
non deve mai entrare nel contesto: l'agente dice *"chiama GitHub come identità del goal X"* e il
broker inietta la credenziale **a valle dell'agente**, al punto di egress. Il prior art è esatto e
funziona da anni: l'instance metadata service di AWS — **la macchina ha l'identità, il processo no**.
Radice in kernel keyring (`keyctl`) o TPM. Identità *per goal*, con scope e scadenza: l'agente non è
uno UID, è un goal con un capability set. Questo rompe il modello "layer sopra": finché l'agente può
leggere `~/.ssh` come il suo utente, nessun layer lo salva.

**4.2 La risorsa scarsa non è la CPU: è la quota API.** Uno scheduler multi-agente pensato in termini
kernel (CPU, IO) sbaglia bersaglio. Per N agenti il collo reale è token/minuto e €/giorno
sull'endpoint del modello, più i rate limit delle API esterne — risorse che **il kernel non può
vedere** e che solo il punto di mediazione vede. Serve un token bucket nel broker: budget per goal,
pressione stile PSI, prelazione fra goal. È la conferma della tesi: il "kernel" di un OS per agenti è
in gran parte userspace, perché arbitra risorse remote e semantiche.

**4.3 Il modello di errore: `errno` non dice cosa è successo al mondo.** Exit code più stderr testuale
sono fatti per un umano che ricostruisce. Per un agente un errore deve essere una dichiarazione sullo
stato del mondo: **(esito, write-set effettivo, undo handle)**. Unix non dice *quali side effect sono
avvenuti prima del fallimento*, e l'agente senza quello ri-sonda (tassa di ricomputo) o allucina. Con
il fork overlay il write-set **è** l'upperdir: gratis. Imparentata e altrettanto economica:
**idempotenza per hash d'azione** — i modelli ri-emettono tool call doppi, e il meccanismo esiste già
per le approvazioni single-use.

**4.4 Audit a prova di manomissione.** Il journal è JSONL modificabile dallo stesso utente. Quando il
caller è umano, in tribunale testimonia lui; **un agente non può testimoniare**. La catena "quale
goal, quale azione, quale approvazione umana" deve essere tamper-evident: hash-chain (ogni entry
include l'hash della precedente), firma Ed25519 del demone, ancoraggio periodico a TPM2 o a una
timestamp authority. È il prerequisito per vendere *"l'agente ha fatto X e l'umano aveva approvato"*
come fatto verificabile.

**4.5 Lease su risorse esterne.** Gli effetti degli agenti sono prevalentemente *fuori* dalla
macchina, dove `flock` non arriva. Tabella di lease per URI (`push:github.com/org/repo`,
`spend:stripe:acct_x`), advisory ma journalizzata e gated. Nessun meccanismo kernel esiste né può
esistere: la risorsa è remota, solo il punto di mediazione la vede.

**4.6 Aggiornamento del sistema.** Meccanicamente è pratica nota (generazioni OSTree/Nix), ma cambia
il soggetto: con il rollback a generazioni **l'agente può aggiornare l'OS su cui gira**, e
l'auto-manutenzione diventa `noisy` invece che `irreversible`. È la fisica della timeline applicata
alla root.

**Guardati e scartati:** osservabilità (è già T4/T5), il tempo (basta il tempo soggettivo come delta
nel wake packet), multi-tenancy adversarial (territorio VM/gVisor: driver, non invenzione),
fallimento hardware (già risolto dallo stato esternalizzato).

---

## 5. Il capitolo hardware

L'intuizione: **la mediazione totale più il costo-per-azione invertito trasformano due risorse
hardware ordinarie in risorse schedulabili dall'OS dell'agente.** Nessun altro layer può farlo perché
nessun altro vede i confini dei turni e la dirty-list completa.

**H1 — Inference-window scheduling** *(novità alta, sforzo basso-medio)*. Fra un tool call e il
successivo c'è una finestra di idle **garantita e nota**: il turno di inferenza, secondi, dopo *ogni*
azione. Ci si infila il lavoro preparatorio a priorità zero (`cpu.idle=1`, `SCHED_IDLE`, `ionice -c3`)
— pre-checkpoint incrementale, pre-materializzazione dei K fork, readahead del working set — e non
ruba mai un ciclo al lavoro vero, che lo preempta. Al tool call successivo il pesante è già fatto.
*Numero:* p50 di `timeline_checkpoint` da secondi a <20 ms, ≥70% delle chiamate pre-servite.

**H2 — Fork overlayfs con upper in tmpfs** *(sforzo medio)*. Non è la velocità della copia: K fork
leggono **gli stessi inode**, quindi la page cache tiene **1 copia invece di K**, e i branch perdenti
scrivono solo in RAM → **zero byte su SSD per ogni traiettoria scartata**. Il riframe: *la durabilità
segue la promozione, non la `write()`*. Bonus: l'upperdir **è** il write-set esatto (vedi 4.3), gratis.
*Numero:* fork ×8 su tree da 1 GB in <100 ms; page cache 300 MB invece di 2,4 GB.

**H3 — Page cache pilotata dal journal** *(giorni)*. Readahead del working set al wake, evict esplicito
delle pagine dei fork perdenti (`posix_fadvise`, `MADV_COLD`, `cachestat(2)`). Onesto: su una macchina
scarica la page cache fa già da sé — il beneficio esiste solo sotto pressione di memoria o con N
agenti in competizione, e il benchmark va fatto lì o il numero è un imbroglio.

**H4 — Gate-freeze** *(una settimana)*. Azione parcheggiata al gate → `cgroup.freeze` sull'albero: 0
CPU, RAM intatta, ripresa in millisecondi. Primo mattone del processo-agente sospendibile.
*Numero:* agente al gate = 0 CPU, approve→ripresa <100 ms.

### ⚠️ Buco aperto: l'hardware qui è quasi solo CPU

H1–H4 parlano di CPU e page cache. Sono le due risorse che la mediazione totale rende schedulabili
per prime, ma non sono le uniche, e trattarle come se lo fossero è un limite del capitolo, non della
tesi. Non ancora affrontati:

- **La GPU.** Per un OS che fa girare inferenza locale è *la* risorsa contesa: il modello locale, un
  eventuale modello di visione per il computer use, e qualunque cosa l'agente stesso costruisca se la
  giocano. Il kernel non ha un `cpu.idle` per la GPU — il tempo GPU non si preempta come quello CPU, e
  MPS/MIG su NVIDIA sono partizionamento statico, non scheduling. Va capito cosa esiste davvero
  (cgroup v2 non copre la GPU; `nvidia-cgroup`/DRM scheduling sono parziali) prima di promettere
  qualcosa.
- **La memoria sotto pressione.** `memory.high` e PSI esistono, e un OS con N agenti più un modello
  residente li vuole entrambi. Oggi non li tocchiamo.
- **Il disco.** `io.weight` e `io.latency` per non far affamare il lavoro vero dalle copie
  speculative — che è esattamente ciò che H2 e la speculazione producono.
- **La rete.** Non solo come confine (BPF egress) ma come risorsa: il flusso di inferenza è il "bus di
  sistema" di questa macchina, e compete con il traffico bulk dei tool.

**Bocciati con motivazione:** CRIU (astrazione sbagliata: lo stato vero è journal+timeline+contesto,
non l'immagine di un loop Node) · io_uring (batcha syscall quando il collo è l'inferenza; `plan_run`
batcha già al livello giusto) · NUMA/hugepages (il compute è remoto) · quote cgroup per agente (da
fare, ma è igiene container standard) · fanotify world-watch (fatelo, ma Watchman lo fa dal 2013).

---

## 6. Il confine del raggiungibile

**Incrementi dal demone attuale — nessuna riscrittura:** hash-chain e firma del journal (giorni) ·
idempotenza per hash d'azione (giorni) · lease manager URI (1–2 settimane) · scheduler a budget token
(2 settimane) · errori con write-set (sopra H2) · boot-as-wake (unit systemd + resume: packaging) ·
**secret broker con egress proxy (3–4 settimane, il rapporto valore/sforzo più alto di tutto il §4)** ·
Nix come driver "install reversibile" · freeze/thaw e human-fork.

**Richiede un artefatto nuovo, non una riscrittura:** la radice di fiducia non può essere Node sotto lo
stesso UID. Serve un **piccolo supervisor privilegiato in Rust** — dell'ordine del binario Landlock già
esistente, non di un OS — che carica la policy al boot e possiede le chiavi. `agentd` resta il policy
engine non privilegiato che gli parla. **È la vera linea di faglia architetturale, ed è attraversabile.**

**"Essere l'OS" = possedere il boot**, e quello è lavoro da distro: modulo NixOS o immagine OSTree —
root immutabile, `nefertari.target`, supervisor, policy BPF, agentd. Settimane di packaging, non anni
di kernel.

**Da non costruire mai:** scheduling di token/quote dentro il kernel (la risorsa gli è invisibile: il
posto giusto è il broker) · isolamento adversarial fatto in casa (Firecracker/gVisor come driver) · un
init proprio (systemd resta).

---

## 7. Task, in ordine di costo

### Fatto il 25 agosto 2026
- [x] **`mcp-socket`**: il demone è un servizio a cui l'agente si connette, non un processo che
      possiede — `fc06561`. Sbloccava tutto il resto: Landlock si eredita, quindi finché `agentd` era
      figlio dell'agente, confinarlo avrebbe confinato anche il broker
- [x] **`nefertari run`**: l'agente parte confinato, workspace in sola lettura — `74f87af`. **Chiude
      il cerchio logico**: "fisica, non convenzione" ora descrive l'agente, non i tool
- [x] **`--deny-read` nell'enforcer** — `06bd842`. Confinare le scritture non protegge un segreto:
      verificato che un agente confinato legge `~/.aws` senza difficoltà. Landlock è allow-only,
      quindi la deny-list è espressa come complemento
- [x] `docs/BENCHMARK.md` con metodo, numeri e dati grezzi — `1f2d250`
- [x] **Confronto con dsh eseguito**, non più solo dichiarato — `1f2d250`

### Fatto il 24 agosto 2026
- [x] Immagine Docker che porta l'enforcer (era fail-open silenzioso) — `db0fdc5`
- [x] Timeline: symlink preservati, fork che raggiunge le dipendenze — `7056fe3`
- [x] `planshape`: step piatti e stringa JSON — `b7ba57b`
- [x] `working_set`: la tassa di orientamento pagata dal journal — `06d533f`
- [x] Doc tracciati, `ocs.mjs`, benchmark — `0185abb`
- [x] MIT ovunque, README riposizionato — `2aa1851`
- [x] Benchmark a N=5 su tre modelli economici
- [x] **`localmodel.mjs` + `egress.mjs`**: tier locale plugabile (llama.cpp / LM Studio / vLLM /
      llamafile / Ollama / qualunque HTTP) e confine del contesto su `fs_read` e output shell
- [x] **Hash-chain del journal** — `f566519`. Un agente non può testimoniare, quindi il registro deve
- [x] **`idle.mjs`**: la finestra di inferenza misurata — `3b97927`. **99–100% su un run reale**
- [x] **`cgroups.mjs`** + una cgroup per comando — `d0dbba1`, `6e011a3`. Freeze e `cpu.idle` verificati
- [x] **`inferd.mjs`**: supervisione dell'inferenza locale — `c343e10`. Congelata: **0 µs su 700 ms**
- [x] **`speculate.mjs`**: il checkpoint fatto nella finestra di idle — `c1ad1c6`.
      **103 ms a freddo → 9 ms preparato**, e sette test su otto sono di correttezza
- [x] **Firma Ed25519 per entry** — `44a8b57`, §4.4. La catena rende la manomissione *visibile*; la firma
      impedisce di riscrivere il registro da capo. Un falsario può ricalcolare ogni hash, non può
      firmare, e una entry non firmata dopo una firmata viene rifiutata. Resta aperta la troncatura:
      nessuna firma può protestare per la propria assenza, serve un àncora esterna
- [x] **Pre-lavoro speculativo in un figlio sotto `cpu.idle`** — `9634bd7`. La copia speculativa non
      gira più dentro il demone. *Numero: copiare 128MB in-process blocca l'event loop per **264 ms**,
      nel figlio per **0 ms**.* Il difetto non era teorico: `copyFileSync` non cede, e il demone è ciò
      che ogni tool call attraversa — una speculazione che può bloccare una chiamata vera è peggio
      di nessuna speculazione, perché il costo cade proprio sul percorso che doveva accelerare.
      In un figlio diventano possibili due cose che prima no: `cpu.idle` (gira solo quando la CPU
      non la vuole nessun altro) e la **kill immediata** all'arrivo di una tool call — uccidere un
      processo è istantaneo e totale, abbandonare un loop no.
      **Trappola trovata nel test:** il primo misuratore di stallo usava `setInterval` e lo
      azzerava appena `run` risolveva; ma un corpo sincrono risolve in una *microtask* e i timer
      sono *macrotask*, quindi l'interval veniva cancellato prima di scattare anche una volta e
      ogni misura tornava uno 0 ms convinto. Un metro che legge zero su un blocco noto di 300 ms
      non fallisce: ti dà ragione. Ora il metro viene verificato contro un blocco noto prima di
      essere usato
- [x] **Budget token nel broker** — §4.2. La risorsa scarsa non è la CPU, è il conto del modello.
      **Il punto che cambia il disegno:** quasi tutti i "token budget" si fidano di ciò che il
      client dichiara, e un budget di cui ti devi fidare è un suggerimento. C'è però una voce
      grossa che il demone possiede **da solo** e che nessuno conta: **i byte che restituisce**.
      Ogni byte di un risultato diventa token di input al turno dopo — e a quello dopo ancora,
      finché resta in finestra. *Numero: un risultato da 200KB costa ~51.400 token una volta e
      ~513.000 su dieci turni, **10×**.* Quindi si misurano due cose tenute separate: `observed`
      (chiamate servite, byte immessi nel contesto, e il **carry**) e `reported` (quel che dice il
      client, se lo dice) — mai una al posto dell'altra, e un run non riportato dice a voce che è
      non misurato invece di sembrare gratis.
      **L'agente non può alzarsi il budget:** non esiste il tool, di proposito. Il limite arriva
      dall'ambiente, da chi paga; l'agente può leggerlo e riportarci dentro, nient'altro. Un tetto
      di spesa che l'agente può modificare è un tetto come lo è una serratura sul lato interno.
      **Esaurirsi non è "rifiuta tutto":** un agente che non può chiamare niente non può rilasciare
      i lease, non può dire dove era arrivato e non è ricostruibile dopo. Il lavoro nuovo si ferma,
      spiegarsi e restituire resta permesso.
      Resta aperta la **prelazione fra goal** di §4.2: qui c'è il contatore e il limite, non ancora
      lo scheduler che toglie quota a un goal per darla a un altro
- [x] **Vista operatore su HTTP** — dare a un'IA il controllo completo si difende solo se qualcuno
      può **vedere**, e vedere dal registro, non dal resoconto che l'agente dà di sé. Una chiamata
      dice cosa il kernel sta davvero applicando *qui*, cosa aspetta un umano, cosa ha fatto (a
      conteggi), quanto è piena la finestra, cosa tiene e da dove, quali identità esistono, quali
      risorse esterne sono in lease. `/journal` prende gli stessi filtri di `journal_query`.
      Pagina servita **senza** token, dati **con**: così l'URL è condivisibile. Lo status non porta
      **nessun valore di credenziale** — è l'endpoint che più facilmente finisce dietro un link
      incollato in chat. E bindare fuori da loopback con un token generato viene **rifiutato**: il
      token finirebbe dentro un container che nessuno da fuori può leggere — una porta chiusa a
      chiave con la chiave dentro.
- [x] **Secret broker: identità che l'agente usa e non vede** — §4.1, la voce che il documento
      indicava come valore/sforzo più alto. L'agente dice *"chiama X come identità Y"* e il demone
      attacca la credenziale **a valle**, al punto di egress: stessa forma dell'instance metadata
      service di AWS — la macchina ha l'identità, il processo no. Un segreto che entra nel contesto
      è esfiltrato **per architettura**, non per attacco, quindi non ci entra mai.
      **Quattro porte chiuse, una per riga:** (1) nessun tool lo restituisce — né intero, né un
      prefisso, né la lunghezza: chi può chiedere *quanto è lungo* può chiedere 200 volte; (2) non
      finisce nel journal, che è il file fatto apposta per essere riletto da altri; (3) non passa
      mai da argv — `nefertari secret add` legge da **stdin**, perché una riga di comando finisce
      nella history, in `ps`, e nel registro di questo stesso demone; (4) ogni identità è **scopata
      a degli host** e lo scope è verificato *prima* che la richiesta parta — è quello che rende
      sicuro conoscerne il **nome**.
      **E la risposta viene scansionata al ritorno:** un'API che rimanda indietro il proprio header
      `Authorization` consegnerebbe dal portone quello che tutto il resto ha tenuto fuori. Il test
      usa un servizio che riflette apposta, e verifica che su **ogni byte** che l'agente ha
      ricevuto la credenziale compaia **zero volte**.
      **Limite dichiarato:** la radice di fiducia è un file 0600, non un keyring del kernel né un
      TPM. Qualunque cosa giri come questo utente lo legge. Quello che compra oggi è che *l'agente*
      no — gira confinato, il demone no, e `--deny-read` glielo rende illeggibile comunque
- [x] **Seam di retrieval: `memory_search`** — memoria per significato come **driver opzionale**. Il
      motore sta fuori dal repository ed è libero di essere commerciale; aperti restano il contratto
      (due chiamate: `/index`, `/search`), la policy e il driver nullo. Senza motore non cambia nulla.
      **Due bug veri trovati dal test:** (1) la prima versione mandava all'indice solo i primi 2KB di
      ogni corpo, per una cautela presa dal posto sbagliato — il pager protegge la *finestra*, non il
      loopback; con le preview la funzione *sembrava* funzionare ed era incapace di trovare qualsiasi
      cosa oltre la prima pagina. (2) il file di stato degli indicizzati stava dentro la cartella
      degli handle, che viene scandita per metadata: veniva riletto come una maniglia fantasma. Una
      directory-store deve contenere esattamente un tipo di cosa
- [x] **`journal_query`: il registro si interroga, non si legge** — la risposta all'obiezione del
      registro che sfonda il contesto. Filtro e conteggio dal lato demone, nella finestra passa solo
      la risposta. *Numero: 8.001 entry (2,3 MB) riassunte in **137 byte**; 5 restituite su 4.000
      trovate, con la differenza dichiarata.* Il retrieval semantico resta lo slot NexusDB
- [x] **Etichetta di fiducia sulla provenienza** — la memoria è **dato, mai istruzione**. Un handle
      che viene da `curl` porta l'etichetta *external/untrusted* e un avviso esplicito **a ogni
      consegna**, non solo alla prima: tutto il problema è che l'agente non si ricorderà di essere
      stato avvisato. Il contenuto locale non viene etichettato, così l'etichetta continua a
      significare qualcosa. Default conservativo — una fonte non riconosciuta è *untrusted*, perché
      i due errori non sono simmetrici: scambiare il mondo per locale è un canale di injection,
      scambiare un file locale per esterno costa una frase
- [x] **Eviction dello store con lapide** — TTL + tetto, e un handle scaduto risponde *"c'era, è
      stato evitto il giorno X, ecco come riprenderlo"* con il comando esatto. Un handle che sparisce
      e basta dà all'agente un errore che non sa interpretare: non distingue *"non è mai esistito"*
      da *"c'era e non c'è più"*, quindi ri-deriva il mondo o decide di essersela immaginata
- [x] **Contesto virtuale: handle + fault-in** — §3. Un risultato che riempirebbe la finestra torna
      come **handle** con anteprima, e il corpo resta sul disco del demone. *Numero: un log di
      2,2MB entra nella finestra come **1.779 byte**; cercarci dentro costa **391 byte** su dati che
      nella finestra non entrano mai.* Struttura preservata: solo il campo troppo grande viene
      paginato, quindi `exitCode` resta leggibile senza fault-in.
      **Niente viene mai troncato in silenzio:** un risultato paginato dice quanto è trattenuto e
      nomina la chiamata che prende il resto. Un agente che riceve una risposta accorciata di
      nascosto non può distinguerla da una completa, e risponderà con sicurezza da mezzo file.
- [x] **`recall()`: il pacchetto di ripresa** — la memoria del sistema **derivata**, mai scritta
      dall'agente. Obiettivo, cosa è cambiato sotto, cosa è trattenuto (con handle), cosa aspetta un
      umano, quali risorse esterne tiene, quanto è piena la finestra. *Numero: 2.563 byte per
      riorientare una sessione che aveva letto 907KB, con il dettaglio recuperabile in 1 chiamata.*
      **Bug vero trovato dal test di ripresa:** il lease era intestato al **processo**, quindi una
      sessione ripresa non riconosceva il proprio e non poteva rilasciarlo. Il lease appartiene al
      **lavoro**, non al processo: ora l'identità è il goal quando c'è.
- [x] **Race sulle approvazioni** — `listPending()` **riscriveva** il file a ogni chiamata, e il
      gate-freeze lo interroga ogni 50 ms mentre un umano approva: il demone poteva leggere la coda,
      l'umano approvare, e il demone riscriverci sopra la propria copia stantia. L'umano vedeva
      *approvato* e l'agente restava in attesa fino al timeout. Sembrava flakiness del test (~1 run
      su 3): era un lost update. Ora i poll usano `peekPending()` che non scrive mai, e il file si
      sostituisce in modo atomico
- [x] **Lease manager su URI esterni** — §4.5. Ogni lock che un sistema offre riguarda una risorsa
      locale; gli effetti di un agente stanno quasi sempre altrove. Due agenti che pushano lo stesso
      branch non stanno correndo su niente che `flock` possa vedere, e chi perde lo scopre dopo.
      Tabella per URI (`push:github.com/org/repo`, `deploy:railway/api`, `publish:npm/x`) nel punto
      che vede ogni azione prima che avvenga.
      **L'URI è dedotto, non dichiarato:** un agente che deve *ricordarsi* di prendere il lease se
      lo dimentica proprio nel run in cui serviva. Un `git push` nudo nomina comunque il remote,
      letto dal repo e non dalla riga di comando. Un'azione che non sappiamo nominare non tiene
      nessun lease e passa: rifiutare tutto l'irriconoscibile renderebbe il broker inutile la prima
      volta che qualcuno usa un tool che non conoscevamo.
      **Advisory, e dirlo conta:** non ferma niente che non passi da Nefertari, e far finta del
      contrario sarebbe peggio che non averlo, perché qualcuno ci si appoggerebbe.
      **Scadenza obbligatoria:** un lease di un processo morto viene recuperato a vista, altrimenti
      il primo crash insegna all'operatore a cancellare il file — cioè a ignorare il meccanismo.
      **Bug trovato dal test:** `cwd` non arrivava al gate, quindi l'URI veniva letto dalla
      directory del demone invece che da quella del comando. Ora ci arriva, e il journal smette di
      registrare `git push` senza dire *dove*
- [x] **`wait_for(condizione)`** — `db8d187`. Svegliarsi su evento, non su orario: il demone guarda
      al posto dell'agente e la chiamata non torna finché la condizione non regge. *Numero: una attesa
      coperta da **1 sola tool call**, 7 poll fatti dal demone che l'agente non ha mai visto —
      da N turni di polling a ZERO.* Condizioni: `path_exists`, `path_gone`, `path_changed`,
      `file_contains`, `command_succeeds` (solo read-only: una condizione viene valutata a ogni
      poll, una con effetti li produrrebbe cento volte).
      **La regola non ovvia:** congelare l'albero è giusto al gate umano e SBAGLIATO qui — chi
      produce la condizione è spesso un figlio dell'agente (`npm test &`), e congelarlo è un
      deadlock travestito da timeout. Si congela solo se nell'albero non c'è nient'altro che
      l'agente; il test costruisce apposta il deadlock per dimostrare che la regola serve
- [x] **H4 gate-freeze** — `8ebf136`, §4.4/H4. L'azione parcheggiata al gate non restituisce più *"torna
      dopo"*: il demone trattiene la risposta e **congela l'albero dell'agente**, poi la scongela
      e la esegue quando l'umano approva. *Numero:* con il gate aperto un figlio che gira brucia
      **404 ms di CPU ogni 400 ms**, mentre il gate trattiene **2 ms — 196× meno**. Opt-in
      (`NEFERTARI_GATE_WAIT_MS`), perché trattenere una risposta cambia ciò che l'agente osserva.
      **Bug vero trovato qui:** `enableCpu()` scriveva `+cpu` nella root, e su qualunque host la
      cui root contiene processi (ogni container) la scrittura viene *accettata* e da lì in poi
      nessun figlio accetta più un processo (EIO). Il freeze smetteva di funzionare e la causa
      era tre chiamate a monte del sintomo. Un knob di priorità non può rompere una garanzia
- [x] **Idempotenza per hash d'azione** — `f827fef`, §4.3. Un'azione identica a quella immediatamente
      precedente, **senza niente in mezzo**, non viene rieseguita: torna il risultato originale,
      etichettato. Il discriminante è *cosa è successo in mezzo*, non il tempo, altrimenti il loop
      edit → test → edit → stesso test si romperebbe. Due bug veri trovati dai test: `fs_write` è
      classificato *reversible* ma cambia il file (non è una lettura), e l'hash deve coprire il
      **contenuto**, che nel journal non entra — senza, la seconda scrittura sullo stesso path
      spariva

## Memoria e contesto in un OS gestito da un'IA

Un OS pilotato da un'IA ha un problema che nessun OS ha mai avuto: **chi decide ha l'amnesia**. Non
ogni tanto — strutturalmente, a ogni sessione, e anche a metà sessione ogni volta che l'harness fa
compact. Qualunque disegno che tratti la conversazione come la memoria del sistema ha messo la
memoria del sistema nell'unico posto che è garantito perderla.

**La tentazione da evitare.** La soluzione ovvia è: prima del compact l'agente scrive un riassunto
di quel che conta. Su un OS è la soluzione pericolosa. Un riassunto scritto dall'agente è il
*resoconto che l'agente dà di sé stesso*: lossy, interessato, e non falsificabile una volta sparite
le prove. Fallo su un OS e alla prima compattazione una convinzione sbagliata diventa permanente,
senza più niente con cui confrontarla. Chi legge dopo — umano o modello — non può distinguere un
fatto ricordato da un'ipotesi ricordata.

**La regola, che è tutto il disegno:**

> La memoria derivata deve essere sempre **ri-derivabile da un registro primario che l'agente non
> può modificare**.

### I livelli

| | Cos'è | Proprietà |
|---|---|---|
| **0 — finestra** | il prompt adesso | volatile, piccola, lossy. **Mai** la fonte di verità |
| **1 — journal** | cosa è successo | append-only, hash-chain, **firmato**: fatti che l'agente non può rivedere a posteriori |
| **2 — store** | i byte stessi | tutto ciò che è stato paginato, intero su disco (`context.mjs`) |
| **3 — viste derivate** | working set, handle, lease, pressione | ricalcolate a richiesta, autorevoli su niente, buttabili |
| **4 — sapere durevole** | fra run diversi | **non costruito**, e non va costruito lasciando scrivere l'agente |

Ogni riga del livello 3 porta la **provenienza** verso 1 o 2 — una entry di journal, un handle, un
lease — così un agente ripreso distingue ciò che *sa* da ciò che starebbe solo assumendo.
`recall()` restituisce **puntatori, non contenuto**: è l'indice che permette a una finestra piccola
di raggiungere una memoria grande, ed è dimensionato per essere pagabile proprio nel momento in cui
la finestra è più piena. *Numero: 2.563 byte per riorientare una sessione che aveva letto 907KB.*

### Le quattro cose che possono andare storte, e cosa le ferma

1. **Memoria confabulata** — l'agente "ricorda" qualcosa che non ha mai verificato. *Ferma:* ogni
   riga di `recall` viene dal journal firmato, dallo store o dalla tabella lease. Nessuna riga è
   asserzione dell'agente, e il campo `provenance` lo dice esplicitamente.
2. **Memoria avvelenata** — contenuto letto dal mondo (una pagina, un log) diventa "memoria" e poi
   istruzione. *Da fare:* la provenienza deve marcare l'origine **non fidata**, e la memoria va
   trattata come dato, mai come istruzione. Oggi la provenienza c'è, l'etichetta di fiducia no.
3. **Perdita silenziosa** — il compact butta qualcosa e nessuno se ne accorge. *Ferma:* ciò che è
   trattenuto è **enumerabile** (`context_list`), quindi la perdita è rilevabile: il demone sa cosa
   l'agente ha letto anche quando l'agente l'ha scordato.
4. **Crescita illimitata** — lo store cresce per sempre. *Da fare:* TTL + tetto di dimensione, con
   **l'eviction registrata**: un handle mancante deve spiegarsi da solo invece di dare un 404
   misterioso a un agente che non può sapere perché.

### E il registro che sfonda il contesto?

È l'obiezione giusta, ed è quella che rompe quasi tutti i disegni di memoria per agenti. Se la
memoria vive in un journal append-only, e il journal cresce per sempre, prima o poi **la memoria
non ci sta più nella finestra che doveva proteggere**. Averla spostata dal contesto al disco non
risolve niente se poi il disco lo devi rileggere.

Non ci sta perché **il registro non viene mai consegnato**. Si interroga.

Il filtro e il conteggio girano dal lato del demone, dove cento megabyte non sono un problema; nella
finestra passa **la risposta**, mai il corpus. Una domanda su 200.000 entry costa quanto una domanda
su venti. *Numero: 8.001 entry, 2,3 MB di journal, riassunte in **137 byte**.*

Tre proprietà, e servono tutte e tre:

1. **Aggregare, non elencare.** `count: true` trasforma qualunque numero di entry in una forma di
   dimensione fissa (totali per tool e per decisione). Elencare è limitato da `limit`, quindi una
   domanda larga verrebbe risposta con una fetta arbitraria — che è peggio di nessuna risposta,
   perché sembra una risposta.
2. **Il totale è sempre dichiarato.** `returned: 5, matched: 4000`. Una lista limitata non deve mai
   poter essere scambiata per l'insieme completo: è l'errore che trasforma una risposta parziale in
   una risposta sbagliata.
3. **Puntatori, non contenuto.** La risposta nomina; chi vuole il corpo lo chiede.

**Quello che i filtri NON fanno è rispondere per significato.** *"Cosa abbiamo deciso sul parser?"* non
è un filtro, è retrieval — e adesso c'è il **seam**: `memory_search` con un motore come **driver
opzionale**, non come dipendenza. Senza motore non cambia niente e la risposta lo dice, indicando la
strada che resta aperta. Il motore è fuori da questo repository ed è libero di essere commerciale;
quello che è aperto è il contratto, la policy intorno, e il driver nullo che rende il tutto opzionale.

**In Nefertari sta la policy, non la ricerca.** Il motore trova; il layer decide cosa gli è permesso
ricevere e cosa deve tornare insieme alla risposta. Due regole, e stanno da questa parte del seam
proprio perché un driver potrebbe essere di chiunque:

1. **L'endpoint dev'essere locale.** Indicizzare significa embeddare: con un motore remoto
   l'indicizzazione *è* esfiltrazione — del registro primario — e avverrebbe in silenzio, come
   effetto collaterale di una funzione che sembra una casella di ricerca. Un endpoint non locale
   viene **rifiutato**. Non vietato: chi ha un motivo può forzare con `ALLOW_REMOTE=1`, ma la scelta
   è esplicita e ogni `status` continua a dichiararla — un override che smette di vedersi smette di
   essere una decisione e diventa un default che nessuno ha scelto.
2. **La provenienza sopravvive al retrieval**, altrimenti il retrieval è una lavatrice: una riga
   ostile dentro una pagina scaricata viene trovata *per significato*, sollevata dal contesto in cui
   stava, e restituita come "conoscenza recuperata" con l'etichetta lasciata indietro. Ogni
   risultato viene **ri-etichettato dallo store**, non da quel che dichiara il motore.

Il motore riceve testo e restituisce **id**: nessuna autorità se non il ranking. I contenuti tornano
dallo store, e un id che non abbiamo mai memorizzato viene ignorato — un motore ordina, non aggiunge
membri.

### Il pager è il modello locale

Confine di egress e pager del contesto sono **lo stesso confine** (§3). La cosa che può leggere 10MB
e decidere quali 2KB contano deve essere la cosa che quei 10MB non li fa uscire dalla macchina. Oggi
il pager è meccanico — soglia, handle, `grep` — e funziona; il passo successivo è farlo scegliere al
modello locale, che è l'unico modo di riassumere senza spedire.

### Prossime, ordinate
- [ ] **Il modello locale come pager** *(1–2 settimane)* — oggi la paginazione è meccanica (soglia +
      `grep`). Far scegliere al modello locale quali 2KB contano è §3, ed è l'unico modo di
      riassumere senza spedire
- [ ] **Livello 4: sapere durevole fra run** *(2–3 settimane)* — un fatto sopravvive a un run solo se
      lo promuove un umano o un **controllo ri-eseguibile**. Mai l'agente che lo asserisce
- [ ] **Definire la LINEA fra azione autonoma e azione che chiede permesso** *(1–2 settimane)* —
      oggi la linea esiste ma è **fissa e implicita**: `reversible`/`noisy` passano, `irreversible`
      va al gate. È un default ragionevole e un cattivo contratto, perché la linea giusta dipende
      da *dove* gira l'agente, non da cosa fa il singolo comando. Le tre cose che mancano:

      **(a) Profili di autonomia dichiarati.** Lo stesso `git push` è ovvio in una sandbox usa-e-getta
      e da chiedere in produzione. Servono profili nominati (`supervised`, `trusted`, `autonomous`,
      `paranoid`) che spostano la soglia, non la tassonomia: la classificazione resta un fatto sul
      comando, il profilo è una decisione sul contesto. Tenerli separati è ciò che impedisce alla
      pressione ("fammelo passare") di corrompere il classificatore.

      **(b) Budget di autonomia, non solo permessi per azione.** "Può spendere fino a X", "può
      toccare fino a N file fuori dal workspace", "può fare 3 azioni irreversibili poi si ferma".
      Un permesso per-azione non scala su una notte di lavoro autonomo: o chiede troppo (e l'umano
      timbra senza leggere — è la stessa approval fatigue per cui esiste già `MAX_PENDING`) o non
      chiede mai. Un budget si esaurisce, ed esaurirsi è un comportamento sicuro.

      **(c) Deleghe con scadenza, per goal.** "Per QUESTO goal, per le prossime 2 ore, i push su
      questo repo sono autonomi" — una capability con scope e scadenza, non un flag globale. Si
      appoggia su `actionHash` (che già identifica un'azione) e sul lease manager di §4.5 (che già
      deve nominare le risorse esterne per URI).

      Vincoli che la linea deve rispettare, e sono il motivo per cui è una voce di design e non una
      config: il default deve restare *chiedi*, l'allentamento deve essere **esplicito, nominato e
      journalizzato** (chi ha allargato la linea, quando, per quale goal), e nessun profilo deve
      poter rendere invisibile un'azione — al massimo può renderla *autonoma*, mai *non registrata*.
      Il journal firmato di §4.4 è ciò che rende questa distinzione verificabile invece che promessa.
- [ ] **H2 fork overlayfs + upper tmpfs** *(2–3 settimane)* — sblocca anche gli errori con write-set
- [ ] **Contesto virtuale**: handle + fault-in + budget, con il modello locale come pager *(§3)*
- [ ] **Seam `screen` con driver** (cdp / extension stile gemma-gem / native / screenpipe) + **classi
      d'azione sullo schermo** nel broker: click su elemento il cui nome dice *delete/pay/send/confirm*
      → irreversibile → gate. Nominare **tutte** le strade allo stesso effetto (Invio in un campo invia
      il form quanto il bottone). Consumare l'albero di accessibilità **prima** dei pixel *(§3-bis)*
- [ ] **`preflight(azione)`** — dove il mondo non è snapshottabile si chiede prima di attuare. Stesso
      primitivo per computer use e robotica *(§3-bis)*
- [ ] **Inferenza embedded** (llama.cpp come libreria nel supervisor Rust) al posto dei driver HTTP
      come default *(§3)*
- [ ] **Postcondizioni (T6) e webhook** — un piano che ritenta o devia senza tornare al modello
- [ ] **Supervisor privilegiato in Rust** + **BPF LSM** (via Aya) — la radice di fiducia
- [ ] **Modulo NixOS / immagine OSTree** — possedere il boot

### Da fare comunque, indipendenti
- [x] `docs/BENCHMARK.md` · confronto dsh eseguito · "The first" tolto dal README
- [ ] Esempio LangChain da ~50 righe via `langchain-mcp-adapters` — dimostra che qualunque framework
      lo pilota, a costo quasi zero
