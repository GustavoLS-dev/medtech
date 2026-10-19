/* ==========================================================================
   MedTech — pages/splash.js  (index.html, tela de abertura)
   Sequência: dias acendem em volta → cápsula se encaixa → nome letra a
   letra → frase → carregamento (verifica a sessão) → "Começar".
   Depois: painel (com sessão) ou login.
   Interação: tocar no fundo solta comprimidos; tocar no logo faz a cápsula
   girar; o logo inclina com o mouse ou com o movimento do celular.
   Depende de: supabase-config.js
   ========================================================================== */

(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Quem já viu a abertura nesta aba vê uma versão curta.
  let seen = false;
  try { seen = sessionStorage.getItem("medtech:splash") === "1"; } catch (e) { /* sem armazenamento */ }
  const SPEED = reduceMotion ? 0 : seen ? 0.45 : 1;
  const AUTO_START_MS = 6000;  // sem toque, entra sozinho

  const stage = document.getElementById("stage");
  const body = document.body;
  const logo = document.getElementById("logo");
  const days = Array.from(document.querySelectorAll("#ring li"));
  const letters = Array.from(document.querySelectorAll("#sp-name span"));
  const bar = document.getElementById("progress-bar");
  const progress = document.getElementById("progress");
  const status = document.getElementById("status");
  const start = document.getElementById("start");
  const particles = document.getElementById("particles");

  let target = "entrar.html";
  let leaving = false;
  let autoTimer = null;

  const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms * SPEED); }); };

  /* ------------------------------------------------------------------ */
  /* Partículas                                                         */
  /* ------------------------------------------------------------------ */
  const COLORS = ["#5fd0de", "#5be3a1", "#f2b84b", "#e07a7a"];

  function burst(x, y, count, spread) {
    if (reduceMotion) return;
    for (let i = 0; i < count; i++) {
      const pill = document.createElement("span");
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const dist = spread * (0.6 + Math.random() * 0.6);
      pill.className = "sp-pill";
      pill.style.left = x + "px";
      pill.style.top = y + "px";
      pill.style.setProperty("--dx", Math.cos(angle) * dist + "px");
      pill.style.setProperty("--dy", Math.sin(angle) * dist + "px");
      pill.style.setProperty("--r", Math.round(Math.random() * 540 - 270) + "deg");
      pill.style.setProperty("--c", COLORS[i % COLORS.length]);
      particles.appendChild(pill);
      setTimeout(function () { pill.remove(); }, 1200);
    }
  }

  function ripple(x, y) {
    if (reduceMotion) return;
    const r = document.createElement("span");
    r.className = "sp-ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    particles.appendChild(r);
    setTimeout(function () { r.remove(); }, 900);
  }

  function logoCenter() {
    const box = logo.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, size: box.width };
  }

  /* ------------------------------------------------------------------ */
  /* Sessão (define para onde ir depois)                                 */
  /* ------------------------------------------------------------------ */
  async function checkSession() {
    try {
      const client = SupabaseConfig.getClient();
      if (!client) return;
      const result = await client.auth.getSession();
      if (result.data && result.data.session) target = "dashboard.html";
    } catch (e) {
      // Sem conexão: vai para o login, que mostra o aviso adequado.
    }
  }

  function setProgress(value) {
    bar.style.width = value + "%";
    progress.setAttribute("aria-valuenow", String(value));
  }

  /* ------------------------------------------------------------------ */
  /* Sequência de abertura                                               */
  /* ------------------------------------------------------------------ */
  function placeDays() {
    const todayIndex = (new Date().getDay() + 6) % 7;  // 0 = segunda (mesma ordem do organizador)
    days.forEach(function (li, i) {
      li.style.setProperty("--a", (i * 360) / days.length + "deg");
      if (i === todayIndex) li.dataset.today = "1";
    });
  }

  async function play() {
    const session = checkSession();
    placeDays();
    await wait(250);
    body.classList.add("is-lit");

    // 1. Os 7 dias aparecem e acendem, um a um
    for (let i = 0; i < days.length; i++) {
      days[i].classList.add("is-on");
      await wait(90);
    }
    for (let i = 0; i < days.length; i++) {
      days[i].classList.add("is-lit");
      setProgress(Math.round(((i + 1) / days.length) * 45));
      await wait(70);
    }

    // 2. O logo surge e a cápsula se encaixa ("clique" + comprimidos)
    body.classList.add("is-logo", "is-logo-entering");
    await wait(450);
    body.classList.add("is-click");
    await wait(280);
    const c = logoCenter();
    burst(c.x, c.y, 14, c.size * 1.3);
    body.classList.remove("is-logo-entering");
    setProgress(65);

    // 3. Nome letra a letra e a frase
    for (let i = 0; i < letters.length; i++) {
      letters[i].classList.add("is-on");
      await wait(70);
    }
    await wait(150);
    body.classList.add("is-tagline");

    // 4. Termina o carregamento (verificação da sessão)
    // Espera a sessão por no máximo 2,5 s (sem internet, segue para o login).
    await Promise.race([session, new Promise(function (r) { setTimeout(r, 2500); })]);
    setProgress(100);
    await wait(350);
    days.forEach(function (li) { li.classList.remove("is-lit"); if (li.dataset.today) li.classList.add("is-today"); });
    status.textContent = target === "dashboard.html" ? "Tudo pronto. Bem-vindo de volta!" : "Tudo pronto.";
    progress.hidden = true;
    start.textContent = target === "dashboard.html" ? "Abrir meu painel" : "Começar";
    start.hidden = false;
    start.focus({ preventScroll: true });
    sweep();
    try { sessionStorage.setItem("medtech:splash", "1"); } catch (e) { /* sem armazenamento */ }
    autoTimer = setTimeout(leave, AUTO_START_MS);
  }

  // Brilho que percorre os dias enquanto espera o toque
  function sweep() {
    if (reduceMotion) return;
    let i = 0;
    setInterval(function () {
      days.forEach(function (li) { li.classList.remove("is-pulse"); });
      days[i % days.length].classList.add("is-pulse");
      i++;
    }, 380);
  }

  /* ------------------------------------------------------------------ */
  /* Saída                                                              */
  /* ------------------------------------------------------------------ */
  function leave() {
    if (leaving) return;
    leaving = true;
    clearTimeout(autoTimer);
    if (reduceMotion) { window.location.href = target; return; }
    const c = logoCenter();
    burst(c.x, c.y, 18, c.size * 2);
    body.classList.add("is-leaving");
    setTimeout(function () { window.location.href = target; }, 780);
  }

  /* ------------------------------------------------------------------ */
  /* Interação                                                          */
  /* ------------------------------------------------------------------ */
  start.addEventListener("click", function (event) { event.stopPropagation(); leave(); });

  document.getElementById("skip").addEventListener("click", async function (event) {
    event.stopPropagation();
    await Promise.race([checkSession(), new Promise(function (r) { setTimeout(r, 1500); })]);
    leave();
  });

  logo.addEventListener("click", function (event) {
    event.stopPropagation();
    if (!body.classList.contains("is-click")) return;
    body.classList.remove("is-wiggle");
    void logo.offsetWidth;  // reinicia a animação
    body.classList.add("is-wiggle");
    const c = logoCenter();
    burst(c.x, c.y, 10, c.size);
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = setTimeout(leave, AUTO_START_MS); }
  });

  // Tocar no fundo: onda + comprimidos no ponto do toque
  stage.addEventListener("pointerdown", function (event) {
    if (event.target.closest("button")) return;
    ripple(event.clientX, event.clientY);
    burst(event.clientX, event.clientY, 6, 70);
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = setTimeout(leave, AUTO_START_MS); }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") leave();
  });

  // Inclinação 3D: mouse no computador, movimento no celular
  function tilt(x, y) {
    logo.style.setProperty("--tilt-x", (-y * 16).toFixed(1) + "deg");
    logo.style.setProperty("--tilt-y", (x * 16).toFixed(1) + "deg");
  }

  if (!reduceMotion) {
    window.addEventListener("pointermove", function (event) {
      if (event.pointerType !== "mouse") return;
      tilt(event.clientX / window.innerWidth - 0.5, event.clientY / window.innerHeight - 0.5);
    });
    window.addEventListener("deviceorientation", function (event) {
      if (event.gamma == null || event.beta == null) return;
      tilt(Math.max(-1, Math.min(1, event.gamma / 30)) / 2, Math.max(-1, Math.min(1, (event.beta - 45) / 30)) / 2);
    });
  }

  play();
})();
