(function () {
  "use strict";

  const cfg = window.CF_CONFIG;
  const ABI = window.CF_ABI;
  const ethers = window.ethers;

  // ---------- Довідники ----------

  const STATUS_NAME = ["Активна", "Успішна", "Провалена", "Виплачено"];
  const STATUS_CLASS = ["info", "ok", "bad", "done"];
  const AUTHOR_ROLE = ethers.id("AUTHOR_ROLE");
  const MINTER_ROLE = ethers.id("MINTER_ROLE");
  const REFRESH_MS = 15000;

  // Зрозумілі пояснення для власних помилок контрактів
  const ERROR_TEXT = {
    NotAdmin: () =>
      "Цю дію може виконати лише адміністратор. Підключіть акаунт адміністратора.",
    AccessControlUnauthorizedAccount: (a) =>
      a[1] === MINTER_ROLE
        ? "Контракт кампаній не має права випускати винагороди: йому не видано роль MINTER_ROLE."
        : "Цю дію може виконати лише адміністратор. Підключіть акаунт адміністратора.",
    NotAuthor: () =>
      "У вашого акаунта немає ролі автора. Адміністратор має спочатку призначити вас автором.",
    ZeroGoal: () => "Цільова сума має бути більшою за нуль.",
    ZeroDuration: () => "Тривалість має бути більшою за нуль.",
    ZeroAmount: () => "Сума внеску має бути більшою за нуль.",
    ZeroAddress: () => "Адреса не може бути нульовою.",
    CampaignNotFound: (a) => `Кампанії №${a[0]} не існує.`,
    CampaignEnded: () =>
      "Час кампанії вичерпано, внески більше не приймаються.",
    CampaignNotEnded: () =>
      "Кампанія ще триває. Ця дія стане доступною після дедлайну.",
    GoalNotReached: () => "Кампанія не зібрала цільову суму.",
    GoalAlreadyReached: () =>
      "Кампанія зібрала цільову суму, тому повернути внесок не можна.",
    NotCampaignAuthor: () => "Забрати кошти може лише автор цієї кампанії.",
    AlreadyWithdrawn: () => "Автор уже забрав кошти цієї кампанії.",
    NothingToRefund: () =>
      "У вас немає внеску в цій кампанії для повернення (або ви його вже забрали).",
    NothingToClaim: () =>
      "У вас немає внеску в цій кампанії, за який належить винагорода (або ви її вже забрали).",
    TransferFailed: () =>
      "Не вдалося надіслати ETH. Транзакцію скасовано, нічого не списано.",
    EnforcedPause: () =>
      "Систему призупинено адміністратором. Спробуйте після зняття паузи.",
    ExpectedPause: () => "Паузу не ввімкнено, тож знімати нічого.",
    ReentrancyGuardReentrantCall: () =>
      "Повторний виклик заблоковано захистом від повторного входу.",
    SafeCastOverflowedUintDowncast: () =>
      "Значення завелике для зберігання в контракті.",
  };

  // ---------- Стан ----------

  const state = {
    provider: null,
    signer: null,
    account: null,
    networkOk: false,
    c: null, // контракти: { campaigns, registry, token }
    page: 0,
    pageSize: 5,
    amounts: {}, // введені суми внеску за номером кампанії
    roles: { admin: false, author: false },
    paused: false,
    totalCampaigns: 0,
    shownCount: 0,
    busy: false,
    timer: null,
    refreshTimeout: null,
  };

  const ifaces = Object.values(ABI).map((abi) => new ethers.Interface(abi));
  const el = (id) => document.getElementById(id);

  // ---------- Допоміжні функції ----------

  function esc(value) {
    return String(value).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[ch]),
    );
  }

  function shortAddr(addr) {
    return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "";
  }

  function fmtEth(wei) {
    const [whole, frac = ""] = ethers.formatEther(wei).split(".");
    const trimmed = frac.slice(0, 6).replace(/0+$/, "");
    return trimmed ? whole + "." + trimmed : whole;
  }

  function fmtDate(seconds) {
    return new Date(Number(seconds) * 1000).toLocaleString("uk-UA");
  }

  function fmtRemaining(deadline) {
    const left = Number(deadline) - Math.floor(Date.now() / 1000);
    if (left <= 0) return "час вичерпано";
    if (left < 60) return `лишилось ${left} с`;
    if (left < 3600) return `лишилось ${Math.floor(left / 60)} хв`;
    if (left < 86400)
      return `лишилось ${Math.floor(left / 3600)} год ${Math.floor(
        (left % 3600) / 60,
      )} хв`;
    return `лишилось ${Math.floor(left / 86400)} дн`;
  }

  function nowTime() {
    return new Date().toLocaleTimeString("uk-UA");
  }

  function setBanner(text, withSwitch) {
    el("banner-text").textContent = text || "";
    el("banner").classList.toggle("show", Boolean(text));
    el("btn-switch").hidden = !withSwitch;
  }

  // ---------- Пояснення помилок ----------

  function extractRevertData(e) {
    const candidates = [
      e && e.data,
      e && e.error && e.error.data,
      e && e.info && e.info.error && e.info.error.data,
      e &&
        e.info &&
        e.info.error &&
        e.info.error.data &&
        e.info.error.data.data,
      e &&
        e.info &&
        e.info.error &&
        e.info.error.data &&
        e.info.error.data.originalError &&
        e.info.error.data.originalError.data,
      e && e.error && e.error.data && e.error.data.data,
      e &&
        e.error &&
        e.error.data &&
        e.error.data.originalError &&
        e.error.data.originalError.data,
    ];
    return (
      candidates.find(
        (c) => typeof c === "string" && c.startsWith("0x") && c.length >= 10,
      ) || null
    );
  }

  function friendly(name, args) {
    const make = ERROR_TEXT[name];
    return {
      text: make ? make(args || []) : `Контракт відхилив транзакцію (${name}).`,
      tech: name,
    };
  }

  // Перетворює помилку на { text, tech }: зрозумілий текст і технічна назва
  function explainError(e) {
    const code = e && (e.code !== undefined ? e.code : null);
    const nested = e && e.info && e.info.error && e.info.error.code;
    if (code === "ACTION_REJECTED" || code === 4001 || nested === 4001) {
      return {
        text: "Ви скасували транзакцію у MetaMask. Нічого не списано.",
        tech: "",
      };
    }
    if (e && e.revert && e.revert.name) {
      return friendly(e.revert.name, Array.from(e.revert.args || []));
    }
    const data = extractRevertData(e);
    if (data) {
      for (const iface of ifaces) {
        try {
          const parsed = iface.parseError(data);
          if (parsed) return friendly(parsed.name, Array.from(parsed.args));
        } catch (_) {
          /* пробуємо наступний інтерфейс */
        }
      }
    }
    const message = String((e && (e.shortMessage || e.message)) || e);
    if (/insufficient funds|insufficient balance/i.test(message)) {
      return {
        text: "Недостатньо ETH на рахунку для суми та комісії за газ.",
        tech: "",
      };
    }
    if (/network|fetch|timeout|disconnected/i.test(message)) {
      return {
        text: "Немає зв'язку з мережею. Перевірте інтернет і спробуйте ще раз.",
        tech: "",
      };
    }
    return {
      text: "Не вдалося виконати дію. Деталі: " + message.slice(0, 160),
      tech: "",
    };
  }

  // ---------- Журнали ----------

  function addTx(label, kind, message, hash, tech) {
    const list = el("tx-list");
    if (list.querySelector(".msg") && !list.querySelector(".badge"))
      list.innerHTML = "";
    const li = document.createElement("li");
    list.prepend(li);
    while (list.children.length > 20) list.lastChild.remove();
    updateTx(li, label, kind, message, hash, tech);
    return { li, label };
  }

  function updateTx(li, label, kind, message, hash, tech) {
    const badge = {
      pending: ["info", "Очікує"],
      ok: ["ok", "Підтверджено"],
      error: ["bad", "Помилка"],
    }[kind];
    li.className = kind;
    const link = hash
      ? ` <a href="${esc(cfg.explorer)}/tx/${esc(
          hash,
        )}" target="_blank" rel="noopener">відкрити в Etherscan</a>`
      : "";
    const techText = tech ? ` <span class="tech">(${esc(tech)})</span>` : "";
    li.innerHTML =
      `<time>${nowTime()}</time><span class="badge ${badge[0]}">${
        badge[1]
      }</span> <strong>${esc(label)}</strong>` +
      `<span class="msg">${esc(message)}${techText}${link}</span>`;
  }

  function addEvent(text) {
    const list = el("event-list");
    if (!list.querySelector("time")) list.innerHTML = "";
    const li = document.createElement("li");
    li.innerHTML = `<time>${nowTime()}</time>${esc(text)}`;
    list.prepend(li);
    while (list.children.length > 30) list.lastChild.remove();
  }

  function describeEvent(name, a) {
    switch (name) {
      case "CampaignCreated":
        return `Створено кампанію №${a[0]}: ціль ${fmtEth(
          a[2],
        )} ETH, автор ${shortAddr(a[1])}.`;
      case "Contributed":
        return `Внесок ${fmtEth(a[2])} ETH у кампанію №${a[0]} від ${shortAddr(
          a[1],
        )}.`;
      case "Withdrawn":
        return `Автор ${shortAddr(a[1])} забрав ${fmtEth(
          a[2],
        )} ETH із кампанії №${a[0]}.`;
      case "Refunded":
        return `Вкладник ${shortAddr(a[1])} повернув ${fmtEth(
          a[2],
        )} ETH із кампанії №${a[0]}.`;
      case "RewardClaimed":
        return `Вкладник ${shortAddr(a[1])} отримав винагороду ${fmtEth(
          a[2],
        )} CFR за кампанію №${a[0]}.`;
      case "Paused":
        return `Систему призупинено (адміністратор ${shortAddr(a[0])}).`;
      case "Unpaused":
        return `Паузу знято (адміністратор ${shortAddr(a[0])}).`;
      case "RoleGranted":
        return a[0] === AUTHOR_ROLE
          ? `Роль автора видано адресі ${shortAddr(a[1])}.`
          : `Видано роль адресі ${shortAddr(a[1])}.`;
      case "RoleRevoked":
        return a[0] === AUTHOR_ROLE
          ? `Роль автора забрано в адреси ${shortAddr(a[1])}.`
          : `Роль забрано в адреси ${shortAddr(a[1])}.`;
      default:
        return `Подія ${name}.`;
    }
  }

  // ---------- Події контрактів ----------

  // Одна й та сама подія може надійти двічі (повторна підписка або повторна видача логів вузлом),
  // тому кожен запис журналу показуємо один раз: за хешем транзакції та номером запису
  const seenEvents = new Set();

  function onChainEvent(payload) {
    const log = payload.log;
    if (log) {
      const key = `${log.transactionHash}:${log.index}`;
      if (seenEvents.has(key)) return;
      seenEvents.add(key);
      if (seenEvents.size > 500)
        seenEvents.delete(seenEvents.values().next().value);
    }
    const name =
      payload.eventName || (payload.fragment && payload.fragment.name);
    if (!name) return;
    addEvent(describeEvent(name, Array.from(payload.args || [])));
    scheduleRefresh();
  }

  function subscribeEvents() {
    state.c.campaigns.on("*", onChainEvent);
    state.c.registry.on("*", onChainEvent);
  }

  async function unsubscribeEvents() {
    if (!state.c) return;
    const old = state.c;
    await Promise.all([
      old.campaigns.removeAllListeners(),
      old.registry.removeAllListeners(),
    ]);
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimeout);
    state.refreshTimeout = setTimeout(refreshAll, 400);
  }

  // ---------- Підключення ----------

  function ready() {
    return Boolean(state.account && state.networkOk && state.c);
  }

  async function connect() {
    if (!window.ethereum) {
      setBanner(
        "MetaMask не знайдено. Встановіть розширення з metamask.io і оновіть сторінку.",
        false,
      );
      return;
    }
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await setup();
    } catch (e) {
      const info = explainError(e);
      addTx("Підключення гаманця", "error", info.text, null, info.tech);
    }
  }

  // Підключення виконуються строго по черзі, щоб два запуски поспіль не заважали один одному
  let setupQueue = Promise.resolve();
  function setup() {
    setupQueue = setupQueue.then(doSetup, doSetup);
    return setupQueue;
  }

  async function doSetup() {
    await unsubscribeEvents();
    clearInterval(state.timer);
    state.provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (!accounts.length) {
      state.c = null;
      state.account = null;
      renderWallet();
      renderLocked("Підключіть MetaMask, щоб побачити кампанії.");
      return;
    }
    state.signer = await state.provider.getSigner();
    state.account = ethers.getAddress(accounts[0]);
    const net = await state.provider.getNetwork();
    state.networkOk = Number(net.chainId) === cfg.chainId;
    if (!state.networkOk) {
      state.c = null;
      renderWallet();
      setBanner(
        `MetaMask підключено до іншої мережі. Для роботи потрібна ${cfg.chainName}.`,
        true,
      );
      renderLocked(`Перемкніть MetaMask на мережу ${cfg.chainName}.`);
      return;
    }
    setBanner("", false);
    state.c = {
      campaigns: new ethers.Contract(
        cfg.addresses.Campaigns,
        ABI.Campaigns,
        state.signer,
      ),
      registry: new ethers.Contract(
        cfg.addresses.AuthorRegistry,
        ABI.AuthorRegistry,
        state.signer,
      ),
      token: new ethers.Contract(
        cfg.addresses.RewardToken,
        ABI.RewardToken,
        state.signer,
      ),
    };
    renderWallet();
    subscribeEvents();
    await refreshAll();
    state.timer = setInterval(refreshAll, REFRESH_MS);
  }

  async function switchNetwork() {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + cfg.chainId.toString(16) }],
      });
      await setup();
    } catch (e) {
      const info = explainError(e);
      addTx("Перемикання мережі", "error", info.text, null, info.tech);
    }
  }

  // ---------- Читання стану ----------

  async function refreshAll() {
    if (!state.c) return;
    try {
      const { campaigns, registry, token } = state.c;
      const me = state.account;
      const [isAdmin, isAuthor, paused, cfr, eth, count] = await Promise.all([
        registry.isAdmin(me),
        registry.isAuthor(me),
        campaigns.paused(),
        token.balanceOf(me),
        state.provider.getBalance(me),
        campaigns.campaignCount(),
      ]);
      state.roles = { admin: isAdmin, author: isAuthor };
      state.paused = paused;

      // Сторінки йдуть від найновіших кампаній до найстаріших
      const total = Number(count);
      const maxPage = Math.max(0, Math.ceil(total / state.pageSize) - 1);
      if (state.page > maxPage) state.page = maxPage;
      const skipped = state.page * state.pageSize;
      const size = Math.min(state.pageSize, total - skipped);
      const start = total - skipped - size;

      let items = [];
      if (size > 0) {
        const raw = Array.from(await campaigns.getCampaigns(start, size));
        items = await Promise.all(
          raw.map(async (c, i) => {
            const id = start + i + 1;
            const [status, mine] = await Promise.all([
              campaigns.status(id),
              campaigns.contributions(id, me),
            ]);
            return {
              id,
              author: c.author,
              goal: c.goal,
              raised: c.raised,
              deadline: c.deadline,
              status: Number(status),
              mine,
            };
          }),
        );
        items.reverse();
      }
      state.totalCampaigns = total;
      state.shownCount = size;
      renderWallet();
      renderAccount(eth, cfr);
      renderPause();
      renderList(items, total, skipped, size);
    } catch (e) {
      const info = explainError(e);
      setBanner("Не вдалося прочитати дані з контрактів. " + info.text, false);
    }
  }

  // ---------- Показ ----------

  function renderWallet() {
    const badge = el("net-badge");
    if (!state.account) {
      badge.className = "badge done";
      badge.textContent = "Не підключено";
    } else if (state.networkOk) {
      badge.className = "badge ok";
      badge.textContent = cfg.chainName;
    } else {
      badge.className = "badge bad";
      badge.textContent = "Інша мережа";
    }
    el("account").textContent = state.account ? shortAddr(state.account) : "";
    el("account").title = state.account || "";
    el("btn-connect").hidden = Boolean(state.account);
    const chips = [];
    if (state.account && state.networkOk) {
      if (state.roles.admin)
        chips.push('<span class="badge info">Адміністратор</span>');
      if (state.roles.author) chips.push('<span class="badge ok">Автор</span>');
      chips.push('<span class="badge done">Вкладник</span>');
    }
    el("role-chips").innerHTML = chips.join(" ");
    updateButtons();
  }

  function renderAccount(eth, cfr) {
    el("eth-balance").textContent = `${fmtEth(eth)} ETH`;
    el("cfr-balance").textContent = `${fmtEth(cfr)} CFR`;
  }

  function renderPause() {
    const badge = el("pause-state");
    badge.className = "badge " + (state.paused ? "warn" : "ok");
    badge.textContent = state.paused ? "Призупинено" : "Працює";
  }

  function renderLocked(message) {
    el("campaign-list").innerHTML = `<p class="empty">${esc(message)}</p>`;
    el("pager-info").textContent = "";
    el("eth-balance").textContent = "—";
    el("cfr-balance").textContent = "—";
    updateButtons();
  }

  function campaignCard(c) {
    const percent =
      c.goal > 0n ? Number((c.raised * 10000n) / c.goal) / 100 : 0;
    const reached = c.raised >= c.goal;
    const amount =
      state.amounts[c.id] !== undefined ? state.amounts[c.id] : "0.01";
    const off = ready() ? "" : " disabled";
    return `
      <article class="campaign" data-id="${c.id}">
        <header>
          <h3>Кампанія №${c.id}</h3>
          <span class="badge ${STATUS_CLASS[c.status]}">${
      STATUS_NAME[c.status]
    }</span>
        </header>
        <div class="progress${
          reached ? " reached" : ""
        }" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(
      percent,
      100,
    )}">
          <div style="width:${Math.min(percent, 100)}%"></div>
        </div>
        <div class="raised"><span>Зібрано ${fmtEth(c.raised)} із ${fmtEth(
      c.goal,
    )} ETH</span><span>${percent.toFixed(percent % 1 ? 1 : 0)}%</span></div>
        <dl class="facts">
          <dt>Автор</dt><dd class="addr" title="${esc(c.author)}">${esc(
      shortAddr(c.author),
    )}</dd>
          <dt>Дедлайн</dt><dd>${esc(fmtDate(c.deadline))}, ${esc(
      fmtRemaining(c.deadline),
    )}</dd>
          <dt>Ваш внесок</dt><dd>${fmtEth(c.mine)} ETH</dd>
        </dl>
        <div class="actions">
          <input class="amount" type="text" inputmode="decimal" data-id="${
            c.id
          }" value="${esc(amount)}" aria-label="Сума внеску в ETH, кампанія ${
      c.id
    }" autocomplete="off">
          <button class="btn small" type="button" data-action="contribute" data-id="${
            c.id
          }"${off}>Внести ETH</button>
        </div>
        <div class="actions">
          <button class="btn secondary small" type="button" data-action="withdraw" data-id="${
            c.id
          }"${off} title="Лише для автора кампанії">Забрати кошти (автор)</button>
          <button class="btn secondary small" type="button" data-action="refund" data-id="${
            c.id
          }"${off}>Повернути внесок</button>
          <button class="btn secondary small" type="button" data-action="claim" data-id="${
            c.id
          }"${off}>Забрати винагороду</button>
        </div>
      </article>`;
  }

  function renderList(items, total, skipped, size) {
    const list = el("campaign-list");
    const active = document.activeElement;
    const keep =
      active && active.classList && active.classList.contains("amount")
        ? {
            id: active.dataset.id,
            start: active.selectionStart,
            end: active.selectionEnd,
          }
        : null;

    if (total === 0) {
      list.innerHTML =
        '<p class="empty">Кампаній ще немає. Автор може створити першу в панелі «Нова кампанія».</p>';
    } else {
      list.innerHTML = items.map(campaignCard).join("");
    }
    el("pager-info").textContent = total
      ? `Кампанії ${total - skipped - size + 1}–${total - skipped} із ${total}`
      : "";
    el("btn-newer").disabled = !ready() || state.page === 0;
    el("btn-older").disabled = !ready() || skipped + size >= total;

    if (keep) {
      const input = list.querySelector(`.amount[data-id="${keep.id}"]`);
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(keep.start, keep.end);
        } catch (_) {
          /* не критично */
        }
      }
    }
  }

  function updateButtons() {
    const on = ready() && !state.busy;
    [
      "btn-register",
      "btn-remove",
      "btn-pause",
      "btn-unpause",
      "btn-create",
      "btn-refresh",
    ].forEach((id) => {
      el(id).disabled = !on && !(id === "btn-refresh" && ready());
    });
    document
      .querySelectorAll("#campaign-list button[data-action]")
      .forEach((b) => {
        b.disabled = !on;
      });
  }

  // ---------- Відправлення транзакцій ----------

  // Спершу пробний виклик без підпису: якщо контракт відхилить, користувач одразу бачить причину
  async function runTx(label, contract, method, args, overrides) {
    if (!ready()) {
      addTx(
        label,
        "error",
        `Підключіть MetaMask і виберіть мережу ${cfg.chainName}.`,
      );
      return;
    }
    state.busy = true;
    updateButtons();
    const entry = addTx(
      label,
      "pending",
      "Перевіряємо, чи контракт прийме транзакцію…",
    );
    const opts = overrides || {};
    try {
      await contract[method].staticCall(...args, opts);
      updateTx(
        entry.li,
        label,
        "pending",
        "Підтвердьте транзакцію у вікні MetaMask…",
      );
      const tx = await contract[method](...args, opts);
      updateTx(
        entry.li,
        label,
        "pending",
        "Транзакцію надіслано. Чекаємо підтвердження в блоці…",
        tx.hash,
      );
      const receipt = await tx.wait();
      if (receipt && receipt.status === 1) {
        updateTx(
          entry.li,
          label,
          "ok",
          `Підтверджено у блоці ${receipt.blockNumber}.`,
          tx.hash,
        );
      } else {
        updateTx(
          entry.li,
          label,
          "error",
          "Транзакцію відхилено мережею.",
          tx.hash,
        );
      }
    } catch (e) {
      const info = explainError(e);
      updateTx(entry.li, label, "error", info.text, null, info.tech);
    } finally {
      state.busy = false;
      updateButtons();
      await refreshAll();
    }
  }

  function parseEth(text) {
    try {
      return ethers.parseEther(String(text).trim().replace(",", "."));
    } catch (_) {
      return null;
    }
  }

  function readAddress(label) {
    const value = el("admin-address").value.trim();
    if (!ethers.isAddress(value)) {
      addTx(
        label,
        "error",
        "Введіть коректну адресу акаунта, що починається з 0x.",
      );
      return null;
    }
    return ethers.getAddress(value);
  }

  function notReady(label) {
    addTx(
      label,
      "error",
      `Підключіть MetaMask і виберіть мережу ${cfg.chainName}.`,
    );
  }

  function onCreate() {
    if (!ready()) return notReady("Створення кампанії");
    const goal = parseEth(el("goal-input").value);
    const minutes = Number(
      String(el("duration-input").value).trim().replace(",", "."),
    );
    if (goal === null || !Number.isFinite(minutes) || minutes < 0) {
      addTx(
        "Створення кампанії",
        "error",
        "Введіть суму та тривалість числами, наприклад 0.01 і 5.",
      );
      return;
    }
    runTx("Створення кампанії", state.c.campaigns, "createCampaign", [
      goal,
      Math.round(minutes * 60),
    ]);
  }

  function onCardAction(button) {
    if (!ready()) return notReady("Дія з кампанією");
    const id = BigInt(button.dataset.id);
    const campaigns = state.c.campaigns;
    switch (button.dataset.action) {
      case "contribute": {
        const raw =
          state.amounts[button.dataset.id] !== undefined
            ? state.amounts[button.dataset.id]
            : "0.01";
        const amount = parseEth(raw);
        if (amount === null) {
          addTx(
            `Внесок у кампанію №${id}`,
            "error",
            "Введіть суму числом, наприклад 0.01.",
          );
          return;
        }
        runTx(`Внесок у кампанію №${id}`, campaigns, "contribute", [id], {
          value: amount,
        });
        break;
      }
      case "withdraw":
        runTx(`Виплата автору, кампанія №${id}`, campaigns, "withdraw", [id]);
        break;
      case "refund":
        runTx(`Повернення внеску, кампанія №${id}`, campaigns, "refund", [id]);
        break;
      case "claim":
        runTx(
          `Отримання винагороди, кампанія №${id}`,
          campaigns,
          "claimReward",
          [id],
        );
        break;
    }
  }

  // ---------- Запуск ----------

  function bind() {
    el("btn-connect").addEventListener("click", connect);
    el("btn-switch").addEventListener("click", switchNetwork);
    el("btn-refresh").addEventListener("click", refreshAll);
    el("btn-newer").addEventListener("click", () => {
      state.page = Math.max(0, state.page - 1);
      refreshAll();
    });
    el("btn-older").addEventListener("click", () => {
      state.page += 1;
      refreshAll();
    });
    el("btn-create").addEventListener("click", onCreate);
    el("btn-register").addEventListener("click", () => {
      if (!ready()) return notReady("Призначення автора");
      const addr = readAddress("Призначення автора");
      if (addr)
        runTx("Призначення автора", state.c.registry, "registerAuthor", [addr]);
    });
    el("btn-remove").addEventListener("click", () => {
      if (!ready()) return notReady("Скасування ролі автора");
      const addr = readAddress("Скасування ролі автора");
      if (addr)
        runTx("Скасування ролі автора", state.c.registry, "removeAuthor", [
          addr,
        ]);
    });
    el("btn-pause").addEventListener("click", () => {
      if (!ready()) return notReady("Увімкнення паузи");
      runTx("Увімкнення паузи", state.c.campaigns, "pause", []);
    });
    el("btn-unpause").addEventListener("click", () => {
      if (!ready()) return notReady("Зняття паузи");
      runTx("Зняття паузи", state.c.campaigns, "unpause", []);
    });

    const list = el("campaign-list");
    list.addEventListener("click", (ev) => {
      const button = ev.target.closest("button[data-action]");
      if (button && !button.disabled) onCardAction(button);
    });
    list.addEventListener("input", (ev) => {
      if (ev.target.classList.contains("amount"))
        state.amounts[ev.target.dataset.id] = ev.target.value;
    });

    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("accountsChanged", () => setup().catch(() => {}));
      window.ethereum.on("chainChanged", () => window.location.reload());
    }
  }

  async function init() {
    bind();
    updateButtons();
    if (!window.ethereum) {
      setBanner(
        "MetaMask не знайдено. Встановіть розширення з metamask.io і оновіть сторінку.",
        false,
      );
      return;
    }
    try {
      const accounts = await window.ethereum.request({
        method: "eth_accounts",
      });
      if (accounts.length) await setup();
    } catch (_) {
      /* користувач підключиться кнопкою */
    }
  }

  init();
})();
