const MODULE_ID = "lipatos-actor-importer";
const VERSION = "1.0.0";
const ACTOR_TYPES = new Map([
  ["npc", "npc"], ["monster", "npc"], ["монстр", "npc"], ["нпс", "npc"],
  ["character", "character"], ["персонаж", "character"], ["герой", "character"]
]);
const ABILITIES = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const ITEM_TYPES = new Set([
  "weapon", "equipment", "consumable", "tool", "loot", "container", "backpack",
  "spell", "feat", "class", "subclass", "race", "background", "facility"
]);
const ICONS = {
  npc: "icons/svg/mystery-man.svg",
  character: "icons/svg/mystery-man.svg",
  weapon: "icons/weapons/swords/sword-guard.webp",
  equipment: "icons/equipment/chest/breastplate-layered-steel.webp",
  consumable: "icons/consumables/potions/bottle-round-corked-red.webp",
  spell: "icons/magic/symbols/runes-star-pentagon-orange.webp",
  feat: "icons/skills/trades/academics-book-study-runes.webp"
};

let lastPayload = "";

Hooks.on("renderActorDirectory", (_app, html) => {
  if (!game.user?.isGM || game.system?.id !== "dnd5e") return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".lipatos-actor-importer-button")) return;

  const header = root.querySelector(".directory-header");
  if (!header) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lipatos-actor-importer-button";
  button.innerHTML = '<i class="fa-solid fa-file-import" aria-hidden="true"></i> Импорт актёра';
  button.addEventListener("click", () => void openImporter());

  // The button is a full-width action immediately below the directory's standard creation controls.
  const actions = header.querySelector(".header-actions, .action-buttons");
  if (actions) actions.insertAdjacentElement("afterend", button);
  else header.append(button);
});

async function openImporter() {
  if (!game.user?.isGM || game.system?.id !== "dnd5e") return;

  const form = await foundry.applications.api.DialogV2.input({
    window: { title: "LipatoS — Импорт актёра" },
    content:
      '<div class="lipatos-actor-importer-dialog">' +
      '<p>Вставьте JSON персонажа или монстра. Поддерживается один актёр или массив актёров. Код JavaScript не выполняется.</p>' +
      '<textarea name="payload" rows="19" spellcheck="false" placeholder=\'{"name":"Скелет-маг","type":"npc","abilities":{"str":8,"dex":14,"con":12,"int":16,"wis":10,"cha":8},"hp":45,"ac":13}\'>' +
      escapeHTML(lastPayload) + '</textarea>' +
      '<p class="lipatos-actor-importer-hint">Можно вставить полный экспорт Foundry: system, items, effects и prototypeToken будут сохранены. Для рабочих атак и заклинаний у предметов передавайте system.activities.</p>' +
      '</div>',
    ok: { label: "Проверить и импортировать", icon: "fa-solid fa-file-import" },
    rejectClose: false,
    modal: true
  });
  if (!form) return;

  lastPayload = String(form.payload ?? "");
  if (!lastPayload.trim()) {
    ui.notifications.warn("Вставьте JSON актёра.");
    return;
  }

  let documents;
  try {
    const source = parsePayload(lastPayload);
    const entries = Array.isArray(source) ? source : [source];
    if (!entries.length) throw new Error("Массив актёров пуст.");
    if (entries.length > 50) throw new Error("За один раз можно импортировать не более 50 актёров.");
    documents = entries.map((entry, index) => normalizeActor(entry, index));
  } catch (error) {
    console.error(MODULE_ID + " | JSON validation failed", error);
    ui.notifications.error("Ошибка JSON: " + error.message + ". Исходный текст сохранён в окне импорта.");
    return;
  }

  const totalItems = documents.reduce((sum, doc) => sum + doc.items.length, 0);
  const names = documents.slice(0, 8).map(doc => "<li>" + escapeHTML(doc.name) +
    " — " + (doc.type === "npc" ? "монстр / NPC" : "персонаж") +
    " (" + doc.items.length + " предметов)</li>").join("");
  const more = documents.length > 8 ? "<p>И ещё: " + (documents.length - 8) + "</p>" : "";
  const approved = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Подтверждение импорта" },
    content: '<div class="lipatos-actor-importer-preview"><p>Создать актёров: <b>' +
      documents.length + '</b>; встроенных предметов: <b>' + totalItems +
      '</b>.</p><ul>' + names + '</ul>' + more + '</div>',
    yes: { label: "Создать актёров", icon: "fa-solid fa-check" },
    no: { label: "Отмена" },
    rejectClose: false,
    modal: true
  });
  if (!approved) return;
  if (!game.user?.isGM) return;

  try {
    const created = await Actor.createDocuments(documents);
    if (!created.length) throw new Error("Foundry не вернул созданные документы.");
    ui.notifications.info("Импортировано актёров: " + created.length + ".");
    lastPayload = "";
    if (created.length === 1) created[0].sheet?.render(true);
  } catch (error) {
    console.error(MODULE_ID + " | Actor creation failed", error);
    ui.notifications.error("Импорт не выполнен: " + error.message + ". JSON сохранён в окне импорта.");
  }
}

