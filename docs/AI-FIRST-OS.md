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
primitivo: qualcosa di locale che legge molto ed emette poco. Il componente costruito il 24 agosto
(`localmodel.mjs` + `egress.mjs`) serve a entrambi.

**Vincolo onesto:** la finestra vera è posseduta dal client (Claude Code, Hermes, il loop custom), non
da `agentd`. Nefertari non può fare eviction dalla finestra altrui. Ma può controllare **cosa
consegna**, che è lo stesso identico vincolo dell'egress e ha la stessa risposta: si governa il lato
ingresso. "Contesto virtuale" significa quindi: *l'OS non consegna mai più del budget, e consegna
handle invece di corpi*. Forma concreta dei tool: `fs_read` restituisce handle + riassunto quando il
corpo supera il budget; `expand(handle, regione)` fa il fault-in della parte che serve davvero.

---

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

### Prossime, ordinate
- [ ] **Confinare l'agente stesso** con Landlock, non solo i comandi che esegue *(giorni)* — oggi
      l'agente aggira il broker lanciando una bash, quindi "fisica non convenzione" è circolare
- [ ] **Hash-chain del journal** + firma Ed25519 *(giorni)* — §4.4
- [ ] **Idempotenza per hash d'azione** *(giorni)* — §4.3
- [ ] **H4 gate-freeze** via `cgroup.freeze` *(1 settimana)*
- [ ] **`wait_for(condizione)`** *(1–2 settimane)* — svegliarsi su evento, non su orario. Unifica
      self-wake, scheduling e processo sospendibile. *Numero: agente in attesa di una CI da 10 min,
      da N turni di polling a ZERO*
- [ ] **Lease manager su URI esterni** *(1–2 settimane)* — §4.5
- [ ] **H1 inference-window scheduling** *(1–2 settimane)* — misurare la finestra prima di usarla
- [ ] **Scheduler a budget token** *(2 settimane)* — §4.2
- [ ] **H2 fork overlayfs + upper tmpfs** *(2–3 settimane)* — sblocca anche gli errori con write-set
- [ ] **Contesto virtuale**: handle + fault-in + budget, con il modello locale come pager *(§3)*
- [ ] **Secret broker con egress proxy** *(3–4 settimane)* — §4.1, il valore/sforzo più alto
- [ ] **Postcondizioni (T6) e webhook** — un piano che ritenta o devia senza tornare al modello
- [ ] **Supervisor privilegiato in Rust** + **BPF LSM** (via Aya) — la radice di fiducia
- [ ] **Modulo NixOS / immagine OSTree** — possedere il boot

### Da fare comunque, indipendenti
- [ ] `docs/BENCHMARK.md` con metodo, tabelle e dati grezzi linkabili
- [ ] Eseguire `examples/bench-dsh.mjs` — scritto, mai lanciato. **Finché non gira non si può dire di
      battere dsh**
- [ ] Togliere "The first" dal README
- [ ] Esempio LangChain da ~50 righe via `langchain-mcp-adapters` — dimostra che qualunque framework
      lo pilota, a costo quasi zero
