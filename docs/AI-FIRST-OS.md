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
- [x] **Firma Ed25519 per entry** — §4.4. La catena rende la manomissione *visibile*; la firma
      impedisce di riscrivere il registro da capo. Un falsario può ricalcolare ogni hash, non può
      firmare, e una entry non firmata dopo una firmata viene rifiutata. Resta aperta la troncatura:
      nessuna firma può protestare per la propria assenza, serve un àncora esterna
- [x] **`wait_for(condizione)`** — svegliarsi su evento, non su orario. Il demone guarda al posto
      dell'agente e la chiamata non torna finché la condizione non regge. *Numero: una attesa
      coperta da **1 sola tool call**, 7 poll fatti dal demone che l'agente non ha mai visto —
      da N turni di polling a ZERO.* Condizioni: `path_exists`, `path_gone`, `path_changed`,
      `file_contains`, `command_succeeds` (solo read-only: una condizione viene valutata a ogni
      poll, una con effetti li produrrebbe cento volte).
      **La regola non ovvia:** congelare l'albero è giusto al gate umano e SBAGLIATO qui — chi
      produce la condizione è spesso un figlio dell'agente (`npm test &`), e congelarlo è un
      deadlock travestito da timeout. Si congela solo se nell'albero non c'è nient'altro che
      l'agente; il test costruisce apposta il deadlock per dimostrare che la regola serve
- [x] **H4 gate-freeze** — §4.4/H4. L'azione parcheggiata al gate non restituisce più *"torna
      dopo"*: il demone trattiene la risposta e **congela l'albero dell'agente**, poi la scongela
      e la esegue quando l'umano approva. *Numero:* con il gate aperto un figlio che gira brucia
      **404 ms di CPU ogni 400 ms**, mentre il gate trattiene **2 ms — 196× meno**. Opt-in
      (`NEFERTARI_GATE_WAIT_MS`), perché trattenere una risposta cambia ciò che l'agente osserva.
      **Bug vero trovato qui:** `enableCpu()` scriveva `+cpu` nella root, e su qualunque host la
      cui root contiene processi (ogni container) la scrittura viene *accettata* e da lì in poi
      nessun figlio accetta più un processo (EIO). Il freeze smetteva di funzionare e la causa
      era tre chiamate a monte del sintomo. Un knob di priorità non può rompere una garanzia
- [x] **Idempotenza per hash d'azione** — §4.3. Un'azione identica a quella immediatamente
      precedente, **senza niente in mezzo**, non viene rieseguita: torna il risultato originale,
      etichettato. Il discriminante è *cosa è successo in mezzo*, non il tempo, altrimenti il loop
      edit → test → edit → stesso test si romperebbe. Due bug veri trovati dai test: `fs_write` è
      classificato *reversible* ma cambia il file (non è una lettura), e l'hash deve coprire il
      **contenuto**, che nel journal non entra — senza, la seconda scrittura sullo stesso path
      spariva

### Prossime, ordinate
- [ ] **Pre-lavoro speculativo in un figlio sotto `cpu.idle`** invece che in-process *(giorni)* —
      la macchina c'è, deve solo guadagnarselo
- [ ] **Lease manager su URI esterni** *(1–2 settimane)* — §4.5
- [ ] **Scheduler a budget token** *(2 settimane)* — §4.2
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
- [ ] **Secret broker con egress proxy** *(3–4 settimane)* — §4.1, il valore/sforzo più alto
- [ ] **Postcondizioni (T6) e webhook** — un piano che ritenta o devia senza tornare al modello
- [ ] **Supervisor privilegiato in Rust** + **BPF LSM** (via Aya) — la radice di fiducia
- [ ] **Modulo NixOS / immagine OSTree** — possedere il boot

### Da fare comunque, indipendenti
- [x] `docs/BENCHMARK.md` · confronto dsh eseguito · "The first" tolto dal README
- [ ] Esempio LangChain da ~50 righe via `langchain-mcp-adapters` — dimostra che qualunque framework
      lo pilota, a costo quasi zero