function parsePayload(input) {
  let text = input.trim();
  const fence = String.fromCharCode(96).repeat(3);
  if (text.startsWith(fence)) {
    const end = text.lastIndexOf(fence);
    text = text.slice(3, end > 3 ? end : undefined).replace(/^json\s*/i, "").trim();
  }
  return JSON.parse(text);
}

function normalizeActor(source, index) {
  const where = "Актёр №" + (index + 1);
  if (!isObject(source)) throw new Error(where + ": ожидается JSON-объект.");
  if (typeof source.name !== "string" || !source.name.trim()) {
    throw new Error(where + ": обязательное поле name отсутствует.");
  }

  const type = ACTOR_TYPES.get(String(source.type ?? "npc").trim().toLowerCase());
  if (!type) throw new Error(where + ": type должен быть npc или character.");
  if (source.system !== undefined && !isObject(source.system)) {
    throw new Error(where + ": system должен быть объектом.");
  }

  const system = foundry.utils.deepClone(source.system ?? {});
  applyShorthand(system, source, where);

  const items = [];
  for (const [property, defaultType] of [["items", null], ["features", "feat"], ["spells", "spell"]]) {
    if (source[property] === undefined) continue;
    if (!Array.isArray(source[property])) throw new Error(where + ": " + property + " должен быть массивом.");
    for (const item of source[property]) items.push(normalizeItem(item, defaultType, where));
  }

  const effects = source.effects ?? [];
  if (!Array.isArray(effects) || !effects.every(isObject)) {
    throw new Error(where + ": effects должен быть массивом объектов.");
  }

  const flags = isObject(source.flags) ? foundry.utils.deepClone(source.flags) : {};
  flags[MODULE_ID] = { ...(isObject(flags[MODULE_ID]) ? flags[MODULE_ID] : {}),
    imported: true, version: VERSION };

  const actor = {
    name: source.name.trim(),
    type,
    img: typeof source.img === "string" && source.img.trim() ? source.img : ICONS[type],
    system,
    items,
    effects: foundry.utils.deepClone(effects),
    flags
  };

  const token = source.prototypeToken ?? source.token;
  if (token !== undefined) {
    if (!isObject(token)) throw new Error(where + ": prototypeToken должен быть объектом.");
    actor.prototypeToken = foundry.utils.deepClone(token);
  }

  if (source.folder !== undefined && source.folder !== null && source.folder !== "") {
    const folder = game.folders?.get(source.folder) ??
      game.folders?.find(f => f.type === "Actor" && f.name === source.folder);
    if (!folder || folder.type !== "Actor") {
      throw new Error(where + ": папка актёров не найдена (folder).");
    }
    actor.folder = folder.id;
  }
  return actor;
}

