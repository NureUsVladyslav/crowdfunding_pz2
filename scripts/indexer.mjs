// Індексатор подій: читає журнали контрактів у мережі й зберігає історію операцій у web/history.json
//
// Запуск:
//   node scripts/indexer.mjs                 разова синхронізація (дописує лише нові події)
//   node scripts/indexer.mjs --watch         працює постійно, оновлює файл кожні 15 секунд
//
// Необов'язкові параметри:
//   --network <назва>   файл deployments/<назва>.json з адресами (за замовчуванням sepolia)
//   --rpc <адреса>      адреса вузла мережі (за замовчуванням SEPOLIA_RPC_URL з .env)
//   --from <блок>       з якого блока (пере)читати історію; без нього дописуються лише нові події
//   --source etherscan  брати події з Etherscan (потрібен ETHERSCAN_API_KEY у .env). Корисно, коли
//                       публічний вузол уже видалив стару історію
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const root = process.cwd();
const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const watch = argv.includes("--watch");
const networkName = argValue("--network") ?? "sepolia";
const rpcUrl =
  argValue("--rpc") ??
  process.env.SEPOLIA_RPC_URL ??
  "https://ethereum-sepolia-rpc.publicnode.com";
const chunk = Number(process.env.INDEXER_CHUNK ?? 2000); // розмір діапазону блоків в одному запиті
const source = argValue("--source") ?? "rpc";
const etherscanUrl =
  process.env.ETHERSCAN_API_URL ?? "https://api.etherscan.io/v2/api";
const etherscanKey = process.env.ETHERSCAN_API_KEY;
const esPage = Number(process.env.INDEXER_ES_PAGE ?? 1000); // записів на сторінку Etherscan (максимум 1000)
let forcedFrom = argValue("--from"); // діє лише на першу синхронізацію
const outFile = path.join(root, "web", "history.json");

const deployFile = path.join(root, "deployments", `${networkName}.json`);
if (!fs.existsSync(deployFile)) {
  console.error(
    `Не знайдено ${path.relative(
      root,
      deployFile,
    )}. Спочатку розгорніть контракти.`,
  );
  process.exit(1);
}
const deployment = JSON.parse(fs.readFileSync(deployFile, "utf8"));

// Індексуємо події головного контракту та реєстру ролей
const names = ["Campaigns", "AuthorRegistry"];
const contracts = names.map((name) => {
  const artifact = path.join(
    root,
    "artifacts",
    "contracts",
    `${name}.sol`,
    `${name}.json`,
  );
  if (!fs.existsSync(artifact)) {
    console.error(
      `Не знайдено ${path.relative(
        root,
        artifact,
      )}. Виконайте npx hardhat compile.`,
    );
    process.exit(1);
  }
  const abi = JSON.parse(fs.readFileSync(artifact, "utf8")).abi;
  return {
    name,
    address: deployment.contracts[name],
    iface: new ethers.Interface(abi),
  };
});

const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
  staticNetwork: true,
  batchMaxCount: 1,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Публічні вузли видаляють стару історію («pruned history unavailable») і обмежують розмір діапазону запиту
const errText = (e) =>
  `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.error?.message ?? ""}`;
const isPruned = (e) =>
  e?.error?.code === 4444 ||
  /pruned|history unavailable|missing trie|header not found|too old/i.test(
    errText(e),
  );
const isRateLimit = (e) =>
  /rate limit|too many requests|429|max calls/i.test(errText(e));
const isRangeError = (e) =>
  !isRateLimit(e) &&
  !isPruned(e) &&
  /range|exceed|more than|10000|too large|too wide|limited to/i.test(
    errText(e),
  );

// Повторні спроби: публічні вузли інколи відповідають помилкою про ліміт запитів
async function retry(label, fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      // Помилки «історії немає» та «діапазон завеликий» повторами не виправити: обробляємо їх окремо
      if (attempt >= 4 || isPruned(e) || isRangeError(e)) throw e;
      console.log(
        `  ${label}: помилка (${String(e.shortMessage ?? e.message).slice(
          0,
          80,
        )}), спроба ${attempt + 1}…`,
      );
      await sleep(1000 * attempt);
    }
  }
}