function applyShorthand(system, source, where) {
  if (source.abilities !== undefined) {
    if (!isObject(source.abilities)) throw new Error(where + ": abilities должен быть объектом.");
    system.abilities ??= {};
    for (const [ability, value] of Object.entries(source.abilities)) {
      if (!ABILITIES.has(ability)) throw new Error(where + ": неизвестная характеристика " + ability);
      const data = typeof value === "number" ? { value } : value;
      if (!isObject(data) || !Number.isFinite(data.value)) {
        throw new Error(where + ": характеристика " + ability + " должна содержать числовое value.");
      }
      system.abilities[ability] = { ...(system.abilities[ability] ?? {}), ...data };
    }
  }

  if (source.saves !== undefined) {
    if (!Array.isArray(source.saves)) throw new Error(where + ": saves должен быть массивом характеристик.");
    system.abilities ??= {};
    for (const key of source.saves) {
      if (!ABILITIES.has(key)) throw new Error(where + ": неизвестный спасбросок " + key);
      system.abilities[key] = { ...(system.abilities[key] ?? {}), proficient: 1 };
    }
  }

  if (source.skills !== undefined) {
    if (!isObject(source.skills)) throw new Error(where + ": skills должен быть объектом.");
    system.skills ??= {};
    for (const [key, proficiency] of Object.entries(source.skills)) {
      if (!Object.hasOwn(CONFIG.DND5E.skills, key)) {
        throw new Error(where + ": неизвестный ключ навыка " + key);
      }
      const data = typeof proficiency === "number" ? { value: proficiency } : proficiency;
      if (!isObject(data)) throw new Error(where + ": неверный навык " + key);
      system.skills[key] = { ...(system.skills[key] ?? {}), ...data };
    }
  }

  if (source.hp !== undefined) {
    const hp = typeof source.hp === "number" ? { value: source.hp, max: source.hp } : source.hp;
    if (!isObject(hp) || !Number.isFinite(hp.value ?? hp.max)) {
      throw new Error(where + ": hp должен быть числом или объектом {value,max}.");
    }
    system.attributes ??= {};
    system.attributes.hp = { ...(system.attributes.hp ?? {}), ...hp };
  }

  if (source.ac !== undefined) {
    if (!Number.isFinite(source.ac)) throw new Error(where + ": ac должен быть числом.");
    system.attributes ??= {};
    system.attributes.ac = { ...(system.attributes.ac ?? {}), calc: "natural", flat: source.ac };
  }

  if (source.movement !== undefined) {
    const movement = typeof source.movement === "number" ? { walk: source.movement } : source.movement;
    if (!isObject(movement)) throw new Error(where + ": movement должен быть числом или объектом.");
    system.attributes ??= {};
    system.attributes.movement = { ...(system.attributes.movement ?? {}), ...movement };
  }

  if (source.cr !== undefined) {
    system.details ??= {};
    system.details.cr = parseCR(source.cr, where);
  }
  if (source.description !== undefined) {
    if (typeof source.description !== "string") throw new Error(where + ": description должен быть строкой.");
    system.details ??= {};
    system.details.biography = { ...(system.details.biography ?? {}), value: source.description };
  }
}

function normalizeItem(source, defaultType, where) {
  if (!isObject(source) || typeof source.name !== "string" || !source.name.trim()) {
    throw new Error(where + ": каждый предмет должен иметь name.");
  }
  const type = String(source.type ?? defaultType ?? "").toLowerCase();
  if (!ITEM_TYPES.has(type)) {
    throw new Error(where + ": неизвестный тип предмета " + type + " (" + source.name + ").");
  }
  if (source.system !== undefined && !isObject(source.system)) {
    throw new Error(where + ": system предмета должен быть объектом (" + source.name + ").");
  }
  const item = foundry.utils.deepClone(source);
  item.name = item.name.trim();
  item.type = type;
  item.system ??= {};
  item.img ||= ICONS[type] ?? "icons/svg/item-bag.svg";
  if (typeof item.description === "string") {
    item.system.description = { ...(item.system.description ?? {}), value: item.description };
  }
  delete item.description;
  return item;
}

function parseCR(value, where) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const text = value.trim().replace(",", ".");
    if (/^\d+\/\d+$/.test(text)) {
      const [a, b] = text.split("/").map(Number);
      if (b > 0) return a / b;
    }
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  throw new Error(where + ": неверное значение cr.");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}