function loadState() {
  if (fs.existsSync(outFile)) {
    try {
      return JSON.parse(fs.readFileSync(outFile, "utf8"));
    } catch (_) {
      /* пошкоджений файл: починаємо спочатку */
    }
  }
  return { network: networkName, fromBlock: null, toBlock: null, events: [] };
}

// Іменовані аргументи події, великі числа як рядки
function namedArgs(parsed) {
  const out = {};
  parsed.fragment.inputs.forEach((input, i) => {
    const value = parsed.args[i];
    out[input.name] =
      typeof value === "bigint" ? value.toString() : String(value);
  });
  return out;
}

async function sync(state) {
  const latest = await retry("номер блока", () => provider.getBlockNumber());
  const chainId = Number((await provider.getNetwork()).chainId);

  // Останні 12 блоків читаємо повторно на випадок реорганізації ланцюга
  let from;
  if (forcedFrom !== undefined) {
    from = Number(forcedFrom);
    forcedFrom = undefined;
  } else if (state.toBlock !== null) from = Math.max(0, state.toBlock - 11);
  else if (deployment.deployBlock !== undefined) from = deployment.deployBlock;
  else from = source === "etherscan" ? 0 : Math.max(0, latest - 30000);
  if (from > latest) return state;

  // Читає журнали обох контрактів в одному діапазоні блоків
  async function readRange(start, end) {
    const part = [];
    for (const c of contracts) {
      const logs = await retry(`${c.name} ${start}-${end}`, () =>
        provider.getLogs({
          address: c.address,
          fromBlock: start,
          toBlock: end,
        }),
      );
      for (const log of logs) {
        const parsed = c.iface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (!parsed) continue;
        part.push({
          block: log.blockNumber,
          logIndex: log.index,
          txHash: log.transactionHash,
          contract: c.name,
          name: parsed.name,
          args: namedArgs(parsed),
        });
      }
    }
    return part;
  }

  // Чи віддає вузол діапазон [mid, end]; помилка про розмір діапазону означає, що історія при цьому є
  async function served(mid, end) {
    try {
      await provider.getLogs({
        address: contracts[0].address,
        fromBlock: mid,
        toBlock: end,
      });
      return true;
    } catch (e) {
      if (isPruned(e)) return false;
      if (isRangeError(e)) return true;
      throw e;
    }
  }

  // Читає події з Etherscan (його індекс зберігає всю історію, на відміну від публічних вузлів)
  async function readEtherscan() {
    if (!etherscanKey)
      throw new Error(
        "Для --source etherscan потрібен ETHERSCAN_API_KEY у файлі .env",
      );
    // Etherscan повертає нуль як "0x", тому звичайне Number("0x") дало б NaN
    const num = (v) =>
      v === undefined || v === null || v === "" || v === "0x" ? 0 : Number(v);
    const part = [];
    for (const c of contracts) {
      for (let page = 1; ; page += 1) {
        const query = new URLSearchParams({
          chainid: String(chainId),
          module: "logs",
          action: "getLogs",
          address: c.address,
          fromBlock: String(from),
          toBlock: String(latest),
          page: String(page),
          offset: String(esPage),
          apikey: etherscanKey,
        });
        const body = await retry("Etherscan", async () => {
          const response = await fetch(`${etherscanUrl}?${query}`);
          const json = await response.json();
          if (json.status === "0" && /no records/i.test(String(json.message)))
            return { status: "1", result: [] };
          if (json.status !== "1")
            throw new Error(
              `Etherscan: ${json.message} ${
                typeof json.result === "string" ? json.result : ""
              }`.trim(),
            );
          return json;
        });
        for (const log of body.result) {
          const parsed = c.iface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (!parsed) continue;
          part.push({
            block: num(log.blockNumber),
            logIndex: num(log.logIndex),
            txHash: log.transactionHash,
            contract: c.name,
            name: parsed.name,
            args: namedArgs(parsed),
            timestamp: num(log.timeStamp),
          });
        }
        await sleep(350); // ліміт безкоштовного ключа: кілька запитів на секунду
        if (body.result.length < esPage) break;
      }
    }
    return part;
  }

  // Іде від найновіших блоків до найстаріших. Якщо вузол видалив стару історію, знаходить межу
  // (найраніший початок діапазону, який вузол ще віддає) і далі читає лише доступну частину
  let found = [];
  if (source === "etherscan") {
    console.log(`Джерело: Etherscan, блоки ${from}–${latest}`);
    found = await readEtherscan();
  } else {
    let size = chunk;
    let end = latest;
    let boundaryHits = 0;
    while (end >= from) {
      const start = Math.max(from, end - size + 1);
      try {
        found.push(...(await readRange(start, end)));
        end = start - 1;
      } catch (e) {
        if (isPruned(e)) {
          if (++boundaryHits > 5) throw e;
          console.log(
            `Вузол не віддає журнал із блока ${start}. Шукаємо найраніший доступний блок…`,
          );
          let lo = start; // початок діапазону, який вузол не віддає
          let hi = end; // початок, який вважаємо доступним
          while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (await served(mid, end)) hi = mid;
            else lo = mid;
          }
          from = hi;
          console.log(
            `Найраніший доступний блок: ${from}. Старіші події цей вузол віддати не може.`,
          );
          console.log(
            "Старіші події можна взяти з Etherscan: node scripts/indexer.mjs --source etherscan --from <блок розгортання>",
          );
          continue;
        }
        if (isRangeError(e) && size > 5) {
          size = Math.max(5, Math.floor(size / 2));
          console.log(
            `  Вузол обмежує діапазон запиту, зменшуємо крок до ${size} блоків`,
          );
          continue;
        }
        throw e;
      }
    }
  }

  // Часові позначки блоків: один запит на кожен блок із подіями
  const stamps = new Map();
  for (const ev of found) {
    if (ev.timestamp !== undefined) continue; // Etherscan віддає мітку часу разом із подією
    if (!stamps.has(ev.block)) {
      const block = await retry(`блок ${ev.block}`, () =>
        provider.getBlock(ev.block),
      );
      stamps.set(ev.block, block.timestamp);
    }
    ev.timestamp = stamps.get(ev.block);
  }

  // Події з перечитаного діапазону замінюємо свіжими, решту лишаємо
  const kept = state.events.filter((ev) => ev.block < from);
  const events = kept
    .concat(found)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const added = Math.max(0, events.length - state.events.length);
  const next = {
    network: networkName,
    chainId,
    fromBlock:
      state.fromBlock === null || state.fromBlock === undefined
        ? from
        : Math.min(state.fromBlock, from),
    toBlock: latest,
    updatedAt: new Date().toISOString(),
    events,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile + ".tmp", JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(outFile + ".tmp", outFile);
  console.log(
    `Блоки ${from}–${latest}: додано нових подій: ${added}, усього ${
      events.length
    }. Файл ${path.relative(root, outFile)} оновлено.`,
  );
  return next;
}

console.log(
  `Мережа ${networkName}, вузол ${new URL(rpcUrl).host}${
    source === "etherscan" ? ", історія з Etherscan" : ""
  }`,
);
let state = loadState();
try {
  state = await sync(state);
} catch (e) {
  console.error(
    "Помилка індексатора:",
    String(e.shortMessage ?? e.message).slice(0, 300),
  );
  process.exit(1);
}

if (watch) {
  console.log(
    "Режим спостереження: оновлення кожні 15 секунд (зупинка Ctrl+C).",
  );
  for (;;) {
    await sleep(15000);
    try {
      state = await sync(state);
    } catch (e) {
      console.log(
        "Помилка синхронізації, повторимо:",
        String(e.shortMessage ?? e.message).slice(0, 120),
      );
    }
  }
}
process.exit(0);
